'use strict';

/**
 * ipcHandlers.js — Electron ipcMain handler registration
 * =========================================================
 * Call registerIpcHandlers(ipcMain) once in your main process.
 * Every channel maps 1-to-1 with a function on ufs2Core.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠  ADMINISTRATOR REQUIRED                                          ║
 * ║  ufs2:run-pork-job (and any direct UFS2 op) spawns UFS2Tool.exe.   ║
 * ║  That process REQUIRES Windows Administrator privileges.           ║
 * ║  Without elevation, spawn() throws EACCES and the job fails.       ║
 * ║  Run your Electron app elevated, or request UAC in your manifest.  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Single-op channels (ipcMain.handle → async/await):
 *   ufs2:version                                               → module info
 *   ufs2:set-tool-path   { toolPath }                         → { ok }
 *   ufs2:makefs          { inputDir, outputFile, opts? }      → RunResult
 *   ufs2:newfs           { inputDir, outputFile, opts? }      → RunResult
 *   ufs2:makefs-ps5      { inputDir, outputFile, opts? }      → RunResult
 *   ufs2:newfs-ps5       { inputDir, outputFile, opts? }      → RunResult
 *   ufs2:extract         { imageFile, outputDir, fsPath? }    → RunResult
 *   ufs2:info            { imageFile }                        → RunResult
 *   ufs2:ls              { imageFile, fsPath? }               → RunResult
 *   ufs2:fsck            { imageFile, mode? }                 → RunResult
 *
 * Workflow channel (full backpork+UFS2 pipeline):
 *   ufs2:run-pork-job    { gamePath, backporkPath, outputFile, tempDir,
 *                          jobId?, method?, toolPath? }
 *                                                             → { ok, outputFile, log }
 *   Progress events pushed to renderer via: ufs2:pork-progress { jobId, phase, percent, detail }
 *   Log line events pushed via:             ufs2:pork-log      { jobId, line }
 *   Cancel a running job:   ufs2:cancel-pork-job   { jobId }
 *
 * Scanning channels (no UFS2Tool involved, safe to call without elevation):
 *   ufs2:scan-games         { sourceDirs: string[] }          → { ok, games[] }
 *   ufs2:scan-backpork      { folderPath }                    → { ok, entries[] }
 *
 * Batch channels — progress events are pushed mid-operation:
 *   ufs2:batch-makefs    { entries, opts? }                   → BatchResult
 *   ufs2:batch-newfs     { entries, opts? }                   → BatchResult
 *   ufs2:batch-extract   { entries, opts? }                   → BatchResult
 *
 * Progress event sent to the requesting window (ipcRenderer.on):
 *   ufs2:batch-progress  { batchId, current, total, ok, entry, result }
 *
 * All handlers return:
 *   { ok: true,  …data }    on success
 *   { ok: false, error }    on failure
 */

const core = require('./ufs2Core');
const pkg  = require('../package.json');

const CHANNELS = [
  'ufs2:version',
  'ufs2:set-tool-path',
  'ufs2:makefs',
  'ufs2:newfs',
  'ufs2:makefs-ps5',
  'ufs2:newfs-ps5',
  'ufs2:extract',
  'ufs2:info',
  'ufs2:ls',
  'ufs2:fsck',
  'ufs2:run-pork-job',
  'ufs2:cancel-pork-job',
  'ufs2:scan-games',
  'ufs2:scan-backpork',
  'ufs2:batch-makefs',
  'ufs2:batch-newfs',
  'ufs2:batch-extract',
];

let _batchSeq = 0; // incrementing ID so renderer can correlate progress events

// Active pork jobs: jobId (string) → { cancelled: boolean }
const _activeJobs = new Map();

/**
 * Register all ufs2 IPC handlers on the supplied ipcMain instance.
 * Safe to call multiple times — existing handlers are removed first.
 *
 * @param   {Electron.IpcMain} ipcMain
 * @returns {() => void}  Cleanup function that removes all registered handlers.
 */
