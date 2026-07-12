'use strict';

/**
 * preload.js — Electron contextBridge preload script
 * ====================================================
 * Include this file in your BrowserWindow webPreferences:
 *
 *   new BrowserWindow({
 *     webPreferences: {
 *       contextIsolation: true,
 *       preload: require.resolve('ufs2-electron-module/preload'),
 *     }
 *   });
 *
 * This exposes window.ufs2API in every renderer window.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠  ADMINISTRATOR REQUIRED                                          ║
 * ║  runPorkJob() and any direct UFS2 conversion method call            ║
 * ║  UFS2Tool.exe which REQUIRES Administrator privileges.              ║
 * ║  Without elevation, spawn() will throw EACCES and jobs will fail.  ║
 * ║  Run your Electron app elevated or embed a UAC manifest.           ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * All methods return Promises that resolve to the raw result from the main
 * process ({ ok, …data }).  Batch/job methods also push progress events —
 * subscribe with onBatchProgress() / onPorkProgress() / onPorkLog().
 */

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke an IPC handle channel.  Does NOT throw on ok:false — caller decides.
 * @param {string} channel
 * @param {object} [payload]
 * @returns {Promise<any>}
 */
async function invoke(channel, payload = {}) {
  return ipcRenderer.invoke(channel, payload);
}

/**
 * Subscribe to an IPC push event; return an unsubscribe function.
 * @param {string}   channel
 * @param {function} callback  (data) => void
 * @returns {function}
 */
