'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const cp   = require('child_process');
const net  = require('net');

// ── Paths ─────────────────────────────────────────────────────────────────────

const SETTINGS_FILE = path.join(app.getPath('userData'), 'ufs2app-settings.json');

// Fallback auto-detect: resolves correctly in both dev (electron .) and packaged builds.
// In packaged builds, extraResources land in process.resourcesPath.
function autoDetectToolPath() {
  const exePath = app.isPackaged
    ? path.join(process.resourcesPath, 'UFS2Tool', 'UFS2Tool.exe')
    : path.resolve(__dirname, '..', '..', 'UFS2Tool', 'UFS2Tool.exe');
  return fs.existsSync(exePath) ? exePath : '';
}

function autoDetectExfatToolPath() {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'UFS2imageexfatTools')
    : path.resolve(__dirname, 'UFS2imageexfatTools');
  return fs.existsSync(path.join(dir, 'make_image.bat')) ? dir : '';
}

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  toolPath:        '',       // path to UFS2Tool.exe (FFPKG mode)
  exfatToolPath:   '',       // folder containing make_image.bat + New-OsfExfatImage.ps1
  gameMode:        'ffpkg',  // 'ffpkg' (UFS2Tool → .ffpkg) | 'exfat' (make_image.bat → .exfat)
  tempWorkerDir:   '',       // large drive scratch space
  outputDir:       '',       // where output files go
  gameSources:     [],       // folders containing game directories (PPSA/CUSA)
  backporkRoots:   [],       // root dirs containing firmware-named subfolders
  backporkFolders: [],       // individually added firmware folders {name, path}
  ufs2Method:      'makefs', // 'makefs' | 'newfs'  (FFPKG mode only)
  // ── CustomPSNotify ──────────────────────────────────────────────────────────
  psNotifyEnabled:        false,
  psNotifyIp:             '',
  psNotifyPort:           6969,
  psNotifyOnGameQueued:   true,
  psNotifyOnBatchQueued:  true,
  psNotifyOnCopyStart:    true,
  psNotifyOnConvertStart: true,
  psNotifyOnJobDone:      true,
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
      // Auto-populate tool paths on first run if workspace copies exist
      if (!saved.toolPath)      saved.toolPath      = autoDetectToolPath();
      if (!saved.exfatToolPath) saved.exfatToolPath = autoDetectExfatToolPath();
      return saved;
    }
  } catch (_) {}
  const defaults = { ...DEFAULT_SETTINGS };
  defaults.toolPath      = autoDetectToolPath();
  defaults.exfatToolPath = autoDetectExfatToolPath();
  return defaults;
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

let settings = loadSettings();

// ── Game ID pattern ───────────────────────────────────────────────────────────
// Searches for a PS5/PS4 title ID (4 letters + 5 digits) anywhere within the
// folder name, so any naming convention works:
//   PPSA01234, CUSA12345, PPSA01234-app0, MyGame_PPSA01234_v2, etc.
const GAME_ID_RE = /([A-Z]{4}\d{5})/i;

function extractGameId(name) {
  const m = name.match(GAME_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

// ── Directory helpers ─────────────────────────────────────────────────────────

async function dirSize(dir) {
  let total = 0;
  try {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else { try { total += (await fs.promises.stat(p)).size; } catch (_) {} }
    }
  } catch (_) {}
  return total;
}

function fmtBytes(n) {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

function listSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch (_) { return []; }
}

// Enumerate every file under a directory recursively. Returns [{ src, rel }]
// Uses fs.stat (not lstat) to follow Windows junctions and symlinks — PS5 game
// folders often use junction points for Image0/, Image1/, etc., which Dirent
// reports as non-directory (isSymbolicLink), causing them to be treated as files.
async function collectFiles(dir, base = dir) {
  const results = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Log but don't crash — skip unreadable directories
    console.warn(`[collectFiles] Cannot read directory: ${dir} — ${err.message}`);
    return results;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    // e.isDirectory() is lstat-based — misses junctions, symlinks, and reparse
    // points that point to directories. Only regular files have e.isFile()===true;
    // for everything else (symlinks, junctions, etc.) call fs.stat which follows
    // the link to determine the real type.
    let isDir = e.isDirectory();
    if (!isDir && !e.isFile()) {
      try {
        isDir = (await fs.promises.stat(full)).isDirectory();
      } catch (_) {
        isDir = false;
      }
    }
    if (isDir) {
      results.push(...await collectFiles(full, base));
    } else {
      results.push({ src: full, rel: path.relative(base, full) });
    }
  }
  return results;
}

