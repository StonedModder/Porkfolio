/**
 * xavatarRenderer.js — renderer-process client for xavatar-electron-module
 * =========================================================================
 * A high-level, zero-dependency helper that wraps window.xavatarAPI
 * (injected by preload.js) and provides ergonomic utilities for loading,
 * cropping, and converting images from the browser DOM.
 *
 * Usage (ES module in renderer):
 *   import XavatarClient from './xavatarRenderer.js';
 *
 *   const client = new XavatarClient();
 *   await client.convertAndDownload(myCanvasElement);
 *
 * Or with a file input / paste / drag-drop wiring:
 *   const client = new XavatarClient();
 *   client.wireFileInput(document.querySelector('input[type=file]'));
 *   client.wirePaste(document);
 *   client.wireDropZone(document.getElementById('drop-zone'));
 *   client.on('image-ready', (canvas) => { ... preview the canvas ... });
 *   client.on('convert-start', () => { ... show spinner ... });
 *   client.on('convert-done',  ({ buffer, filename }) => { ... });
 *   client.on('convert-error', (err) => { ... });
 */

const MASTER_SIZE = 440;

// ---------------------------------------------------------------------------
// Tiny event emitter
// ---------------------------------------------------------------------------
class Emitter {
  constructor() { this._handlers = {}; }
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; }
  off(ev, fn) { this._handlers[ev] = (this._handlers[ev] || []).filter(h => h !== fn); return this; }
  emit(ev, ...args) { (this._handlers[ev] || []).forEach(fn => fn(...args)); }
}

// ---------------------------------------------------------------------------
// Main client class
// ---------------------------------------------------------------------------
class XavatarClient extends Emitter {
  /**
   * @param {{ api?: object, masterSize?: number }} [opts]
   *   api        — override for window.xavatarAPI (useful in tests)
   *   masterSize — internal canvas size for image processing (default: 440)
   */
  constructor(opts = {}) {
    super();
    this._api        = opts.api || window.xavatarAPI;
    this._masterSize = opts.masterSize || MASTER_SIZE;

    if (!this._api) {
      console.warn('[XavatarClient] window.xavatarAPI not found. ' +
        'Ensure xavatar-electron-module/preload is loaded in webPreferences.');
    }

    // Internal state
    this._sourceImg     = null; // HTMLImageElement of current source
    this._masterCanvas  = null; // off-screen canvas at masterSize × masterSize
    this._currentBlob   = null; // Blob of the source file (for filename hint)
  }

  // -------------------------------------------------------------------------
  // Image loading
  // -------------------------------------------------------------------------

  /**
   * Load an image File or Blob into the client (triggers 'image-ready').
   * @param {File|Blob} file
   * @returns {Promise<HTMLCanvasElement>}  The master canvas
   */
  async loadFile(file) {
    this._currentBlob = file;
    const dataURL = await _blobToDataURL(file);
    return this._loadDataURL(dataURL, file.name);
  }

  /**
   * Fetch a URL, decode it, and load it (triggers 'image-ready').
   * @param {string} url
   * @returns {Promise<HTMLCanvasElement>}
   */
  async loadURL(url) {
    const img = await _loadImage(url);
    return this._drawToMaster(img, _stemFromURL(url));
  }

  /**
   * Accept a raw RGBA buffer already sized to masterSize × masterSize.
   * @param {Uint8Array} rgba
   * @param {number}     width
   * @param {number}     height
   * @returns {HTMLCanvasElement}
   */
  loadRGBA(rgba, width, height) {
    const canvas = _makeCanvas(width, height);
    const imgData = canvas.getContext('2d').createImageData(width, height);
    imgData.data.set(rgba);
    canvas.getContext('2d').putImageData(imgData, 0, 0);
    return this._drawToMaster(canvas, 'avatar');
  }

  // -------------------------------------------------------------------------
  // DOM wiring helpers
  // -------------------------------------------------------------------------

  /**
   * Wire an <input type="file"> element.  On change, calls loadFile().
   * @param {HTMLInputElement} inputEl
   * @returns {() => void}  Cleanup / unwire function
   */
  wireFileInput(inputEl) {
    const handler = async () => {
      const f = inputEl.files && inputEl.files[0];
      if (f) await this._safeLoad(() => this.loadFile(f));
    };
    inputEl.addEventListener('change', handler);
    return () => inputEl.removeEventListener('change', handler);
  }

