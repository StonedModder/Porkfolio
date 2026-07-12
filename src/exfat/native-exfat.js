'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Native exFAT image builder (Windows)
//
// A pure Node.js port of ps5-image-studio's lazy_mkpfs/create_exfat.py Windows
// path — no external .bat/.ps1 scripts and no Python. The only external
// dependency is OSFMount (osfmount.com), a kernel mount driver, because Windows
// cannot format a raw exFAT image from userland without mounting it.
//
// Pipeline:
//   1. calculateExfatSize()  — walk source, compute image size + cluster
//   2. fsutil file createnew — allocate the raw image
//   3. osfmount -a           — mount the raw image as a drive letter (rw)
//   4. format /FS:exFAT      — quick-format the mounted volume
//   5. streamed parallel copy — copy the game folder into the mounted volume
//   6. osfmount -d           — unmount (retry, Windows is slow to release locks)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MB = 1024 * 1024;

// ── Sizing (ported 1:1 from calculate_exfat_size) ────────────────────────────
function calculateExfatSize(source, forceCluster) {
  let clusterSize = forceCluster || 65536; // 64K default, matches PS5 exFAT
  let totalRaw = 0, totalAlloc = 0, fileCount = 0, dirCount = 0;

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirCount++; walk(full); }
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        totalRaw += size;
        totalAlloc += Math.ceil(size / clusterSize) * clusterSize;
        fileCount++;
      }
    }
  };
  walk(source);

  const dataClusters = Math.ceil(totalAlloc / clusterSize);
  const fatBytes     = dataClusters * 4;
  const bitmapBytes  = Math.ceil(dataClusters / 8);
  const entryBytes   = (fileCount + dirCount) * 256;
  const metaFixed    = 32 * MB;

  const baseTotal = totalAlloc + fatBytes + bitmapBytes + entryBytes + metaFixed;
  let spare = Math.floor(baseTotal / 200);
  spare = Math.max(spare, 64 * MB);
  spare = Math.min(spare, 512 * MB);

  let total = baseTotal + spare;
  total = Math.max(total, totalRaw + 64 * MB);

  const sizeMb = Math.ceil(total / MB);
  return { sizeMb, clusterSize, totalRaw, fileCount };
}