// Copy srcDir → destDir file-by-file using streams so onProgress fires per chunk,
// not just after each file completes. This prevents the UI from appearing frozen
// while a large file (multi-GB) is mid-copy.
// onProgress({ file, index, total, bytesDone, bytesTotal }) — called on every chunk.
// If getCancelled() returns true, the current stream is destroyed and 'Cancelled' is thrown.
async function copyDirWithProgress(srcDir, destDir, { onProgress, getCancelled } = {}) {
  const files = await collectFiles(srcDir);
  let bytesDone  = 0;
  let bytesTotal = 0;
  const sizes = await Promise.all(files.map(f =>
    fs.promises.stat(f.src).then(s => s.size).catch(() => 0)
  ));
  sizes.forEach(s => { bytesTotal += s; });

  for (let i = 0; i < files.length; i++) {
    if (getCancelled?.()) throw new Error('Cancelled');
    const { src, rel } = files[i];
    const dest = path.join(destDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    // Stream each file so we get chunk-level byte progress
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);

      rs.on('data', chunk => {
        bytesDone += chunk.length;
        onProgress?.({ file: rel, index: i + 1, total: files.length, bytesDone, bytesTotal });
        // Check cancel mid-file — destroy both streams
        if (getCancelled?.()) {
          rs.destroy();
          ws.destroy(new Error('Cancelled'));
        }
      });

      rs.on('error', reject);
      ws.on('error', err => {
        rs.destroy();
        reject(err);
      });
      ws.on('close', resolve);
      rs.pipe(ws);
    });
  }
  return { files: files.length, bytes: bytesDone };
}

// ── Game source scanning ──────────────────────────────────────────────────────
// Returns array of { game_id, source_path, size }
async function scanGameSources(sourceDirs) {
  const games = new Map(); // game_id → entry
  for (const src of sourceDirs) {
    if (!fs.existsSync(src)) continue;
    for (const name of listSubdirs(src)) {
      const game_id = extractGameId(name);
      if (!game_id) continue;
      const full = path.join(src, name);
      const size = await dirSize(full);
      // Keep the largest match — avoids picking a smaller variant (e.g. PPSA12345/)
      // over the full game folder (e.g. PPSA12345_app0/) when both exist in the source.
      const existing = games.get(game_id);
      if (!existing || size > existing.size) {
        games.set(game_id, { game_id, folder_name: name, source_path: full, source_root: src, size });
      }
    }
  }
  return [...games.values()].sort((a, b) => a.game_id.localeCompare(b.game_id));
}

// ── Backpork scanning ─────────────────────────────────────────────────────────
// Returns array of { name, path }
function scanBackporkRoots(roots) {
  const folders = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of listSubdirs(root)) {
      folders.push({ name, path: path.join(root, name) });
    }
  }
  return folders;
}

// Returns games (PPSA/CUSA ids) in a single firmware folder
async function scanBackporkFolder(folderPath) {
  const entries = [];
  for (const name of listSubdirs(folderPath)) {
    const game_id = extractGameId(name);
    if (!game_id) continue;
    const full = path.join(folderPath, name);
    entries.push({ game_id, folder_name: name, path: full, size: await dirSize(full) });
  }
  return entries;
}

// Returns all firmware folders (from roots + manually added) as array of { name, path, games[] }
async function getAllFirmwareFolders() {
  const fromRoots   = scanBackporkRoots(settings.backporkRoots);
  const manual      = settings.backporkFolders || [];
  const seen        = new Set();
  const all         = [];
  for (const f of [...fromRoots, ...manual]) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ ...f, games: await scanBackporkFolder(f.path) });
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

// ── UFS2Tool runner ───────────────────────────────────────────────────────────

function getToolPath() {
  return settings.toolPath || '';
}

function getExfatToolPath() {
  return settings.exfatToolPath || '';
}

