'use strict';

/**
 * preload.js — Electron contextBridge preload script
 * ====================================================
 * Include this file in your BrowserWindow webPreferences:
 *
 *   new BrowserWindow({
 *     webPreferences: {
 *       contextIsolation: true,
 *       preload: require.resolve('xavatar-electron-module/preload'),
 *     }
 *   });
 *
 * This exposes window.xavatarAPI in every renderer window.
 * Combine with xavatarRenderer.js for the full client-side API.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call an IPC handler and unwrap the result or throw on failure.
 * @template T
 * @param {string} channel
 * @param {object} payload
 * @returns {Promise<T>}
 */
async function invoke(channel, payload = {}) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error || `IPC error on ${channel}`);
  return result;
}

// ---------------------------------------------------------------------------
// Exposed API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('xavatarAPI', {

  /**
   * Get module version and capability info.
   * @returns {Promise<{ version: string, sharpAvailable: boolean }>}
   */
  version() {
    return ipcRenderer.invoke('xavatar:version');
  },

  /**
   * Convert an HTMLCanvasElement or OffscreenCanvas to .xavatar.
   * The canvas should contain the final cropped / sized image.
   * ImageData is extracted in the renderer (no file I/O), then the main
   * process handles DXT5 compression and ZIP packaging.
   *
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  async convertFromCanvas(canvas, opts = {}) {
    const ctx      = canvas.getContext('2d');
    const imgData  = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba     = new Uint8Array(imgData.data.buffer);
    const result   = await invoke('xavatar:convert-rgba', {
      rgba,
      width:    canvas.width,
      height:   canvas.height,
      filename: opts.filename,
    });
    return { buffer: result.buffer.buffer || result.buffer, filename: result.filename };
  },

  /**
   * Convert raw RGBA pixel data (e.g. from WebGL or custom pipeline).
   *
   * @param {Uint8Array|ArrayBuffer} rgba  RGBA row-major top-to-bottom
   * @param {number}                 width
   * @param {number}                 height
   * @param {{ filename?: string }}  [opts]
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  async convertFromRGBA(rgba, width, height, opts = {}) {
    const buf    = rgba instanceof ArrayBuffer ? new Uint8Array(rgba) : rgba;
    const result = await invoke('xavatar:convert-rgba', {
      rgba: buf, width, height, filename: opts.filename,
    });
    return { buffer: result.buffer.buffer || result.buffer, filename: result.filename };
  },

  /**
   * Convert a DataURL (e.g. result of canvas.toDataURL()) to .xavatar.
   * Decodes the data URL into an encoded image Buffer and sends to main.
   * Requires sharp in the main process.
   *
   * @param {string}               dataURL  'data:image/png;base64,...'
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  async convertFromDataURL(dataURL, opts = {}) {
    const base64  = dataURL.split(',')[1];
    if (!base64)  throw new Error('Invalid data URL');
    const buffer  = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const result  = await invoke('xavatar:convert-buffer', {
      buffer, filename: opts.filename,
    });
    return { buffer: result.buffer.buffer || result.buffer, filename: result.filename };
  },

  /**
   * Convert a remote image URL to .xavatar.
   * Fetch is done in the main process (bypasses CORS).
   * Requires sharp in the main process.
   *
   * @param {string}               url
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  async convertFromURL(url, opts = {}) {
    const result = await invoke('xavatar:convert-url', { url, filename: opts.filename });
    return { buffer: result.buffer.buffer || result.buffer, filename: result.filename };
  },

  /**
   * Convert a local file by its absolute path.
   * Requires sharp in the main process.
   *
   * @param {string}               filePath  Absolute path visible to main process
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  async convertFromPath(filePath, opts = {}) {
    const result = await invoke('xavatar:convert-path', { filePath, filename: opts.filename });
    return { buffer: result.buffer.buffer || result.buffer, filename: result.filename };
  },

  /**
   * Trigger a browser download of an ArrayBuffer as the given filename.
   * Convenience helper so renderer code doesn't need to manage blob URLs.
   *
   * @param {ArrayBuffer|Buffer|Uint8Array} buffer
   * @param {string}                        filename
   */
  download(buffer, filename) {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
});
