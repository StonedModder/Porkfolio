'use strict';

/**
 * xavatar-electron-module — main entry point
 * ============================================
 * Drop-in Electron/Node.js module that converts any image into a
 * PS4/PS5-compatible .xavatar archive (DXT5 DDS + PNG + online.json in ZIP).
 *
 * ── Node / Main-process usage ──────────────────────────────────────────────
 *   const xavatar = require('xavatar-electron-module');
 *
 *   // Register IPC handlers so renderer processes can trigger conversions
 *   xavatar.registerIpcHandlers(ipcMain);
 *
 *   // Direct API (main process / any Node.js context)
 *   const { buffer, filename } = await xavatar.convertFromPath('/img.png');
 *   require('fs').writeFileSync(filename, buffer);
 *
 * ── Renderer-process usage (via preload bridge) ────────────────────────────
 *   // In main: include preload.js in BrowserWindow webPreferences
 *   //   preload: require.resolve('xavatar-electron-module/preload')
 *
 *   // In renderer:
 *   const result = await window.xavatarAPI.convertFromCanvas(canvasElement);
 *   // result.buffer (ArrayBuffer), result.filename (string)
 */

const fs   = require('fs');
const path = require('path');

const core    = require('./src/xavatarCore');
const ipc     = require('./src/ipcHandlers');

// ---------------------------------------------------------------------------
// Re-export conversion API (Node / main process)
// ---------------------------------------------------------------------------

/**
 * Convert raw RGBA pixel data to .xavatar.
 * No sharp required.  Ideal for renderer → main IPC flows.
 *
 * @param {Buffer|Uint8Array} rgbaBuffer  RGBA row-major top-to-bottom
 * @param {number}            width
 * @param {number}            height
 * @param {{ filename?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
const convertFromRGBA = core.convertFromRGBA;

/**
 * Convert an encoded image Buffer (PNG/JPEG/WebP/AVIF/…) to .xavatar.
 * Requires: sharp
 *
 * @param {Buffer}  imgBuffer
 * @param {{ filename?: string }} [opts]
 */
const convertFromImageBuffer = core.convertFromImageBuffer;

/**
 * Convert an image file at `filePath` to .xavatar.
 * Requires: sharp
 *
 * @param {string} filePath  Absolute path
 * @param {{ filename?: string }} [opts]
 */
const convertFromPath = core.convertFromPath;

/**
 * Fetch a remote image URL and convert it to .xavatar.
 * Requires: sharp
 *
 * @param {string} url  HTTP or HTTPS URL
 * @param {{ filename?: string }} [opts]
 */
const convertFromURL = core.convertFromURL;

// ---------------------------------------------------------------------------
// IPC integration (Electron main process)
// ---------------------------------------------------------------------------

/**
 * Register all xavatar IPC handlers on ipcMain.
 * Call once during app startup in your main process.
 *
 * @param   {Electron.IpcMain} ipcMain
 * @returns {() => void}  Cleanup function — call it to remove all handlers.
 *
 * @example
 * const { app, ipcMain } = require('electron');
 * const xavatar = require('xavatar-electron-module');
 * app.whenReady().then(() => {
 *   const cleanup = xavatar.registerIpcHandlers(ipcMain);
 *   app.on('will-quit', cleanup);
 * });
 */
const registerIpcHandlers = ipc.registerIpcHandlers;

/** List of all IPC channel names registered by this module. */
const IPC_CHANNELS = ipc.CHANNELS;

// ---------------------------------------------------------------------------
// Convenience: convert + write to disk
// ---------------------------------------------------------------------------

/**
 * Convert an image file and write the resulting .xavatar next to the source.
 * Returns the output file path.
 *
 * @param {string} filePath          Source image path
 * @param {string} [outputDir]       Output directory (defaults to source dir)
 * @param {{ filename?: string }} [opts]
 * @returns {Promise<string>}        Absolute path of written .xavatar file
 */
async function convertAndSave(filePath, outputDir, opts = {}) {
  const result  = await convertFromPath(filePath, opts);
  const outDir  = outputDir || path.dirname(filePath);
  const outPath = path.join(outDir, result.filename);
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(outPath, result.buffer);
  return outPath;
}

/**
 * Convert a URL and write the resulting .xavatar to `outputDir`.
 *
 * @param {string} url
 * @param {string} outputDir
 * @param {{ filename?: string }} [opts]
 * @returns {Promise<string>}  Absolute path of written .xavatar file
 */
async function convertURLAndSave(url, outputDir, opts = {}) {
  const result  = await convertFromURL(url, opts);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, result.filename);
  await fs.promises.writeFile(outPath, result.buffer);
  return outPath;
}

// ---------------------------------------------------------------------------
// Module info
// ---------------------------------------------------------------------------

const { version } = require('./package.json');

/** @returns {{ version: string, sharpAvailable: boolean }} */
function moduleInfo() {
  let sharpAvailable = false;
  try { require('sharp'); sharpAvailable = true; } catch {}
  return { version, sharpAvailable };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core conversion (Node / main process)
  convertFromRGBA,
  convertFromImageBuffer,
  convertFromPath,
  convertFromURL,

  // Convenience helpers
  convertAndSave,
  convertURLAndSave,

  // Electron IPC integration
  registerIpcHandlers,
  IPC_CHANNELS,

  // Module metadata
  moduleInfo,
  version,

  // Advanced: internal core for custom pipelines
  core,
};