  /**
   * Wire clipboard paste anywhere on `target` (typically `document`).
   * @param {EventTarget} target
   * @returns {() => void}  Cleanup function
   */
  wirePaste(target = document) {
    const handler = async (ev) => {
      const items = (ev.clipboardData || window.clipboardData || {}).items || [];
      for (const item of items) {
        if (item.type && item.type.startsWith('image')) {
          ev.preventDefault();
          const file = item.getAsFile();
          if (file) await this._safeLoad(() => this.loadFile(file));
          return;
        }
      }
    };
    target.addEventListener('paste', handler);
    return () => target.removeEventListener('paste', handler);
  }

  /**
   * Wire drag-and-drop onto `dropEl`.
   * @param {HTMLElement} dropEl
   * @returns {() => void}  Cleanup function
   */
  wireDropZone(dropEl) {
    const over    = (e) => { e.preventDefault(); };
    const drop    = async (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) await this._safeLoad(() => this.loadFile(f));
    };
    dropEl.addEventListener('dragover', over);
    dropEl.addEventListener('drop', drop);
    return () => {
      dropEl.removeEventListener('dragover', over);
      dropEl.removeEventListener('drop', drop);
    };
  }

  // -------------------------------------------------------------------------
  // Conversion
  // -------------------------------------------------------------------------

  /**
   * Convert the current master canvas to .xavatar and return the result.
   * Emits 'convert-start', 'convert-done', or 'convert-error'.
   *
   * @param {{ canvas?: HTMLCanvasElement, cropRegion?: {x,y,w,h}, filename?: string }} [opts]
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  async convert(opts = {}) {
    const canvas = opts.canvas || this._masterCanvas;
    if (!canvas) throw new Error('No image loaded. Call loadFile() or loadURL() first.');

    let srcCanvas = canvas;
    if (opts.cropRegion) {
      srcCanvas = this._applyCrop(canvas, opts.cropRegion);
    }

    this.emit('convert-start');
    try {
      const filename = opts.filename
        || (this._currentBlob && this._currentBlob.name
            ? this._currentBlob.name.replace(/\.[^.]+$/, '')
            : 'avatar');

      const result = await this._api.convertFromCanvas(srcCanvas, { filename });
      this.emit('convert-done', result);
      return result;
    } catch (err) {
      this.emit('convert-error', err);
      throw err;
    }
  }

  /**
   * Convert and immediately trigger a browser file download.
   * @param {object} [opts]  Same as convert()
   */
  async convertAndDownload(opts = {}) {
    const result = await this.convert(opts);
    this._api.download(result.buffer, result.filename);
    return result;
  }

  // -------------------------------------------------------------------------
  // Canvas utilities
  // -------------------------------------------------------------------------

  /** @returns {HTMLCanvasElement|null}  The current master canvas */
  get masterCanvas() { return this._masterCanvas; }

  /**
   * Draw a rectangular crop region from `src` and scale to masterSize.
   * Returns a new canvas.
   */
  cropAndResize(src, { x, y, w, h }, targetSize = this._masterSize) {
    return this._applyCrop(src, { x, y, w, h }, targetSize);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async _loadDataURL(dataURL, hint = '') {
    const img = await _loadImage(dataURL);
    return this._drawToMaster(img, _stemFromFilename(hint));
  }

  _drawToMaster(source, name = 'avatar') {
    const sz = this._masterSize;
    const canvas = _makeCanvas(sz, sz);
    canvas.getContext('2d').drawImage(source, 0, 0, sz, sz);
    this._masterCanvas = canvas;
    this._currentName  = name;
    this.emit('image-ready', canvas);
    return canvas;
  }

  _applyCrop(srcCanvas, { x, y, w, h }, targetSize = this._masterSize) {
    const out  = _makeCanvas(targetSize, targetSize);
    out.getContext('2d').drawImage(srcCanvas, x, y, w, h, 0, 0, targetSize, targetSize);
    return out;
  }

  async _safeLoad(fn) {
    try { await fn(); }
    catch (err) { this.emit('load-error', err); }
  }
}

// ---------------------------------------------------------------------------
// Private static helpers
// ---------------------------------------------------------------------------

function _makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${e.message || src}`));
    img.src = src;
  });
}

function _blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function _stemFromFilename(name) {
  if (!name) return 'avatar';
  return name.replace(/\.[^.]+$/, '') || 'avatar';
}

function _stemFromURL(url) {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop() || 'avatar';
    return base.replace(/\.[^.]+$/, '') || 'avatar';
  } catch { return 'avatar'; }
}

// ---------------------------------------------------------------------------
// Export — ESM default (for <script type="module"> and bundler imports)
// Also sets window.XavatarClient as a convenience global.
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') window.XavatarClient = XavatarClient;

export { XavatarClient };
export default XavatarClient;
