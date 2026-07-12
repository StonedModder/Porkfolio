'use strict';

const ftp    = require('basic-ftp');
const path   = require('path');
const fs     = require('fs');
const stream = require('stream');
const log    = require('electron-log');

let client     = null;
let connected  = false;
let _lastCreds = null; // stored so dropped connections can be silently re-established

// Promise-chaining mutex — basic-ftp rejects concurrent operations on the same client.
// All public functions that use the singleton `client` must go through withLock().
let _lock = Promise.resolve();

function withLock(fn) {
  const p = _lock.then(fn);
  _lock = p.catch(() => {}); // keep chain alive even when fn rejects
  return p;
}

/**
 * Must be called from inside withLock().
 * Silently re-establishes the FTP control connection when the PS5's FTPD has
 * closed it between transfers (e.g. idle timeout, post-transfer disconnect).
 * Only reconnects if we have stored credentials from a previous connect() call.
 */
async function _ensureActive() {
  if (client && !client.closed) {
    // Liveness check: PWD gets an instant response on a live connection.
    // Race against 5 s to detect half-open / silently-dropped control sockets —
    // basic-ftp's client.closed is NOT updated when the PS5 FTPD closes server-side,
    // so without this check every control-channel command would hang indefinitely.
    try {
      await Promise.race([
        client.pwd(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('liveness timeout')), 5000)),
      ]);
      return; // still live
    } catch (_) {
      log.warn('[FTP] Liveness check failed — forcing reconnect');
      try { client.close(); } catch (_e) {}
      client = null;
    }
  }
  if (!_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  log.info('[FTP] Control connection dropped — auto-reconnecting…');
  if (client) { try { client.close(); } catch (_) {} }
  client = new ftp.Client(30000);
  client.ftp.verbose = false;
  await client.access({
    host:     _lastCreds.host,
    port:     parseInt(_lastCreds.port) || 21,
    user:     _lastCreds.user     || 'anonymous',
    password: _lastCreds.password || '',
    secure:   false,
  });
  connected = true;
  log.info('[FTP] Auto-reconnected to PS5');
}

// ── SFO Parser ────────────────────────────────────────────────────────────────
// Parses PS5 param.sfo binary files to extract game metadata.
// SFO format: magic(4) + version(4) + key_table_off(4) + data_table_off(4) + num_entries(4)
// Followed by index table (16 bytes/entry), key table, and data table.

function parseSfo(buf) {
  const result = { title: '', game_id: '', version: '', content_id: '' };
  try {
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46535000) return result; // "\0PSF"

    const keyOff  = buf.readUInt32LE(8);
    const dataOff = buf.readUInt32LE(12);
    const count   = buf.readUInt32LE(16);

    for (let i = 0; i < count; i++) {
      const e       = 20 + i * 16;
      const kOff    = buf.readUInt16LE(e);
      const fmt     = buf.readUInt16LE(e + 2);
      const dataLen = buf.readUInt32LE(e + 4);
      const dOff    = buf.readUInt32LE(e + 12);

      // Read null-terminated key
      let kEnd = keyOff + kOff;
      while (kEnd < buf.length && buf[kEnd] !== 0) kEnd++;
      const key = buf.slice(keyOff + kOff, kEnd).toString('utf8');

      // Read value
      const dStart = dataOff + dOff;
      let value = '';
      if (fmt === 0x0204 || fmt === 0x0004) {
        value = buf.slice(dStart, dStart + dataLen).toString('utf8').replace(/\0/g, '').trim();
      } else if (fmt === 0x0404) {
        value = buf.readUInt32LE(dStart).toString();
      }

      if (key === 'TITLE')                   result.title      = value;
      if (key === 'TITLE_ID')                result.game_id    = value;
      if (key === 'VERSION' || key === 'APP_VER') result.version = value;
      if (key === 'CONTENT_ID')              result.content_id = value;
    }
  } catch (e) {
    log.warn('[FTP] SFO parse error:', e.message);
  }
  return result;
}

// ── Download to buffer ────────────────────────────────────────────────────────

