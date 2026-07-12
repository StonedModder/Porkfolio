'use strict';

/**
 * PSNotifyModule
 * ──────────────
 * Drop this folder into any Node.js / Electron project.
 * Sends toast notifications to a PS5 running customPSNotify.js.
 *
 * QUICK START
 * ───────────
 *   const { PS5Notifier } = require('./PSNotifyModule');
 *
 *   const ps5 = new PS5Notifier('192.168.1.100');
 *   await ps5.send('Build finished!');
 *   await ps5.send('Deploy done', { subMessage: 'v2.1.0 is live' });
 *
 * ONE-SHOT (no instance needed)
 * ─────────────────────────────
 *   const { notify } = require('./PSNotifyModule');
 *   await notify('192.168.1.100', 'Hello PS5!');
 */

const net = require('net');

const DEFAULT_PORT    = 6969;
const DEFAULT_TIMEOUT = 5000; // ms

// ─── Low-level send ──────────────────────────────────────────────────────────

/**
 * Send a single notification to a PS5.
 *
 * @param {string} host            PS5 IP address or hostname
 * @param {string} message         Main toast body text
 * @param {object} [opts]
 * @param {string} [opts.subMessage]  Smaller line below the body
 * @param {number} [opts.port]        TCP port (default 6969)
 * @param {number} [opts.timeout]     Timeout in ms (default 5000)
 * @returns {Promise<{ok: boolean}>}  Resolves with the ACK from the PS5
 */
function notify(host, message, opts = {}) {
  const port      = opts.port       ?? DEFAULT_PORT;
  const timeout   = opts.timeout    ?? DEFAULT_TIMEOUT;
  const subMessage = opts.subMessage ?? '';

  if (!host)    return Promise.reject(new TypeError('host is required'));
  if (!message) return Promise.reject(new TypeError('message is required'));

  // Encode the JSON packet as explicit UTF-8 bytes so that emoji and other
  // multi-byte Unicode characters survive the trip to the PS5 intact.
  const packetBuf = Buffer.from(JSON.stringify({ message, subMessage }) + '\n', 'utf8');

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let raw  = '';
    let done = false;

    // Hard timeout — fires if the server never responds.
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port} after ${timeout}ms`));
    }, timeout);

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) return reject(err);
      try   { resolve(JSON.parse(raw.trim())); }
      catch { resolve({ ok: true }); }
    };

    sock.once('connect', () => {
      sock.write(packetBuf, (err) => {
        if (err) finish(err);
        // Don't close — wait for the {"ok":true} response from the PS5 server.
      });
    });

    sock.on('data', (chunk) => {
      raw += chunk.toString();
      // The PS5 server responds with {"ok":true} then keeps the socket open.
      // As soon as we have a complete JSON response, resolve and close.
      if (raw.includes('}')) finish(null);
    });

    // If the server does close its side, honour it.
    // If the server closes its side gracefully, honour it.
    sock.once('end', () => finish(null));
    sock.once('error', (err) => {
      // ECONNRESET means the server RST'd after receiving our packet — the
      // notification was delivered.  A genuine connection failure (wrong IP /
      // port not open) produces ECONNREFUSED or a timeout, never a reset.
      // Use setImmediate so any buffered 'data' events get one more tick to
      // fire and populate `raw` before we resolve.
      if (err.code === 'ECONNRESET') {
        setImmediate(() => finish(null));
      } else {
        finish(err);
      }
    });
  });
}

// ─── PS5Notifier class ───────────────────────────────────────────────────────

/**
 * Stateful client that remembers the PS5 host and default options.
 * Designed to be instantiated once per app and reused.
 *
 * @example
 *   const ps5 = new PS5Notifier('192.168.1.100');
 *   await ps5.send('Hello!');
 *   await ps5.send('Status', { subMessage: 'All good' });
 */
class PS5Notifier {
  /**
   * @param {string} host  PS5 IP address
   * @param {object} [defaults]
   * @param {number} [defaults.port]     Default port (6969)
   * @param {number} [defaults.timeout]  Default timeout ms (5000)
   */
  constructor(host, defaults = {}) {
    if (!host) throw new TypeError('PS5Notifier: host is required');
    this.host     = host;
    this.port     = defaults.port    ?? DEFAULT_PORT;
    this.timeout  = defaults.timeout ?? DEFAULT_TIMEOUT;
    this._history = [];
  }

  /**
   * Send a notification to the PS5.
   *
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.subMessage]
   * @param {number} [opts.port]      Override port for this call
   * @param {number} [opts.timeout]   Override timeout for this call
   * @returns {Promise<{ok: boolean}>}
   */
  async send(message, opts = {}) {
    const result = await notify(this.host, message, {
      subMessage: opts.subMessage ?? '',
      port:       opts.port       ?? this.port,
      timeout:    opts.timeout    ?? this.timeout,
    });

    this._history.push({
      ts: new Date().toISOString(),
      message,
      subMessage: opts.subMessage ?? '',
      ok: result.ok ?? true,
    });

    return result;
  }

  /**
   * Returns the last N notifications sent (default 50).
   * @param {number} [n]
   */
  history(n = 50) {
    return this._history.slice(-n);
  }

  /** Update the PS5 host at runtime (e.g. if IP changes). */
  setHost(host) {
    this.host = host;
  }

  toString() {
    return `PS5Notifier(${this.host}:${this.port})`;
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  /** One-shot function — no instance needed */
  notify,
  /** Stateful class — instantiate once and reuse */
  PS5Notifier,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT,
};
