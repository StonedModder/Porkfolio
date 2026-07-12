'use strict';
module.exports = function register(ipcMain, { win, store, log, path, fs, os, spawn, ps5Notify, transferMgr, dialog, ftp }) {
const { createExfatImage } = require('../exfat/native-exfat');
const { buildPfs } = require('../pfs/native-pfs');
const { getConversionCapabilities } = require('../platform-capabilities');
const conversionCapabilities = getConversionCapabilities();
// ── GAME CONVERSION ENGINE (FFPKG / ExFAT) ─── Windows-only ──────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── File utilities ────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576)    return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024)       return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

async function convCollectFiles(dir, base = dir) {
  const results = [];
  const visited = new Set();
  const stack   = [dir];

  while (stack.length) {
    const current = stack.pop();

    // Resolve the real path to detect symlink / junction cycles
    let realPath;
    try { realPath = await fs.promises.realpath(current); } catch { realPath = current; }
    if (visited.has(realPath)) continue;
    visited.add(realPath);

    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
    catch (err) { log.warn(`[Conv] Cannot read dir: ${current} — ${err.message}`); continue; }

    for (const e of entries) {
      const full = path.join(current, e.name);
      let isDir = e.isDirectory();
      if (!isDir && !e.isFile()) {
        try { isDir = (await fs.promises.stat(full)).isDirectory(); } catch (_) { isDir = false; }
      }
      if (isDir) stack.push(full);
      else       results.push({ src: full, rel: path.relative(base, full) });
    }
  }
  return results;
}

async function convCopyDirWithProgress(srcDir, destDir, { onProgress, getCancelled } = {}) {
  const files = await convCollectFiles(srcDir);
  let bytesDone = 0, bytesTotal = 0;
  const sizes = await Promise.all(files.map(f =>
    fs.promises.stat(f.src).then(s => s.size).catch(() => 0)
  ));
  sizes.forEach(s => { bytesTotal += s; });

  for (let i = 0; i < files.length; i++) {
    if (getCancelled?.()) throw new Error('Cancelled');
    const { src, rel } = files[i];
    const dest = path.join(destDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);
      rs.on('data', chunk => {
        bytesDone += chunk.length;
        onProgress?.({ file: rel, index: i + 1, total: files.length, bytesDone, bytesTotal });
        if (getCancelled?.()) { rs.destroy(); ws.destroy(new Error('Cancelled')); }
      });
      rs.on('error', reject);
      ws.on('error', err => { rs.destroy(); reject(err); });
      ws.on('close', resolve);
      rs.pipe(ws);
    });
  }
  return { files: files.length, bytes: bytesDone };
}

// Find the game's subfolder within a firmware folder path
function findGameSubfolder(folderPath, game_id) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(/([A-Z]{4}\d{5})/i);
      if (m && m[1].toUpperCase() === game_id.toUpperCase()) return entry.name;
    }
  } catch (_) {}
  return null;
}

// ── UFS2Tool runner ───────────────────────────────────────────────────────────

const CONV_UFS2_PROGRESS_RE = /Adding files to image\.\.\.\s+(\d+)%\s+\((\d+)\/(\d+)\s+files,\s+([\d.]+ \S+)\/([\d.]+ \S+)\)/;

function convParseUfs2Progress(text) {
  for (const line of text.split(/[\r\n]/)) {
    const m = CONV_UFS2_PROGRESS_RE.exec(line);
    if (m) return {
      toolPct:    parseInt(m[1], 10),
      filesNow:   parseInt(m[2], 10),
      filesTotal: parseInt(m[3], 10),
      bytesNow:   m[4],
      bytesTotal: m[5],
    };
  }
  return null;
}

// Best-effort kill of a spawned child and its descendants. On Windows the exfat
// path runs cmd.exe → powershell, so a plain proc.kill() would orphan the child;
// taskkill /T /F takes down the whole tree.
function convKillProc(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (_) { /* already gone */ }
}