async function downloadToBuffer(c, remotePath) {
  const chunks   = [];
  const writable = new stream.Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  await c.downloadTo(writable, remotePath);
  return Buffer.concat(chunks);
}

// ── Connection ────────────────────────────────────────────────────────────────

async function connect({ host, port, user, password }) {
  if (client) { try { client.close(); } catch (_) {} }
  _lock = Promise.resolve(); // reset lock — discard any queued ops for the old client

  // 30-second idle timeout. basic-ftp applies this to the data socket too, so it only
  // fires when NO bytes have flowed for 30s — i.e. a truly stalled connection.
  // During an active transfer the socket is continuously receiving/sending, so this
  // timer resets on every chunk and never fires while data is moving.
  client = new ftp.Client(30000);
  client.ftp.verbose = false;

  await client.access({
    host,
    port:     parseInt(port)  || 21,
    user:     user            || 'anonymous',
    password: password        || '',
    secure:   false,
  });

  _lastCreds = { host, port, user, password };
  connected  = true;
  log.info(`[FTP] Connected to ${host}:${port}`);
}

async function disconnect() {
  if (client) { client.close(); client = null; }
  connected  = false;
  _lastCreds = null; // clear creds so _ensureActive won't reconnect after explicit disconnect
  _lock = Promise.resolve();
  log.info('[FTP] Disconnected');
}

function isConnected() {
  return connected && client != null && !client.closed;
}

/** True if we have stored credentials that _ensureActive() can use to reconnect. */
function hasCredentials() {
  return _lastCreds !== null;
}

// ── Game Scanner ──────────────────────────────────────────────────────────────
// PS5 FTPD typically exposes game folders under /mnt/sandbox/pfsmnt/
// Each game directory is named like PPSA#####-app0

const SCAN_PATHS = [
  '/mnt/sandbox/pfsmnt/',
  '/user/app/',
  '/mnt/data/app/',
];

async function scanGames(onProgress, customPaths) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
  await _ensureActive();
  const c = client;
  const pathsToScan = (customPaths && customPaths.length > 0)
    ? customPaths.map(p => p.endsWith('/') ? p : p + '/')
    : SCAN_PATHS;

  const games = [];
  const seen  = new Set();

  for (const basePath of pathsToScan) {
    let list;
    try {
      list = await c.list(basePath);
    } catch (_) {
      continue; // path doesn't exist on this system
    }

    for (const item of list) {
      if (item.type !== ftp.FileType.Directory) continue;

      // Match title ID pattern anywhere in the folder name
      // e.g. "PPSA03644-app", "PPSA03644", "Two Point Campus 01.029 PPSA03644"
      const match = item.name.match(/([A-Z]{4}\d{5})/);
      if (!match) continue;

      const game_id = match[1];
      if (seen.has(game_id)) continue;
      seen.add(game_id);

      const ftpPath = basePath + item.name;
      const game = {
        game_id,
        title:       game_id,
        content_id:  '',
        version:     '',
        size:        item.size || 0,
        installed:   1,
        backed_up:   0,
        ftp_path:    ftpPath,
        last_scanned: new Date().toISOString(),
      };

      // Try to enrich from param.sfo
      for (const sfoRel of ['/sce_sys/param.sfo', '/param.sfo']) {
        try {
          const buf = await downloadToBuffer(c, ftpPath + sfoRel);
          const sfo = parseSfo(buf);
          if (sfo.title)      game.title      = sfo.title;
          if (sfo.version)    game.version    = sfo.version;
          if (sfo.content_id) game.content_id = sfo.content_id;
          if (sfo.game_id)    game.game_id    = sfo.game_id;
          break;
        } catch (_) {}
      }

      games.push(game);
      if (onProgress) onProgress({ current: games.length, game });
    }
  }

  log.info(`[FTP] Scan complete — found ${games.length} games`);
  return games;
  }); // end withLock
}

// ── Internal transfer helpers (accept explicit client) ────────────────────────

