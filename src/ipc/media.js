'use strict';

// Manual form construction for file uploads. Explicit knownLength forces
// Content-Length, avoiding chunked transfer encoding that catbox's server has
// historically mishandled for large PS5 clips.
const _nodeFetch    = require('node-fetch');
const _NodeFormData = require('form-data');

module.exports = function register(ipcMain, { win, store, log, ftp, shell, dialog, path, fs, os, http, https, ffmpegPath, spawn, transferMgr, ps5Notify, eNet, app, BrowserWindow }) {
// ── Media (Screenshots & Clips) ───────────────────────────────────────────────

// Recursively walk an FTP directory, collecting all files whose extension
// matches `ext`.  The PS5 stores media like:
//   /user/av_contents/photo/{AppId}/{GameId}/{hashFolder}/{file.jpg}
//   /user/av_contents/video/{AppId}/{GameId}/{hashFolder}/{file.webm}
// We extract game_id from the folder that looks like a PPSA/CUSA id (depth 2
// from base), but fall back to whatever is at depth 1 if nothing matches.
async function scanMediaDir(basePath, type, ext, items) {
  const GAME_ID_RE = /^[A-Z]{2,4}\d{5}/i;
  async function recurse(dirPath, depth) {
    if (depth > 6) return; // safety cap
    let entries;
    try { entries = await ftp.listDir(dirPath); } catch (_) { return; }
    for (const entry of entries) {
      const childPath = `${dirPath}/${entry.name}`;
      if (entry.isDir) {
        await recurse(childPath, depth + 1);
      } else {
        const entryExt = entry.name.split('.').pop().toLowerCase();
        if (entryExt === ext) {
          // Extract game_id from path segments relative to basePath
          const rel      = dirPath.slice(basePath.length).replace(/^\//, '');
          const segs     = rel.split('/').filter(Boolean);
          // Prefer the segment that looks like a game ID (PPSA/CUSA); fall back to seg[1] → seg[0]
          const game_id  = segs.find(s => GAME_ID_RE.test(s))
                        || segs[1] || segs[0] || 'Unknown';

          // Parse capture timestamp from PS5 filename: YYYYMMDD_HHMMSS_xxxxxxxx.ext
          // This is more reliable than FTP modifiedAt which may be missing or offset.
          let capturedAt = null;
          const fnMatch  = entry.name.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
          if (fnMatch) {
            const [, yr, mo, dy, hr, mn, sc] = fnMatch;
            capturedAt = new Date(`${yr}-${mo}-${dy}T${hr}:${mn}:${sc}`).getTime();
          } else if (entry.modifiedAt instanceof Date) {
            capturedAt = entry.modifiedAt.getTime();
          }

          items.push({ type, game_id, filename: entry.name, size: entry.size, remotePath: childPath, capturedAt });
          win?.webContents.send('media:scan:progress', { game_id, type, found: items.length });
        }
      }
    }
  }
  await recurse(basePath, 0);
}

ipcMain.handle('media:scan', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const SOURCES = [
    { dir: '/user/av_contents/photo', type: 'screenshot', ext: 'jpg'  },
    { dir: '/user/av_contents/video', type: 'clip',       ext: 'webm' },
  ];
  const items = [];
  for (const src of SOURCES) await scanMediaDir(src.dir, src.type, src.ext, items);

  if (store.get('media.psNotify.enabled', true)) {
    const shots = items.filter(i => i.type === 'screenshot').length;
    const clips = items.filter(i => i.type === 'clip').length;
    const parts = [];
    if (shots) parts.push(`${shots} screenshot${shots !== 1 ? 's' : ''}`);
    if (clips) parts.push(`${clips} clip${clips !== 1 ? 's' : ''}`);
    ps5Notify('Media Scan Complete', parts.length ? parts.join(', ') : 'No media found');
  }

  return items;
});

// Media file cache — shared by fetch-thumb, get-cache-path, open, discord-send
const _mediaCacheDir = path.join(os.tmpdir(), 'porkfolio-media-thumb');
const _mediaCacheMap = new Map(); // remotePath → localPath

// Ensure a remote file is in the local cache; returns the local path.
async function _ensureMediaCached(remotePath) {
  if (_mediaCacheMap.has(remotePath)) {
    const cached = _mediaCacheMap.get(remotePath);
    if (typeof cached === 'string' && fs.existsSync(cached)) return cached;
  }
  fs.mkdirSync(_mediaCacheDir, { recursive: true });
  const safe      = remotePath.replace(/[^a-zA-Z0-9._-]/g, '_');
  const localPath = path.join(_mediaCacheDir, safe);
  if (!fs.existsSync(localPath)) await ftp.downloadFile(remotePath, localPath);
  _mediaCacheMap.set(remotePath, localPath);
  return localPath;
}

// Screenshot thumbnails — returns a data URL (JPEGs are small, ≤2 MB).
// Video clips must use media:get-cache-path + the pork-cache:// protocol
// instead; encoding a 30 MB webm as base64 over IPC is not viable.
ipcMain.handle('media:fetch-thumb', async (_e, { remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected');
  const ext = path.extname(remotePath).slice(1).toLowerCase();
  if (ext === 'webm') throw new Error('Use media:get-cache-path for video files');
  const localPath = await _ensureMediaCached(remotePath);
  const buf  = fs.readFileSync(localPath);
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${buf.toString('base64')}`;
});

// Returns the safe filename for use in pork-cache://<safeName> URLs.
// Downloads the file first if not already cached.
ipcMain.handle('media:get-cache-path', async (_e, { remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected');
  const localPath = await _ensureMediaCached(remotePath);
  return path.basename(localPath); // just the filename — renderer builds the URL
});

// Download just the first 4 MB of a webm clip for thumbnail extraction.
// The partial file is enough for Chromium's <video> element to decode the first
// cluster of frames.  Returns a pork-cache:// safe filename so the renderer
// never needs to base64-encode a large buffer.
const _VIDEO_PREVIEW_BYTES = 4 * 1024 * 1024; // 4 MB
ipcMain.handle('media:fetch-video-preview', async (_e, { remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected');
  fs.mkdirSync(_mediaCacheDir, { recursive: true });
  const safe        = remotePath.replace(/[^a-zA-Z0-9._-]/g, '_');
  const previewName = `preview_${safe}`;
  const localPath   = path.join(_mediaCacheDir, previewName);
  if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
    win?.webContents.send('media:thumb:progress', { remotePath, state: 'downloading' });
    await ftp.downloadPartialFile(remotePath, localPath, _VIDEO_PREVIEW_BYTES);
  }
  win?.webContents.send('media:thumb:progress', { remotePath, state: 'decoding' });
  return previewName;
});

// ── catbox.moe uploader ───────────────────────────────────────────────────────
// Uses manual form-data + node-fetch for file uploads with explicit knownLength
// so Content-Length is set correctly (avoids chunked transfer encoding which
// catbox's server mishandles).
//
// Retries up to MAX_RETRIES times with exponential backoff on transient errors.
const _CATBOX_MAX_RETRIES  = 3;
const _CATBOX_TIMEOUT_MS   = 10 * 60 * 1000; // 10 minutes per attempt
const _CATBOX_API          = 'https://catbox.moe/user/api.php';

const _MIME_BY_EXT = { webm: 'video/webm', mp4: 'video/mp4', jpg: 'image/jpeg', png: 'image/png' };

async function _catboxUpload(filePath, onRetry = null) {
  let lastErr;

  const stat   = (() => { try { return fs.statSync(filePath); } catch (_) { return null; } })();
  const sizeKB = stat ? (stat.size / 1024).toFixed(1) : '?';
  const ext    = path.extname(filePath).slice(1).toLowerCase();
  const mime   = _MIME_BY_EXT[ext] || 'application/octet-stream';
  console.log(`[catbox] Starting upload: ${filePath} (${sizeKB} KB, ${mime})`);

  for (let attempt = 1; attempt <= _CATBOX_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        const backoff = 3000 * (attempt - 1);
        console.log(`[catbox] Waiting ${backoff}ms before retry ${attempt}/${_CATBOX_MAX_RETRIES}...`);
        await new Promise(r => setTimeout(r, backoff));
        onRetry?.(attempt, _CATBOX_MAX_RETRIES);
        log.warn(`[catbox] Retry ${attempt}/${_CATBOX_MAX_RETRIES} after: ${lastErr?.message}`);
      }

      console.log(`[catbox] Attempt ${attempt}/${_CATBOX_MAX_RETRIES} — uploading...`);
      const t0 = Date.now();

      const form = new _NodeFormData();
      form.append('reqtype', 'fileupload');
      form.append('fileToUpload', fs.createReadStream(filePath), {
        filename:    path.basename(filePath),
        contentType: mime,
        knownLength: stat?.size,
      });

      const uploadPromise = _nodeFetch(_CATBOX_API, {
        method:  'POST',
        body:    form,
        headers: form.getHeaders(),
      }).then(res => {
        console.log(`[catbox] HTTP ${res.status} ${res.statusText} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return res.text();
      }).then(text => {
        console.log(`[catbox] Response body: ${text.slice(0, 200)}`);
        return text.trim();
      });

      const timeoutErr = new Error(`catbox.moe upload timed out after ${_CATBOX_TIMEOUT_MS / 1000}s`);
      timeoutErr.code  = 'ETIMEDOUT';
      const timeoutPromise = new Promise((_, rej) =>
        setTimeout(() => rej(timeoutErr), _CATBOX_TIMEOUT_MS)
      );

      const url = await Promise.race([uploadPromise, timeoutPromise]);
      if (!url || !url.startsWith('https://')) {
        const err = new Error(`Unexpected catbox response: ${url}`);
        err.code = 'EBADRESPONSE';
        throw err;
      }
      console.log(`[catbox] Upload complete in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${url}`);
      return url;
    } catch (err) {
      lastErr = err;
      const transient = err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
                        err.code === 'ETIMEDOUT'  || err.code === 'EBADRESPONSE' ||
                        err.message?.includes('timed out');
      console.error(`[catbox] Attempt ${attempt} failed (transient=${transient}): [${err.code}] ${err.message}`);
      if (!transient) throw err;
    }
  }
  throw new Error(`catbox.moe upload failed after ${_CATBOX_MAX_RETRIES} attempts: ${lastErr?.message}`);
}