function convRunUfs2(args, { onData, onProgress, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const toolPath = store.get('conv.ufs2ToolPath', '');
    if (!toolPath || !fs.existsSync(toolPath)) {
      return reject(new Error(
        toolPath
          ? `UFS2Tool not found at: ${toolPath}`
          : 'UFS2Tool.exe path not configured. Set it in Settings → Game Conversion.'
      ));
    }
    const proc = require('child_process').spawn(toolPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onProc?.(proc);
    let done = false;
    const timeoutMs = store.get('conv.toolTimeoutMs', 30 * 60 * 1000);
    const timer = setTimeout(() => {
      if (done) return; done = true;
      convKillProc(proc);
      reject(new Error(`UFS2Tool timed out after ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);
    const out  = [];
    const handle = (d) => {
      const s = d.toString();
      out.push(s);
      onData?.(s);
      const parsed = convParseUfs2Progress(s);
      if (parsed) onProgress?.(parsed);
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    proc.on('error', err => { if (done) return; done = true; clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`UFS2Tool exited ${code}: ${text.slice(0, 300)}`));
    });
  });
}

function convMakefPS5(inputDir, outputFile, opts = {}) {
  return convRunUfs2([
    'makefs', '-S', '4096', '-t', 'ffs',
    '-o', 'version=2,minfree=0,softupdates=0,optimization=space',
    outputFile, inputDir,
  ], opts);
}

function convNewfsPS5(inputDir, outputFile, opts = {}) {
  return convRunUfs2(['newfs', '-D', inputDir, outputFile], opts);
}

/**
 * Find the directory that directly contains eboot.bin via BFS (up to 5 levels).
 * Handles layouts:
 *   workerDir/eboot.bin
 *   workerDir/app0/eboot.bin
 *   workerDir/Image0/app0/eboot.bin
 *   workerDir/PPSA21837/Image0/app0/eboot.bin
 * Returns the path that directly contains eboot.bin, or null if not found.
 *
 * Uses fs.statSync() fallback for junction points / symlinks so Windows reparse
 * points (common in PS5 game backups) are followed when present in workerDir.
 */
function convFindGameRoot(dir) {
  const MAX_DEPTH = 5;
  // BFS queue entries: { absPath, depth }
  const queue = [{ absPath: dir, depth: 0 }];
  let found = null;

  while (queue.length) {
    const { absPath, depth } = queue.shift();

    // Does this directory directly contain eboot.bin?
    if (fs.existsSync(path.join(absPath, 'eboot.bin'))) {
      if (found && found !== absPath) return null; // ambiguous — multiple candidates
      found = absPath;
      continue; // don't descend further from a match
    }

    if (depth < MAX_DEPTH) {
      try {
        for (const e of fs.readdirSync(absPath, { withFileTypes: true })) {
          let isDir = e.isDirectory(); // lstat-based — misses junction points / symlinks
          if (!isDir && !e.isFile()) {
            // Reparse point / junction / symlink — use stat() to follow it
            try { isDir = fs.statSync(path.join(absPath, e.name)).isDirectory(); } catch (_) { isDir = false; }
          }
          if (isDir) queue.push({ absPath: path.join(absPath, e.name), depth: depth + 1 });
        }
      } catch (_) {}
    }
  }

  return found;
}

// Resolve the OSFMount executable: explicit setting, then legacy exfat-tools
// folder (older setups bundled osfmount.com there), then standard install dirs.
function resolveOsfmountPath() {
  const legacyDir = store.get('conv.exfatToolPath', '');
  const candidates = [
    store.get('conv.osfmountPath', ''),
    legacyDir ? path.join(legacyDir, 'osfmount.com') : '',
    'C:\\Program Files\\OSFMount\\osfmount.com',
    'C:\\Program Files (x86)\\OSFMount\\osfmount.com',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return '';
}

// Native exFAT builder — no external make_image.bat / .ps1, only OSFMount.
// Ported from ps5-image-studio's create_exfat.py Windows path.
function convBuildExfatNative(outputFile, inputDir, job, { onData, onProc } = {}) {
  const osfmountPath = resolveOsfmountPath();
  const totalRaw = { v: 0 };
  let copiedBytes = 0;
  return createExfatImage({
    sourceDir:    inputDir,
    outputFile,
    label:        (job && job.game_id) ? job.game_id.slice(0, 15) : 'PS5exfat',
    clusterSize:  store.get('conv.exfatCluster', 0) || null,
    osfmountPath,
    onLog:        (line) => onData?.(line.endsWith('\n') ? line : line + '\n'),
    onProgress:   (p) => {
      if (!job) return;
      if (p.phase) job.progress.phase = p.phase;
      if (p.total) totalRaw.v = p.total;
      if (p.bytes) copiedBytes += p.bytes;
      // Copy phase spans 50→95% of the overall job.
      if (totalRaw.v > 0 && copiedBytes > 0) {
        job.progress.percent = 50 + Math.min(45, Math.round((copiedBytes / totalRaw.v) * 45));
      }
      sendConvJobUpdate(job);
    },
    isCancelled:  () => !!(job && job._cancelled),
    onProc:       (proc) => { if (job) job._activeProc = proc; onProc?.(proc); },
  });
}

// Native FFPFSC (compressed PFS) builder — ports lazy_mkpfs, no external tool.
// ponytail: buildPfs is synchronous and runs on the main process; fine for small
// games but will block the UI on multi-GB dumps — move to a worker_thread if that
// becomes a problem (native-pfs.js is already worker-safe: pure fs/zlib).
function convBuildPfsNative(outputFile, inputDir, job, { onData } = {}) {
  let totalRaw = 0, copied = 0;
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const res = buildPfs({
          sourceDir:  inputDir,
          outputPath: outputFile,
          compress:   true,
          zlibLevel:  store.get('conv.pfscZlibLevel', 6),
          onLog:      (line) => onData?.(line.endsWith('\n') ? line : line + '\n'),
          onProgress: (p) => {
            if (!job) return;
            if (p.phase) job.progress.phase = p.phase;
            if (p.total) totalRaw = p.total;
            if (p.bytes) copied += p.bytes;
            if (totalRaw > 0) job.progress.percent = 50 + Math.min(45, Math.round((copied / totalRaw) * 45));
            sendConvJobUpdate(job);
          },
          isCancelled: () => !!(job && job._cancelled),
        });
        resolve(res);
      } catch (e) { reject(e); }
    });
  });
}

// ── Conversion-specific PS5 notify helper ─────────────────────────────────────
function convPs5Notify(message, sub) {
  if (!store.get('conv.psNotify.enabled', true)) return;
  ps5Notify(message, sub || '');
}

// ── Conversion Job Queue ──────────────────────────────────────────────────────

let convJobIdCounter = 1;
const convJobs       = new Map();
let convIsProcessing = false;
let convQueuePaused  = true;

function setConvQueuePaused(val) {
  convQueuePaused = val;
  win?.webContents.send('conv:queue:paused-change', convQueuePaused);
}

function serializeConvJob(job) {
  return {
    id:             job.id,
    game_id:        job.game_id,
    game_name:      job.game_name,
    mode:           job.mode,
    firmware_label: job.firmware_label,
    output_file:    job.output_file,
    ftpUpload:      job.ftpUpload,
    ftpRemotePath:  job.ftpRemotePath,
    deleteAfter:    job.deleteAfter,
    status:         job.status,
    progress:       { ...job.progress },
    error:          job.error,
    createdAt:      job.createdAt,
    startedAt:      job.startedAt,
    completedAt:    job.completedAt,
  };
}

function sendConvJobUpdate(job) {
  win?.webContents.send('conv:job-update', serializeConvJob(job));
}

function enqueueConvJob({ game_id, game_name, game_path, backpork_path, firmware_label, output_file, mode, ftpUpload, ftpRemotePath, deleteAfter }) {
  const id  = convJobIdCounter++;
  const job = {
    id, game_id, game_name: game_name || game_id, game_path, backpork_path, firmware_label,
    output_file, mode: mode || 'ffpkg',
    ftpUpload:   !!ftpUpload,
    ftpRemotePath: ftpRemotePath || '',
    deleteAfter: !!deleteAfter,
    status:    'queued',
    progress:  { phase: 'Queued', percent: 0, log: [] },
    error:     null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    _cancelled: false,
  };
  convJobs.set(id, job);
  sendConvJobUpdate(job);
  tickConvQueue();
  return id;
}

function tickConvQueue() {
  if (convQueuePaused)   return;
  if (convIsProcessing)  return;
  const next = [...convJobs.values()].find(j => j.status === 'queued');
  if (!next) {
    setConvQueuePaused(true);
    return;
  }
  convIsProcessing = true;
  runConvJob(next).finally(() => {
    convIsProcessing = false;
    tickConvQueue();
  });
}

async function runConvJob(job) {
  job.status    = 'running';
  job.startedAt = Date.now();
  sendConvJobUpdate(job);

  const logLine = (msg) => {
    job.progress.log.push(msg);
    if (job.progress.log.length > 500) job.progress.log.shift();
    sendConvJobUpdate(job);
  };

  const workerBase = store.get('conv.tempDir', '') || os.tmpdir();
  const workerDir  = path.join(workerBase, `pork_conv_${job.id}_${job.game_id}`);

  try {
    // ── Phase 1: Resolve the game root, then copy it to temp worker ───────
    job.progress.phase   = 'Locating game root…';
    job.progress.percent = 3;
    sendConvJobUpdate(job);

    // Verify the source exists and is a directory, not a file backup (.ffpkg etc.)
    let srcStat;
    try { srcStat = fs.statSync(job.game_path); } catch (e) {
      throw new Error(`Game source path not found: ${job.game_path}`);
    }
    if (!srcStat.isDirectory()) {
      throw new Error(
        `Game source is a file, not a folder: ${job.game_path}\n` +
        `ExFAT/FFPKG conversion requires the raw game folder. Select a folder backup, not a .ffpkg or .exfat file.`
      );
    }

    // For ExFAT, find the subfolder that directly contains eboot.bin NOW (in the source),
    // then copy only from that folder — exactly what the standalone ufs2ElectronApp does
    // (its game_path IS already the game root). This handles wrapper layouts like:
    //   game_path/eboot.bin             → copy game_path
    //   game_path/PPSA01234/eboot.bin   → copy game_path/PPSA01234
    // FFPKG mode: UFS2Tool understands the full tree, so always copy game_path directly.
    const isExfat = job.mode === 'exfat';
    let copyFrom = job.game_path;
    if (isExfat) {
      const srcGameRoot = convFindGameRoot(job.game_path);
      if (!srcGameRoot) {
        throw new Error(
          `ExFAT conversion failed: eboot.bin not found in the source game folder (searched up to 5 levels deep).\n` +
          `Source: ${job.game_path}\n` +
          `Ensure the backup folder contains a valid PS5 game structure with eboot.bin.`
        );
      }
      copyFrom = srcGameRoot;
      if (copyFrom !== job.game_path) {
        logLine(`[1/4] Game root detected at: …\\${path.relative(job.game_path, copyFrom)}`);
      }
    }

    job.progress.phase   = 'Copying game — enumerating files…';
    job.progress.percent = 5;
    sendConvJobUpdate(job);
    logLine(`[1/4] Copying game from ${copyFrom}`);
    logLine(`       → ${workerDir}`);
    if (store.get('conv.psNotify.onCopyStart', true))
      convPs5Notify(`${job.game_id} copying`, job.firmware_label ? `Patch: ${job.firmware_label}` : undefined);

    if (job._cancelled) throw new Error('Cancelled');
    fs.mkdirSync(workerDir, { recursive: true });

    let _lastUiMs = 0;
    const throttled = () => {
      const now = Date.now();
      if (now - _lastUiMs >= 100) { _lastUiMs = now; sendConvJobUpdate(job); }
    };

    const cp1 = await convCopyDirWithProgress(copyFrom, workerDir, {
      getCancelled: () => job._cancelled,
      onProgress: ({ index, total, bytesDone, bytesTotal }) => {
        const pct = 5 + Math.round((bytesTotal > 0 ? bytesDone / bytesTotal : index / total) * 30);
        job.progress.phase   = `Copying game — ${index}/${total} files (${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)})`;
        job.progress.percent = pct;
        throttled();
      },
    });
    sendConvJobUpdate(job);
    logLine(`[1/4] Game copy done — ${cp1.files} files, ${fmtBytes(cp1.bytes)}.`);

    // ── Phase 2: Overlay backpork (optional) ──────────────────────────────
    if (job.backpork_path) {
      // Resolve the actual game-patch directory.  Older Porkfolio versions (pre-fix)
      // passed bp.folder_path (the firmware folder, e.g. G:\Backporks\11.50.0) rather
      // than bp.game_path (the game-specific subfolder, e.g. …\11.50.0\PPSA21837-app0).
      // Detect that case by looking for canonical game markers (eboot.bin / sce_sys);
      // if absent the path is probably a parent folder and we find the subfolder with
      // findGameSubfolder() — the same resolution used by the PFS pork upload.
      let patchDir = job.backpork_path;
      const hasPatchMarker = fs.existsSync(path.join(patchDir, 'eboot.bin'))
                          || fs.existsSync(path.join(patchDir, 'sce_sys'));
      if (!hasPatchMarker) {
        const sub = findGameSubfolder(patchDir, job.game_id);
        if (sub) {
          patchDir = path.join(patchDir, sub);
          logLine(`[2/4] Resolved game patch subfolder: …\\${path.relative(job.backpork_path, patchDir)}`);
        } else {
          logLine(`[2/4] Warning: no game-specific subfolder for ${job.game_id} found in ${patchDir} — skipping backpork overlay.`);
          patchDir = null;
        }
      }

      if (patchDir && fs.existsSync(patchDir)) {
        job.progress.phase   = 'Applying backpork — enumerating files…';
        job.progress.percent = 35;
        sendConvJobUpdate(job);
        logLine(`[2/4] Applying backpork from ${patchDir}`);
        if (job._cancelled) throw new Error('Cancelled');
        _lastUiMs = 0;
        const cp2 = await convCopyDirWithProgress(patchDir, workerDir, {
          getCancelled: () => job._cancelled,
          onProgress: ({ index, total, bytesDone, bytesTotal }) => {
            const pct = 35 + Math.round((bytesTotal > 0 ? bytesDone / bytesTotal : index / total) * 15);
            job.progress.phase   = `Applying backpork — ${index}/${total} files (${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)})`;
            job.progress.percent = pct;
            throttled();
          },
        });
        sendConvJobUpdate(job);
        logLine(`[2/4] Backpork overlay done — ${cp2.files} files, ${fmtBytes(cp2.bytes)}.`);
      } else {
        logLine('[2/4] Backpork path not found — skipping overlay.');
        job.progress.percent = 50;
        sendConvJobUpdate(job);
      }
    } else {
      logLine('[2/4] No backpork patch — skipping.');
      job.progress.percent = 50;
      sendConvJobUpdate(job);
    }

    // ── Phase 3: Convert ──────────────────────────────────────────────────
    const isFfpfsc = job.mode === 'ffpfsc';
    const modeLabel = isExfat ? 'ExFAT (native)' : isFfpfsc ? 'FFPFSC (compressed PFS, native)' : `FFPKG (${store.get('conv.ufs2Method', 'makefs')})`;
    job.progress.phase   = `Converting to ${modeLabel}…`;
    job.progress.percent = 50;
    sendConvJobUpdate(job);
    logLine(`[3/4] Converting → ${job.output_file}  [mode: ${job.mode}]`);
    if (store.get('conv.psNotify.onConvertStart', true))
      convPs5Notify(`${job.game_id} converting`, `Mode: ${job.mode.toUpperCase()}`);
    fs.mkdirSync(path.dirname(job.output_file), { recursive: true });
    if (job._cancelled) throw new Error('Cancelled');

    const onData = (chunk) => {
      // Normalise CRLF/CR/LF — same as ufs2ElectronApp so no \n artifacts on Windows bat/PS output
      for (const raw of chunk.split(/\r\n|\r|\n/)) {
        const line = raw.trimEnd();
        if (line) logLine(line);
      }
    };

    if (isExfat) {
      // workerDir was populated by copying from the resolved game root (see Phase 1),
      // so eboot.bin is guaranteed at the root of workerDir — pass it directly,
      // identical to how the standalone ufs2ElectronApp works.
      await convBuildExfatNative(job.output_file, workerDir, job, { onData, onProc: p => { job._activeProc = p; } });
      job._activeProc = null;
    } else if (isFfpfsc) {
      // Native compressed-PFS build — no external tool, no admin required.
      await convBuildPfsNative(job.output_file, workerDir, job, { onData });
    } else {
      let _lastUfs2Ms = 0;
      const onUfs2Progress = ({ toolPct, filesNow, filesTotal, bytesNow, bytesTotal }) => {
        job.progress.percent = 50 + Math.round(toolPct * 0.45);
        job.progress.phase   = `Converting — ${toolPct}% (${filesNow}/${filesTotal} files, ${bytesNow} / ${bytesTotal})`;
        const now = Date.now();
        if (now - _lastUfs2Ms >= 150) { _lastUfs2Ms = now; sendConvJobUpdate(job); }
      };
      const method = store.get('conv.ufs2Method', 'makefs');
      const onProc = p => { job._activeProc = p; };
      if (method === 'newfs') await convNewfsPS5(workerDir, job.output_file, { onData, onProgress: onUfs2Progress, onProc });
      else                    await convMakefPS5(workerDir, job.output_file, { onData, onProgress: onUfs2Progress, onProc });
      job._activeProc = null;
      sendConvJobUpdate(job);
    }
    logLine('[3/4] Conversion done.');

    // ── Phase 4: Cleanup temp ─────────────────────────────────────────────
    job.progress.phase   = 'Cleaning up…';
    job.progress.percent = 95;
    sendConvJobUpdate(job);
    logLine(`[4/4] Removing temp: ${workerDir}`);
    await fs.promises.rm(workerDir, { recursive: true, force: true });
    logLine('[4/4] Temp removed.');

    job.progress.phase   = 'Complete';
    job.progress.percent = 100;
    job.status           = 'done';
    job.completedAt      = Date.now();
    logLine(`✓ Output: ${job.output_file}`);
    if (store.get('conv.psNotify.onJobDone', true))
      convPs5Notify(`${job.game_id} conversion done`, path.basename(job.output_file));
    sendConvJobUpdate(job);

    // ── Optional Phase 5: FTP upload ──────────────────────────────────────
    if (job.ftpUpload && job.ftpRemotePath) {
      if (!ftp.isConnected() && !ftp.hasCredentials()) {
        logLine('⚠ FTP not connected — skipping auto-upload. Upload manually via the Transfers/Install flow.');
        win?.webContents.send('conv:job-upload-skipped', { id: job.id, reason: 'FTP not connected' });
      } else {
        const uploadLabel = `${job.game_id} → PS5 (post-conv)`;
        const outputPath  = job.output_file;
        // ftpRemotePath is the destination directory — append the output filename so
        // the file lands with its proper extension (e.g. PPSA03644.exfat).
        const remoteDest = job.ftpRemotePath.replace(/\/+$/, '') + '/' + path.basename(outputPath);
        logLine(`[5] Queuing FTP upload → ${remoteDest}`);
        const deleteFlag = job.deleteAfter;
        const jobId      = job.id;
        transferMgr.enqueue('upload', {
          label:      uploadLabel,
          localPath:  outputPath,
          remotePath: remoteDest,
        }).then(() => {
          if (deleteFlag) {
            try {
              fs.unlinkSync(outputPath);
              log.info(`[Conv] Deleted converted file after upload: ${outputPath}`);
              win?.webContents.send('conv:job-file-deleted', { id: jobId, output_file: outputPath });
            } catch (e) {
              log.warn(`[Conv] Could not delete file after upload: ${e.message}`);
            }
          }
          convPs5Notify(`${job.game_id} uploaded to PS5`);
        }).catch(e => {
          log.warn(`[Conv] Post-conv upload failed: ${e.message}`);
          win?.webContents.send('conv:job-upload-failed', { id: jobId, error: e.message });
        });
      }
    }

  } catch (e) {
    job.status      = job._cancelled ? 'cancelled' : 'error';
    job.error       = e.message;
    job.completedAt = Date.now();
    logLine(`✗ ${e.message}`);
    if (store.get('conv.psNotify.onJobDone', true) && !job._cancelled)
      convPs5Notify(`${job.game_id} conv failed`, e.message.slice(0, 80));
    try {
      if (fs.existsSync(workerDir))
        await fs.promises.rm(workerDir, { recursive: true, force: true });
    } catch (_) {}
    // Also delete any partial output file the converter may have created
    try { if (job.output_file && fs.existsSync(job.output_file)) fs.unlinkSync(job.output_file); } catch (_) {}
    sendConvJobUpdate(job);
  }
}

// ── Conversion IPC ────────────────────────────────────────────────────────────

ipcMain.handle('conv:tool-info', () => {
  const tp = store.get('conv.ufs2ToolPath', '');
  return {
    toolPath: tp,
    toolAvailable: conversionCapabilities.ufs2 && !!(tp && fs.existsSync(tp)),
    supported: conversionCapabilities.ufs2,
    reason: conversionCapabilities.ufs2 ? '' : conversionCapabilities.reason,
  };
});

ipcMain.handle('conv:exfat-tool-info', () => {
  // ExFAT is built natively on Windows; Linux does not have OSFMount support.
  const osf = resolveOsfmountPath();
  const available = conversionCapabilities.exfat && !!osf;
  return {
    toolPath:      osf || store.get('conv.osfmountPath', '') || store.get('conv.exfatToolPath', ''),
    osfmountPath:  osf,
    // Legacy fields kept so the existing settings UI availability indicator works.
    batAvailable:  available,
    psAvailable:   available,
    toolAvailable: available,
    supported:     conversionCapabilities.exfat,
    reason:        conversionCapabilities.exfat ? '' : conversionCapabilities.reason,
    native:        true,
  };
});

ipcMain.handle('conv:tool-pick', async () => {
  if (!conversionCapabilities.ufs2) throw new Error(conversionCapabilities.reason);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:   'Select UFS2Tool.exe',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (canceled) return null;
  const tp = filePaths[0];
  store.set('conv.ufs2ToolPath', tp);
  return { toolPath: tp, toolAvailable: fs.existsSync(tp) };
});

ipcMain.handle('conv:exfat-tool-pick', async () => {
  if (!conversionCapabilities.exfat) throw new Error(conversionCapabilities.reason);
  // Pick osfmount.com (the only external dependency for native exFAT building).
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:   'Select osfmount.com (from your OSFMount install)',
    filters: [{ name: 'OSFMount CLI', extensions: ['com', 'exe'] }],
    properties: ['openFile'],
  });
  if (canceled) return null;
  const tp = filePaths[0];
  store.set('conv.osfmountPath', tp);
  const available = fs.existsSync(tp);
  return { toolPath: tp, osfmountPath: tp, batAvailable: available, psAvailable: available, toolAvailable: available, native: true };
});

ipcMain.handle('conv:pick-output-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select Output Directory (where .ffpkg / .exfat files are saved)',
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  store.set('conv.outputDir', filePaths[0]);
  return filePaths[0];
});

ipcMain.handle('conv:pick-temp-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select Temp / Worker Directory (needs plenty of free space)',
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  store.set('conv.tempDir', filePaths[0]);
  return filePaths[0];
});

ipcMain.handle('conv:queue:add', (_e, item) => {
  const out    = store.get('conv.outputDir', '') || path.join(os.homedir(), 'Downloads', 'pork-converted');
  const ext    = item.mode === 'exfat' ? '.exfat' : item.mode === 'ffpfsc' ? '.ffpfsc' : '.ffpkg';
  const suffix = item.firmware_label ? `_${item.firmware_label}` : '';
  const outFile = path.join(out, `${item.game_id}${suffix}${ext}`);
  const id = enqueueConvJob({ ...item, output_file: outFile });
  if (store.get('conv.psNotify.onGameQueued', true))
    convPs5Notify(`${item.game_id} queued for conversion`);
  return { id, output_file: outFile };
});

ipcMain.handle('conv:queue:add-batch', (_e, items) => {
  const out = store.get('conv.outputDir', '') || path.join(os.homedir(), 'Downloads', 'pork-converted');
  const ids = items.map(item => {
    const ext     = item.mode === 'exfat' ? '.exfat' : item.mode === 'ffpfsc' ? '.ffpfsc' : '.ffpkg';
    const suffix  = item.firmware_label ? `_${item.firmware_label}` : '';
    const outFile = path.join(out, `${item.game_id}${suffix}${ext}`);
    return enqueueConvJob({ ...item, game_name: item.game_name || item.game_id, output_file: outFile });
  });
  if (items.length === 1 && store.get('conv.psNotify.onGameQueued', true))
    convPs5Notify(`${items[0].game_id} queued for conversion`);
  else if (items.length > 1 && store.get('conv.psNotify.onBatchQueued', true))
    convPs5Notify(`${items.length} games queued for conversion`);
  return ids;
});

ipcMain.handle('conv:queue:list',      () => [...convJobs.values()].map(serializeConvJob));
ipcMain.handle('conv:queue:is-paused', () => convQueuePaused);

ipcMain.handle('conv:queue:start', () => {
  setConvQueuePaused(false);
  tickConvQueue();
  return { ok: true };
});

ipcMain.handle('conv:queue:cancel', (_e, { id }) => {
  const job = convJobs.get(id);
  if (!job) return { success: false };
  job._cancelled = true;
  // Kill an in-flight conversion tool so cancel works mid-spawn (not just at
  // phase boundaries) and doesn't leave the queue blocked on a hung child.
  if (job._activeProc) { convKillProc(job._activeProc); job._activeProc = null; }
  if (job.status === 'queued') {
    job.status = 'cancelled';
    sendConvJobUpdate(job);
  }
  return { success: true };
});

ipcMain.handle('conv:queue:clear-done', () => {
  for (const [id, job] of convJobs) {
    if (['done', 'cancelled', 'error'].includes(job.status)) convJobs.delete(id);
  }
  return [...convJobs.values()].map(serializeConvJob);
});

ipcMain.handle('conv:queue:retry', (_e, { id }) => {
  const old = convJobs.get(id);
  if (!old) return { success: false };
  const newId = enqueueConvJob({
    game_id:        old.game_id,
    game_name:      old.game_name,
    game_path:      old.game_path,
    backpork_path:  old.backpork_path,
    firmware_label: old.firmware_label,
    output_file:    old.output_file,
    mode:           old.mode,
    ftpUpload:      old.ftpUpload,
    ftpRemotePath:  old.ftpRemotePath,
    deleteAfter:    old.deleteAfter,
  });
  return { success: true, newId };
});

ipcMain.handle('conv:queue:cleanup-temp', async () => {
  const workerBase = store.get('conv.tempDir', '') || os.tmpdir();
  let deletedDirs = 0, deletedFiles = 0;
  const errors = [];

  // 1. Remove leftover pork_conv_* scratch directories in the worker base
  try {
    if (fs.existsSync(workerBase)) {
      for (const name of fs.readdirSync(workerBase)) {
        if (/^pork_conv_/.test(name)) {
          const full = path.join(workerBase, name);
          try {
            await fs.promises.rm(full, { recursive: true, force: true });
            deletedDirs++;
          } catch (e) { errors.push(`Could not delete ${full}: ${e.message}`); }
        }
      }
    }
  } catch (e) { errors.push(`Could not scan temp folder: ${e.message}`); }

  // 2. Remove partial output files belonging to errored jobs in the current session
  for (const job of convJobs.values()) {
    if (job.status === 'error' && job.output_file) {
      try {
        if (fs.existsSync(job.output_file)) { fs.unlinkSync(job.output_file); deletedFiles++; }
      } catch (e) { errors.push(`Could not delete ${job.output_file}: ${e.message}`); }
    }
  }

  return { deletedDirs, deletedFiles, errors };
});

};