async function _downloadFileWith(c, remotePath, localPath, onProgress) {
  c.trackProgress(info => { if (onProgress) onProgress(info); });
  try {
    await c.downloadTo(localPath, remotePath);
  } finally {
    c.trackProgress();
  }
}

// Ensure every component of a remote path exists by issuing MKD for each level.
// MKD is safe to call on existing dirs — PS5 FTPD returns 550 which sendIgnoringError swallows.
async function _ensureRemoteDir(c, remoteDir) {
  const parts = remoteDir.replace(/^\/+/, '').split('/');
  let current = '';
  for (const part of parts) {
    if (!part) continue;
    current += '/' + part;
    try { await c.sendIgnoringError('MKD ' + current); } catch (_) {}
  }
}

async function _uploadFileWith(c, localPath, remotePath, onProgress) {
  // Ensure the remote parent directory exists before uploading.
  const remoteDir = remotePath.lastIndexOf('/') > 0
    ? remotePath.substring(0, remotePath.lastIndexOf('/'))
    : '';
  if (remoteDir) await _ensureRemoteDir(c, remoteDir);
  // basic-ftp's trackProgress does not include the file size in its callback,
  // so we stat it upfront and inject it into every progress event ourselves.
  let fileSize = 0;
  try { fileSize = fs.statSync(localPath).size; } catch (_) {}
  c.trackProgress(info => { if (onProgress) onProgress({ ...info, size: fileSize }); });
  try {
    await c.uploadFrom(localPath, remotePath);
  } finally {
    c.trackProgress();
  }
}

