'use strict';

/**
 * ufs2-electron-module — main entry point
 * =========================================
 * Drop-in Electron/Node.js module that drives UFS2Tool.exe for the full
 * PS5 backpork patching + UFS2 filesystem image workflow.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠  ADMINISTRATOR REQUIRED                                          ║
 * ║  UFS2Tool.exe calls low-level filesystem drivers that require       ║
 * ║  Windows Administrator privileges.  Without elevation EACCES will  ║
 * ║  be thrown by Node's child_process.spawn() and jobs will fail.     ║
 * ║                                                                     ║
 * ║  Production builds: set requestedExecutionLevel: requireAdministrator║
 * ║  in your electron-builder nsis/win config.                          ║
 * ║  Dev: right-click your .bat → "Run as administrator", or use a     ║
 * ║  bat with `net session` + `Start-Process -Verb RunAs` elevation.   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ── Node / Main-process usage ──────────────────────────────────────────────
 *   const ufs2 = require('./src/ufs2ElectronModule');
 *
 *   // User must provide their own UFS2Tool.exe path:
 *   ufs2.setToolPath('C:/tools/UFS2Tool/UFS2Tool.exe');
 *
 *   // Full backpork + UFS2 pipeline (must run as Administrator):
 *   const result = await ufs2.runPorkJob({
 *     gamePath:     './PPSA24473-app',
 *     backporkPath: './Backporks/5.xx/PPSA24473',
 *     outputFile:   './output/PPSA24473_5.xx.ffpkg',
 *     tempDir:      'C:/temp',
 *     method:       'makefs',   // or 'newfs'
 *   }, {
 *     onProgress: ({ phase, percent, detail }) => console.log(percent, phase, detail),
 *     onLog:      (line) => console.log(line),
 *     getCancelled: () => false,
 *   });
 *
 *   // Single PS5 image — makefs variant (recommended)
 *   const r = await ufs2.makefsPS5('./PPSA01234', './PPSA01234.ffpkg');
 *
 *   // Scan game folders (no Admin needed)
 *   const games = await ufs2.scanGameDirs(['G:/PS5/Games']);
 *
 *   // Scan a backpork firmware folder (no Admin needed)
 *   const backporks = await ufs2.scanBackporkFolder('./Backporks/5.xx');
 *
 *   // Batch — array of { inputDir, outputFile } or bare directory paths
 *   const batch = await ufs2.batchMakefsPS5([
 *     { inputDir: './PPSA01234', outputFile: './out/PPSA01234.ffpkg' },
 *     './PPSA05678',   // auto-names to ./PPSA05678.ffpkg
 *   ], { onProgress: (cur, total, item) => console.log(cur, '/', total) });
 *
 *   // Register IPC handlers so renderer processes can trigger operations
 *   ufs2.registerIpcHandlers(ipcMain);
 *
 * ── Renderer-process usage (via preload bridge) ────────────────────────────
 *   new BrowserWindow({
 *     webPreferences: {
 *       contextIsolation: true,
 *       preload: require.resolve('ufs2-electron-module/preload'),
 *     }
 *   });
 *
 *   // In renderer:
 *   ufs2API.onPorkProgress((ev) => console.log(ev.percent, ev.phase, ev.detail));
 *   ufs2API.onPorkLog((ev) => console.log(ev.line));
 *   const result = await ufs2API.runPorkJob({ gamePath, backporkPath, outputFile, tempDir });
 *
 *   const { games } = await ufs2API.scanGames(['G:/PS5/Games']);
 *   const r = await ufs2API.makefsPS5(inputDir, outputFile);
 *   ufs2API.onBatchProgress((ev) => console.log(ev));
 *   const batch = await ufs2API.batchMakefsPS5(entries);
 */

const path = require('path');
const fs   = require('fs');

const core = require('./src/ufs2Core');
const ipc  = require('./src/ipcHandlers');

// ---------------------------------------------------------------------------
// Re-export core API (Node / main process)
// ---------------------------------------------------------------------------

/** @see src/ufs2Core.js */
const setToolPath      = core.setToolPath;
const getToolPath      = core.getToolPath;
const toolAvailable    = core.toolAvailable;

// Single ops
const makefs           = core.makefs;
const newfs            = core.newfs;
const makefsPS5        = core.makefsPS5;
const newfsPS5         = core.newfsPS5;
const extract          = core.extract;
const info             = core.info;
const ls               = core.ls;
const fsck             = core.fsck;

// Batch ops
const batchMakefs      = core.batchMakefs;
const batchNewfs       = core.batchNewfs;
const batchExtract     = core.batchExtract;