// ── Discord share ─────────────────────────────────────────────────────────────
// Screenshots → attached directly as a Discord webhook image embed.
// Video clips → download webm from PS5, upload to catbox.moe,
//               post link to Discord, then delete temp file.
//
// Progress events emitted to renderer (media:discord:progress):
//   { remotePath, state: 'downloading',    pct }   — FTP download   0–100
//   { remotePath, state: 'uploading-video',pct }   — catbox upload  0–100
//   { remotePath, state: 'sending'             }   — Discord POST
//
// Thumbnail event (media:discord:thumb):
//   { remotePath, dataUrl }  — jpeg frame extracted from the local mp4


/**
 * Verify a downloaded WebM actually contains video data.
 *
 * PS5 clips sometimes have a valid EBML container (headers, track info, cue
 * index) but the Cluster holding the actual VP9/Opus packets is entirely
 * zeroed out — either due to a corrupt recording or an FTP transfer issue.
 * ffmpeg produces a confusing "Cannot determine format" error in that case,
 * so we detect it early and surface a clear message.
 *
 * Returns null if OK, or an error string if the file is corrupt.
 */
function _verifyWebmData(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < 1024) return 'File too small to contain video data';

    // Sample 4 KB from the middle of the file — if it’s all zeroes the
    // recording has no actual video payload.
    const sampleSize = 4096;
    const offset     = Math.max(1024, Math.floor(stat.size / 2));
    const buf        = Buffer.alloc(sampleSize);
    fs.readSync(fd, buf, 0, sampleSize, offset);

    let allZero = true;
    for (let i = 0; i < sampleSize; i++) {
      if (buf[i] !== 0) { allZero = false; break; }
    }
    if (allZero) {
      return `Video data is zeroed out (sampled ${sampleSize} bytes at offset ${offset}). ` +
             'The clip may be a corrupt recording on the PS5.';
    }
    return null; // OK
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Fix PS5 WebM files whose Segment element declares a size that covers only
 * the tail of the file (~8 seconds).  Players honour the declared size and
 * stop early, even though all the data is present.
 *
 * We locate the Segment element (EBML ID 0x18538067) and overwrite its VINT
 * size field with the "unknown" sentinel for the same byte-width.  This tells
 * decoders to read until EOF, which is the correct behaviour for a single-
 * Segment file.
 *
 * Returns true if patched, false if nothing needed fixing or skipped.
 */