// Upload an entire directory's contents into a remote directory (recursive).
// Fires onProgress({ file, bytesOverall, filesDone, filesTotal }) for each file.
// hooks: { onStart({ count, totalBytes }), onRetry({ rel, attempt, maxAttempts, error }),
//          onFileFailed({ rel, attempts, error }) }
//
// APPROACH: flat scan → MKD pre-pass → per-file cd(absolute)+STOR(filename)
//   • No recursive CWD stack / no cdup() — a single failed CDUP can abort the
//     entire upload on PS5 FTPD (proven root cause of the "13 files" cutoff).
//   • Every file independently navigates to its target directory via absolute
//     CWD so a previous failure can never leave CWD in the wrong place.
//   • MKD pre-pass (sendIgnoringError) creates all subdirs before any transfer
//     starts so the cd() per file always lands in an existing directory.
async function _uploadDirectoryWith(c, localDir, remoteDir, onProgress, hooks = {}) {
  // ── Active client ref — refreshed on reconnect ─────────────────────────────
  // hooks._reconnect() (if provided) closes the stale client, reconnects, and
  // returns the fresh client object.  Callers (uploadDirectory / createClient)
  // supply this callback so we can recover from dead control-channel sockets
  // without leaking the reconnect logic into this general-purpose function.
  const _reconnect = hooks._reconnect || null;
  let ac = c; // "active client" — may be swapped after a reconnect

  async function tryRefreshClient() {
    if (!_reconnect) return;
    try {
      try { ac.close(); } catch (_) {} // cancel any ghost operations on the stale client
      const fresh = await _reconnect();
      if (fresh) { ac = fresh; log.info('[FTP] uploadDirectory: client refreshed after error'); }
    } catch (_re) {
      log.warn(`[FTP] uploadDirectory: client refresh failed: ${_re.message}`);
    }
  }

  // ── PHASE 1: flat-scan local tree ──────────────────────────────────────────
  const allFiles = []; // { localFull, remoteFileDir, remoteFileName, rel }
  const allDirs  = new Set([remoteDir]);

  function scanLocal(localPath, remotePath) {
    let entries;
    try { entries = fs.readdirSync(localPath, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const localFull  = path.join(localPath, e.name);
      const remoteFull = remotePath + '/' + e.name;
      if (e.isDirectory()) {
        allDirs.add(remoteFull);
        scanLocal(localFull, remoteFull);
      } else {
        allFiles.push({
          localFull,
          remoteFileDir:  remotePath,
          remoteFileName: e.name,
          rel:            remoteFull.slice(remoteDir.length + 1),
        });
      }
    }
  }

  scanLocal(localDir, remoteDir);

  const filesTotal = allFiles.length;
  const totalBytes = allFiles.reduce((sum, { localFull }) => {
    try { return sum + fs.statSync(localFull).size; } catch (_) { return sum; }
  }, 0);

  log.info(`[FTP] uploadDirectory: localDir="${localDir}" remoteDir="${remoteDir}" filesFound=${filesTotal} dirs=${allDirs.size}`);

  try { hooks.onStart?.({ count: filesTotal, totalBytes }); } catch (_) {}

  // ── PHASE 2: pre-create all remote directories (shallow-first) ─────────────
  // Wrap in a 10-second race: a hung MKD means the control channel is dead.
  // If it times out, tryRefreshClient reconnects before the upload loop starts.
  const sortedDirs = [...allDirs].sort((a, b) => a.split('/').length - b.split('/').length);
  log.info(`[FTP] MKD pre-pass for ${sortedDirs.length} dirs`);
  for (const dir of sortedDirs) {
    for (let mkdAttempt = 1; mkdAttempt <= 2; mkdAttempt++) {
      try {
        await Promise.race([
          ac.sendIgnoringError('MKD ' + dir),
          new Promise((_, rej) => setTimeout(() => rej(new Error('MKD timeout')), 10000)),
        ]);
        break; // success
      } catch (mkdErr) {
        log.warn(`[FTP] MKD attempt ${mkdAttempt}/2 threw: ${dir} — ${mkdErr.message}`);
        if (mkdAttempt < 2) await tryRefreshClient();
      }
    }
  }

  // ── PHASE 3: upload files — each one navigates its own absolute remote dir ──
  // cd + uploadFrom are both wrapped in a 30-second race.  basic-ftp has no
  // command-level timeout on the control channel; a half-open TCP socket causes
  // CWD / STOR to hang forever.  On timeout (or any other network error) we
  // refresh the client so the retry gets a clean connection.
  let filesDone = 0;
  const MAX_RETRIES = 3;

  // ── PHASE 3: parallel file upload worker pool ─────────────────────────────
  // hooks.fileConcurrency workers each own a separate FTP connection and consume
  // from a shared queue so N files transfer simultaneously. fileConcurrency=1
  // gives the same sequential behaviour as before.
  const fileQueue = [...allFiles]; // workers consume via .shift() — safe in single-threaded JS

  // Primary slot uses `ac` (already live after Phase 2).
  // Extra slots get fresh raw basic-ftp Client objects from the hook.
  const workerStates = [{ ac, isExtra: false }];
  const fileConcurrency = Math.max(1, hooks.fileConcurrency || 1);
  if (fileConcurrency > 1 && hooks._createWorkerClient) {
    for (let i = 1; i < fileConcurrency; i++) {
      try {
        const raw = await hooks._createWorkerClient();
        workerStates.push({ ac: raw, isExtra: true });
      } catch (e) {
        log.warn(`[FTP] File worker ${i} connect failed — skipping: ${e.message}`);
      }
    }
  }

  async function runFileWorker(state) {
    while (true) {
      const item = fileQueue.shift();
      if (!item) return; // queue exhausted
      const { localFull, remoteFileDir, remoteFileName, rel } = item;
      let currentFileSize = 0;
      try { currentFileSize = fs.statSync(localFull).size; } catch (_) {}
      log.info(`[FTP] Uploading [${filesDone + 1}/${filesTotal}] "${rel}" → cd("${remoteFileDir}") + STOR "${remoteFileName}"`);
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        state.ac.trackProgress(info => {
          if (onProgress) onProgress({ file: rel, filesDone: filesDone + 1, filesTotal, currentFileSize, ...info });
        });
        try {
          // Absolute CWD + filename-only STOR — only reliable combo on PS5 FTPD.
          await Promise.race([
            (async () => {
              await state.ac.cd(remoteFileDir);
              await state.ac.uploadFrom(localFull, remoteFileName);
            })(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('upload timeout')), 30000)),
          ]);
          break; // success
        } catch (uploadErr) {
          if (uploadErr.message === 'Cancelled') throw uploadErr;
          log.warn(`[FTP] attempt ${attempt}/${MAX_RETRIES} FAILED for "${rel}": ${uploadErr.message}`);
          if (state.isExtra && hooks._createWorkerClient) {
            // Replace this extra worker's client with a fresh connection.
            try { state.ac.close(); } catch (_) {}
            try { state.ac = await hooks._createWorkerClient(); } catch (re) {
              log.warn(`[FTP] Extra worker reconnect failed: ${re.message}`);
            }
          } else {
            // Primary client: use the shared reconnect hook (updates outer `ac`).
            await tryRefreshClient();
            state.ac = ac;
          }
          if (attempt < MAX_RETRIES) {
            try { hooks.onRetry?.({ rel, attempt, maxAttempts: MAX_RETRIES, error: uploadErr.message }); } catch (_) {}
            await new Promise(r => setTimeout(r, attempt * 1000));
          } else {
            try { hooks.onFileFailed?.({ rel, attempts: MAX_RETRIES, error: uploadErr.message }); } catch (_) {}
            log.error(`[FTP] Giving up on "${rel}" after ${MAX_RETRIES} attempts: ${uploadErr.message}`);
            // Do NOT throw — skip and continue with the rest
          }
        } finally {
          state.ac.trackProgress();
        }
      }
      filesDone++;
    }
  }

  try {
    await Promise.all(workerStates.map(s => runFileWorker(s)));
  } finally {
    // Close extra worker connections — primary is managed by the caller.
    for (const s of workerStates) {
      if (s.isExtra) try { s.ac.close(); } catch (_) {}
    }
  }

  // Final progress event so UI shows the completed count.
  if (onProgress && filesTotal > 0) {
    try { onProgress({ file: '', filesDone: filesTotal, filesTotal, bytes: 0, bytesOverall: 0 }); } catch (_) {}
  }

  log.info(`[FTP] uploadDirectory done — ${filesDone}/${filesTotal} file(s) to ${remoteDir}`);
}

