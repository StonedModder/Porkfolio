'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ELF Arsenal client (replaces the deprecated VoidShell integration)
//
// ELF Arsenal (git.etawen.dev/soniciso/elf-arsenal) is PS5-side homebrew that
// serves a web UI + REST API on :6969. This module is the Porkfolio-side client:
// all requests go through the main process (node-fetch) to avoid renderer CORS,
// mirroring the API the ELF Arsenal web UI itself uses.
//
// Endpoints used (from elf-arsenal/assets/app.js):
//   GET /version
//   GET /api/fs/list?path=            → { entries|items:[{name,is_dir|dir,size,mtime,mode}], safety_lock }
//   GET /api/fs/stat?path=
//   GET /api/fs/mkdir?path=
//   GET /api/fs/rename?src=&dst=      (also used as move within a device)
//   GET /api/fs/delete?path=&recursive=1
//   GET /api/fs/copy?src=&dst=        (long-running → poll /api/fs/job/status)
//   GET /api/fs/move?src=&dst=        (long-running → poll /api/fs/job/status)
//   GET /api/fs/job/status            → { busy, ... }
//   GET /api/fs/job/cancel
//   GET /api/fs/usb                   → attached USB mounts
//   GET /api/fs/download?path=        → raw file bytes
//   GET /hbldr?path=&args=&daemon=&pipe=1   → launch an ELF / app
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function register(ipcMain, { win, store, log, path, fs, dialog, nodeFetch, ps5Notify }) {
  const DEFAULT_PORT = 6969;

  function eaBase() {
    const ip = store.get('ftp.host', '');
    if (!ip) throw new Error('PS5 IP not set. Configure it in FTP Settings first.');
    const port = store.get('elfArsenal.port', DEFAULT_PORT);
    return `http://${ip}:${port}`;
  }

  // Fetch with a timeout; returns the raw Response.
  async function eaFetch(pathAndQuery, { method = 'GET', body, headers, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await nodeFetch(eaBase() + pathAndQuery, { method, body, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // GET → parsed JSON, throwing a useful error on non-2xx / non-JSON.
  async function eaJson(pathAndQuery, opts) {
    const r = await eaFetch(pathAndQuery, opts);
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`ELF Arsenal returned non-JSON (HTTP ${r.status}): ${text.slice(0, 120)}`); }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  const q = encodeURIComponent;

  // Normalize the list response into a stable shape the renderer can rely on.
  function normalizeEntries(data) {
    const raw = (data.entries || data.items || []).map(i =>
      typeof i === 'string' ? { name: i } : i);
    const entries = raw
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => ({
        name:   e.name,
        is_dir: e.is_dir !== undefined ? !!e.is_dir : !!e.dir,
        size:   e.size || 0,
        mtime:  e.mtime || 0,
        mode:   e.mode || '',
      }));
    return { entries, safety_lock: data.safety_lock === true || data.safety_lock === 'true' };
  }

  // ── Connectivity / version ─────────────────────────────────────────────────
  ipcMain.handle('ea:version', async () => {
    try {
      const r = await eaFetch('/version', { timeoutMs: 5000 });
      if (!r.ok) return { connected: false };
      const v = await r.json().catch(() => ({}));
      return { connected: true, ...v };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  });

  // ── Directory / file ops ───────────────────────────────────────────────────
  ipcMain.handle('ea:list',  (_e, { path: p }) => eaJson(`/api/fs/list?path=${q(p)}`).then(normalizeEntries));
  ipcMain.handle('ea:stat',  (_e, { path: p }) => eaJson(`/api/fs/stat?path=${q(p)}`));
  ipcMain.handle('ea:usb',   ()                => eaJson('/api/fs/usb'));
  ipcMain.handle('ea:mkdir', (_e, { path: p }) => eaJson(`/api/fs/mkdir?path=${q(p)}`));
  ipcMain.handle('ea:rename',(_e, { src, dst }) => eaJson(`/api/fs/rename?src=${q(src)}&dst=${q(dst)}`));
  ipcMain.handle('ea:delete',(_e, { path: p, recursive = true }) =>
    eaJson(`/api/fs/delete?path=${q(p)}${recursive ? '&recursive=1' : ''}`));
  ipcMain.handle('ea:copy',  (_e, { src, dst }) => eaJson(`/api/fs/copy?src=${q(src)}&dst=${q(dst)}`));
  ipcMain.handle('ea:move',  (_e, { src, dst }) => eaJson(`/api/fs/move?src=${q(src)}&dst=${q(dst)}`));
  ipcMain.handle('ea:job-status', () => eaJson('/api/fs/job/status').catch(() => ({ busy: false })));
  ipcMain.handle('ea:job-cancel', () => eaFetch('/api/fs/job/cancel').then(() => ({ ok: true })).catch(() => ({ ok: false })));

  // ── Launch an ELF / app via hbldr ──────────────────────────────────────────
  ipcMain.handle('ea:launch', async (_e, { path: p, args = null, daemon = false }) => {
    const params = new URLSearchParams({ pipe: '1', daemon: daemon ? '1' : '0', path: p });
    if (args) params.append('args', Array.isArray(args) ? args.map(a => a.replace(/ /g, '\\ ')).join(' ') : String(args).replace(/ /g, '\\ '));
    const r = await eaFetch('/hbldr?' + params.toString(), { timeoutMs: 30000 });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); if (j && j.error) detail = ' — ' + j.error; } catch {}
      throw new Error(`Launch failed (HTTP ${r.status})${detail}`);
    }
    ps5Notify?.('ELF Arsenal', `Launched ${path.basename(p)}`).catch?.(() => {});
    return { ok: true };
  });

  // ── Download a remote file to the PC (save dialog) ─────────────────────────
  ipcMain.handle('ea:download', async (_e, { path: remotePath, filename }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: filename || path.basename(remotePath),
    });
    if (canceled || !filePath) return { canceled: true };
    const r = await eaFetch(`/api/fs/download?path=${q(remotePath)}`, { timeoutMs: 5 * 60 * 1000 });
    if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(filePath);
      out.on('error', reject);
      out.on('finish', resolve);
      r.body.on('error', reject);
      r.body.pipe(out);
    });
    return { ok: true, filePath };
  });

  // ── Upload a local file to a remote directory ──────────────────────────────
  // ELF Arsenal accepts a POST to /api/fs/upload with the target path in the
  // query and the raw bytes as the body.
  ipcMain.handle('ea:upload', async (_e, { localPath, remotePath }) => {
    if (!fs.existsSync(localPath)) throw new Error(`Local file not found: ${localPath}`);
    const data = await fs.promises.readFile(localPath);
    const r = await eaFetch(`/api/fs/upload?path=${q(remotePath)}`, {
      method: 'POST',
      body: data,
      headers: { 'Content-Type': 'application/octet-stream' },
      timeoutMs: 5 * 60 * 1000,
    });
    if (!r.ok) throw new Error(`Upload failed: HTTP ${r.status}`);
    return { ok: true, bytes: data.length };
  });

  log.info('[ELF Arsenal] IPC handlers registered');
};