function registerIpcHandlers(ipcMain) {
  // Remove stale handlers first (idempotent)
  CHANNELS.forEach((ch) => { try { ipcMain.removeHandler(ch); } catch {} });

  // ─── ufs2:version ──────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:version', () => {
    return { ok: true, ...core.moduleInfo() };
  });

  // ─── ufs2:set-tool-path ────────────────────────────────────────────────────
  ipcMain.handle('ufs2:set-tool-path', (_event, { toolPath }) => {
    try {
      if (!toolPath) throw new Error('toolPath is required');
      core.setToolPath(toolPath);
      return { ok: true, toolPath, toolAvailable: core.toolAvailable() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:makefs ───────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:makefs', async (_event, { inputDir, outputFile, opts }) => {
    try {
      if (!inputDir || !outputFile) throw new Error('inputDir and outputFile are required');
      const result = await core.makefs(inputDir, outputFile, opts);
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:newfs ────────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:newfs', async (_event, { inputDir, outputFile, opts }) => {
    try {
      if (!inputDir || !outputFile) throw new Error('inputDir and outputFile are required');
      const result = await core.newfs(inputDir, outputFile, opts);
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:makefs-ps5 ───────────────────────────────────────────────────────
  ipcMain.handle('ufs2:makefs-ps5', async (_event, { inputDir, outputFile, opts }) => {
    try {
      if (!inputDir || !outputFile) throw new Error('inputDir and outputFile are required');
      const result = await core.makefsPS5(inputDir, outputFile, opts);
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:newfs-ps5 ────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:newfs-ps5', async (_event, { inputDir, outputFile, opts }) => {
    try {
      if (!inputDir || !outputFile) throw new Error('inputDir and outputFile are required');
      const result = await core.newfsPS5(inputDir, outputFile, opts);
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:extract ──────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:extract', async (_event, { imageFile, outputDir, fsPath, opts }) => {
    try {
      if (!imageFile || !outputDir) throw new Error('imageFile and outputDir are required');
      const result = await core.extract(imageFile, outputDir, { fsPath, ...opts });
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:info ─────────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:info', async (_event, { imageFile, opts }) => {
    try {
      if (!imageFile) throw new Error('imageFile is required');
      const result = await core.info(imageFile, opts);
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:ls ───────────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:ls', async (_event, { imageFile, fsPath, opts }) => {
    try {
      if (!imageFile) throw new Error('imageFile is required');
      const result = await core.ls(imageFile, fsPath, opts);
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:fsck ─────────────────────────────────────────────────────────────
  ipcMain.handle('ufs2:fsck', async (_event, { imageFile, mode, opts }) => {
    try {
      if (!imageFile) throw new Error('imageFile is required');
      const result = await core.fsck(imageFile, { mode, ...opts });
      return { ok: result.ok, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:batch-makefs ─────────────────────────────────────────────────────
  ipcMain.handle('ufs2:batch-makefs', async (event, { entries, opts }) => {
    try {
      if (!Array.isArray(entries)) throw new Error('entries must be an array');
      const batchId    = ++_batchSeq;
      const batchOpts  = {
        ...(opts || {}),
        onProgress: (current, total, item) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('ufs2:batch-progress', { batchId, current, total, ...item });
          }
        },
      };
      const result = await core.batchMakefs(entries, batchOpts);
      return { ok: true, batchId, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:batch-newfs ──────────────────────────────────────────────────────
  ipcMain.handle('ufs2:batch-newfs', async (event, { entries, opts }) => {
    try {
      if (!Array.isArray(entries)) throw new Error('entries must be an array');
      const batchId   = ++_batchSeq;
      const batchOpts = {
        ...(opts || {}),
        onProgress: (current, total, item) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('ufs2:batch-progress', { batchId, current, total, ...item });
          }
        },
      };
      const result = await core.batchNewfs(entries, batchOpts);
      return { ok: true, batchId, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:batch-extract ────────────────────────────────────────────────────
  ipcMain.handle('ufs2:batch-extract', async (event, { entries, opts }) => {
    try {
      if (!Array.isArray(entries)) throw new Error('entries must be an array');
      const batchId   = ++_batchSeq;
      const batchOpts = {
        ...(opts || {}),
        onProgress: (current, total, item) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('ufs2:batch-progress', { batchId, current, total, ...item });
          }
        },
      };
      const result = await core.batchExtract(entries, batchOpts);
      return { ok: true, batchId, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:run-pork-job ─────────────────────────────────────────────────────
  // Full pipeline: copy game → overlay backpork → UFS2 convert → cleanup.
  // ⚠ Phase 3 spawns UFS2Tool.exe — REQUIRES Administrator privileges.
  //   Without elevation, spawn() throws EACCES and the job will fail.
  ipcMain.handle('ufs2:run-pork-job', async (event, jobOpts) => {
    const jobId    = jobOpts.jobId || `pork_${Date.now()}`;
    const jobState = { cancelled: false };
    _activeJobs.set(jobId, jobState);
    try {
      const result = await core.runPorkJob(
        { ...jobOpts, jobId },
        {
          getCancelled: () => jobState.cancelled,
          onProgress: ({ phase, percent, detail }) => {
            if (!event.sender.isDestroyed())
              event.sender.send('ufs2:pork-progress', { jobId, phase, percent, detail });
          },
          onLog: (line) => {
            if (!event.sender.isDestroyed())
              event.sender.send('ufs2:pork-log', { jobId, line });
          },
        }
      );
      return result.ok
        ? { ok: true,  jobId, outputFile: result.outputFile, log: result.log }
        : { ok: false, jobId, error: result.error,           log: result.log };
    } catch (err) {
      return { ok: false, jobId, error: String(err.message || err), log: [] };
    } finally {
      _activeJobs.delete(jobId);
    }
  });

  // ─── ufs2:cancel-pork-job ──────────────────────────────────────────────────
  ipcMain.handle('ufs2:cancel-pork-job', (_event, { jobId }) => {
    const job = _activeJobs.get(jobId);
    if (job) { job.cancelled = true; return { ok: true }; }
    return { ok: false, error: 'Job not found or already completed' };
  });

  // ─── ufs2:scan-games ───────────────────────────────────────────────────────
  // Scan source directories for PS5/PS4 game folders. No UFS2Tool involved.
  ipcMain.handle('ufs2:scan-games', async (_event, { sourceDirs }) => {
    try {
      if (!Array.isArray(sourceDirs)) throw new Error('sourceDirs must be an array');
      const games = await core.scanGameDirs(sourceDirs);
      return { ok: true, games };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ─── ufs2:scan-backpork ────────────────────────────────────────────────────
  // Scan a firmware folder for game sub-directories. No UFS2Tool involved.
  ipcMain.handle('ufs2:scan-backpork', async (_event, { folderPath }) => {
    try {
      if (!folderPath) throw new Error('folderPath is required');
      const entries = await core.scanBackporkFolder(folderPath);
      return { ok: true, entries };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Return cleanup function
  return function unregisterIpcHandlers() {
    CHANNELS.forEach((ch) => { try { ipcMain.removeHandler(ch); } catch {} });
  };
}

module.exports = { registerIpcHandlers, CHANNELS };