// EventEmitter batch runner
const createBatchRunner = core.createBatchRunner;

// ---------------------------------------------------------------------------
// Convenience: PS5 batch wrappers (ps5: true already set)
// ---------------------------------------------------------------------------

/**
 * Batch makefs with PS5 flags pre-set.
 * Equivalent to batchMakefs(entries, { ...opts, ps5: true }).
 */
function batchMakefsPS5(entries, opts = {}) {
  return core.batchMakefs(entries, { ...opts, ps5: true });
}

/**
 * Batch newfs with PS5 flags pre-set.
 * Equivalent to batchNewfs(entries, { ...opts, ps5: true }).
 */
function batchNewfsPS5(entries, opts = {}) {
  return core.batchNewfs(entries, { ...opts, ps5: true });
}

// ---------------------------------------------------------------------------
// Convenience: convert a whole folder of sub-directories to .ffpkg files
// ---------------------------------------------------------------------------

/**
 * Scan `sourceDir` for immediate sub-directories and create a .ffpkg for each
 * one inside `outputDir` (created if absent).
 *
 * @param {string}  sourceDir   Directory whose sub-folders are the sources
 * @param {string}  outputDir   Directory to write .ffpkg files into
 * @param {{ ps5?: boolean, method?: 'makefs'|'newfs',
 *            onProgress?: function, stopOnError?: boolean,
 *            extraFlags?: string[], timeout?: number }} [opts]
 *   method: 'makefs' (default with ps5:true) or 'newfs'
 * @returns {Promise<import('./src/ufs2Core').BatchResult>}
 */
async function batchFromFolder(sourceDir, outputDir, opts = {}) {
  const { method = 'makefs', ps5 = true, ...rest } = opts;

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      inputDir:   path.join(sourceDir, d.name),
      outputFile: path.join(outputDir, `${d.name}.ffpkg`),
    }));

  if (entries.length === 0) {
    return { results: [], succeeded: 0, failed: 0, durationMs: 0 };
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  return method === 'newfs'
    ? batchNewfs(entries, { ps5, ...rest })
    : batchMakefs(entries, { ps5, ...rest });
}

// ---------------------------------------------------------------------------
// IPC integration (Electron main process)
// ---------------------------------------------------------------------------

/**
 * Register all ufs2 IPC handlers on ipcMain.
 * Call once during app startup in your main process.
 *
 * @param   {Electron.IpcMain} ipcMain
 * @returns {() => void}  Cleanup function — call it to remove all handlers.
 *
 * @example
 * const { app, ipcMain } = require('electron');
 * const ufs2 = require('./src/ufs2ElectronModule');
 * app.whenReady().then(() => {
 *   const cleanup = ufs2.registerIpcHandlers(ipcMain);
 *   app.on('will-quit', cleanup);
 * });
 */
const registerIpcHandlers = ipc.registerIpcHandlers;

/** List of all IPC channel names registered by this module. */
const IPC_CHANNELS = ipc.CHANNELS;

// ---------------------------------------------------------------------------
// Module info
// ---------------------------------------------------------------------------

const { version } = require('./package.json');

/** @returns {{ version: string, toolPath: string, toolAvailable: boolean }} */
function moduleInfo() {
  return core.moduleInfo();
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
  version,

  // Single ops — Node / main process
  // ⚠ All UFS2 ops require Administrator privileges (spawn EACCES without elevation)
  makefs,
  newfs,
  makefsPS5,
  newfsPS5,
  extract,
  info,
  ls,
  fsck,

  // Full backpork + UFS2 pipeline (Admin required for phase 3)
  runPorkJob: core.runPorkJob,

  // Scanning helpers (no UFS2Tool involved, no Admin required)
  GAME_ID_RE:          core.GAME_ID_RE,
  extractGameId:       core.extractGameId,
  fmtBytes:            core.fmtBytes,
  dirSize:             core.dirSize,
  collectFiles:        core.collectFiles,
  copyDirWithProgress: core.copyDirWithProgress,
  scanGameDirs:        core.scanGameDirs,
  scanBackporkFolder:  core.scanBackporkFolder,
  // UFS2Tool output parser (useful for IPC consumers that receive raw log lines)
  parseUfs2Progress:   core.parseUfs2Progress,

  // Batch ops — Node / main process (Admin required)
  batchMakefs,
  batchNewfs,
  batchMakefsPS5,
  batchNewfsPS5,
  batchExtract,
  batchFromFolder,

  // EventEmitter batch runner
  createBatchRunner,

  // Electron IPC integration
  registerIpcHandlers,
  IPC_CHANNELS,

  // Advanced: internal core for custom pipelines
  core,
};