// Parse UFS2Tool's verbose progress lines:
//   "  Adding files to image...  89% (68/69 files, 5.31 GiB/5.97 GiB)"
// Returns { toolPct, filesNow, filesTotal, bytesNow, bytesTotal } or null.
const UFS2_PROGRESS_RE = /Adding files to image\.\.\.\s+(\d+)%\s+\((\d+)\/(\d+)\s+files,\s+([\d.]+ \S+)\/([\d.]+ \S+)\)/;
function parseUfs2Progress(text) {
  // UFS2Tool may use \r for in-place overwriting — split on both
  for (const line of text.split(/[\r\n]/)) {
    const m = UFS2_PROGRESS_RE.exec(line);
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

// onProgress: optional callback({ toolPct, filesNow, filesTotal, bytesNow, bytesTotal })
function runUfs2(args, { onData, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const toolPath = getToolPath();
    if (!toolPath || !fs.existsSync(toolPath)) {
      return reject(new Error(
        toolPath
          ? `UFS2Tool not found at: ${toolPath}`
          : 'UFS2Tool path not configured. Set it in Settings first.'
      ));
    }
    const proc = cp.spawn(toolPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out  = [];
    const handleChunk = (d) => {
      const s = d.toString();
      out.push(s);
      onData?.(s);
      const parsed = parseUfs2Progress(s);
      if (parsed) onProgress?.(parsed);
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.on('error', reject);
    proc.on('close', code => {
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`UFS2Tool exited ${code}: ${text.slice(0, 300)}`));
    });
  });
}

// PS5 makefs: UFS2Tool.exe makefs -S 4096 -t ffs -o version=2,minfree=0,softupdates=0,optimization=space <out> <in>
function makefPS5(inputDir, outputFile, { onData, onProgress } = {}) {
  return runUfs2([
    'makefs', '-S', '4096', '-t', 'ffs',
    '-o', 'version=2,minfree=0,softupdates=0,optimization=space',
    outputFile, inputDir,
  ], { onData, onProgress });
}

// PS5 newfs: UFS2Tool.exe newfs -D <dir> <out>
function newfsPS5(inputDir, outputFile, { onData, onProgress } = {}) {
  return runUfs2(['newfs', '-D', inputDir, outputFile], { onData, onProgress });
}

// ── ExFAT image runner ───────────────────────────────────────────────────────
// Run: cmd.exe /c make_image.bat "<outputFile.exfat>" "<sourceDir>"
// Requirements:
//   • New-OsfExfatImage.ps1 must be in the same folder as make_image.bat
//   • OSFMount installed (https://www.osforensics.com/tools/mount-disk-images.html)
//   • Administrator elevation (guaranteed by launch_ufs2electron.bat)
function runExfatTool(outputFile, inputDir, { onData } = {}) {
  return new Promise((resolve, reject) => {
    const toolDir = getExfatToolPath();
    if (!toolDir || !fs.existsSync(toolDir)) {
      return reject(new Error(
        toolDir
          ? `ExFAT tool folder not found: ${toolDir}`
          : 'ExFAT tool folder not configured. Set it in Settings first.'
      ));
    }
    const batPath  = path.join(toolDir, 'make_image.bat');
    const psScript = path.join(toolDir, 'New-OsfExfatImage.ps1');
    if (!fs.existsSync(batPath)) {
      return reject(new Error(`make_image.bat not found in folder: ${toolDir}`));
    }
    if (!fs.existsSync(psScript)) {
      return reject(new Error(
        `New-OsfExfatImage.ps1 not found in folder: ${toolDir}`
      ));
    }
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    // Use cwd=toolDir so we call make_image.bat by its plain relative name —
    // this avoids cmd.exe mis-parsing a space-containing full path.
    // Node.js will quote outputFile/inputDir automatically when they contain spaces.
    const proc = cp.spawn(
      'cmd.exe',
      ['/c', 'make_image.bat', outputFile, inputDir],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd:   toolDir,
      }
    );
    const out = [];
    const handleChunk = (d) => {
      const s = d.toString();
      out.push(s);
      onData?.(s);
      // TODO: parse ExFAT progress lines once format is known
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.on('error', reject);
    proc.on('close', code => {
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`make_image.bat exited ${code}:\n${text.slice(0, 400)}`));
    });
  });
}

