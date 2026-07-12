'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const WebSocket = require('ws');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4':  'video/mp4',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.elf':  'application/octet-stream',
  '.bin':  'application/octet-stream',
};

// CSP for web mode — relaxes pork-cache:// restriction, adds ws: for WebSocket
const WEB_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' https://cdn.prosperopatches.com https://prosperopatches.com data: blob:",
  "media-src 'self' blob:",
  "frame-src http: https:",
  "connect-src 'self' ws: wss: http: https:",
].join('; ');

class WebUIServer {
  constructor({ appRoot, store, log, webHandlers, onRelayRequest }) {
    this.appRoot        = appRoot;
    this.store          = store;
    this.log            = log;
    this.webHandlers    = webHandlers; // Map<channel, handlerFn>
    this.onRelayRequest = onRelayRequest || (() => {});
    this.server         = null;
    this.wss            = null;
    this.clients        = new Set(); // /ws event-bus clients
    this.port           = null;
    this._indexHtml     = null; // cached modified index.html
    // Stream relay state
    this._svEncoderWs  = null;  // one encoder (Electron renderer)
    this._svViewers    = new Set(); // browser viewer WS connections
    this._svMeta       = null;  // { type:'meta', mimeType } from encoder
    this._svInitChunk  = null;  // first binary chunk (WebM init segment)
  }

  _allowedOrigins() {
    return new Set([
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
    ]);
  }

  _isAllowedOrigin(origin) {
    if (!origin || !this.port) return false;
    return this._allowedOrigins().has(origin);
  }