// ── Small process helpers ────────────────────────────────────────────────────
function run(cmd, args, { cwd, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, windowsHide: true });
    onProc?.(proc);
    const out = [];
    proc.stdout.on('data', d => out.push(d.toString()));
    proc.stderr.on('data', d => out.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${text.slice(0, 400)}`));
    });
  });
}

function resolveOsfmount(configured) {
  const candidates = [
    configured,
    'C:\\Program Files\\OSFMount\\osfmount.com',
    'C:\\Program Files (x86)\\OSFMount\\osfmount.com',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

function freeDriveLetter() {
  const used = new Set();
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (fs.existsSync(`${l}:\\`)) used.add(l);
  }
  for (const l of 'FGHIJKLMNOPQRSTUVWXYZ') { if (!used.has(l)) return l; }
  throw new Error('No free drive letters available for mounting.');
}

// Windows `format` rejects raw byte /A: values at this size and wants K/M.
function allocArg(clusterSize) {
  return clusterSize % MB === 0 ? `${clusterSize / MB}M` : `${clusterSize / 1024}K`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Streamed parallel copy into the mounted volume ───────────────────────────
async function copyTree(source, destRoot, { onProgress, isCancelled, onProc } = {}) {
  // Collect dirs (to pre-create) and files (to copy).
  const dirs = [];
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r    = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirs.push(r); walk(full, r); }
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        files.push({ src: full, rel: r, size });
      }
    }
  };
  walk(source, '');

  for (const d of dirs) fs.mkdirSync(path.join(destRoot, d), { recursive: true });

  let copiedFiles = 0;
  const copyOne = (file) => new Promise((resolve, reject) => {
    if (isCancelled?.()) return reject(new Error('Cancelled'));
    const dst = path.join(destRoot, file.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const rs = fs.createReadStream(file.src, { highWaterMark: 8 * MB });
    const ws = fs.createWriteStream(dst);
    onProc?.({ kill: () => { rs.destroy(); ws.destroy(); } }); // let cancel tear down the active stream
    let cancelled = false;
    rs.on('data', chunk => {
      onProgress?.({ bytes: chunk.length, file: file.rel });
      if (isCancelled?.() && !cancelled) { cancelled = true; rs.destroy(); ws.destroy(); reject(new Error('Cancelled')); }
    });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => { copiedFiles++; onProgress?.({ files: 1 }); resolve(); });
    rs.pipe(ws);
  });

  // Bounded concurrency pool.
  const concurrency = Math.min(Math.max(os.cpus().length, 2), 8);
  let idx = 0;
  const worker = async () => {
    while (idx < files.length) {
      if (isCancelled?.()) throw new Error('Cancelled');
      const file = files[idx++];
      await copyOne(file);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { copiedFiles, totalFiles: files.length };
}

// ── Main entry ───────────────────────────────────────────────────────────────
// opts: { sourceDir, outputFile, label, clusterSize, osfmountPath,
//         onLog(str), onProgress({bytes,files,file,phase}), isCancelled(), onProc(proc) }
async function createExfatImage(opts) {
  if (process.platform !== 'win32') {
    throw new Error('Native exFAT builder currently supports Windows only.');
  }
  const {
    sourceDir, outputFile, label = 'PS5exfat', clusterSize = null,
    osfmountPath = '', onLog = () => {}, onProgress = () => {}, isCancelled = () => false, onProc,
  } = opts;

  const source = path.resolve(sourceDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Source folder does not exist: ${source}`);
  }
  const osfmount = resolveOsfmount(osfmountPath);
  if (!osfmount) {
    throw new Error('OSFMount not found. Install OSFMount and set its path in Settings → Game Conversion.');
  }

  let output = path.resolve(outputFile);
  if (path.extname(output).toLowerCase() !== '.exfat') output += '.exfat';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) fs.unlinkSync(output);

  onProgress({ phase: 'Analyzing folder…' });
  const { sizeMb, clusterSize: cluster, totalRaw, fileCount } = calculateExfatSize(source, clusterSize);
  onLog(`Analyzing: ${fileCount} files, ${(totalRaw / MB).toFixed(1)} MB`);
  onLog(`Target image: ${sizeMb} MB (cluster ${cluster / 1024}K)`);

  const sizeBytes = sizeMb * MB;
  let mounted = false;
  let driveLetter = null;
  const mountPoint = () => `${driveLetter}:`;

  try {
    // 1. Allocate raw image
    onProgress({ phase: 'Allocating image…', total: totalRaw });
    onLog(`Creating raw image (${(sizeBytes / MB).toFixed(0)} MB)…`);
    await run('fsutil', ['file', 'createnew', output, String(sizeBytes)], { onProc });
    const actual = fs.statSync(output).size;
    if (actual !== sizeBytes) throw new Error(`Image size mismatch: expected ${sizeBytes}, got ${actual}`);
    if (isCancelled()) throw new Error('Cancelled');

    // 2. Mount via OSFMount
    driveLetter = freeDriveLetter();
    onProgress({ phase: `Mounting as ${mountPoint()}…` });
    onLog(`Mounting raw image as ${mountPoint()} via OSFMount…`);
    await run(osfmount, ['-a', '-t', 'file', '-f', output, '-m', mountPoint(), '-o', 'rw'], { onProc });
    mounted = true;
    if (isCancelled()) throw new Error('Cancelled');

    // 3. Format as exFAT (quick). `format` is a .com that prompts even with /Y —
    //    wrap in cmd.exe and feed newlines to stdin, mirroring the reference tool.
    onProgress({ phase: 'Formatting exFAT…' });
    onLog(`Formatting ${mountPoint()} as exFAT (cluster ${allocArg(cluster)}, label '${label}')…`);
    await new Promise((resolve, reject) => {
      const fmt = spawn('cmd.exe',
        ['/c', 'format', mountPoint(), '/FS:exFAT', '/Q', '/Y', `/A:${allocArg(cluster)}`, `/V:${label}`],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      onProc?.(fmt);
      const out = [];
      fmt.stdout.on('data', d => out.push(d.toString()));
      fmt.stderr.on('data', d => out.push(d.toString()));
      try { fmt.stdin.write('\n\n\n'); fmt.stdin.end(); } catch {}
      fmt.on('error', reject);
      fmt.on('close', code => code === 0
        ? resolve()
        : reject(new Error(`format /FS:exFAT failed (rc=${code}): ${out.join('').slice(0, 300)}`)));
    });
    if (isCancelled()) throw new Error('Cancelled');

    // 4. Copy files into the mounted volume root (needs trailing separator).
    onProgress({ phase: 'Copying files…', total: totalRaw });
    onLog(`Copying ${fileCount} files (${(totalRaw / MB).toFixed(1)} MB)…`);
    const destRoot = `${driveLetter}:\\`;
    await copyTree(source, destRoot, { onProgress, isCancelled, onProc });
    onLog('Copy complete.');
  } catch (err) {
    // Clean up partial output on failure (after unmount below).
    throw err;
  } finally {
    // 5. Unmount, retrying — Windows is slow to release volume locks.
    if (mounted && driveLetter) {
      onLog('Syncing and unmounting…');
      let ok = false;
      for (let i = 0; i < 5; i++) {
        try { await run(osfmount, ['-d', '-m', mountPoint()], {}); ok = true; break; }
        catch { await sleep(1000); }
      }
      if (!ok) onLog('⚠ OSFMount unmount failed (volume may be locked by another process).');
    }
  }

  // Remove the image if the build was cancelled/failed partway.
  if (isCancelled()) {
    try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
    throw new Error('Cancelled');
  }

  onLog(`✅ Created exFAT image: ${output}`);
  return { output, sizeMb, cluster, totalRaw, fileCount };
}

module.exports = { createExfatImage, calculateExfatSize };

// Self-check for the sizing math: node src/exfat/native-exfat.js --selfcheck
if (require.main === module && process.argv.includes('--selfcheck')) {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exfat-sc-'));
  fs.writeFileSync(path.join(tmp, 'a.bin'), Buffer.alloc(1 * MB));
  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.writeFileSync(path.join(tmp, 'sub', 'b.bin'), Buffer.alloc(3 * MB));
  const r = calculateExfatSize(tmp, null);
  assert.strictEqual(r.fileCount, 2, 'fileCount');
  assert.strictEqual(r.totalRaw, 4 * MB, 'totalRaw');
  assert.strictEqual(r.clusterSize, 65536, 'default cluster 64K');
  assert.ok(r.sizeMb >= Math.ceil((4 * MB + 64 * MB) / MB), 'size >= raw + 64MB floor');
  assert.strictEqual(allocArg(65536), '64K');
  assert.strictEqual(allocArg(1 * MB), '1M');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('native-exfat selfcheck OK:', r);
}