// ── PS5 Notifications (CustomPSNotify) ───────────────────────────────────────
// Sends a UTF-8 JSON line over TCP to the PS5's customPSNotify.js payload.
// Fire-and-forget — failures are silently swallowed so they never block jobs.
function sendPSNotify(message, subMessage) {
  if (!settings.psNotifyEnabled) return;
  const ip   = (settings.psNotifyIp || '').trim();
  const port = Number(settings.psNotifyPort) || 6969;
  if (!ip) return;
  try {
    const payload = JSON.stringify(
      subMessage ? { message, subMessage } : { message }
    ) + '\n';
    const client = new net.Socket();
    let closed = false;
    const cleanup = () => { if (!closed) { closed = true; try { client.destroy(); } catch (_) {} } };
    client.setTimeout(3000);
    client.on('timeout', cleanup);
    client.on('error',   cleanup);
    client.on('close',   cleanup);
    client.connect(port, ip, () => {
      client.write(Buffer.from(payload, 'utf8'), () => setTimeout(cleanup, 300));
    });
  } catch (_) {}
}

// ── Job Queue ─────────────────────────────────────────────────────────────────

let jobIdCounter = 1;
const jobs = new Map();  // id → job

/*
  job = {
    id, game_id, game_path, backpork_path, firmware_label, output_file,
    status: 'queued'|'running'|'done'|'error'|'cancelled',
    progress: { phase: string, percent: number, log: string[] },
    createdAt, startedAt, completedAt, error
  }
*/

let isProcessing = false;
let queuePaused   = true;    // waits for user to click "Go!!" before processing begins

function setQueuePaused(val) {
  queuePaused = val;
  win?.webContents?.send('queue:paused-change', queuePaused);
}

function sendJobUpdate(job) {
  win?.webContents?.send('queue:job-update', serializeJob(job));
}

function serializeJob(job) {
  return {
    id:             job.id,
    game_id:        job.game_id,
    firmware_label: job.firmware_label,
    output_file:    job.output_file,
    mode:           job.mode || 'ffpkg',
    status:         job.status,
    progress:       { ...job.progress },
    error:          job.error,
    createdAt:      job.createdAt,
    startedAt:      job.startedAt,
    completedAt:    job.completedAt,
  };
}

function enqueueJob({ game_id, game_path, backpork_path, firmware_label, output_file, mode }) {
  const id  = jobIdCounter++;
  const job = {
    id, game_id, game_path, backpork_path, firmware_label, output_file,
    mode:        mode || 'ffpkg',   // 'ffpkg' | 'exfat'
    status:      'queued',
    progress:    { phase: 'Queued', percent: 0, log: [] },
    error:       null,
    createdAt:   Date.now(),
    startedAt:   null,
    completedAt: null,
    _cancelled:  false,
  };
  jobs.set(id, job);
  sendJobUpdate(job);
  tickQueue();
  return id;
}

function tickQueue() {
  if (queuePaused)   return;
  if (isProcessing)  return;
  const next = [...jobs.values()].find(j => j.status === 'queued');
  if (!next) {
    // Queue drained — re-arm the pause so the next batch needs a Go!! click
    setQueuePaused(true);
    return;
  }
  isProcessing = true;
  runJob(next).finally(() => {
    isProcessing = false;
    tickQueue();
  });
}

