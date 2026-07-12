// ── Transfer Manager controls ─────────────────────────────────────────────────

$('btn-transfer-pause').addEventListener('click', async () => {
  if (_transferState.paused) {
    await window.pork.transferResume();
  } else {
    await window.pork.transferPause();
  }
});

$('btn-transfer-clear').addEventListener('click', () => window.pork.transferClearDone());

$('transfer-concurrent-slider').addEventListener('input', async e => {
  const n = parseInt(e.target.value);
  $('tstat-concurrent').textContent = n;
  await window.pork.transferSetConcurrent(n);
});

// Cancel button delegation (list is re-rendered, so use document delegation)
$('transfers-list').addEventListener('click', e => {
  const btn = e.target.closest('.btn-cancel-transfer');
  if (!btn) return;
  const id = parseInt(btn.dataset.jobId);
  if (!isNaN(id)) window.pork.transferCancel(id);
});

// ── Media page ────────────────────────────────────────────────────────────────

// Format a Unix ms timestamp into a short human-readable string.
// Respects _timeFormat ('12h' | '24h').
let _timeFormat = '12h'; // default; overwritten by loadSettings
function _fmtDate(ms) {
  if (!ms) return '';
  const d   = new Date(ms);
  const now = new Date();
  let time;
  if (_timeFormat === '24h') {
    const pad = n => String(n).padStart(2, '0');
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else {
    const h   = d.getHours();
    const m   = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 || 12;
    time = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  const isSameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isSameDay)   return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  const mo = d.toLocaleString('default', { month: 'short' });
  return `${mo} ${d.getDate()}  ${time}`;
}

let _mediaItems       = [];   // all items returned by last scan
let _mediaFilter      = 'all';
let _mediaSort        = 'date-desc';
let _mediaSearch      = '';
let _mediaSearchTimer = null;
const _thumbCache     = new Map(); // remotePath → dataUrl (in-memory, cleared on new scan)
const _thumbFetching  = new Set(); // remotePaths currently being fetched
let _thumbQueued      = 0;          // total thumb loads enqueued in current render cycle
let _thumbDone        = 0;          // completed (success + failure)

function _updateThumbStatus() {
  const el = $('media-thumb-status');
  if (!el) return;
  const pending = _thumbQueued - _thumbDone;
  if (pending <= 0 || _thumbQueued === 0) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `Loading thumbnails: ${_thumbDone} / ${_thumbQueued}`;
}

/** Show or update the thumb-status bar with an arbitrary message (for clip-batch). */
function _setThumbStatusMsg(msg) {
  const el = $('media-thumb-status');
  if (!el) return;
  if (msg == null) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

function _setCardLabel(remotePath, text) {
  const lbl = document.querySelector(`.thumb-label[data-remote="${CSS.escape(remotePath)}"]`);
  if (lbl) lbl.textContent = text;
}

// ── Video frame extractor removed ───────────────────────────────────────────
// Webm thumbnails are not generated — the card shows a WEBM type badge instead.
// generateVideoThumb intentionally omitted.

// ── IntersectionObserver for lazy thumbnail loading ───────────────────────────
const _thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const imgEl = entry.target;
    const remote = imgEl.dataset.remote;
    if (!remote) continue;
    _thumbObserver.unobserve(imgEl);

    if (_thumbCache.has(remote)) {
      _applyThumb(imgEl, _thumbCache.get(remote));
      continue;
    }
    if (_thumbFetching.has(remote)) continue;
    _thumbFetching.add(remote);
    _thumbQueued++;
    _updateThumbStatus();

    // Videos: screenshots only now (clips use static badge)
    const thumbPromise = window.pork.mediaFetchThumb(remote);

    thumbPromise
      .then(thumbUrl => {
        _thumbCache.set(remote, thumbUrl);
        document.querySelectorAll(`.media-thumb-img[data-remote="${CSS.escape(remote)}"]`).forEach(el => {
          _applyThumb(el, thumbUrl);
        });
      })
      .catch(err => {
        const card = imgEl.closest('.media-card');
        const wrap = imgEl.closest('.media-card-thumb');
        wrap?.classList.add('thumb-error');
        // Show a retry button so the user isn't left with a silent `!`
        if (card && !card.querySelector('.btn-thumb-retry')) {
          const retryBtn = document.createElement('button');
          retryBtn.className = 'btn btn-sm btn-thumb-retry';
          retryBtn.title = err?.message || 'Thumbnail failed';
          retryBtn.textContent = '\u21BB Retry';
          retryBtn.addEventListener('click', () => {
            _thumbFetching.delete(remote);
            _thumbCache.delete(remote);
            _thumbQueued = Math.max(0, _thumbQueued - 1);
            _thumbDone   = Math.max(0, _thumbDone   - 1);
            retryBtn.remove();
            wrap?.classList.remove('thumb-error');
            // Re-add the spinner and img, then re-observe
            const newSpin = document.createElement('div');
            newSpin.className = 'thumb-spin';
            const newLbl = document.createElement('div');
            newLbl.className = 'thumb-label'; newLbl.dataset.remote = remote;
            newLbl.textContent = 'Waiting…';
            wrap?.prepend(newLbl);
            wrap?.prepend(newSpin);
            imgEl.src = ''; imgEl.classList.remove('thumb-loaded'); imgEl.classList.add('thumb-loading');
            _thumbObserver.observe(imgEl);
          });
          card.querySelector('.media-card-body')?.prepend(retryBtn);
        }
      })
      .finally(() => {
        _thumbFetching.delete(remote);
        _thumbDone++;
        _updateThumbStatus();
      });
  }
}, { rootMargin: '200px', threshold: 0 });