function _fixWebmSegmentSize(filePath) {
  const SEGMENT_ID = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const fd = fs.openSync(filePath, 'r+');
  try {
    const stat = fs.fstatSync(fd);
    // Read the first 64 bytes — the Segment element is always near the start
    // (right after the EBML header, which is typically 30-40 bytes).
    const headBuf = Buffer.alloc(64);
    fs.readSync(fd, headBuf, 0, 64, 0);

    // Find the Segment ID
    const segIdx = headBuf.indexOf(SEGMENT_ID);
    if (segIdx < 0) return false; // not a WebM or mangled header

    const sizeOffset = segIdx + 4; // VINT size starts right after the 4-byte ID
    const firstByte  = headBuf[sizeOffset];

    // Determine VINT width from the leading-one position
    let vintWidth = 0;
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      vintWidth++;
      if (firstByte & mask) break;
    }
    if (vintWidth < 1 || vintWidth > 8) return false; // invalid

    // Decode the current VINT value
    const raw = Buffer.alloc(vintWidth);
    fs.readSync(fd, raw, 0, vintWidth, sizeOffset);
    // Mask out the leading VINT marker bit
    raw[0] &= (0xFF >> vintWidth);
    let declaredSize = 0n;
    for (let i = 0; i < vintWidth; i++) declaredSize = (declaredSize << 8n) | BigInt(raw[i]);

    // Build the "unknown" sentinel for this VINT width: all data bits set
    const unknownVal = (1n << BigInt(7 * vintWidth)) - 1n;
    if (declaredSize === unknownVal) return false; // already unknown — nothing to fix

    // Check if the declared size matches the rest of the file
    const expectedSize = BigInt(stat.size) - BigInt(sizeOffset + vintWidth);
    if (declaredSize === expectedSize) return false; // size is already correct

    // Overwrite with the unknown-size sentinel
    const patch = Buffer.alloc(vintWidth);
    let val = unknownVal;
    for (let i = vintWidth - 1; i >= 0; i--) { patch[i] = Number(val & 0xFFn); val >>= 8n; }
    // Set the leading VINT marker bit
    patch[0] |= (0x80 >> (vintWidth - 1));
    fs.writeSync(fd, patch, 0, vintWidth, sizeOffset);

    console.log(`[webm-fix] Patched Segment size at offset ${sizeOffset}: ` +
                `declared ${declaredSize} → unknown (file ${stat.size} bytes, ` +
                `expected ${expectedSize}, VINT width ${vintWidth})`);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse HH:MM:SS.ms duration string from ffmpeg stderr → microseconds */
function _parseFfmpegDuration(text) {
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Math.round((parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])) * 1_000_000);
}