async function runJob(job) {
  job.status    = 'running';
  job.startedAt = Date.now();
  sendJobUpdate(job);

  const logLine = (msg) => {
    job.progress.log.push(msg);
    sendJobUpdate(job);
  };

  const workerBase = settings.tempWorkerDir || app.getPath('temp');
  const workerDir  = path.join(workerBase, `ufs2_job_${job.id}_${job.game_id}`);

  try {
    // ── Phase 1: Copy game to temp_worker ─────────────────────────────────
    job.progress.phase   = 'Copying game — enumerating files…';
    job.progress.percent = 5;
    sendJobUpdate(job);
    logLine(`[1/4] Copying game from ${job.game_path}`);
    logLine(`       → ${workerDir}`);
    if (settings.psNotifyOnCopyStart) sendPSNotify(`${job.game_id} started copying`, job.firmware_label ? `Patch: ${job.firmware_label}` : undefined);

    if (job._cancelled) throw new Error('Cancelled');
    fs.mkdirSync(workerDir, { recursive: true });

    // Throttle UI updates to at most once per 100 ms during copy
    let _lastUiMs = 0;
    const throttledUpdate = () => {
      const now = Date.now();
      if (now - _lastUiMs >= 100) { _lastUiMs = now; sendJobUpdate(job); }
    };

    const cp1 = await copyDirWithProgress(job.game_path, workerDir, {
      getCancelled: () => job._cancelled,
      onProgress: ({ index, total, bytesDone, bytesTotal }) => {
        // Phase 1 uses 5—35% of the overall bar; drive by bytes for smooth progress on large files
        const pct = 5 + Math.round((bytesTotal > 0 ? bytesDone / bytesTotal : index / total) * 30);
        job.progress.phase   = `Copying game — ${index}/${total} files (${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)})`;
        job.progress.percent = pct;
        throttledUpdate();
      },
    });
    sendJobUpdate(job);   // ensure final state is always sent
    logLine(`[1/4] Game copy done — ${cp1.files} files, ${fmtBytes(cp1.bytes)}.`);

    // ── Phase 2: Overlay backpork files (skipped if no patch selected) ──────
    if (job.backpork_path) {
      job.progress.phase   = 'Applying backpork — enumerating files…';
      job.progress.percent = 35;
      sendJobUpdate(job);
      logLine(`[2/4] Applying backpork from ${job.backpork_path}`);

      if (job._cancelled) throw new Error('Cancelled');
      _lastUiMs = 0;   // reset throttle for phase 2

      const cp2 = await copyDirWithProgress(job.backpork_path, workerDir, {
        getCancelled: () => job._cancelled,
        onProgress: ({ index, total, bytesDone, bytesTotal }) => {
          // Phase 2 uses 35—50% of the overall bar; drive by bytes for smooth progress
          const pct = 35 + Math.round((bytesTotal > 0 ? bytesDone / bytesTotal : index / total) * 15);
          job.progress.phase   = `Applying backpork — ${index}/${total} files (${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)})`;
          job.progress.percent = pct;
          throttledUpdate();
        },
      });
      sendJobUpdate(job);   // ensure final state is always sent
      logLine(`[2/4] Backpork overlay done — ${cp2.files} files, ${fmtBytes(cp2.bytes)}.`);
    } else {
      logLine('[2/4] No backpork patch — skipping overlay step.');
      job.progress.percent = 50;
      sendJobUpdate(job);
    }

    // ── Phase 3: Image conversion ─────────────────────────────────────────
    const isExfat = job.mode === 'exfat';
    const p3Label = isExfat ? 'ExFAT image (make_image.bat)' : `UFS2 (${settings.ufs2Method})`;
    job.progress.phase   = `Converting to ${p3Label}…`;
    job.progress.percent = 50;
    sendJobUpdate(job);
    logLine(`[3/4] Converting → ${job.output_file}  [mode: ${job.mode}]`);
    if (settings.psNotifyOnConvertStart) sendPSNotify(`${job.game_id} converting to ${job.mode === 'exfat' ? '.exfat' : '.ffpkg'}`, job.firmware_label ? `Patch: ${job.firmware_label}` : undefined);
    fs.mkdirSync(path.dirname(job.output_file), { recursive: true });

    if (job._cancelled) throw new Error('Cancelled');

    const onData = (chunk) => {
      // Normalise CRLF/CR/LF so no leading \n artifacts appear in log entries
      for (const raw of chunk.split(/\r\n|\r|\n/)) {
        const line = raw.trimEnd();
        if (line) logLine(line);
      }
    };

    if (isExfat) {
      // ── ExFAT mode: make_image.bat ──────────────────────────────────────      // make_image.bat requires the source folder to be the game root
      // containing eboot.bin directly. Verify before spawning.
      const ebootPath = path.join(workerDir, 'eboot.bin');
      if (!fs.existsSync(ebootPath)) {
        throw new Error(
          `ExFAT conversion failed: eboot.bin not found in the game root.\n` +
          `Expected: ${ebootPath}\n` +
          `The source game folder must contain eboot.bin at its root (not inside a subfolder).`
        );
      }      await runExfatTool(job.output_file, workerDir, { onData });
      // TODO: parse ExFAT progress lines once output format is known
    } else {
      // ── FFPKG mode: UFS2Tool ────────────────────────────────────────────
      // Parse UFS2Tool's verbose progress and map its 0–100% to bar range 50–95%.
      // UFS2Tool emits: "  Adding files to image...  89% (68/69 files, 5.31 GiB/5.97 GiB)"
      let _lastUfs2Ms = 0;
      const onUfs2Progress = ({ toolPct, filesNow, filesTotal, bytesNow, bytesTotal }) => {
        job.progress.percent = 50 + Math.round(toolPct * 0.45); // 50→95 %
        job.progress.phase   = `Converting — ${toolPct}% (${filesNow}/${filesTotal} files, ${bytesNow} / ${bytesTotal})`;
        const now = Date.now();
        if (now - _lastUfs2Ms >= 150) { _lastUfs2Ms = now; sendJobUpdate(job); }
      };
      if (settings.ufs2Method === 'newfs') {
        await newfsPS5(workerDir, job.output_file, { onData, onProgress: onUfs2Progress });
      } else {
        await makefPS5(workerDir, job.output_file, { onData, onProgress: onUfs2Progress });
      }
      sendJobUpdate(job); // flush final UFS2 state
    }
    logLine(`[3/4] Conversion done.`);

    // ── Phase 4: Cleanup ──────────────────────────────────────────────────
    job.progress.phase   = 'Cleaning up…';
    job.progress.percent = 95;
    sendJobUpdate(job);
    logLine(`[4/4] Removing temp worker: ${workerDir}`);
    await fs.promises.rm(workerDir, { recursive: true, force: true });
    logLine(`[4/4] Done.`);

    job.progress.phase   = 'Complete';
    job.progress.percent = 100;
    job.status           = 'done';
    job.completedAt      = Date.now();
    logLine(`✓ Output: ${job.output_file}`);
    if (settings.psNotifyOnJobDone) sendPSNotify(`${job.game_id} finished`, path.basename(job.output_file));

  } catch (e) {
    job.status    = job._cancelled ? 'cancelled' : 'error';
    job.error     = e.message;
    job.completedAt = Date.now();
    logLine(`✗ ${e.message}`);
    if (settings.psNotifyOnJobDone && !job._cancelled) sendPSNotify(`${job.game_id} failed`, e.message.slice(0, 80));
    // try to clean worker dir even on failure
    try { if (fs.existsSync(workerDir)) await fs.promises.rm(workerDir, { recursive: true, force: true }); } catch (_) {}
    // try to remove any partial output file left by a failed conversion
    try { if (job.output_file && fs.existsSync(job.output_file)) fs.unlinkSync(job.output_file); } catch (_) {}
  }

  sendJobUpdate(job);
}