// Download an entire remote directory tree into a local directory (recursive).
// Fires onProgress({ file, filesDone, filesTotal, bytes, bytesOverall }) for each chunk.
async function _downloadDirectoryWith(c, remoteDir, localDir, onProgress) {
  // Walk the remote tree first so we know the total file count upfront.
  async function collectRemoteFiles(rDir, relBase) {
    let list;
    try { list = await c.list(rDir); } catch (_) { return []; }
    const out = [];
    for (const entry of list) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.type === ftp.FileType.Directory) {
        out.push(...await collectRemoteFiles(`${rDir}/${entry.name}`, rel));
      } else {
        out.push({ remotePath: `${rDir}/${entry.name}`, rel, size: entry.size || 0 });
      }
    }
    return out;
  }

  const files = await collectRemoteFiles(remoteDir, '');
  let filesDone    = 0;
  let filesFailed  = 0;
  let bytesOverall = 0;

  for (const { remotePath, rel, size } of files) {
    // Build the local path, converting forward-slash separators to OS separators.
    const localPath = path.join(localDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    // Report 1-indexed "current file" so the UI shows N/N not (N-1)/N
    c.trackProgress(info => {
      if (onProgress) onProgress({
        file:         rel,
        filesDone:    filesDone + 1,
        filesTotal:   files.length,
        bytes:        info.bytes        || 0,
        bytesOverall: bytesOverall + (info.bytes || 0),
      });
    });
    try {
      await c.downloadTo(localPath, remotePath);
    } catch (dlErr) {
      filesFailed++;
      log.warn(`[FTP] downloadDirectory: skipping ${rel} — ${dlErr.message}`);
    } finally {
      c.trackProgress(); // clear tracker between files
    }
    bytesOverall += size;
    filesDone++;
  }

  // Fire a final progress event so the UI reflects the true completed count
  if (onProgress && files.length > 0) {
    try { onProgress({ file: '', filesDone: files.length, filesTotal: files.length, bytes: 0, bytesOverall }); } catch (_) {}
  }

  log.info(`[FTP] downloadDirectory done — ${filesDone - filesFailed}/${files.length} file(s) from ${remoteDir}${filesFailed ? `, ${filesFailed} skipped` : ''}`);
}

