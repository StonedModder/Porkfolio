'use strict';

/**
 * ufs2Core.js — UFS2Tool.exe wrapper for Node.js / Electron main process
 * ==========================================================================
 * All public functions are pure Node.js (no Electron dependency) so the
 * module can be tested standalone with just `node test.js`.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠  ADMINISTRATOR REQUIRED                                          ║
 * ║  UFS2Tool.exe calls low-level filesystem drivers that require       ║
 * ║  Windows Administrator privileges.  Without elevation, cp.spawn()   ║
 * ║  will throw EACCES and the process will never start.                ║
 * ║                                                                     ║
 * ║  In production: build your Electron app with                        ║
 * ║    requestedExecutionLevel: requireAdministrator                    ║
 * ║  in the nsis/win electron-builder config.                           ║
 * ║  In dev: right-click your launch script → "Run as administrator",  ║
 * ║  or use a .bat that calls `net session` + `Start-Process -Verb RunAs`║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Entry points
 * ─────────────
 *  Single operations:
 *   makefs(inputDir, outputFile, opts?)   → Promise<RunResult>
 *   newfs(inputDir, outputFile, opts?)    → Promise<RunResult>
 *   extract(imageFile, outputDir, opts?)  → Promise<RunResult>
 *   info(imageFile)                       → Promise<RunResult>
 *   ls(imageFile, fsPath?)                → Promise<RunResult>
 *   fsck(imageFile, opts?)                → Promise<RunResult>
 *
 *  PS5 convenience presets (common flags already wired in):
 *   makefsPS5(inputDir, outputFile, opts?) → Promise<RunResult>
 *   newfsPS5(inputDir, outputFile, opts?)  → Promise<RunResult>
 *
 *  Batch operations (return BatchResult, accept onProgress callback):
 *   batchMakefs(entries, opts?)    → Promise<BatchResult>
 *   batchNewfs(entries, opts?)     → Promise<BatchResult>
 *   batchExtract(entries, opts?)   → Promise<BatchResult>
 *
 *  Tool management:
 *   setToolPath(absPath)           → void
 *   getToolPath()                  → string
 *   toolAvailable()                → boolean
 *   moduleInfo()                   → { version, toolPath, toolAvailable }
 *
 * RunResult  { ok, stdout, stderr, exitCode, durationMs }
 * BatchResult{ results: RunResult[], succeeded, failed, durationMs }
 *
 * opts for single ops:
 *   extraFlags  {string[]}  Extra CLI flags to append, e.g. ['-b', '32768']
 *   timeout     {number}    Process timeout in ms (default: 120 000)
 *   fsOptions   {string}    -o key=value,…  string for makefs
 *   sectorSize  {string}    -S value for makefs (default: '4096')
 *   outputName  {string}    Override output filename stem (batch helpers)
 *
 * opts for batch ops (all the above plus):
 *   onProgress  {function}  (current, total, entry, result) → void
 *   stopOnError {boolean}   Stop batch on first failure (default: false)
 */

const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');
const EventEmitter = require('events');

const pkg = require('../package.json');

// ---------------------------------------------------------------------------
// Tool path resolution
// ---------------------------------------------------------------------------

// Default: two levels up from src/ → project root → UFS2Tool/UFS2Tool.exe
//   src/ufs2ElectronModule/src/ufs2Core.js  →  ../../..  = project root
const DEFAULT_TOOL_PATH = path.resolve(
  __dirname, '..', '..', '..', 'UFS2Tool', 'UFS2Tool.exe'
);

let _toolPath = DEFAULT_TOOL_PATH;

/** Override the UFS2Tool.exe path at runtime. */
function setToolPath(absPath) {
  _toolPath = absPath;
}

/** Returns the currently configured UFS2Tool.exe path. */
function getToolPath() {
  return _toolPath;
}