// ── Window ────────────────────────────────────────────────────────────────────

let win;

function createWindow() {
  win = new BrowserWindow({
    width:  1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color:       '#0f0f0f',
      symbolColor: '#9898d0',
      height:      36,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: Settings ─────────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => ({ ...settings }));

ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  return { ...settings };
});

ipcMain.handle('settings:pick-folder', async (_e, { title }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: title || 'Select Folder',
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
});

// ── IPC: Tool ─────────────────────────────────────────────────────────────────

ipcMain.handle('tool:info', () => {
  const tp = getToolPath();
  return {
    toolPath:      tp,
    toolAvailable: !!(tp && fs.existsSync(tp)),
  };
});

ipcMain.handle('tool:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:   'Select UFS2Tool.exe',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (canceled) return null;
  const p = filePaths[0];
  settings = { ...settings, toolPath: p };
  saveSettings(settings);
  const tp = getToolPath();
  return { toolPath: tp, toolAvailable: !!(tp && fs.existsSync(tp)) };
});

// ── IPC: Game sources ─────────────────────────────────────────────────────────

ipcMain.handle('games:scan', () => scanGameSources(settings.gameSources));

ipcMain.handle('games:add-source', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:      'Add Game Source Folder',
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  const src = filePaths[0];
  if (!settings.gameSources.includes(src)) {
    settings.gameSources.push(src);
    saveSettings(settings);
  }
  return { src, games: await scanGameSources(settings.gameSources) };
});

ipcMain.handle('games:remove-source', (_e, { src }) => {
  settings.gameSources = settings.gameSources.filter(s => s !== src);
  saveSettings(settings);
  return scanGameSources(settings.gameSources);
});