/** Run ffmpeg, emit progress events, resolve when done.
 *  @param {string[]} args       ffmpeg argument array (no leading 'ffmpeg')
 *  @param {(pct:number)=>void} onPct  called with 0-100 each keyframe
 *  @returns {Promise<void>}
 */
function _runFfmpeg(args, onPct) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    let totalUs   = 0;

    proc.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      if (!totalUs) totalUs = _parseFfmpegDuration(stderrBuf);
    });

    let stdoutBuf = '';
    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m && totalUs > 0) {
          const pct = Math.min(99, Math.round((parseInt(m[1]) / totalUs) * 100));
          onPct?.(pct);
        }
      }
    });

    proc.on('close', code => {
      if (code === 0) { onPct?.(100); resolve(); }
      else {
        log.warn(`[ffmpeg] exit ${code} stderr:\n${stderrBuf}`);
        reject(new Error(`ffmpeg exited with code ${code}.\n${stderrBuf.slice(-1000)}`));
      }
    });
    proc.on('error', reject);
  });
}

/** Extract one JPEG frame from a local video file via ffmpeg, return base64 data URL. */
function _extractThumb(videoPath) {
  return new Promise((resolve, reject) => {
    const thumbPath = videoPath + '.thumb.jpg';
    const proc = spawn(ffmpegPath, [
      '-y', '-i', videoPath,
      '-vframes', '1',
      '-q:v', '4',
      '-vf', 'scale=320:-1',
      thumbPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.on('close', code => {
      if (code !== 0) return reject(new Error('Thumbnail extraction failed'));
      try {
        const buf     = fs.readFileSync(thumbPath);
        const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
        fs.unlink(thumbPath, () => {}); // cleanup; fire-and-forget
        resolve(dataUrl);
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

ipcMain.handle('media:discord-send', async (_e, { remotePath, game_id, filename, type }) => {
  const webhookUrl = store.get('discord.webhookUrl', '');
  if (!webhookUrl) throw new Error('No Discord webhook URL configured — add one in Settings → Integrations.');

  const emit = (state, pct) =>
    win?.webContents.send('media:discord:progress', { remotePath, state, pct });

  // ── Temp-dir setup ─────────────────────────────────────────────────────────
  const tmpDir  = path.join(os.tmpdir(), 'porkfolio-discord-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const safe     = remotePath.replace(/[^a-zA-Z0-9._-]/g, '_');
  const webmPath = path.join(tmpDir, safe);          // downloaded webm

  const cleanup = () => {
    try { if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath); } catch (_) {}
  };

  try {
    if (type === 'screenshot') {
      // ── Screenshot: attach JPEG directly ────────────────────────────────────
      // Re-use the media cache dir for screenshots (no conversion needed)
      const cacheDir  = path.join(os.tmpdir(), 'porkfolio-media-thumb');
      fs.mkdirSync(cacheDir, { recursive: true });
      const localPath = path.join(cacheDir, safe);

      if (!fs.existsSync(localPath)) {
        emit('downloading', 0);
        await ftp.downloadFile(remotePath, localPath, (info) => {
          if (info.bytesOverall) emit('downloading', 50); // small file — just show activity
        });
      }
      emit('downloading', 100);
      emit('uploading');

      const fileBuffer = fs.readFileSync(localPath);
      const form = new FormData();
      form.set('payload_json', JSON.stringify({
        username: 'Porkfolio',
        embeds: [{
          title:       game_id,
          description: filename,
          color:       0xBB86FC,
          image:       { url: `attachment://${filename}` },
          footer:      { text: 'Shared from Porkfolio' },
        }],
      }));
      form.set('files[0]', new Blob([fileBuffer], { type: 'image/jpeg' }), filename);

      let res;
      for (let _attempt = 1; _attempt <= 3; _attempt++) {
        if (_attempt > 1) { await new Promise(r => setTimeout(r, 2000 * _attempt)); }
        res = await eNet.fetch(webhookUrl, { method: 'POST', body: form });
        if (res.ok || res.status !== 503) break;
        log.warn(`[Discord] Screenshot POST got 503, retry ${_attempt}/3`);
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Discord returned ${res.status}: ${txt.slice(0, 300)}`);
      }
      return { via: 'discord-attachment' };

    } else {
      // ── Video clip: download → upload → post → delete ──────────────────────
      const masterOn = () => store.get('media.psNotify.enabled', true);
      const stepOn   = key => masterOn() && store.get(key, true);

      // 1. Download webm to completion (dedicated connection — no timeout issues)
      if (stepOn('media.psNotify.discordDownload')) ps5Notify('Downloading Clip…', filename);
      emit('downloading', 0);
      await ftp.downloadFileFresh(remotePath, webmPath, ({ bytesOverall, total }) => {
        if (total) emit('downloading', Math.min(99, Math.round((bytesOverall / total) * 100)));
      });
      emit('downloading', 100);
      const webmStat = fs.existsSync(webmPath) ? fs.statSync(webmPath) : null;
      if (!webmStat || webmStat.size === 0)
        throw new Error('Download failed — empty file.');
      log.info(`[discord] Downloaded: ${(webmStat.size / 1024 / 1024).toFixed(2)} MB → ${webmPath}`);

      // Verify the downloaded WebM actually contains video data
      const dataErr = _verifyWebmData(webmPath);
      if (dataErr) throw new Error(dataErr);

      // Fix PS5 WebM Segment size — PS5 often writes a too-small size that
      // makes players stop after ~8 seconds even though the full data is there.
      try {
        if (_fixWebmSegmentSize(webmPath))
          log.info('[discord] Patched WebM Segment size → unknown');
      } catch (fixErr) {
        log.warn('[discord] WebM Segment fix failed (non-fatal):', fixErr.message);
      }

      // Thumbnail (non-fatal)
      try {
        const dataUrl = await _extractThumb(webmPath);
        win?.webContents.send('media:discord:thumb', { remotePath, dataUrl });
        _saveClipThumbToDisk(remotePath, dataUrl);
      } catch (_) {}

      // 2. Upload webm directly to catbox.moe
      if (stepOn('media.psNotify.discordUpload')) ps5Notify('Uploading to catbox…', filename);
      emit('uploading-video', null);
      const catUrl = await _catboxUpload(webmPath, (attempt, max) => {
        win?.webContents.send('media:discord:progress', { remotePath, state: 'retrying', attempt, max });
      });
      log.info(`[discord] catbox URL: ${catUrl}`);
      emit('uploading-video', 100);

      // 4. Post to Discord
      emit('sending');
      let discordRes;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await new Promise(r => setTimeout(r, 2000 * attempt));
        discordRes = await eNet.fetch(webhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            username: 'Porkfolio',
            content:  catUrl,
            embeds: [{
              title:       game_id,
              description: filename,
              color:       0xBB86FC,
              url:         catUrl,
              footer:      { text: `Shared from Porkfolio • ${catUrl}` },
            }],
          }),
        });
        if (discordRes.ok || discordRes.status !== 503) break;
        log.warn(`[Discord] POST got 503, retry ${attempt}/3`);
      }
      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => '');
        throw new Error(`Discord returned ${discordRes.status}: ${txt.slice(0, 300)}`);
      }
      if (stepOn('media.psNotify.discordDone')) ps5Notify('Clip Sent to Discord ✓', filename);
      return { via: 'catbox+discord', url: catUrl };
    }
  } catch (err) {
    if (store.get('media.psNotify.enabled', true) && store.get('media.psNotify.discordError', true)) {
      ps5Notify('Discord Share Failed', err.message?.slice(0, 60) || 'Unknown error');
    }
    throw err;
  } finally {
    cleanup();
  }
});

// ── Clip thumbnail disk cache ────────────────────────────────────────────────
// Stores {remotePath: dataUrl} as JSON in Electron's userData so thumbnails
// fetched via "Fetch Clip Thumbnails" or Discord share persist across sessions.
function _getClipThumbCachePath() {
  return path.join(app.getPath('userData'), 'clip-thumb-cache.json');
}

function _loadClipThumbsFromDisk() {
  try {
    const raw = fs.readFileSync(_getClipThumbCachePath(), 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) {
    return {};
  }
}

function _saveClipThumbToDisk(remotePath, dataUrl) {
  try {
    const existing = _loadClipThumbsFromDisk();
    existing[remotePath] = dataUrl;
    fs.writeFileSync(_getClipThumbCachePath(), JSON.stringify(existing), 'utf8');
  } catch (err) {
    log.warn('clip-thumb-cache write failed:', err.message);
  }
}

ipcMain.handle('media:clip-thumbs:load', () => _loadClipThumbsFromDisk());

// ── Batch clip thumbnail fetcher ───────────────────────────────────────────────
// For each webm remotePath: download the first 10 MB (partial), extract a single
// JPEG frame with ffmpeg, emit media:discord:thumb so the renderer patches the card,
// then clean up.  No mp4 conversion needed — far faster than the Discord pipeline.
//
// Progress events:  media:clip-thumb:progress
//   { done, total, remote, state }
//   state: 'downloading' | 'extracting' | 'ok' | 'failed'
ipcMain.handle('media:batch-clip-thumbs', async (_e, remotePaths) => {
  if (!Array.isArray(remotePaths) || remotePaths.length === 0) return { done: 0, total: 0 };

  const total  = remotePaths.length;
  let   done   = 0;
  const tmpDir = path.join(os.tmpdir(), 'porkfolio-clip-thumb-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const remotePath of remotePaths) {
    const safe        = remotePath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const partialPath = path.join(tmpDir, `${safe}.partial.webm`);
    let   state       = 'failed';

    try {
      win?.webContents.send('media:clip-thumb:progress', { done, total, remote: remotePath, state: 'downloading' });
      // 10 MB is plenty for the first keyframe of a PS5 webm
      await ftp.downloadPartialFile(remotePath, partialPath, 10 * 1024 * 1024);

      win?.webContents.send('media:clip-thumb:progress', { done, total, remote: remotePath, state: 'extracting' });
      const dataUrl = await _extractThumb(partialPath);

      // Reuse the existing discord:thumb renderer event — patches the card live
      win?.webContents.send('media:discord:thumb', { remotePath, dataUrl });
      _saveClipThumbToDisk(remotePath, dataUrl);
      state = 'ok';
    } catch (_err) {
      // Non-fatal: skip this clip and continue with the rest
    } finally {
      done++;
      win?.webContents.send('media:clip-thumb:progress', { done, total, remote: remotePath, state });
      try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch (_) {}
    }
  }
  return { done, total };
});

ipcMain.handle('media:download', async (_e, { remotePath, game_id, filename }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  let mediaPath = store.get('mediaLocalPath', '');

  // If no path is configured, or the drive/root is unreachable, fall back to
  // Documents\Porkfolio Media and persist that as the new setting so the UI
  // reflects it after the next settings load.
  const _rootOk = async (p) => {
    if (!p) return false;
    try { await fs.promises.access(path.parse(p).root, fs.constants.F_OK); return true; }
    catch { return false; }
  };

  if (!(await _rootOk(mediaPath))) {
    mediaPath = path.join(app.getPath('documents'), 'Porkfolio Media');
    store.set('mediaLocalPath', mediaPath);
    log.info(`[media:download] Configured path unreachable; falling back to "${mediaPath}"`);
    win?.webContents.send('settings:updated', { mediaLocalPath: mediaPath });
  }

  const localPath = path.join(mediaPath, game_id, filename);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  // If the file already exists, check whether it's usable or locked.
  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath);
    if (stat.size > 0) {
      // File already downloaded — skip re-download.
      log.info(`[media:download] Already exists (${(stat.size / 1024 / 1024).toFixed(2)} MB): ${localPath}`);
      return { localPath, alreadyExists: true };
    }
    // Zero-byte leftover — try to remove it before re-downloading.
    try { fs.unlinkSync(localPath); } catch (e) {
      if (e.code === 'EBUSY') throw new Error('File is locked (OneDrive may be syncing). Try again in a moment.');
      throw e;
    }
  }

  const result = await transferMgr.enqueue('download', {
    label:      `Media: ${filename}`,
    localPath,
    remotePath,
  });
  // Fix PS5 WebM Segment size so downloaded clips play in full
  if (filename.toLowerCase().endsWith('.webm')) {
    try { _fixWebmSegmentSize(localPath); } catch (_) {}
  }
  return result;
});

// ── Active media preview windows ──────────────────────────────────────────────
// Maps remotePath → { win: BrowserWindow, server: http.Server, tmpPath: string }
const _mediaPreviews = new Map();

ipcMain.handle('media:open', async (_e, { remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  // Re-use existing preview window if still open
  const existing = _mediaPreviews.get(remotePath);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return;
  }

  const filename = remotePath.split('/').pop();
  const tmpPath  = path.join(os.tmpdir(), `porkfolio-preview-${Date.now()}-${filename}`);

  // HTTP server with range-request support so the <video> element can seek
  const server = http.createServer((req, res) => {
    if (!fs.existsSync(tmpPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
      res.end('Downloading…');
      return;
    }
    const stat  = fs.statSync(tmpPath);
    const total = stat.size;
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(s, 10);
      const end   = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      const len   = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': len,
        'Content-Type':   'video/webm',
      });
      fs.createReadStream(tmpPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type':   'video/webm',
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(tmpPath).pipe(res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const playerWin = new BrowserWindow({
    width:  1280,
    height: 760,
    minWidth:  640,
    minHeight: 400,
    title:  filename,
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  const cleanup = () => {
    _mediaPreviews.delete(remotePath);
    try { server.close(); } catch (_) {}
    setTimeout(() => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {} }, 1500);
  };
  playerWin.on('closed', cleanup);
  _mediaPreviews.set(remotePath, { win: playerWin, server, tmpPath });

  const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>${filename.replace(/"/g, '&quot;')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d0d;display:flex;flex-direction:column;height:100vh;overflow:hidden;font-family:system-ui,sans-serif;color:#fff}
#overlay{position:absolute;inset:0;background:#0d0d0d;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:10;transition:opacity .4s}
#overlay.hidden{opacity:0;pointer-events:none}
#fn{font-size:13px;color:#ccc;max-width:80%;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bar-wrap{width:320px;height:6px;background:#333;border-radius:3px;overflow:hidden}
#bar{height:100%;background:#BB86FC;border-radius:3px;transition:width .15s}
#lbl{font-size:12px;color:#888}
#err{font-size:13px;color:#f44;text-align:center;max-width:80%}
video{flex:1;width:100%;background:#000;min-height:0}
</style></head><body>
<div id="overlay">
  <div id="fn">${filename.replace(/</g, '&lt;')}</div>
  <div id="bar-wrap"><div id="bar" style="width:0%"></div></div>
  <div id="lbl">Downloading…</div>
  <div id="err"></div>
</div>
<video id="v" controls autoplay style="display:none"></video>
<script>
const v   = document.getElementById('v');
const ov  = document.getElementById('overlay');
const bar = document.getElementById('bar');
const lbl = document.getElementById('lbl');
const err = document.getElementById('err');
function setProgress(pct, label) {
  bar.style.width = pct + '%';
  lbl.textContent = label || ('Downloading ' + pct + '%');
}
function onReady() {
  v.style.display = 'block';
  v.src = 'http://127.0.0.1:${port}/video.webm';
  ov.classList.add('hidden');
  setTimeout(() => { ov.style.display='none'; }, 500);
}
function onError(msg) {
  bar.style.display='none';
  lbl.style.display='none';
  err.textContent = 'Error: ' + msg;
}
</script></body></html>`;

  playerWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  playerWin.once('ready-to-show', () => playerWin.show());

  // Download in the background — push progress to the player window via JS
  setImmediate(async () => {
    try {
      await ftp.downloadFile(remotePath, tmpPath, (got, total) => {
        if (playerWin.isDestroyed()) return;
        const pct = total ? Math.min(99, Math.round((got / total) * 100)) : 0;
        playerWin.webContents
          .executeJavaScript(`typeof setProgress === 'function' && setProgress(${pct})`, true)
          .catch(() => {});
      });
      // Fix PS5 WebM Segment size so the preview plays the full clip
      try { _fixWebmSegmentSize(tmpPath); } catch (_) {}
      if (!playerWin.isDestroyed()) {
        playerWin.webContents
          .executeJavaScript(`typeof onReady === 'function' && onReady()`, true)
          .catch(() => {});
      }
    } catch (err) {
      log.error('[media:open] Download failed:', err);
      if (!playerWin.isDestroyed()) {
        const msg = JSON.stringify(err.message);
        playerWin.webContents
          .executeJavaScript(`typeof onError === 'function' && onError(${msg})`, true)
          .catch(() => {});
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
};