// ── Public transfer API (uses singleton client) ───────────────────────────────

async function downloadFile(remotePath, localPath, onProgress) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    return _downloadFileWith(client, remotePath, localPath, onProgress);
  });
}

// Fetch only the first `maxBytes` of a remote file.  Used to grab enough of a
// webm clip to decode the first video frame without downloading the full file.
// After the partial download the control channel is in an unknown state so the
// client is force-closed; _ensureActive() will reconnect on the next operation.
async function downloadPartialFile(remotePath, localPath, maxBytes) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();

    let bytesWritten  = 0;
    let limitReached  = false;
    const fileStream  = fs.createWriteStream(localPath);

    const limiter = new stream.Writable({
      write(chunk, _enc, cb) {
        if (limitReached) { cb(); return; }
        const remaining = maxBytes - bytesWritten;
        const slice     = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
        bytesWritten   += slice.length;
        fileStream.write(slice, () => {
          if (bytesWritten >= maxBytes) {
            limitReached = true;
            fileStream.end();
            // Destroy triggers an error in basic-ftp which aborts the data transfer.
            // We intentionally swallow that error below.
            this.destroy(new Error('partial-limit-reached'));
          }
          cb();
        });
      },
      final(cb) { fileStream.end(cb); },
    });

    try {
      await client.downloadTo(limiter, remotePath);
    } catch (err) {
      if (!limitReached) {
        // Unexpected error — surface it
        try { fileStream.destroy(); } catch (_) {}
        throw err;
      }
      // Intentional abort — fall through
    } finally {
      // Always force-reconnect after a partial download so the next FTP
      // operation gets a clean control channel via _ensureActive().
      try { client.close(); } catch (_) {}
      client = null;
    }

    // Wait for the file write to flush if not already closed
    if (!fileStream.closed && !fileStream.destroyed) {
      await new Promise((res, rej) => {
        fileStream.once('finish', res);
        fileStream.once('error',  rej);
        if (!fileStream.writableEnded) fileStream.end();
      });
    }
  });
}

async function uploadFile(localPath, remotePath, onProgress) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    return _uploadFileWith(client, localPath, remotePath, onProgress);
  });
}

async function uploadDirectory(localDir, remoteDir, onProgress, hooks) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    // Provide a reconnect callback so _uploadDirectoryWith can recover mid-upload
    // from a dropped control-channel socket without hanging the whole queue.
    const _reconnect = async () => {
      await _ensureActive(); // reconnects singleton `client` if needed
      return client;
    };
    return _uploadDirectoryWith(client, localDir, remoteDir, onProgress, { ...hooks, _reconnect });
  });
}

async function downloadDirectory(remoteDir, localDir, onProgress) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    return _downloadDirectoryWith(client, remoteDir, localDir, onProgress);
  });
}

async function listRemote(remotePath) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    try {
      const list = await client.list(remotePath);
      return list
        .filter(f => f.type === ftp.FileType.File)
        .map(f => ({ name: f.name, size: f.size || 0 }));
    } catch (e) {
      log.warn(`[FTP] listRemote failed for ${remotePath}: ${e.message}`);
      return [];
    }
  });
}

async function deleteRemote(remotePath) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    await client.remove(remotePath);
    log.info(`[FTP] Deleted remote file: ${remotePath}`);
  });
}

// ── FTP directory browser ─────────────────────────────────────────────────────

async function removeDir(remotePath) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    await client.removeDir(remotePath);
    log.info(`[FTP] Removed directory: ${remotePath}`);
  });
}