function _applyThumb(imgEl, dataUrl) {
  imgEl.src = dataUrl;
  imgEl.classList.remove('thumb-loading');
  imgEl.classList.add('thumb-loaded');
  const spin = imgEl.parentElement?.querySelector('.thumb-spin');
  if (spin) spin.remove();
}

async function loadMedia() {
  try {
    const s = await window.pork.getSettings();
    if (s.mediaLocalPath) $('media-save-path').value = s.mediaLocalPath;
  } catch (_) {}
  renderMediaGrid();
}

function getFilteredMedia() {
  const filtered = _mediaItems.filter(item => {
    if (_mediaFilter !== 'all' && item.type !== _mediaFilter) return false;
    if (_mediaSearch) {
      const q = _mediaSearch.toLowerCase();
      return item.game_id.toLowerCase().includes(q) || item.filename.toLowerCase().includes(q);
    }
    return true;
  });
  // Sort
  filtered.sort((a, b) => {
    switch (_mediaSort) {
      case 'date-asc':  return (a.capturedAt || 0) - (b.capturedAt || 0);
      case 'size-desc': return b.size - a.size;
      case 'name-asc':  return a.filename.localeCompare(b.filename);
      default:          return (b.capturedAt || 0) - (a.capturedAt || 0); // date-desc
    }
  });
  return filtered;
}