/** Returns true if UFS2Tool.exe exists at the configured path. */
function toolAvailable() {
  try { fs.accessSync(_toolPath, fs.constants.F_OK); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

/**
 * Spawn UFS2Tool.exe with the given args.
 *
 * ⚠ ADMINISTRATOR REQUIRED — UFS2Tool.exe will fail with EACCES if the
 *   calling process is not running as Administrator. See the warning block
 *   at the top of this file for how to elevate your Electron app.
 *
 * @param {string[]} args
 * @param {{ timeout?: number, onData?: function, onProgress?: function }} [runOpts]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, exitCode: number, durationMs: number }>}
 */

// Parse UFS2Tool's verbose progress lines:
//   "  Adding files to image...  89% (68/69 files, 5.31 GiB/5.97 GiB)"
// Returns { toolPct, filesNow, filesTotal, bytesNow, bytesTotal } or null.
const UFS2_PROGRESS_RE = /Adding files to image\.\.\.\s+(\d+)%\s+\((\d+)\/(\d+)\s+files,\s+([\d.]+ \S+)\/([\d.]+ \S+)\)/;
function parseUfs2Progress(text) {
  // UFS2Tool may use \r for in-place overwriting — scan every segment
  for (const seg of text.split(/[\r\n]/)) {
    const m = UFS2_PROGRESS_RE.exec(seg);
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

function runTool(args, runOpts = {}) {
  const timeout = runOpts.timeout ?? DEFAULT_TIMEOUT;
  const t0      = Date.now();

  return new Promise((resolve) => {
    let stdout   = '';
    let stderr   = '';
    let settled  = false;
    let timedOut = false;

    if (!toolAvailable()) {
      return resolve({
        ok: false,
        stdout: '',
        stderr: `UFS2Tool.exe not found at: ${_toolPath}`,
        exitCode: -1,
        durationMs: 0,
      });
    }

    const proc = spawn(_toolPath, args, {
      windowsHide: true,
    });

    const timer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
        }, timeout)
      : null;

    const _handleChunk = (stream, chunk) => {
      const s = chunk.toString();
      if (stream === 'stdout') stdout += s; else stderr += s;
      runOpts.onData?.(s);
      const parsed = parseUfs2Progress(s);
      if (parsed) runOpts.onProgress?.(parsed);
    };
    proc.stdout.on('data', (chunk) => _handleChunk('stdout', chunk));
    proc.stderr.on('data', (chunk) => _handleChunk('stderr', chunk));

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const exitCode   = timedOut ? -2 : (code ?? -1);
      const stderrFull = timedOut
        ? 'Process timed out and was killed.\n' + stderr
        : stderr;
      resolve({
        ok:         !timedOut && exitCode === 0,
        stdout:     stdout.trim(),
        stderr:     stderrFull.trim(),
        exitCode,
        durationMs: Date.now() - t0,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // ⚠ EACCES here almost always means the process is NOT running as Administrator.
      //   UFS2Tool.exe requires elevation — see the warning block at the top of this file.
      resolve({
        ok:         false,
        stdout:     stdout.trim(),
        stderr:     err.code === 'EACCES'
          ? `EACCES: UFS2Tool.exe requires Administrator privileges. Run your Electron app elevated. (${err.message})`
          : err.message,
        exitCode:   -1,
        durationMs: Date.now() - t0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

function extraFlagsFrom(opts) {
  return Array.isArray(opts?.extraFlags) ? opts.extraFlags : [];
}

// ---------------------------------------------------------------------------
// Single operations
// ---------------------------------------------------------------------------

/**
 * makefs — create UFS image from a directory tree.
 *
 * @param {string} inputDir   Source directory to pack
 * @param {string} outputFile Destination image path (.ffpkg / .img)
 * @param {{ sectorSize?: string, fsOptions?: string, extraFlags?: string[], timeout?: number }} [opts]
 */
async function makefs(inputDir, outputFile, opts = {}) {
  const sectorSize = opts.sectorSize ?? '512';
  const fsOptions  = opts.fsOptions  ?? 'version=1';
  const args = [
    'makefs',
    '-S', sectorSize,
    '-t', 'ffs',
    '-o', fsOptions,
    ...extraFlagsFrom(opts),
    outputFile,
    inputDir,
  ];
  return runTool(args, opts);
}

/**
 * newfs — create UFS image and populate from a directory (-D flag).
 *
 * @param {string} inputDir   Directory to copy into the image (auto-sizes)
 * @param {string} outputFile Destination image path
 * @param {{ extraFlags?: string[], timeout?: number }} [opts]
 */
async function newfs(inputDir, outputFile, opts = {}) {
  const args = [
    'newfs',
    '-D', inputDir,
    ...extraFlagsFrom(opts),
    outputFile,
  ];
  return runTool(args, opts);
}

/**
 * makefsPS5 — PS5/ShadowMount-compatible image via makefs.
 *
 * Hard-wires the flags from the official PS5 Quick Start:
 *   makefs -S 4096 -t ffs -o version=2,minfree=0,softupdates=0,optimization=space
 *
 * @param {string} inputDir
 * @param {string} outputFile
 * @param {{ extraFlags?: string[], timeout?: number }} [opts]
 */
async function makefsPS5(inputDir, outputFile, opts = {}) {
  const args = [
    'makefs',
    '-S', '4096',
    '-t', 'ffs',
    '-o', 'version=2,minfree=0,softupdates=0,optimization=space',
    ...extraFlagsFrom(opts),
    outputFile,
    inputDir,
  ];
  return runTool(args, opts);
}

/**
 * newfsPS5 — PS5/ShadowMount-compatible image via newfs -D.
 *
 * @param {string} inputDir
 * @param {string} outputFile
 * @param {{ extraFlags?: string[], timeout?: number }} [opts]
 */
async function newfsPS5(inputDir, outputFile, opts = {}) {
  const args = [
    'newfs',
    '-D', inputDir,
    ...extraFlagsFrom(opts),
    outputFile,
  ];
  return runTool(args, opts);
}

/**
 * extract — extract files from a UFS image to a directory.
 *
 * @param {string}  imageFile   Source image path
 * @param {string}  outputDir   Destination directory (will be created if absent)
 * @param {{ fsPath?: string, extraFlags?: string[], timeout?: number }} [opts]
 */
async function extract(imageFile, outputDir, opts = {}) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const args = [
    'extract',
    imageFile,
    outputDir,
    ...extraFlagsFrom(opts),
  ];
  if (opts.fsPath) args.push(opts.fsPath);
  return runTool(args, opts);
}

/**
 * info — print filesystem superblock information.
 *
 * @param {string} imageFile
 * @param {{ timeout?: number }} [opts]
 */
async function info(imageFile, opts = {}) {
  return runTool(['info', imageFile], opts);
}

/**
 * ls — list directory contents inside a UFS image.
 *
 * @param {string}  imageFile
 * @param {string}  [fsPath='/']  Path inside the image
 * @param {{ timeout?: number }} [opts]
 */
async function ls(imageFile, fsPath, opts = {}) {
  const args = ['ls', imageFile];
  if (fsPath) args.push(fsPath);
  return runTool(args, opts);
}

/**
 * fsck — run a filesystem consistency check.
 *
 * @param {string}  imageFile
 * @param {{ mode?: 'preen'|'readonly'|'force', extraFlags?: string[], timeout?: number }} [opts]
 */
async function fsck(imageFile, opts = {}) {
  let modeFlag = '-p'; // preen default
  if (opts.mode === 'readonly') modeFlag = '-n';
  if (opts.mode === 'force')    modeFlag = '-fy';
  const args = ['fsck_ufs', modeFlag, ...extraFlagsFrom(opts), imageFile];
  return runTool(args, opts);
}

// ---------------------------------------------------------------------------
// ── Workflow helpers (used by runPorkJob and available for external use) ─────
// ---------------------------------------------------------------------------

/**
 * Matches PS5/PS4 game IDs in folder names:
 *   PPSA01234, CUSA12345, PPSA01234-app, PPSA01234_app0
 * Capture group 1 is the canonical 9-char game ID (e.g. PPSA01234).
 */
const GAME_ID_RE = /^([A-Z]{4}\d{5})(?:[_\-]app\d*)?$/i;

/**
 * Extract the canonical game ID from a folder name, or null.
 * @param {string} name  Folder name e.g. "PPSA24473-app"
 * @returns {string|null}
 */
function extractGameId(name) {
  const m = name.match(GAME_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Human-readable byte size string.
 * @param {number} n
 * @returns {string}
 */
function fmtBytes(n) {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * Recursively compute total byte size of a directory tree.
 * @param {string} dir
 * @returns {Promise<number>}
 */
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

/**
 * Recursively enumerate every file under `dir`.
 * @param {string} dir
 * @param {string} [base]  Root used to compute `rel`. Defaults to `dir`.
 * @returns {Promise<Array<{ src: string, rel: string }>>}
 */
async function collectFiles(dir, base = dir) {
  const results = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...await collectFiles(full, base));
    } else {
      results.push({ src: full, rel: path.relative(base, full) });
    }
  }
  return results;
}

/**
 * Copy srcDir → destDir, one file at a time, calling onProgress after each.
 *
 * Progress callback receives:
 *   { file: string, index: number, total: number, bytesDone: number, bytesTotal: number }
 *
 * If getCancelled() returns true, throws new Error('Cancelled').
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {{ onProgress?: function, getCancelled?: function }} [opts]
 * @returns {Promise<{ files: number, bytes: number }>}
 */
async function copyDirWithProgress(srcDir, destDir, { onProgress, getCancelled } = {}) {
  const files = await collectFiles(srcDir);
  const sizes = await Promise.all(
    files.map(f => fs.promises.stat(f.src).then(s => s.size).catch(() => 0))
  );
  let bytesDone  = 0;
  const bytesTotal = sizes.reduce((a, b) => a + b, 0);

  for (let i = 0; i < files.length; i++) {
    if (getCancelled?.()) throw new Error('Cancelled');
    const { src, rel } = files[i];
    const dest = path.join(destDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    bytesDone += sizes[i];
    onProgress?.({ file: rel, index: i + 1, total: files.length, bytesDone, bytesTotal });
  }
  return { files: files.length, bytes: bytesDone };
}

/**
 * Scan a directory for PS5/PS4 game sub-folders and return metadata.
 * Deduplicates by game ID — first occurrence wins.
 *
 * @param {string[]} sourceDirs  List of root folders to scan
 * @returns {Promise<Array<{ game_id, folder_name, source_path, source_root, size }>>}
 */
async function scanGameDirs(sourceDirs) {
  const games = new Map();
  for (const src of sourceDirs) {
    if (!fs.existsSync(src)) continue;
    let entries;
    try { entries = await fs.promises.readdir(src, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const game_id = extractGameId(e.name);
      if (!game_id || games.has(game_id)) continue;
      const full = path.join(src, e.name);
      games.set(game_id, {
        game_id,
        folder_name: e.name,
        source_path: full,
        source_root: src,
        size: await dirSize(full),
      });
    }
  }
  return [...games.values()].sort((a, b) => a.game_id.localeCompare(b.game_id));
}

/**
 * Scan a single firmware/backpork folder for game sub-directories.
 *
 * @param {string} folderPath
 * @returns {Promise<Array<{ game_id, folder_name, path, size }>>}
 */
async function scanBackporkFolder(folderPath) {
  const entries = [];
  let list;
  try { list = await fs.promises.readdir(folderPath, { withFileTypes: true }); }
  catch (_) { return entries; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    const game_id = extractGameId(e.name);
    if (!game_id) continue;
    const full = path.join(folderPath, e.name);
    entries.push({ game_id, folder_name: e.name, path: full, size: await dirSize(full) });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ── runPorkJob — full backpork + UFS2 workflow ────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Execute the complete PS5 backpork patching + UFS2 conversion pipeline:
 *
 *   Phase 1 (5–35%):  Copy game directory to a temp worker folder.
 *   Phase 2 (35–50%): Overlay backpork patch files on top (cp with overwrite).
 *   Phase 3 (50–95%): Run UFS2Tool makefs or newfs to produce the .ffpkg.
 *   Phase 4 (95–100%): Delete temp worker folder.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠  ADMINISTRATOR REQUIRED                                          ║
 * ║  Phase 3 spawns UFS2Tool.exe which REQUIRES Administrator rights.  ║
 * ║  Without elevation spawn() will fail with EACCES.  Run your        ║
 * ║  Electron app or Node process as Administrator.                     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * @param {object} opts
 * @param {string}  opts.gamePath      Absolute path to the game directory (e.g. PPSA24473-app)
 * @param {string}  opts.backporkPath  Absolute path to the firmware-specific backpork folder for this game
 * @param {string}  opts.outputFile    Destination .ffpkg path
 * @param {string}  opts.tempDir       Scratch directory — a unique sub-folder is created here per job
 * @param {string}  [opts.jobId]       Optional job identifier used for the temp subfolder name
 * @param {'makefs'|'newfs'} [opts.method='makefs']  UFS2 conversion method
 * @param {string}  [opts.toolPath]    Override tool path (defaults to current getToolPath())
 *
 * @param {object}  [callbacks]
 * @param {function} [callbacks.onProgress]   ({ phase, percent, detail }) => void
 *   Called at most once per ~100 ms during copy phases (caller can throttle further).
 *   percent is 0–100 overall.
 * @param {function} [callbacks.onLog]        (line: string) => void  — each log line
 * @param {function} [callbacks.getCancelled] () => boolean           — return true to cancel
 *
 * @returns {Promise<{ ok: boolean, outputFile: string, log: string[] }>}
 */
async function runPorkJob(opts, callbacks = {}) {
  const {
    gamePath,
    backporkPath,
    outputFile,
    tempDir,
    jobId = `job_${Date.now()}`,
    method = 'makefs',
    toolPath: toolPathOverride,
  } = opts;

  const { onProgress, onLog, getCancelled } = callbacks;

  const log    = [];
  const logLine = (line) => { log.push(line); onLog?.(line); };

  // Temporarily override tool path if provided
  const savedToolPath = _toolPath;
  if (toolPathOverride) _toolPath = toolPathOverride;

  const workerDir = path.join(tempDir, `ufs2_${jobId}`);

  // Throttle helper so onProgress is called at most once per 100 ms
  let _lastProgressMs = 0;
  const throttledProgress = (info) => {
    const now = Date.now();
    if (now - _lastProgressMs >= 100) { _lastProgressMs = now; onProgress?.(info); }
  };

  try {
    // ── Phase 1: Copy game ──────────────────────────────────────────────────
    logLine(`[1/4] Copying game from ${gamePath}`);
    logLine(`       → ${workerDir}`);
    onProgress?.({ phase: 'Copying game — enumerating files…', percent: 5, detail: '' });

    if (getCancelled?.()) throw new Error('Cancelled');
    await fs.promises.mkdir(workerDir, { recursive: true });

    const cp1 = await copyDirWithProgress(gamePath, workerDir, {
      getCancelled,
      onProgress: ({ index, total, bytesDone, bytesTotal }) => {
        const pct = 5 + Math.round((index / total) * 30);
        throttledProgress({
          phase:   'Copying game',
          percent: pct,
          detail:  `${index}/${total} files (${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)})`,
        });
      },
    });
    onProgress?.({ phase: 'Copying game — done', percent: 35, detail: `${cp1.files} files, ${fmtBytes(cp1.bytes)}` });
    logLine(`[1/4] Done — ${cp1.files} files, ${fmtBytes(cp1.bytes)}.`);

    // ── Phase 2: Overlay backpork ───────────────────────────────────────────
    logLine(`[2/4] Applying backpork from ${backporkPath}`);
    onProgress?.({ phase: 'Applying backpork — enumerating files…', percent: 35, detail: '' });

    if (getCancelled?.()) throw new Error('Cancelled');
    _lastProgressMs = 0; // reset throttle for phase 2

    const cp2 = await copyDirWithProgress(backporkPath, workerDir, {
      getCancelled,
      onProgress: ({ index, total, bytesDone, bytesTotal }) => {
        const pct = 35 + Math.round((index / total) * 15);
        throttledProgress({
          phase:   'Applying backpork',
          percent: pct,
          detail:  `${index}/${total} files (${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)})`,
        });
      },
    });
    onProgress?.({ phase: 'Applying backpork — done', percent: 50, detail: `${cp2.files} files, ${fmtBytes(cp2.bytes)}` });
    logLine(`[2/4] Done — ${cp2.files} files, ${fmtBytes(cp2.bytes)}.`);

    // ── Phase 3: UFS2 convert ───────────────────────────────────────────────
    // ⚠ UFS2Tool.exe REQUIRES Administrator privileges.
    // If this throws EACCES, the calling process is not elevated.
    logLine(`[3/4] Running UFS2 ${method} → ${outputFile}`);
    onProgress?.({ phase: `Converting to UFS2 (${method})…`, percent: 50, detail: '' });

    if (getCancelled?.()) throw new Error('Cancelled');
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });

    // Map UFS2Tool's 0–100% to overall bar range 50→95%.
    // UFS2Tool emits: "  Adding files to image...  89% (68/69 files, 5.31 GiB/5.97 GiB)"
    let _lastUfs2Ms = 0;
    const onUfs2Progress = ({ toolPct, filesNow, filesTotal, bytesNow, bytesTotal }) => {
      const pct = 50 + Math.round(toolPct * 0.45);
      const detail = `${toolPct}% — ${filesNow}/${filesTotal} files, ${bytesNow} / ${bytesTotal}`;
      const now = Date.now();
      if (now - _lastUfs2Ms >= 150) {
        _lastUfs2Ms = now;
        onProgress?.({ phase: `Converting to UFS2 (${method})`, percent: pct, detail });
      }
    };
    const _logData = (s) => {
      for (const raw of s.split(/\r/)) {
        const line = raw.trimEnd();
        if (line) logLine(line);
      }
    };
    const ufs2Result = method === 'newfs'
      ? await newfsPS5(workerDir, outputFile, { onData: _logData, onProgress: onUfs2Progress })
      : await makefsPS5(workerDir, outputFile, { onData: _logData, onProgress: onUfs2Progress });

    if (!ufs2Result.ok) {
      throw new Error(ufs2Result.stderr || `UFS2Tool exited with error`);
    }
    onProgress?.({ phase: 'Converting to UFS2 — done', percent: 95, detail: '' });
    logLine(`[3/4] Done.`);

    // ── Phase 4: Cleanup ────────────────────────────────────────────────────
    logLine(`[4/4] Cleaning up temp…`);
    onProgress?.({ phase: 'Cleaning up…', percent: 97, detail: '' });
    try { await fs.promises.rm(workerDir, { recursive: true, force: true }); } catch (_) {}
    onProgress?.({ phase: 'Done', percent: 100, detail: outputFile });
    logLine(`[4/4] Complete → ${outputFile}`);

    return { ok: true, outputFile, log };

  } catch (err) {
    // Best-effort cleanup on failure / cancellation
    try { await fs.promises.rm(workerDir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: err.message, log };

  } finally {
    // Restore tool path if it was overridden for this job
    _toolPath = savedToolPath;
  }
}

// ---------------------------------------------------------------------------
// Batch helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {{ inputDir: string, outputFile: string }} MakeFsEntry
 * @typedef {{ imageFile: string, outputDir: string, fsPath?: string }} ExtractEntry
 * @typedef {{ ok: boolean, entry: object, result: import('./ufs2Core').RunResult }} BatchItemResult
 * @typedef {{ results: BatchItemResult[], succeeded: number, failed: number, durationMs: number }} BatchResult
 */

/**
 * Run a single-op function over an array of entries, reporting progress.
 *
 * @param {object[]}  entries
 * @param {function}  opFn        (entry, index) → Promise<RunResult>
 * @param {{ onProgress?: function, stopOnError?: boolean }} [batchOpts]
 * @returns {Promise<BatchResult>}
 */
async function runBatch(entries, opFn, batchOpts = {}) {
  const { onProgress, stopOnError = false } = batchOpts;
  const t0      = Date.now();
  const results = [];
  let succeeded = 0;
  let failed    = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let result;
    try {
      result = await opFn(entry, i);
    } catch (err) {
      result = { ok: false, stdout: '', stderr: err.message, exitCode: -1, durationMs: 0 };
    }

    const item = { ok: result.ok, entry, result };
    results.push(item);
    if (result.ok) succeeded++; else failed++;

    if (typeof onProgress === 'function') {
      onProgress(i + 1, entries.length, item);
    }

    if (!result.ok && stopOnError) break;
  }

  return { results, succeeded, failed, durationMs: Date.now() - t0 };
}

/**
 * Batch makefs — creates multiple UFS images from directory entries.
 *
 * Entry shape: { inputDir, outputFile }
 * Or a bare string path to a directory — outputFile is auto-derived as
 * `<inputDir basename>.ffpkg` in the same parent folder.
 *
 * @param {(MakeFsEntry|string)[]} entries
 * @param {{ ps5?: boolean, sectorSize?: string, fsOptions?: string,
 *            extraFlags?: string[], timeout?: number,
 *            onProgress?: function, stopOnError?: boolean }} [opts]
 */
async function batchMakefs(entries, opts = {}) {
  const usePS5 = opts.ps5 === true;
  const norm   = entries.map((e) => {
    if (typeof e === 'string') {
      return { inputDir: e, outputFile: path.join(path.dirname(e), `${path.basename(e)}.ffpkg`) };
    }
    return e;
  });
  return runBatch(norm, (entry) => {
    const fn = usePS5 ? makefsPS5 : makefs;
    return fn(entry.inputDir, entry.outputFile, opts);
  }, opts);
}

/**
 * Batch newfs — creates multiple UFS images from directory entries using newfs -D.
 *
 * Entry shape: { inputDir, outputFile }
 * Or a bare string — outputFile auto-derived as `<basename>.ffpkg`.
 *
 * @param {(MakeFsEntry|string)[]} entries
 * @param {{ ps5?: boolean, extraFlags?: string[], timeout?: number,
 *            onProgress?: function, stopOnError?: boolean }} [opts]
 */
async function batchNewfs(entries, opts = {}) {
  const usePS5 = opts.ps5 === true;
  const norm   = entries.map((e) => {
    if (typeof e === 'string') {
      return { inputDir: e, outputFile: path.join(path.dirname(e), `${path.basename(e)}.ffpkg`) };
    }
    return e;
  });
  return runBatch(norm, (entry) => {
    const fn = usePS5 ? newfsPS5 : newfs;
    return fn(entry.inputDir, entry.outputFile, opts);
  }, opts);
}

/**
 * Batch extract — extracts multiple UFS images.
 *
 * Entry shape: { imageFile, outputDir, fsPath? }
 * Or a bare string path to an image — outputDir auto-derived as a sibling
 * folder named `<image-basename>_extracted/`.
 *
 * @param {(ExtractEntry|string)[]} entries
 * @param {{ timeout?: number, onProgress?: function, stopOnError?: boolean }} [opts]
 */
async function batchExtract(entries, opts = {}) {
  const norm = entries.map((e) => {
    if (typeof e === 'string') {
      const base = path.basename(e, path.extname(e));
      return { imageFile: e, outputDir: path.join(path.dirname(e), `${base}_extracted`) };
    }
    return e;
  });
  return runBatch(norm, (entry) => {
    return extract(entry.imageFile, entry.outputDir, { fsPath: entry.fsPath, ...opts });
  }, opts);
}

// ---------------------------------------------------------------------------
// Module info
// ---------------------------------------------------------------------------

/** @returns {{ version: string, toolPath: string, toolAvailable: boolean }} */
function moduleInfo() {
  return {
    version:      pkg.version,
    toolPath:     _toolPath,
    toolAvailable: toolAvailable(),
  };
}

// ---------------------------------------------------------------------------
// Progress EventEmitter (convenience for non-callback usage)
// ---------------------------------------------------------------------------

/**
 * Create a batch runner that emits events instead of using a callback.
 * Usage:
 *   const runner = createBatchRunner();
 *   runner.on('progress', ({ current, total, entry, result }) => { ... });
 *   runner.on('done', (batchResult) => { ... });
 *   runner.runMakefs(entries, opts);
 */
function createBatchRunner() {
  const emitter = new EventEmitter();

  function progressFn(current, total, item) {
    emitter.emit('progress', { current, total, ...item });
  }

  emitter.runMakefs = (entries, opts = {}) => {
    return batchMakefs(entries, { ...opts, onProgress: progressFn })
      .then((res) => { emitter.emit('done', res); return res; })
      .catch((err) => { emitter.emit('error', err); throw err; });
  };

  emitter.runNewfs = (entries, opts = {}) => {
    return batchNewfs(entries, { ...opts, onProgress: progressFn })
      .then((res) => { emitter.emit('done', res); return res; })
      .catch((err) => { emitter.emit('error', err); throw err; });
  };

  emitter.runExtract = (entries, opts = {}) => {
    return batchExtract(entries, { ...opts, onProgress: progressFn })
      .then((res) => { emitter.emit('done', res); return res; })
      .catch((err) => { emitter.emit('error', err); throw err; });
  };

  return emitter;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Tool management
  setToolPath,
  getToolPath,
  toolAvailable,
  moduleInfo,

  // Single ops
  makefs,
  newfs,
  extract,
  info,
  ls,
  fsck,

  // PS5 presets
  makefsPS5,
  newfsPS5,

  // Batch ops
  batchMakefs,
  batchNewfs,
  batchExtract,

  // EventEmitter pattern
  createBatchRunner,

  // Workflow helpers (game scanning, file copy with progress)
  GAME_ID_RE,
  extractGameId,
  fmtBytes,
  dirSize,
  collectFiles,
  copyDirWithProgress,
  scanGameDirs,
  scanBackporkFolder,

  // UFS2Tool output parser
  parseUfs2Progress,

  // Full backpork + UFS2 pipeline
  // ⚠ runPorkJob spawns UFS2Tool.exe which REQUIRES Administrator privileges.
  runPorkJob,

  // Internal (for custom pipelines)
  runTool,
  runBatch,
};
