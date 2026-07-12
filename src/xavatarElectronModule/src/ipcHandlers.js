'use strict';

/**
 * ipcHandlers.js — Electron ipcMain handler registration
 *
 * Call registerIpcHandlers(ipcMain) once in your main process.
 * Every channel maps 1-to-1 with a method on xavatarCore so the renderer
 * can trigger conversions without needing direct Node.js access.
 *
 * Channels (all use ipcMain.handle → async/await):
 *   xavatar:convert-rgba     { rgba: Uint8Array, width, height, filename? }
 *   xavatar:convert-buffer   { buffer: Uint8Array, filename? }      ← needs sharp
 *   xavatar:convert-path     { filePath: string, filename? }        ← needs sharp
 *   xavatar:convert-url      { url: string, filename? }             ← needs sharp
 *   xavatar:version          (no args) → { version, sharpAvailable }
 *
 * All handlers return:
 *   { ok: true,  buffer: Uint8Array, filename: string }   on success
 *   { ok: false, error: string }                          on failure
 */

const core = require('./xavatarCore');
const pkg  = require('../package.json');

const CHANNELS = [
  'xavatar:convert-rgba',
  'xavatar:convert-buffer',
  'xavatar:convert-path',
  'xavatar:convert-url',
  'xavatar:version',
];

/**
 * Register all xavatar IPC handlers on the supplied ipcMain instance.
 * Safe to call multiple times — existing handlers are removed first.
 *
 * @param {Electron.IpcMain} ipcMain
 * @returns {() => void}  Cleanup function that removes all registered handlers.
 */
function registerIpcHandlers(ipcMain) {
  // Remove any stale handlers first (idempotent registration)
  CHANNELS.forEach((ch) => { try { ipcMain.removeHandler(ch); } catch {} });

  // -------------------------------------------------------------------------
  // xavatar:version
  // -------------------------------------------------------------------------
  ipcMain.handle('xavatar:version', () => {
    let sharpAvailable = false;
    try { require('sharp'); sharpAvailable = true; } catch {}
    return { version: pkg.version, sharpAvailable };
  });

  // -------------------------------------------------------------------------
  // xavatar:convert-rgba
  // No sharp required — renderer passes pre-processed RGBA from Canvas.
  // -------------------------------------------------------------------------
  ipcMain.handle('xavatar:convert-rgba', async (_event, payload) => {
    try {
      const { rgba, width, height, filename } = payload;
      if (!rgba || !width || !height) throw new Error('Missing rgba / width / height.');
      const buf = Buffer.from(rgba); // Uint8Array from renderer
      const result = await core.convertFromRGBA(buf, width, height, { filename });
      return { ok: true, buffer: result.buffer, filename: result.filename };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // -------------------------------------------------------------------------
  // xavatar:convert-buffer  (encoded image: PNG/JPEG/WebP/etc)
  // Requires sharp.
  // -------------------------------------------------------------------------
  ipcMain.handle('xavatar:convert-buffer', async (_event, payload) => {
    try {
      const { buffer, filename } = payload;
      if (!buffer) throw new Error('Missing image buffer.');
      const buf    = Buffer.from(buffer);
      const result = await core.convertFromImageBuffer(buf, { filename });
      return { ok: true, buffer: result.buffer, filename: result.filename };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // -------------------------------------------------------------------------
  // xavatar:convert-path  (absolute file path on disk)
  // Requires sharp.
  // -------------------------------------------------------------------------
  ipcMain.handle('xavatar:convert-path', async (_event, payload) => {
    try {
      const { filePath, filename } = payload;
      if (!filePath) throw new Error('Missing filePath.');
      const result = await core.convertFromPath(filePath, { filename });
      return { ok: true, buffer: result.buffer, filename: result.filename };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // -------------------------------------------------------------------------
  // xavatar:convert-url  (remote image URL)
  // Requires sharp.
  // -------------------------------------------------------------------------
  ipcMain.handle('xavatar:convert-url', async (_event, payload) => {
    try {
      const { url, filename } = payload;
      if (!url) throw new Error('Missing url.');
      const result = await core.convertFromURL(url, { filename });
      return { ok: true, buffer: result.buffer, filename: result.filename };
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