function renderMediaGrid() {
  const grid  = $('media-grid');
  const empty = $('media-empty');
  const all   = _mediaItems;
  const shots = all.filter(i => i.type === 'screenshot');
  const clips = all.filter(i => i.type === 'clip');

  $('media-count-all').textContent         = all.length   || '';
  $('media-count-screenshots').textContent = shots.length || '';
  $('media-count-clips').textContent       = clips.length || '';

  // Show the "Fetch Clip Thumbnails" button whenever there are clips loaded
  const clipThumbBtn = $('btn-clip-thumbs');
  if (clipThumbBtn) {
    const missing = clips.filter(c => !_thumbCache.has(c.remotePath)).length;
    clipThumbBtn.style.display = clips.length ? '' : 'none';
    clipThumbBtn.title = missing
      ? `Generate thumbnails for ${missing} clip${missing !== 1 ? 's' : ''} (${clips.length - missing} already cached)`
      : 'All clip thumbnails are already cached';
  }

  const badge = $('nav-media-badge');
  if (all.length) { badge.textContent = all.length; badge.hidden = false; }
  else              badge.hidden = true;

  const visible = getFilteredMedia();
  grid.innerHTML = '';

  if (!visible.length) { empty.hidden = false; return; }
  empty.hidden = true;

  const iconMap = new Map((state.games || []).map(g => [g.game_id, g.prospero_icon_url || '']));

  for (const item of visible) {
    const card     = document.createElement('div');
    card.className = 'media-card';
    card.dataset.remote = item.remotePath;
    card.dataset.type   = item.type;

    const icon    = iconMap.get(item.game_id) || '';
    const iconHtml = icon
      ? `<img src="${escHtml(icon)}" class="media-card-game-icon" alt="" onerror="this.style.display='none'">`
      : `<div class="media-card-game-icon-empty"></div>`;

    // Thumbnail area — real <img> for screenshots (lazy-loaded), styled placeholder for clips
    let thumbHtml;
    if (item.type === 'screenshot') {
      const cached = _thumbCache.get(item.remotePath);
      if (cached) {
        thumbHtml = `
          <div class="media-card-thumb type-screenshot media-thumb-wrap">
            <img src="${escHtml(cached)}" class="media-thumb-img thumb-loaded"
                 data-remote="${escHtml(item.remotePath)}" alt=""/>
          </div>`;
      } else {
        thumbHtml = `
          <div class="media-card-thumb type-screenshot media-thumb-wrap">
            <div class="thumb-spin"></div>
            <img src="" class="media-thumb-img thumb-loading"
                 data-remote="${escHtml(item.remotePath)}" alt=""/>
          </div>`;
      }
    } else {
      // Video clip — static WEBM badge + play overlay; no thumbnail download.
      const cachedClip = _thumbCache.get(item.remotePath);
      const clipImg = cachedClip
        ? `<img src="${escHtml(cachedClip)}" class="media-thumb-img thumb-loaded" data-remote="${escHtml(item.remotePath)}" alt=""/>`
        : `<div class="clip-type-badge">WEBM</div>`;
      thumbHtml = `
        <div class="media-card-thumb type-clip media-thumb-wrap">
          ${clipImg}
          <div class="clip-play-overlay">
            <svg viewBox="0 0 40 40" width="36" height="36" fill="none">
              <circle cx="20" cy="20" r="18" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.25)" stroke-width="1"/>
              <polygon points="16,13 30,20 16,27" fill="white" opacity=".9"/>
            </svg>
          </div>
        </div>`;
    }

    card.innerHTML = `
      ${thumbHtml}
      <div class="media-card-body">
        <div class="media-card-game">
          ${iconHtml}
          <span class="media-card-game-id">${escHtml(item.game_id)}</span>
        </div>
        <div class="media-card-filename" title="${escHtml(item.filename)}">${escHtml(item.filename)}</div>
        <div class="media-card-meta">
          <span class="media-card-size">${fmt(item.size)}</span>
          ${item.capturedAt ? `<span class="media-card-date" title="${new Date(item.capturedAt).toLocaleString()}">${_fmtDate(item.capturedAt)}</span>` : ''}
        </div>
        <div class="media-card-actions">
          ${item.type === 'clip'
            ? `<button class="btn btn-sm btn-accent btn-media-play"
                data-remote="${escHtml(item.remotePath)}"
                data-file="${escHtml(item.filename)}">&#9654; Play</button>`
            : ''}
          <button class="btn btn-sm btn-media-dl"
            data-remote="${escHtml(item.remotePath)}"
            data-game="${escHtml(item.game_id)}"
            data-file="${escHtml(item.filename)}">&#8659; Download</button>
          <button class="btn btn-sm btn-media-share"
            data-remote="${escHtml(item.remotePath)}"
            data-game="${escHtml(item.game_id)}"
            data-file="${escHtml(item.filename)}"
            data-type="${escHtml(item.type)}">&#128279; Discord</button>
        </div>
      </div>`;
    grid.appendChild(card);

    // Register lazy loading — screenshots only; clips show a static WEBM badge.
    if (item.type === 'screenshot' && !_thumbCache.has(item.remotePath)) {
      const imgEl = card.querySelector('.media-thumb-img');
      if (imgEl) _thumbObserver.observe(imgEl);
    }
  }
}

// Clip thumbnail batch progress — update the status bar with live count
window.pork.on('media:clip-thumb:progress', ({ done, total, remote, state }) => {
  const label = remote ? remote.split('/').pop() : '';
  if (state === 'downloading') {
    _setThumbStatusMsg(`Fetching clip thumbnails: ${done} / ${total} — downloading ${label}…`);
  } else if (state === 'extracting') {
    _setThumbStatusMsg(`Fetching clip thumbnails: ${done} / ${total} — extracting frame…`);
  } else {
    // 'ok' or 'failed'
    if (done >= total) {
      const clips   = _mediaItems.filter(i => i.type === 'clip');
      const missing = clips.filter(c => !_thumbCache.has(c.remotePath)).length;
      _setThumbStatusMsg(`Done — fetched ${done} clip thumbnail${done !== 1 ? 's' : ''}${missing ? `, ${missing} still missing (partial download may not have contained a keyframe)` : ''}`);
      setTimeout(() => _setThumbStatusMsg(null), 8000);
      // Refresh button tooltip
      const clipThumbBtn = $('btn-clip-thumbs');
      if (clipThumbBtn) {
        clipThumbBtn.disabled    = false;
        clipThumbBtn.textContent = '\u{1F3AC} Fetch Clip Thumbnails';
      }
      renderMediaGrid();
    } else {
      _setThumbStatusMsg(`Fetching clip thumbnails: ${done} / ${total}${state === 'failed' ? ` (last failed)` : ''}`);
    }
  }
});

// ── Fetch Clip Thumbnails button ──────────────────────────────────────────────
$('btn-clip-thumbs').addEventListener('click', async () => {
  const clips   = _mediaItems.filter(i => i.type === 'clip');
  const missing = clips.filter(c => !_thumbCache.has(c.remotePath));

  if (missing.length === 0) {
    setStatus('All clip thumbnails are already cached.', 'ok');
    return;
  }

  // Warn if it will take a while — each clip needs a partial FTP download + ffmpeg
  const warnThreshold = 5;
  if (missing.length > warnThreshold) {
    const ok = confirm(
      `Fetching thumbnails for ${missing.length} video clip${missing.length !== 1 ? 's' : ''}.\n\n` +
      `This will download the first ~10 MB of each clip from your PS5 and extract a frame.\n` +
      `With many files this can take several minutes.\n\nContinue?`
    );
    if (!ok) return;
  }

  const btn = $('btn-clip-thumbs');
  btn.disabled    = true;
  btn.textContent = 'Fetching…';
  _setThumbStatusMsg(`Starting thumbnail fetch for ${missing.length} clip${missing.length !== 1 ? 's' : ''}…`);

  try {
    await window.pork.mediaFetchClipThumbs(missing.map(c => c.remotePath));
  } catch (err) {
    setStatus(`Clip thumbnail fetch failed: ${err.message}`, 'error');
    _setThumbStatusMsg(null);
    btn.disabled    = false;
    btn.textContent = '\u{1F3AC} Fetch Clip Thumbnails';
  }
});

// ── Scan button ───────────────────────────────────────────────────────────────
$('btn-media-scan').addEventListener('click', async () => {
  const btn    = $('btn-media-scan');
  const status = $('media-scan-status');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  status.textContent = 'Connecting to PS5…';
  status.hidden = false;

  // Clear old data + caches
  _mediaItems = [];
  _thumbCache.clear();
  _thumbFetching.clear();
  _thumbQueued = 0;
  _thumbDone   = 0;
  const tsEl = $('media-thumb-status');
  if (tsEl) tsEl.hidden = true;
  renderMediaGrid();

  try {
    _mediaItems = await window.pork.mediaScan();
    status.hidden = true;
    // Restore persisted clip thumbnails so they show immediately after scan
    try {
      const diskCache = await window.pork.mediaLoadClipThumbs();
      for (const [rp, du] of Object.entries(diskCache || {})) _thumbCache.set(rp, du);
    } catch (_) {}
    renderMediaGrid();
  } catch (e) {
    status.textContent = `Scan failed: ${e.message}`;
    status.style.cssText += ';color:var(--red)';
    status.style.animationName = 'none';
  } finally {
    btn.disabled = false;
    btn.textContent = '↺ Scan via FTP';
  }
});

// Per-card thumb state updates from main process
window.pork.on('media:thumb:progress', ({ remotePath, state }) => {
  const labels = { downloading: 'Downloading…', decoding: 'Processing…' };
  if (labels[state]) _setCardLabel(remotePath, labels[state]);
});

// Live scan progress
window.pork.on('media:scan:progress', ({ game_id, type, found }) => {
  const status = $('media-scan-status');
  if (!status.hidden) {
    status.textContent = `Scanning ${type === 'screenshot' ? 'screenshots' : 'video clips'}… ${found} found (${game_id})`;
  }
});

// Discord share progress — update the share button live for every pipeline stage
// Track remote paths whose discord share has fully resolved so late progress
// events (which can race against the IPC reply) don't override the final state.
const _discordCompleted = new Set();

window.pork.on('media:discord:progress', ({ remotePath, state, pct, attempt, max }) => {
  if (_discordCompleted.has(remotePath)) return;
  const btn = document.querySelector(`.btn-media-share[data-remote="${CSS.escape(remotePath)}"]`);
  if (!btn) return;

  if (state === 'downloading') {
    btn.classList.remove('uploading');
    btn.textContent = pct != null ? `Downloading ${pct}%` : 'Downloading…';
  } else if (state === 'converting') {
    btn.classList.remove('uploading');
    btn.textContent = pct != null ? `Converting ${pct}%` : 'Converting…';
  } else if (state === 'uploading-video') {
    btn.classList.add('uploading');
    btn.style.setProperty('--upload-pct', `${pct ?? 0}%`);
    btn.textContent = pct != null ? `Uploading ${pct}%` : 'Uploading…';
  } else if (state === 'retrying') {
    btn.classList.remove('uploading');
    btn.style.removeProperty('--upload-pct');
    btn.textContent = `Retrying… (${attempt}/${max})`;
  } else {
    btn.classList.remove('uploading');
    btn.style.removeProperty('--upload-pct');
    const labels = { sending: 'Sending…', uploading: 'Uploading…' };
    if (labels[state]) btn.textContent = labels[state];
  }
});

// Discord share thumbnail — ffmpeg extracted a frame from the local mp4; cache it
// and patch the clip card immediately so the user sees the thumbnail right away.
window.pork.on('media:discord:thumb', ({ remotePath, dataUrl }) => {
  if (!remotePath || !dataUrl) return;
  _thumbCache.set(remotePath, dataUrl);
  // Find every clip card for this path and swap the background → actual thumb
  document.querySelectorAll(`.media-card[data-remote="${CSS.escape(remotePath)}"]`).forEach(card => {
    const wrap = card.querySelector('.media-card-thumb');
    if (!wrap) return;
    // Replace the WEBM badge placeholder with a real thumbnail image
    const badge = wrap.querySelector('.clip-type-badge');
    if (badge) badge.remove();
    let img = wrap.querySelector('.media-thumb-img');
    if (!img) {
      img = document.createElement('img');
      img.className  = 'media-thumb-img';
      img.alt        = '';
      img.dataset.remote = remotePath;
      wrap.insertBefore(img, wrap.firstChild);
    }
    img.src = dataUrl;
    img.classList.add('thumb-loaded');
    img.classList.remove('thumb-loading');
  });
});

// Save path browse
$('btn-media-save-browse').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('media-save-path').value = folder;
  await window.pork.setSettings({ mediaLocalPath: folder });
});

// Open media folder in Explorer
$('btn-media-open-folder').addEventListener('click', () => {
  const folder = $('media-save-path').value;
  if (folder) window.pork.openShell(folder);
  else setStatus('No media folder configured — select one first.', 'error');
});

// Live update when main process falls back to a default path (e.g. configured drive missing)
window.pork.on('settings:updated', (patch) => {
  if (patch?.mediaLocalPath) {
    const el = $('media-save-path');
    if (el) el.value = patch.mediaLocalPath;
    setStatus(`Media save folder updated to "${patch.mediaLocalPath}" (previous path was inaccessible).`, 'ok');
  }
});

// Sort dropdown
$('media-sort').addEventListener('change', e => {
  _mediaSort = e.target.value;
  renderMediaGrid();
});

// Filter buttons
document.querySelectorAll('[data-mfilter]').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mfilter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _mediaFilter = btn.dataset.mfilter;
    renderMediaGrid();
  })
);

// Search
$('media-search').addEventListener('input', () => {
  clearTimeout(_mediaSearchTimer);
  _mediaSearchTimer = setTimeout(() => {
    _mediaSearch = $('media-search').value.trim();
    renderMediaGrid();
  }, 250);
});

// ── Lightbox ──────────────────────────────────────────────────────────────────
let _lightboxItem = null; // current { remotePath, game_id, filename }

function openLightbox(item) {
  _lightboxItem = item;
  const box  = $('media-lightbox');
  const img  = $('lightbox-img');
  const spin = $('lightbox-spinner');
  const meta = $('lightbox-meta');

  img.src = '';
  img.hidden = true;
  spin.hidden = false;
  meta.textContent = `${item.game_id} — ${item.filename}`;
  box.hidden = false;
  document.body.classList.add('lightbox-open');

  const cached = _thumbCache.get(item.remotePath);
  if (cached) {
    img.src = cached;
    img.hidden = false;
    spin.hidden = true;
  } else {
    window.pork.mediaFetchThumb(item.remotePath)
      .then(dataUrl => {
        _thumbCache.set(item.remotePath, dataUrl);
        if (_lightboxItem?.remotePath === item.remotePath) {
          img.src = dataUrl;
          img.hidden = false;
          spin.hidden = true;
        }
      })
      .catch(err => {
        spin.hidden = true;
        meta.textContent += ` — Load failed: ${err.message}`;
      });
  }
}

function closeLightbox() {
  $('media-lightbox').hidden = true;
  document.body.classList.remove('lightbox-open');
  $('lightbox-img').src = '';
  _lightboxItem = null;
}

$('btn-lightbox-close').addEventListener('click', closeLightbox);
$('media-lightbox').addEventListener('click', e => {
  if (e.target === $('media-lightbox') || e.target.classList.contains('media-lightbox-backdrop')) closeLightbox();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('media-lightbox').hidden) closeLightbox();
});

$('btn-lightbox-dl').addEventListener('click', async () => {
  if (!_lightboxItem) return;
  const btn = $('btn-lightbox-dl');
  btn.disabled = true;
  btn.textContent = 'Queued';
  try {
    await window.pork.mediaDownload({
      remotePath: _lightboxItem.remotePath,
      game_id:    _lightboxItem.game_id,
      filename:   _lightboxItem.filename,
    });
    setStatus(`Queued: ${_lightboxItem.filename} — see Transfers`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = '↓ Save to PC'; }, 2000);
  }
});

// ── Grid click delegation ─────────────────────────────────────────────────────
$('media-grid').addEventListener('click', async e => {
  // Share to Discord button
  const shareBtn = e.target.closest('.btn-media-share');
  if (shareBtn) {
    shareBtn.disabled = true;
    shareBtn.textContent = 'Preparing…';
    try {
      const res = await window.pork.mediaDiscordSend({
        remotePath: shareBtn.dataset.remote,
        game_id:    shareBtn.dataset.game,
        filename:   shareBtn.dataset.file,
        type:       shareBtn.dataset.type,
      });
      _discordCompleted.add(shareBtn.dataset.remote);
      shareBtn.classList.remove('uploading');
      shareBtn.style.removeProperty('--upload-pct');
      shareBtn.textContent = '\u2713 Sent!';
      const detail = res?.url ? ` • ${res.url}` : '';
      setStatus(`Shared to Discord: ${shareBtn.dataset.file}${detail}`, 'ok');
      setTimeout(() => {
        shareBtn.disabled = false;
        shareBtn.textContent = '\uD83D\uDD17 Discord';
        _discordCompleted.delete(shareBtn.dataset.remote);
      }, 3000);
    } catch (err) {
      _discordCompleted.add(shareBtn.dataset.remote);
      shareBtn.classList.remove('uploading');
      shareBtn.style.removeProperty('--upload-pct');
      shareBtn.disabled = false;
      shareBtn.textContent = '\uD83D\uDD17 Discord';
      _discordCompleted.delete(shareBtn.dataset.remote);
      setStatus(`Discord share failed: ${err.message}`, 'error');
    }
    return;
  }

  // Download button
  const dlBtn = e.target.closest('.btn-media-dl');
  if (dlBtn) {
    dlBtn.disabled = true;
    dlBtn.textContent = 'Queued';
    try {
      await window.pork.mediaDownload({
        remotePath: dlBtn.dataset.remote,
        game_id:    dlBtn.dataset.game,
        filename:   dlBtn.dataset.file,
      });
      setStatus(`Queued: ${dlBtn.dataset.file} — see Transfers`, 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    }
    dlBtn.disabled = false;
    dlBtn.textContent = '\u21D3 Download';
    return;
  }

  // Play button (video clips)
  const playBtn = e.target.closest('.btn-media-play');
  if (playBtn) {
    playBtn.disabled = true;
    playBtn.textContent = 'Opening\u2026';
    try {
      await window.pork.mediaOpen(playBtn.dataset.remote);
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      setTimeout(() => { playBtn.disabled = false; playBtn.textContent = '\u25B6 Play'; }, 1500);
    }
    return;
  }

  // Click on a screenshot thumbnail → open lightbox
  const card = e.target.closest('.media-card[data-type="screenshot"]');
  if (card && !e.target.closest('button')) {
    const remote   = card.dataset.remote;
    const mediaItem = _mediaItems.find(i => i.remotePath === remote);
    if (mediaItem) openLightbox(mediaItem);
  }
});