  _decodeIpcValue(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.__porkBinary === true && typeof value.base64 === 'string') {
      return Buffer.from(value.base64, 'base64');
    }
    if (Array.isArray(value)) return value.map(v => this._decodeIpcValue(v));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = this._decodeIpcValue(v);
    return out;
  }

  _encodeIpcValue(value) {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) {
      return { __porkBinary: true, base64: value.toString('base64') };
    }
    if (value instanceof Uint8Array) {
      return { __porkBinary: true, base64: Buffer.from(value).toString('base64') };
    }
    if (Array.isArray(value)) return value.map(v => this._encodeIpcValue(v));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this._encodeIpcValue(v);
      return out;
    }
    return value;
  }

  // ── Stream relay — encoder (Electron renderer) connection ────────────────────
  _handleEncoderWs(ws) {
    if (this._svEncoderWs) {
      try { this._svEncoderWs.terminate(); } catch (_) {}
    }
    this._svEncoderWs = ws;
    this._svInitChunk = null; // reset for new session
    this.log.info('[WebUI] Stream encoder connected');

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Text: codec metadata — forward to existing viewers
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'meta') {
            this._svMeta = msg;
            const text = data.toString();
            for (const v of this._svViewers) {
              if (v.readyState === WebSocket.WebSocket.OPEN) v.send(text);
            }
          }
        } catch (_) {}
        return;
      }
      // Binary: stream chunk — save first as init, relay all to viewers
      if (!this._svInitChunk) this._svInitChunk = data;
      for (const v of this._svViewers) {
        if (v.readyState === WebSocket.WebSocket.OPEN) {
          v.send(data, (err) => { if (err) this._svViewers.delete(v); });
        }
      }
    });

    ws.on('close', () => {
      this._svEncoderWs = null;
      this._svMeta      = null;
      this._svInitChunk = null;
      const msg = JSON.stringify({ type: 'no-stream' });
      for (const v of this._svViewers) {
        if (v.readyState === WebSocket.WebSocket.OPEN) v.send(msg);
      }
      this.log.info('[WebUI] Stream encoder disconnected');
    });

    ws.on('error', () => { try { ws.terminate(); } catch (_) {} });
  }

  // ── Stream relay — viewer (browser) connection ────────────────────────────────
  _handleViewerWs(ws) {
    this._svViewers.add(ws);
    this.log.info('[WebUI] Stream viewer connected');

    // Send current state to new viewer
    if (this._svMeta) {
      ws.send(JSON.stringify(this._svMeta));
    }
    if (this._svInitChunk) {
      ws.send(this._svInitChunk, (err) => { if (err) this._svViewers.delete(ws); });
    } else if (!this._svEncoderWs) {
      ws.send(JSON.stringify({ type: 'no-stream' }));
    }

    const cleanup = () => {
      this._svViewers.delete(ws);
      if (this._svViewers.size === 0) this.onRelayRequest(false);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // Trigger relay start when first viewer connects
    if (this._svViewers.size === 1) this.onRelayRequest(true);
  }

  // Build the modified index.html: replace CSP with web-friendly version
  _buildIndexHtml() {
    let html = fs.readFileSync(path.join(this.appRoot, 'renderer', 'index.html'), 'utf8');
    html = html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*\/>/,
      `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}"/>`
    );
    return html;
  }

  // Serve a local file, streaming it to the response
  _serveFile(res, filePath) {
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
    const stream = fs.createReadStream(filePath);
    // A read error after the headers are sent (file removed in the TOCTOU window,
    // EACCES, mid-stream I/O error) emits 'error' on a later tick — unhandled it
    // would crash the process. Tear down the response instead.
    stream.on('error', err => {
      this.log.warn(`[WebUI] read stream error for ${filePath}: ${err.message}`);
      res.destroy(err);
    });
    stream.pipe(res);
  }

  _handleRequest(req, res) {
    const url      = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;

    // ── POST /api/invoke — call a registered IPC handler ──────────────────────
    if (req.method === 'POST' && pathname === '/api/invoke') {
      if (!this._isAllowedOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let channel = '?';
        try {
          const parsed    = JSON.parse(body);
          channel         = parsed.channel;
          const args      = Array.isArray(parsed.args) ? this._decodeIpcValue(parsed.args) : [];
          const handler   = this.webHandlers.get(channel);
          if (!handler) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `No handler for: ${channel}` }));
            return;
          }
          const fakeEvent = { sender: { id: 0, getURL: () => '' } };
          const result    = await handler(fakeEvent, ...args);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: this._encodeIpcValue(result ?? null) }));
        } catch (e) {
          this.log.warn(`[WebUI] Handler "${channel}" threw:`, e.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }

    // ── GET /pork-cache/:filename — serve cached media files ──────────────────
    if (pathname.startsWith('/pork-cache/')) {
      const raw      = pathname.slice('/pork-cache/'.length);
      const safeName = path.basename(decodeURIComponent(raw))
        .replace(/\.\./g, '').replace(/[/\\]/g, '');
      const filePath = path.join(os.tmpdir(), 'porkfolio-media-thumb', safeName);
      this._serveFile(res, filePath);
      return;
    }

    // ── GET / or /index.html — serve modified index ───────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      if (!this._indexHtml) this._indexHtml = this._buildIndexHtml();
      const buf = Buffer.from(this._indexHtml, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }

    if (pathname === '/favicon.ico') {
      const iconPath = path.join(this.appRoot, 'build', 'icon.png');
      this._serveFile(res, iconPath);
      return;
    }

    // ── GET /pork-web-shim.js — the browser-side shim ────────────────────────
    if (pathname === '/pork-web-shim.js') {
      const shimPath = path.join(this.appRoot, 'renderer', 'pork-web-shim.js');
      this._serveFile(res, shimPath);
      return;
    }

    // ── GET /build/** — static build assets (icon, lang files, etc) ──────────
    if (pathname.startsWith('/build/')) {
      const sub      = pathname.slice('/build/'.length);
      const resolved = path.resolve(path.join(this.appRoot, 'build', sub));
      const base     = path.resolve(path.join(this.appRoot, 'build'));
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      this._serveFile(res, resolved);
      return;
    }

    // ── GET /src/** — src assets (xavatarElectronModule renderer, etc) ────────
    if (pathname.startsWith('/src/')) {
      const sub      = pathname.slice('/src/'.length);
      const resolved = path.resolve(path.join(this.appRoot, 'src', sub));
      const base     = path.resolve(path.join(this.appRoot, 'src'));
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      this._serveFile(res, resolved);
      return;
    }

    // ── GET everything else — renderer/ static files ──────────────────────────
    const sub      = pathname.slice(1); // strip leading /
    const resolved = path.resolve(path.join(this.appRoot, 'renderer', sub));
    const base     = path.resolve(path.join(this.appRoot, 'renderer'));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    this._serveFile(res, resolved);
  }

  start(port) {
    return new Promise((resolve, reject) => {
      if (this.server) { resolve(); return; }

      this.port       = port;
      this._indexHtml = null; // force rebuild on next request

      this.server = http.createServer((req, res) => {
        try {
          this._handleRequest(req, res);
        } catch (e) {
          this.log.error('[WebUI] Unhandled request error:', e);
          try { res.writeHead(500); res.end('Internal error'); } catch (_) {}
        }
      });

      this.wss = new WebSocket.WebSocketServer({ server: this.server });
      this.wss.on('connection', (ws, request) => {
        if (!this._isAllowedOrigin(request.headers.origin)) {
          try { ws.close(1008, 'Forbidden'); } catch (_) {}
          return;
        }
        const url      = new URL(request.url || '/', 'http://localhost');
        const pathname = url.pathname;
        if (pathname === '/sv-stream') {
          const role = url.searchParams.get('role');
          if (role === 'encoder') { this._handleEncoderWs(ws); return; }
          this._handleViewerWs(ws);
          return;
        }
        // /ws — general event-bus clients
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
        this.log.info('[WebUI] Browser client connected');
      });

      this.server.listen(port, '127.0.0.1', () => {
        this.log.info(`[WebUI] Listening on http://127.0.0.1:${port}`);
        resolve();
      });

      this.server.on('error', (e) => {
        this.log.error('[WebUI] Server error:', e.message);
        this.server = null;
        this.wss    = null;
        reject(e);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      for (const ws of this.clients)    { try { ws.terminate(); } catch (_) {} }
      for (const ws of this._svViewers) { try { ws.terminate(); } catch (_) {} }
      if (this._svEncoderWs) { try { this._svEncoderWs.terminate(); } catch (_) {} }
      this.clients.clear();
      this._svViewers.clear();
      this._svEncoderWs = null;
      this._svMeta      = null;
      this._svInitChunk = null;
      this.wss.close(() => {
        this.server.close(() => {
          this.server = null;
          this.wss    = null;
          this.port   = null;
          this.log.info('[WebUI] Server stopped');
          resolve();
        });
      });
    });
  }

  isRunning() {
    return !!(this.server && this.server.listening);
  }

  // Forward a main-process event to all connected browser clients
  broadcast(channel, ...args) {
    if (!this.clients.size) return;
    const msg = JSON.stringify({ channel, args });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.WebSocket.OPEN) {
        ws.send(msg, (err) => { if (err) this.clients.delete(ws); });
      }
    }
  }
}

module.exports = WebUIServer;