// ── IPC: Backpork / Firmware ──────────────────────────────────────────────────

ipcMain.handle('backporks:list', () => getAllFirmwareFolders());

ipcMain.handle('backporks:add-root', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:      'Add Backpork Root Folder',
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  const root = filePaths[0];
  if (!settings.backporkRoots.includes(root)) {
    settings.backporkRoots.push(root);
    saveSettings(settings);
  }
  return getAllFirmwareFolders();
});

ipcMain.handle('backporks:remove-root', (_e, { root }) => {
  settings.backporkRoots = settings.backporkRoots.filter(r => r !== root);
  saveSettings(settings);
  return getAllFirmwareFolders();
});

ipcMain.handle('backporks:add-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:      'Add Firmware Folder (e.g. "11.50.0")',
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  const p    = filePaths[0];
  const name = path.basename(p);
  const already = settings.backporkFolders.some(f => f.path.toLowerCase() === p.toLowerCase());
  if (!already) {
    settings.backporkFolders.push({ name, path: p });
    saveSettings(settings);
  }
  return getAllFirmwareFolders();
});

ipcMain.handle('backporks:remove-folder', (_e, { folderPath }) => {
  settings.backporkFolders = settings.backporkFolders.filter(
    f => f.path.toLowerCase() !== folderPath.toLowerCase()
  );
  saveSettings(settings);
  return getAllFirmwareFolders();
});

ipcMain.handle('backporks:scan-folder', (_e, { folderPath }) => scanBackporkFolder(folderPath));

// ── IPC: Queue ────────────────────────────────────────────────────────────────

ipcMain.handle('queue:list',      () => [...jobs.values()].map(serializeJob));
ipcMain.handle('queue:is-paused', () => queuePaused);
ipcMain.handle('queue:start',     () => { setQueuePaused(false); tickQueue(); return { ok: true }; });

ipcMain.handle('queue:add', (_e, { game_id, game_path, backpork_path, firmware_label }) => {
  const out     = settings.outputDir || path.join(app.getPath('downloads'), 'ufs2-output');
  const ext     = settings.gameMode === 'exfat' ? '.exfat' : '.ffpkg';
  const suffix  = firmware_label ? `_${firmware_label}` : '';
  const outFile = path.join(out, `${game_id}${suffix}${ext}`);
  const id = enqueueJob({ game_id, game_path, backpork_path, firmware_label, output_file: outFile, mode: settings.gameMode });
  if (settings.psNotifyOnGameQueued) sendPSNotify(`${game_id} added to queue`);
  return { id, output_file: outFile };
});

ipcMain.handle('queue:add-batch', (_e, items) => {
  // items = [{ game_id, game_path, backpork_path?, firmware_label?, mode? }, ...]
  // item.mode (from the renderer's inline selector) takes precedence over the global setting
  const out = settings.outputDir || path.join(app.getPath('downloads'), 'ufs2-output');
  const ids = items.map(item => {
    const jobMode = item.mode || settings.gameMode || 'ffpkg';
    const ext     = jobMode === 'exfat' ? '.exfat' : '.ffpkg';
    const suffix  = item.firmware_label ? `_${item.firmware_label}` : '';
    const outFile = path.join(out, `${item.game_id}${suffix}${ext}`);
    return enqueueJob({ ...item, output_file: outFile, mode: jobMode });
  });
  // ── Queue notifications ───────────────────────────────────────────────────
  if (items.length === 1 && settings.psNotifyOnGameQueued) {
    sendPSNotify(`${items[0].game_id} added to queue`);
  } else if (items.length > 1 && settings.psNotifyOnBatchQueued) {
    sendPSNotify(`${items.length} items added to queue`);
  }
  return ids;
});

ipcMain.handle('queue:cancel', (_e, { id }) => {
  const job = jobs.get(id);
  if (!job) return { success: false };
  job._cancelled = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    sendJobUpdate(job);
  }
  return { success: true };
});

ipcMain.handle('queue:clear-done', () => {
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'cancelled' || job.status === 'error') {
      jobs.delete(id);
    }
  }
  return [...jobs.values()].map(serializeJob);
});