function on(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// ---------------------------------------------------------------------------
// Exposed API — window.ufs2API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('ufs2API', {

  // ── Module info ────────────────────────────────────────────────────────────

  /**
   * Get module version and tool availability.
   * @returns {Promise<{ ok: boolean, version: string, toolPath: string, toolAvailable: boolean }>}
   */
  version() {
    return invoke('ufs2:version');
  },

  /**
   * Override UFS2Tool.exe path at runtime.
   * @param {string} toolPath  Absolute path to UFS2Tool.exe
   */
  setToolPath(toolPath) {
    return invoke('ufs2:set-tool-path', { toolPath });
  },

  // ── Single UFS2 ops ────────────────────────────────────────────────────────
  // ⚠ Each of these spawns UFS2Tool.exe — requires Administrator privileges.

  /** Create a UFS image using makefs. */
  makefs(inputDir, outputFile, opts) {
    return invoke('ufs2:makefs', { inputDir, outputFile, opts });
  },

  /** Create a UFS image using newfs -D. */
  newfs(inputDir, outputFile, opts) {
    return invoke('ufs2:newfs', { inputDir, outputFile, opts });
  },

  /**
   * Create a PS5-compatible UFS2 image using makefs.
   * PS5 flags: -S 4096 -t ffs -o version=2,minfree=0,softupdates=0,optimization=space
   */
  makefsPS5(inputDir, outputFile, opts) {
    return invoke('ufs2:makefs-ps5', { inputDir, outputFile, opts });
  },

  /** Create a PS5-compatible UFS2 image using newfs -D. */
  newfsPS5(inputDir, outputFile, opts) {
    return invoke('ufs2:newfs-ps5', { inputDir, outputFile, opts });
  },

  /** Extract files from a UFS image to a directory. */
  extract(imageFile, outputDir, fsPath, opts) {
    return invoke('ufs2:extract', { imageFile, outputDir, fsPath, opts });
  },

  /** Get filesystem superblock information. */
  info(imageFile) {
    return invoke('ufs2:info', { imageFile });
  },

  /** List directory contents inside a UFS image. */
  ls(imageFile, fsPath) {
    return invoke('ufs2:ls', { imageFile, fsPath });
  },

  /** Run a filesystem consistency check. */
  fsck(imageFile, mode) {
    return invoke('ufs2:fsck', { imageFile, mode });
  },

  // ── Pork job (full backpork+UFS2 pipeline) ─────────────────────────────────
  // ⚠ Phase 3 of the job spawns UFS2Tool.exe — REQUIRES Administrator privileges.

  /**
   * Run the complete PS5 backpork patching + UFS2 conversion pipeline:
   *   1. Copy game directory to temp worker dir.
   *   2. Overlay backpork patch files on top.
   *   3. Run UFS2Tool makefs/newfs → .ffpkg output.  ← needs Admin
   *   4. Delete temp worker dir.
   *
   * Subscribe to progress and log events BEFORE calling this method:
   *   ufs2API.onPorkProgress((ev) => { ... });
   *   ufs2API.onPorkLog((ev) => { ... });
   *
   * @param {object} opts
   * @param {string}  opts.gamePath      Absolute path to the game directory
   * @param {string}  opts.backporkPath  Absolute path to firmware-specific backpork folder
   * @param {string}  opts.outputFile    Destination .ffpkg path
   * @param {string}  opts.tempDir       Scratch directory for per-job temp folder
   * @param {string}  [opts.jobId]       Unique ID (auto-generated if omitted)
   * @param {'makefs'|'newfs'} [opts.method='makefs']
   * @param {string}  [opts.toolPath]    Override UFS2Tool path for this job only
   * @returns {Promise<{ ok: boolean, jobId: string, outputFile?: string, error?: string, log: string[] }>}
   */
  runPorkJob(opts) {
    return invoke('ufs2:run-pork-job', opts);
  },

  /**
   * Request cancellation of a running pork job.
   * @param {string} jobId
   */
  cancelPorkJob(jobId) {
    return invoke('ufs2:cancel-pork-job', { jobId });
  },

  // ── Scanning (no UFS2Tool, no Admin needed) ────────────────────────────────

  /**
   * Scan directories for PS5/PS4 game folders (PPSA/CUSA patterns).
   * @param {string[]} sourceDirs  Root folders to search
   * @returns {Promise<{ ok: boolean, games: Array<{ game_id, folder_name, source_path, source_root, size }> }>}
   */
  scanGames(sourceDirs) {
    return invoke('ufs2:scan-games', { sourceDirs });
  },

  /**
   * Scan a firmware/backpork folder for game sub-directories.
   * @param {string} folderPath
   * @returns {Promise<{ ok: boolean, entries: Array<{ game_id, folder_name, path, size }> }>}
   */
  scanBackpork(folderPath) {
    return invoke('ufs2:scan-backpork', { folderPath });
  },

  // ── Batch ops ──────────────────────────────────────────────────────────────
  // ⚠ All batch ops spawn UFS2Tool.exe — require Administrator privileges.

  /**
   * Batch create UFS images using makefs.
   * Progress events are pushed via onBatchProgress().
   * @param {Array<{inputDir:string, outputFile:string}|string>} entries
   * @param {object} [opts]
   */
  batchMakefs(entries, opts) {
    return invoke('ufs2:batch-makefs', { entries, opts });
  },

  /** Batch newfs. */
  batchNewfs(entries, opts) {
    return invoke('ufs2:batch-newfs', { entries, opts });
  },

  /** Batch makefs with PS5 flags pre-set (ps5: true). */
  batchMakefsPS5(entries, opts = {}) {
    return invoke('ufs2:batch-makefs', { entries, opts: { ...opts, ps5: true } });
  },

  /** Batch newfs with PS5 flags pre-set (ps5: true). */
  batchNewfsPS5(entries, opts = {}) {
    return invoke('ufs2:batch-newfs', { entries, opts: { ...opts, ps5: true } });
  },

  /** Batch extract images. */
  batchExtract(entries, opts) {
    return invoke('ufs2:batch-extract', { entries, opts });
  },

  // ── Event subscriptions ────────────────────────────────────────────────────

  /**
   * Subscribe to batch progress events.
   * Callback receives: { batchId, current, total, ok, entry, result }
   * @returns {function}  Unsubscribe
   */
  onBatchProgress(callback) {
    return on('ufs2:batch-progress', callback);
  },

  /**
   * Subscribe to per-file + phase progress from runPorkJob.
   * Callback receives: { jobId, phase: string, percent: number, detail: string }
   * percent is 0–100 overall; fires at most once per ~100 ms during copy phases.
   * @returns {function}  Unsubscribe
   */
  onPorkProgress(callback) {
    return on('ufs2:pork-progress', callback);
  },

  /**
   * Subscribe to log lines emitted by runPorkJob.
   * Callback receives: { jobId, line: string }
   * @returns {function}  Unsubscribe
   */
  onPorkLog(callback) {
    return on('ufs2:pork-log', callback);
  },
});
