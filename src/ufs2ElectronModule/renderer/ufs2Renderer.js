'use strict';

/**
 * ufs2Renderer.js — Client-side helper for renderer processes
 * =============================================================
 * Wraps window.ufs2API (injected by preload.js) with richer state management,
 * a progress event bus, and convenience logging.
 *
 * Include this script after the preload bridge is set up:
 *   <script src="path/to/renderer/ufs2Renderer.js"></script>
 *
 * Or import it as a module:
 *   import { Ufs2Renderer } from './renderer/ufs2Renderer.js';
 *
 * Usage:
 *   const ufs2 = new Ufs2Renderer();
 *
 *   ufs2.on('progress', ({ current, total, ok, entry }) => {
 *     progressBar.value = current / total * 100;
 *   });
 *   ufs2.on('done', ({ succeeded, failed }) => {
 *     summary.textContent = `Done: ${succeeded} ok, ${failed} failed`;
 *   });
 *   ufs2.on('error', ({ message }) => { alert(message); });
 *
 *   await ufs2.batchMakefsPS5(entries);
 */

/* global window, EventTarget, CustomEvent */

class Ufs2Renderer extends EventTarget {
  constructor() {
    super();
    this._api        = window.ufs2API;
    this._unsubscribe = null;
    this._activeBatchId = null;
    this._subscribeToProgress();
  }

  // ── Progress subscription ────────────────────────────────────────────────

  _subscribeToProgress() {
    if (!this._api) return;
    this._unsubscribe = this._api.onBatchProgress((data) => {
      if (this._activeBatchId !== null && data.batchId !== this._activeBatchId) return;
      this.dispatchEvent(new CustomEvent('progress', { detail: data }));
    });
  }

  /** Convenience: add event listener and return `this` for chaining. */
  on(type, listener) {
    this.addEventListener(type, (e) => listener(e.detail ?? e));
    return this;
  }

  destroy() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  // ── Module info ──────────────────────────────────────────────────────────

  async version() {
    return this._api.version();
  }

  async setToolPath(toolPath) {
    return this._api.setToolPath(toolPath);
  }

  // ── Single ops ───────────────────────────────────────────────────────────

  async makefs(inputDir, outputFile, opts)    { return this._api.makefs(inputDir, outputFile, opts); }
  async newfs(inputDir, outputFile, opts)     { return this._api.newfs(inputDir, outputFile, opts); }
  async makefsPS5(inputDir, outputFile, opts) { return this._api.makefsPS5(inputDir, outputFile, opts); }
  async newfsPS5(inputDir, outputFile, opts)  { return this._api.newfsPS5(inputDir, outputFile, opts); }
  async extract(imageFile, outputDir, fsPath) { return this._api.extract(imageFile, outputDir, fsPath); }
  async info(imageFile)                       { return this._api.info(imageFile); }
  async ls(imageFile, fsPath)                 { return this._api.ls(imageFile, fsPath); }
  async fsck(imageFile, mode)                 { return this._api.fsck(imageFile, mode); }

  // ── Batch ops ────────────────────────────────────────────────────────────

  async _runBatch(apiFn, entries, opts = {}) {
    this._activeBatchId = null; // will be set once we get the batchId back
    this.dispatchEvent(new CustomEvent('batch-start', { detail: { total: entries.length } }));
    try {
      // Kick off the batch — progress events will arrive while this awaits
      const result = await apiFn.call(this._api, entries, opts);
      this._activeBatchId = result.batchId ?? null;
      this.dispatchEvent(new CustomEvent('done', { detail: result }));
      return result;
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: err.message } }));
      throw err;
    } finally {
      this._activeBatchId = null;
    }
  }

  /**
   * @param {Array<{inputDir:string,outputFile:string}|string>} entries
   * @param {object} [opts]
   */
  batchMakefs(entries, opts)    { return this._runBatch(this._api.batchMakefs, entries, opts); }
  batchNewfs(entries, opts)     { return this._runBatch(this._api.batchNewfs, entries, opts); }
  batchMakefsPS5(entries, opts) { return this._runBatch(this._api.batchMakefsPS5, entries, opts); }
  batchNewfsPS5(entries, opts)  { return this._runBatch(this._api.batchNewfsPS5, entries, opts); }
  batchExtract(entries, opts)   { return this._runBatch(this._api.batchExtract, entries, opts); }
}

// ---------------------------------------------------------------------------
// CommonJS + ES Module dual export
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Ufs2Renderer };
}
// ESM default for browser bundlers
if (typeof window !== 'undefined') {
  window.Ufs2Renderer = Ufs2Renderer;
}