ipcMain.handle('queue:retry', (_e, { id }) => {
  const old = jobs.get(id);
  if (!old) return { success: false };
  const newId = enqueueJob({
    game_id:        old.game_id,
    game_path:      old.game_path,
    backpork_path:  old.backpork_path,
    firmware_label: old.firmware_label,
    output_file:    old.output_file,
    mode:           old.mode || 'ffpkg',
  });
  return { success: true, newId };
});

ipcMain.handle('queue:cleanup-temp', async () => {
  const workerBase = settings.tempWorkerDir || app.getPath('temp');
  let deletedDirs = 0, deletedFiles = 0;
  const errors = [];

  // 1. Remove any leftover ufs2_job_* scratch directories in the worker base
  try {
    if (fs.existsSync(workerBase)) {
      for (const name of fs.readdirSync(workerBase)) {
        if (/^ufs2_job_/.test(name)) {
          const full = path.join(workerBase, name);
          try {
            await fs.promises.rm(full, { recursive: true, force: true });
            deletedDirs++;
          } catch (e) { errors.push(`Could not delete ${full}: ${e.message}`); }
        }
      }
    }
  } catch (e) { errors.push(`Could not scan temp folder: ${e.message}`); }

  // 2. Remove partial output files belonging to errored jobs
  for (const job of jobs.values()) {
    if (job.status === 'error' && job.output_file) {
      try {
        if (fs.existsSync(job.output_file)) {
          fs.unlinkSync(job.output_file);
          deletedFiles++;
        }
      } catch (e) { errors.push(`Could not delete ${job.output_file}: ${e.message}`); }
    }
  }

  return { deletedDirs, deletedFiles, errors };
});

// ── IPC: Open paths in explorer ───────────────────────────────────────────────

ipcMain.handle('shell:open-path', (_e, { p })   => { shell.openPath(p); });
ipcMain.handle('shell:open-url',  (_e, { url }) => { shell.openExternal(url); });

// ── IPC: Notifications ────────────────────────────────────────────────────────
ipcMain.handle('notify:test', () => {
  const ip   = (settings.psNotifyIp || '').trim();
  const port = Number(settings.psNotifyPort) || 6969;
  if (!settings.psNotifyEnabled || !ip) return { ok: false, reason: 'Not enabled or no IP set' };
  return new Promise(resolve => {
    try {
      const payload = JSON.stringify({ message: 'Shadowbatch connected!', subMessage: 'CustomPSNotify is working.' }) + '\n';
      const client = new net.Socket();
      let responded = false;
      const finish = (ok, reason) => {
        if (!responded) { responded = true; try { client.destroy(); } catch (_) {} resolve({ ok, reason }); }
      };
      client.setTimeout(3000);
      client.on('timeout', () => finish(false, 'Connection timed out'));
      client.on('error',   err => finish(false, err.message));
      client.on('data', () => finish(true, null));
      client.connect(port, ip, () => {
        client.write(Buffer.from(payload, 'utf8'), () => setTimeout(() => finish(true, null), 400));
      });
    } catch (err) {
      resolve({ ok: false, reason: err.message });
    }
  });
});
// ── IPC: ExFAT Tool ─────────────────────────────────────────────────────

ipcMain.handle('exfat:tool-info', () => {
  const tp      = getExfatToolPath();
  const batPath = tp ? path.join(tp, 'make_image.bat')           : '';
  const psPath  = tp ? path.join(tp, 'New-OsfExfatImage.ps1')   : '';
  return {
    toolPath:      tp,
    batAvailable:  !!(batPath && fs.existsSync(batPath)),
    psAvailable:   !!(psPath  && fs.existsSync(psPath)),
    toolAvailable: !!(batPath && fs.existsSync(batPath) && psPath && fs.existsSync(psPath)),
  };
});

ipcMain.handle('exfat:tool-pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:      'Select ExFAT Tools Folder (containing make_image.bat)',
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  const tp      = filePaths[0];
  const batPath = path.join(tp, 'make_image.bat');
  const psPath  = path.join(tp, 'New-OsfExfatImage.ps1');
  settings = { ...settings, exfatToolPath: tp };
  saveSettings(settings);
  return {
    toolPath:      tp,
    batAvailable:  fs.existsSync(batPath),
    psAvailable:   fs.existsSync(psPath),
    toolAvailable: fs.existsSync(batPath) && fs.existsSync(psPath),
  };
});