async function listDir(remotePath) {
  if (!connected && !_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return withLock(async () => {
    await _ensureActive();
    try {
      const list = await client.list(remotePath);
      return list
        .map(f => ({
          name:       f.name,
          isDir:      f.type === ftp.FileType.Directory,
          size:       f.size || 0,
          modifiedAt: f.modifiedAt || null,  // Date | null
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch (e) {
      log.info(`[FTP] listDir failed for ${remotePath}: ${e.message}`);
      throw e;
    }
  });
}

// ── Raw client factory (for parallel file workers inside _uploadDirectoryWith) ──
// Returns the raw basic-ftp Client object so _uploadDirectoryWith can use
// cd / uploadFrom / trackProgress directly. Caller must call .close() when done.
async function createRawClient({ host, port, user, password }) {
  const c = new ftp.Client(30000);
  c.ftp.verbose = false;
  await c.access({
    host,
    port:     parseInt(port) || 21,
    user:     user           || 'anonymous',
    password: password       || '',
    secure:   false,
  });
  log.info(`[FTP] Raw worker client connected to ${host}:${port}`);
  return c;
}

// ── Extra client factory (for concurrent transfer slots) ──────────────────────
// Creates a new, independently-connected FTP client from the provided credentials.
// Callers are responsible for calling .close() when done.

async function createClient({ host, port, user, password }) {
  const c = new ftp.Client(30000); // idle timeout — resets on every chunk, so safe for large files
  c.ftp.verbose = false;
  await c.access({
    host,
    port:     parseInt(port) || 21,
    user:     user           || 'anonymous',
    password: password       || '',
    secure:   false,
  });
  log.info(`[FTP] Extra client connected to ${host}:${port}`);
  return {
    uploadFile:        (local, remote, onProg) => _uploadFileWith(c, local, remote, onProg),
    uploadDirectory:   (localDir, remoteDir, onProg, hooks) => {
      // Reconnect callback for the dedicated client: close + re-access using the
      // same credentials captured in the createClient() closure.
      const _reconnect = async () => {
        try { c.close(); } catch (_) {}
        await c.access({ host, port: parseInt(port) || 21, user: user || 'anonymous', password: password || '', secure: false });
        log.info(`[FTP] Extra client reconnected to ${host}:${port}`);
        return c; // same object — re-used after re-access
      };
      return _uploadDirectoryWith(c, localDir, remoteDir, onProg, { ...hooks, _reconnect });
    },
    downloadFile:      (remote, local, onProg) => _downloadFileWith(c, remote, local, onProg),
    downloadDirectory: (remote, local, onProg) => _downloadDirectoryWith(c, remote, local, onProg),
    close:           () => { try { c.close(); } catch (_) {} log.info('[FTP] Extra client closed'); },
    get closed()     { return c.closed; },
  };
}

// ── Dedicated single-file download (for large media) ─────────────────────────
// Opens a throwaway FTP connection with a generous idle timeout (5 min) so large
// video transfers aren't killed by the shared 30-second timeout.  Does NOT hold
// the singleton lock — other FTP operations can proceed in parallel.
//
// onProgress receives { bytes, bytesOverall, total } where `total` is the remote
// file size (0 if unavailable).
async function downloadFileFresh(remotePath, localPath, onProgress) {
  if (!_lastCreds) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const c = new ftp.Client(300_000); // 5-minute idle timeout
  c.ftp.verbose = false;

  try {
    await c.access({
      host:     _lastCreds.host,
      port:     parseInt(_lastCreds.port) || 21,
      user:     _lastCreds.user     || 'anonymous',
      password: _lastCreds.password || '',
      secure:   false,
    });

    // Grab remote file size so callers can show a real percentage
    let total = 0;
    try { total = await c.size(remotePath); } catch (_) {}

    c.trackProgress(info => {
      if (onProgress) onProgress({ bytes: info.bytes, bytesOverall: info.bytesOverall, total });
    });

    try {
      await c.downloadTo(localPath, remotePath);
    } finally {
      c.trackProgress();
    }
  } finally {
    try { c.close(); } catch (_) {}
  }
}

module.exports = { connect, disconnect, isConnected, hasCredentials, scanGames, listDir, removeDir, downloadFile, downloadFileFresh, downloadPartialFile, uploadFile, uploadDirectory, downloadDirectory, listRemote, deleteRemote, createClient, createRawClient };
