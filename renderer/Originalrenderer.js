'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  connected: false,
  games:     [],
  backups:   [],
  sortCol:   'title',
  sortDir:   'asc',
  filter:    'all',
  search:    '',
  firmwareFilter: 'all',
  currentGame: null,
};

// Shared hash summary maps — populated by loadGames() and loadBackporks().
// _gameHashSummary:    game_id → summary for hash_type='game'
// _backporkHashSummary: 'game_id|firmware_label' → summary for hash_type='backpork'
const _gameHashSummary     = new Map();
const _backporkHashSummary = new Map();

function _populateHashMaps(summaries) {
  _gameHashSummary.clear();
  _backporkHashSummary.clear();
  for (const s of summaries) {
    if (s.hash_type === 'backpork') {
      _backporkHashSummary.set(s.game_id + '|' + (s.firmware_label || ''), s);
    } else {
      _gameHashSummary.set(s.game_id, s);
    }
  }
}

// ── System View state ─────────────────────────────────────────────────────────
let _svStream    = null;
let _svMuted     = false;
let _svAudioCtx  = null;   // AudioContext for low-latency capture-card audio
let _svAudioGain = null;   // GainNode — controls mute without stopping the stream
let _svHotkeys   = { mute: 'm', gif: 'g', video: 'v', fullscreen: 'f', popout: 'p' };
let _svRecording = false;
let _svRecFrames = [];    // Uint8ClampedArray[] — one per captured frame
let _svRecInterval = null;
let _svRecTimer    = null;
let _svRecStart    = 0;
let _svRecCanvas   = null; // lazy-created hidden 640×360 canvas
let _svRecCtx      = null;
const GIF_W = 640, GIF_H = 360;

// Video recording state
let _svVidRecorder = null;
let _svVidWritable = null;
let _svVidChunks   = null;
let _svVidTimer    = null;
let _svVidStart    = 0;
let _svVidPaused   = false;
let _svVidBytes    = 0;
let _svVidMimeType = '';
let _svVidExt      = '';

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmt(bytes) {
  const n = Number(bytes);
  if (!n || isNaN(n)) return '—';
  const gb = n / 1073741824;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`;
}

function yesNo(v) {
  return v ? '<span class="pill pill-yes">Yes</span>' : '<span class="pill pill-no">No</span>';
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Pinnable cards registry ───────────────────────────────────────────────────
const PINNABLE_CARDS = [
  { id: 'payload-update',  label: 'Payload Update Checker', page: 'jailbreak', hint: 'Check sources for payload updates and push to PS5.' },
  { id: 'payload-mgr',     label: 'Payload Manager',     page: 'jailbreak',    hint: 'Manage local payloads and push to PS5.' },
  { id: 'psnotify',        label: 'Send Notification',   page: 'psnotify',     hint: 'Send debug notifications to your PS5.' },
  { id: 'xavatar-convert', label: 'XAvatar Convert',     page: 'xavatar',      hint: 'Convert images to .xavatar format.' },
  { id: 'xavatar-library', label: 'XAvatar Library',     page: 'xavatar',      hint: 'Manage .xavatar files on your PS5.' },
  { id: 'transfers',       label: 'Transfer Manager',    page: 'transfers',    hint: 'Monitor active and queued FTP transfers.' },
  { id: 'games',           label: 'Games Library',       page: 'games',        hint: 'Browse and manage your PS5 game collection.' },
  { id: 'cheats',          label: 'Cheats',              page: 'cheats',       hint: 'Browse and install game cheats.' },
  { id: 'media',           label: 'Media',               page: 'media',        hint: 'Browse screenshots and video clips from PS5.' },
  { id: 'system-view',     label: 'System View',         page: 'system-view',  hint: 'View your PS5 via capture card stream.' },
  { id: 'backups',         label: 'Backups',             page: 'backups',      hint: 'Browse and manage game backup files.' },
];

const _PIN_PAGE_LABELS = {
  jailbreak: 'Manage Jailbreak', psnotify: 'Notification Debug', xavatar: 'XAvatar Management',
  transfers: 'Transfers', games: 'Games', cheats: 'Cheats', media: 'Media',
  'system-view': 'System View', backups: 'Backups', voidshell: 'Voidshell', savemgr: 'Local Save Manager',
};

function setStatus(msg, type = '') {
  const el = $('sb-msg');
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : type === 'ok' ? 'var(--green)' : 'var(--yellow)';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

function showToast(msg, type = 'info', duration = 5000) {
  const icons = { ok: '✓', error: '✕', info: '●' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] ?? '●'}</span><span class="toast-body">${msg}</span><button class="toast-close" aria-label="Dismiss">×</button>`;

  const container = $('toast-container');
  container.appendChild(toast);

  function dismiss() {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  const timer = setTimeout(dismiss, duration);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => setTimeout(dismiss, 2000));
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));

  // Embed pages need #content to be overflow:hidden so the iframe can fill available height
  const isEmbed = (page === 'voidshell' || page === 'savemgr');
  document.getElementById('content').classList.toggle('embed-page-active', isEmbed);
  if (page === 'dashboard') loadDashboard();
  if (page === 'games')     loadGames();
  if (page === 'backporks') loadBackporks();
  if (page === 'backups')   loadBackups();
  if (page === 'database')  loadDatabase();
  if (page === 'settings')  loadSettings();
  if (page === 'jailbreak')    loadJailbreak();
  if (page === 'psnotify')     loadPsNotify();
  if (page === 'xavatar')      loadXavatar();
  if (page === 'system-view') loadSystemView();
  if (page === 'transfers')   loadTransfers();
  if (page === 'media')       loadMedia();
  if (page === 'cheats')      loadCheats();
  if (page === 'garlic')      loadGarlic();
  if (page === 'voidshell')   loadVoidshell();
  if (page === 'savemgr')     loadSaveMgr();
  syncPinStates();
}

async function syncPinStates() {
  try {
    const s      = await window.pork.getSettings();
    const pinned = new Set(s.pinnedCards || []);
    document.querySelectorAll('.btn-pin').forEach(btn =>
      btn.classList.toggle('pinned', pinned.has(btn.dataset.pinId))
    );
  } catch (_) {}
}

async function loadJailbreak() {
  // Reset UI
  $('payload-check-status').textContent = '';
  $('payload-sources-check-list').innerHTML = '';
  await renderLocalPayloads();
  await renderPayloadSender();
  await renderAutoloaderSnapshots();
}

// ── PS Notify page ────────────────────────────────────────────────────────────

async function loadPsNotify() {
  // Populate settings fields from store
  try {
    const s = await window.pork.getSettings();
    $('psn-enabled').checked = s.psnotifyEnabled !== false;
    $('psn-port').value      = s.psnotifyPort || 6969;
  } catch (_) {}
  await renderPsnHistory();
}

async function renderPsnHistory() {
  const hist    = await window.pork.psnotifyHistory();
  const list    = $('psn-history');
  const empty   = $('psn-history-empty');
  if (!hist.length) {
    list.innerHTML = '';
    empty.hidden   = false;
    return;
  }
  empty.hidden   = true;
  list.innerHTML = hist.slice().reverse().map(e => {
    const cls = e.ok !== false ? 'psn-ok' : 'psn-fail';
    const ts  = new Date(e.ts).toLocaleTimeString();
    const sub = e.subMessage ? `<span class="psn-entry-sub">\u2014 ${escHtml(e.subMessage)}</span>` : '';
    return `<div class="psn-entry ${cls}">
      <span class="psn-entry-ts">${ts}</span>
      <span class="psn-entry-msg">${escHtml(e.message)}</span>${sub}
    </div>`;
  }).join('');
}

$('btn-psn-send').addEventListener('click', async () => {
  const msg = $('psn-message').value.trim();
  const sub = $('psn-submessage').value.trim();
  if (!msg) { $('psn-status').textContent = 'Message is required.'; return; }
  const btn = $('btn-psn-send');
  btn.disabled = true;
  $('psn-status').textContent = 'Sending\u2026';
  try {
    await window.pork.psnotifySend(msg, sub);
    $('psn-status').textContent = 'Sent \u2713';
    $('psn-message').value    = '';
    $('psn-submessage').value = '';
    await renderPsnHistory();
  } catch (e) {
    $('psn-status').textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
});

$('btn-psn-test').addEventListener('click', async () => {
  const btn = $('btn-psn-test');
  btn.disabled = true;
  $('psn-status').textContent = 'Sending test\u2026';
  try {
    await window.pork.psnotifyTest();
    $('psn-status').textContent = 'Test sent \u2713';
    await renderPsnHistory();
  } catch (e) {
    $('psn-status').textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
});

$('btn-psn-save-settings').addEventListener('click', async () => {
  const port = parseInt($('psn-port').value) || 6969;
  await window.pork.setSettings({
    psnotifyEnabled: $('psn-enabled').checked,
    psnotifyPort:    port,
  });
  $('psn-port').value = port;
  $('psn-status').textContent = 'Settings saved \u2713';
});

$('btn-psn-refresh-history').addEventListener('click', renderPsnHistory);

// ── PS Notify colour/encoding experiments ────────────────────────────────────────

async function _sendExp(msg, sub = '') {
  const el = $('psn-exp-status');
  el.textContent = 'Sending…';
  try {
    await window.pork.psnotifySend(msg, sub);
    el.textContent = 'Sent \u2713 — check your PS5';
    await renderPsnHistory();
  } catch (e) {
    el.textContent = 'Error: ' + e.message;
  }
}

$('btn-psn-push-payload').addEventListener('click', async () => {
  const btn = $('btn-psn-push-payload');
  const st  = $('psn-push-status');
  btn.disabled = true;
  st.textContent = 'Queuing upload\u2026';
  try {
    const res = await window.pork.psnotifyPushPayload();
    st.textContent = `Queued \u2713 \u2014 sending to ${res.remotePath}. Reload the payload on your PS5 then emoji will work.`;
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
});

// HTML markup
$('btn-psn-exp-html-red').addEventListener('click', () =>
  _sendExp('<font color="red">This is red text</font>', 'HTML <font color> test'));

$('btn-psn-exp-html-multi').addEventListener('click', () =>
  _sendExp('<font color="red">Red</font> <font color="green">Green</font> <font color="blue">Blue</font>', 'HTML multi-colour test'));

$('btn-psn-exp-sony-tag').addEventListener('click', () =>
  _sendExp('$[color=ff0000]Red$[/color] $[color=00ff00]Green$[/color]', 'Sony $[color] tag test'));

// Emoji colour squares (4-byte UTF-8 — need TextDecoder patch in customPSNotify.js to arrive intact)
$('btn-psn-exp-sq-red').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE5 Red notification', 'Emoji \uD83D\uDFE5 (U+1F7E5, 4-byte UTF-8)'));

$('btn-psn-exp-sq-green').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE9 Green notification', 'Emoji \uD83D\uDFE9 (U+1F7E9, 4-byte UTF-8)'));

$('btn-psn-exp-sq-blue').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE6 Blue notification', 'Emoji \uD83D\uDFE6 (U+1F7E6, 4-byte UTF-8)'));

$('btn-psn-exp-sq-yellow').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE8 Yellow notification', 'Emoji \uD83D\uDFE8 (U+1F7E8, 4-byte UTF-8)'));

$('btn-psn-exp-sq-all').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE5\uD83D\uDFE7\uD83D\uDFE8\uD83D\uDFE9\uD83D\uDFE6\uD83D\uDFEA Colour squares test', 'All 6 colour squares'));

// ANSI escape codes
$('btn-psn-exp-ansi-red').addEventListener('click', () =>
  _sendExp('\x1b[31mRed ANSI text\x1b[0m', 'ANSI \\x1b[31m colour test'));

$('btn-psn-exp-ansi-bold').addEventListener('click', () =>
  _sendExp('\x1b[1mBold ANSI text\x1b[0m', 'ANSI \\x1b[1m bold test'));

// ── VoidShell (native) ────────────────────────────────────────────────────────
let _vsInterval         = null;
let _vsFsProgInterval   = null;
let _vsInitialized      = false;
let _vsLibrary          = [];
let _vsConfig           = {};
let _vsFavs             = new Set(JSON.parse(localStorage.getItem('vs-favs') || '[]'));
let _vsFavOnly          = false;
let _vsSort             = 'name';
let _vsSearch           = '';
let _vsPkgFile          = null;
const _vsImgCache       = {};
let _vsPanels = {
  left:  { path: '/mnt/usb0', selection: null },
  right: { path: '/data',     selection: null },
};

async function loadVoidshell() {
  const s = await window.pork.getSettings();
  const ip   = s.ftpHost || '';
  const port = s.voidshellPort || 7007;
  $('vs-ip-display').textContent = ip || '(not set — configure FTP Settings)';
  $('vs-port').value             = port;
  $('s-voidshell-port').value    = port;
  if (!ip) return;
  if (!_vsInitialized) { _vsInitialized = true; _vsInitEvents(); }
  await _vsRefreshAll();
  if (_vsInterval) clearInterval(_vsInterval);
  _vsInterval = setInterval(_vsRefreshStats, 5000);
}

// — Helpers —
async function _vsGet(path)           { return window.pork.vsRequest(path); }
async function _vsPost(path, body, t) { return window.pork.vsPost(path, body, t); }

function _vsFormatBytes(b) {
  if (b < 1024)           return `${b} B`;
  if (b < 1048576)        return `${(b/1024).toFixed(1)} KB`;
  if (b < 1073741824)     return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}

function _vsParentPath(p) {
  const parts = p.replace(/\/$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function _vsGameName(id) {
  const g = _vsLibrary.find(g => g.id === id);
  return g ? g.name : id;
}

async function _vsLoadImg(imgId, apiPath) {
  const cached = _vsImgCache[apiPath];
  if (cached) { const el = $(imgId); if (el) el.src = cached; return; }
  const src = await window.pork.vsImage(apiPath);
  if (src) {
    _vsImgCache[apiPath] = src;
    const el = $(imgId);
    if (el) el.src = src;
  }
}

// — Tab switching —
function _vsSwitchTab(name) {
  document.querySelectorAll('.vs-tab').forEach(t => t.classList.toggle('active', t.dataset.vsTab === name));
  document.querySelectorAll('.vs-pane').forEach(p => p.classList.toggle('active', p.id === `vs-pane-${name}`));
  if (name === 'logs')     _vsLoadLogs();
  if (name === 'settings') _vsLoadSettings();
  if (name === 'payloads') _vsLoadPayloads();
  if (name === 'pkg')      _vsLoadTempFiles();
  if (name === 'files')    { _vsLoadPanel('left'); _vsLoadPanel('right'); }
}

// — Stats & Library —
async function _vsRefreshAll() {
  await Promise.all([_vsRefreshStats(), _vsRefreshLibrary()]);
}

async function _vsRefreshStats() {
  try {
    const r = await _vsGet('/api/stats');
    if (r.ok) _vsApplyStats(r.data);
  } catch(e) { console.error('[VS] stats', e); }
}

async function _vsRefreshLibrary() {
  try {
    const r = await _vsGet('/api/library');
    if (r.ok) { _vsLibrary = r.data.games || []; _vsRenderGrid(); }
  } catch(e) { console.error('[VS] library', e); }
}

function _vsApplyStats(s) {
  const hasGame = s.active_game && s.state !== 'HOME';
  // Status bar
  $('vs-username').textContent    = s.username || '—';
  $('vs-active-game').textContent = hasGame ? `${s.active_game} · ${s.state}` : 'No game running';
  $('vs-temp-soc').textContent    = `${s.soc}°C `;
  $('vs-temp-cpu').textContent    = `${s.cpu}°C `;
  $('vs-uptime').textContent      = s.sys_uptime || '—';
  if (s.userid) _vsLoadImg('vs-avatar', `/api/avatar?id=${s.userid}&rev=0`);
  // Hero
  $('vs-hero-title').textContent  = hasGame ? _vsGameName(s.active_game) : 'No game running';
  $('vs-hero-id').textContent     = hasGame ? s.active_game : '';
  $('btn-vs-close-game').hidden   = !hasGame;
  if (hasGame) _vsLoadImg('vs-hero-art', `/assets/pic?id=${s.active_game}`);
  else { const el = $('vs-hero-art'); if (el) el.src = ''; }
  // Stat cards
  $('vs-stat-soc').textContent    = `${s.soc}°C`;
  $('vs-stat-cpu').textContent    = `${s.cpu}°C`;
  $('vs-stat-uptime').textContent = s.sys_uptime || '—';
  $('vs-stat-lib').textContent    = `${s.total}`;
  $('vs-stat-lib-sub').textContent = `PS5: ${s.ps5} · PS4: ${s.ps4}`;
}

function _vsRenderGrid() {
  const grid = $('vs-game-grid');
  if (!grid) return;
  let games = [..._vsLibrary];
  if (_vsFavOnly) games = games.filter(g => _vsFavs.has(g.id));
  const q = _vsSearch.toLowerCase();
  if (q) games = games.filter(g => g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q));
  if (_vsSort === 'name') games.sort((a, b) => a.name.localeCompare(b.name));
  else games.sort((a, b) => a.id.localeCompare(b.id));
  if (!games.length) {
    grid.innerHTML = '<div class="vs-empty-lib">No games found.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const g of games) {
    const isFav = _vsFavs.has(g.id);
    const card  = document.createElement('div');
    card.className   = 'vs-game-card';
    card.dataset.id  = g.id;
    card.innerHTML = `
      <div class="vs-card-art-wrap"><img class="vs-card-art" id="vs-art-${g.id}" src="" alt=""></div>
      <div class="vs-card-body">
        <div class="vs-card-name">${g.name}</div>
        <div class="vs-card-meta">${g.id} · v${g.version}</div>
        <div class="vs-card-actions">
          <button class="btn btn-xs btn-accent vs-btn-launch" data-id="${g.id}">▶</button>
          <button class="btn btn-xs vs-btn-fav${isFav ? ' active' : ''}" data-id="${g.id}">★</button>
        </div>
      </div>`;
    grid.appendChild(card);
    _vsLoadImg(`vs-art-${g.id}`, `/assets/pic?id=${g.id}`);
  }
}

// — File Commander —
async function _vsLoadPanel(side) {
  const panel = _vsPanels[side];
  $(`vs-path-${side}`).textContent = panel.path;
  const listEl = $(`vs-list-${side}`);
  listEl.innerHTML = '<div class="vs-empty-msg">Loading…</div>';
  try {
    const r = await _vsGet(`/api/fs/list?dir=${encodeURIComponent(panel.path)}`);
    if (!r.ok) throw new Error('List failed');
    _vsRenderPanel(side, r.data.items || []);
  } catch(e) { listEl.innerHTML = `<div class="vs-empty-msg vs-err">Error: ${e.message}</div>`; }
}

function _vsRenderPanel(side, items) {
  const listEl = $(`vs-list-${side}`);
  _vsPanels[side].selection = null;
  if (!items.length) { listEl.innerHTML = '<div class="vs-empty-msg">Empty</div>'; return; }
  items.sort((a, b) => a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name));
  listEl.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className      = 'vs-fs-item' + (item.is_dir ? ' vs-fs-dir' : '');
    el.dataset.name   = item.name;
    const sz = item.is_dir ? '' : `<span class="vs-fs-size">${_vsFormatBytes(item.size)}</span>`;
    el.innerHTML = `<span class="vs-fs-icon">${item.is_dir ? '📁' : '📄'}</span><span class="vs-fs-name">${item.name}</span>${sz}`;
    el.addEventListener('click', () => {
      if (item.is_dir) {
        _vsPanels[side].path = _vsPanels[side].path.replace(/\/$/, '') + '/' + item.name;
        _vsLoadPanel(side);
      } else {
        listEl.querySelectorAll('.vs-fs-item').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        _vsPanels[side].selection = item.name;
      }
    });
    listEl.appendChild(el);
  }
}

async function _vsFsOp(op, srcSide, dstSide) {
  const src = _vsPanels[srcSide];
  if (!src.selection) { showToast('Select a file first', 'error'); return; }
  const srcPath = src.path.replace(/\/$/, '') + '/' + src.selection;
  const dstPath = _vsPanels[dstSide].path.replace(/\/$/, '') + '/' + src.selection;
  try {
    await _vsPost('/api/fs/safety', { enabled: $('vs-safety-mode')?.checked });
    await _vsPost('/api/fs/control', { op, src: srcPath, dst: dstPath });
    showToast(`${op} started`, 'ok');
    _vsStartFsProgress();
  } catch(e) { showToast(`${op} failed: ${e.message}`, 'error'); }
}

async function _vsFsDelete(side) {
  const panel = _vsPanels[side];
  if (!panel.selection) { showToast('Select a file first', 'error'); return; }
  const path = panel.path.replace(/\/$/, '') + '/' + panel.selection;
  try {
    await _vsPost('/api/fs/safety', { enabled: $('vs-safety-mode')?.checked });
    await _vsPost('/api/fs/delete', { path });
    showToast('Deleted', 'ok');
    _vsLoadPanel(side);
  } catch(e) { showToast('Delete failed: ' + e.message, 'error'); }
}

function _vsStartFsProgress() {
  const wrap = $('vs-fs-prog-wrap');
  if (wrap) wrap.hidden = false;
  if (_vsFsProgInterval) clearInterval(_vsFsProgInterval);
  _vsFsProgInterval = setInterval(async () => {
    try {
      const r = await _vsGet('/api/fs/progress');
      if (!r.ok) return;
      const p = r.data;
      $('vs-fs-prog-lbl').textContent  = `${p.task}: ${p.file} (${p.speed})`;
      $('vs-fs-prog-fill').style.width = `${p.percent}%`;
      $('vs-fs-prog-pct').textContent  = `${p.percent}%`;
      if (!p.busy && p.state === 'IDLE') {
        clearInterval(_vsFsProgInterval);
        _vsFsProgInterval = null;
        setTimeout(() => { const w = $('vs-fs-prog-wrap'); if (w) w.hidden = true; }, 2000);
        _vsLoadPanel('left');
        _vsLoadPanel('right');
      }
    } catch {}
  }, 1000);
}

// — PKG —
async function _vsLoadTempFiles() {
  const el = $('vs-pkg-temp-list');
  if (!el) return;
  el.innerHTML = '<div class="vs-empty-msg">Loading…</div>';
  try {
    const r = await _vsGet('/api/fs/list?dir=/data/pkg_temp');
    const items = r.ok ? (r.data.items || []).filter(i => !i.is_dir) : [];
    if (!items.length) { el.innerHTML = '<div class="vs-empty-msg">No temp files.</div>'; return; }
    el.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'vs-pkg-temp-row';
      row.innerHTML = `<span class="vs-pkg-temp-name">${item.name}</span><span class="vs-fs-size">${_vsFormatBytes(item.size)}</span>`;
      el.appendChild(row);
    }
  } catch { el.innerHTML = '<div class="vs-empty-msg">Could not list temp files.</div>'; }
}

// — Payloads —
let _vsPayloads = [];
async function _vsLoadPayloads() {
  try {
    const r = await _vsGet('/api/payloads');
    if (r.ok) { _vsPayloads = r.data.files || []; _vsRenderPayloads(); }
  } catch(e) { console.error('[VS] payloads', e); }
}

function _vsRenderPayloads() {
  const el = $('vs-payload-list');
  if (!el) return;
  if (!_vsPayloads.length) { el.innerHTML = '<div class="vs-empty-msg">No payloads found.</div>'; return; }
  el.innerHTML = '';
  for (const p of _vsPayloads) {
    const row = document.createElement('div');
    row.className    = 'vs-payload-row';
    row.dataset.name = p.name;
    row.innerHTML = `
      <label class="vs-payload-auto"><input type="checkbox" class="vs-pl-en" ${p.enabled ? 'checked' : ''}><span>AUTO</span></label>
      <input type="number" class="vs-pl-seq vs-num-input" value="${p.order}" min="0" max="99" title="Order">
      <span class="vs-payload-name">${p.name}</span>
      <button class="btn btn-xs btn-accent vs-btn-inject" data-name="${p.name}">Inject</button>`;
    el.appendChild(row);
  }
}

async function _vsInjectPayload(name) {
  try {
    await _vsPost('/api/send_payload', { name });
    showToast(`Injected: ${name}`, 'ok');
  } catch(e) { showToast('Inject failed: ' + e.message, 'error'); }
}

async function _vsSavePayloadConfig() {
  if (!Object.keys(_vsConfig).length) {
    const r = await _vsGet('/api/config_raw');
    _vsConfig = _vsParseIni(r.data);
  }
  _vsConfig.AutoPayloads = {};
  document.querySelectorAll('.vs-payload-row').forEach(row => {
    const en    = row.querySelector('.vs-pl-en')?.checked;
    const order = row.querySelector('.vs-pl-seq')?.value || '0';
    if (en) _vsConfig.AutoPayloads[row.dataset.name] = `0,${order}`;
  });
  try {
    await _vsPost('/api/save_ini', _vsSerializeIni(_vsConfig), 'text');
    showToast('Payload config saved', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
}

// — Settings (INI) —
function _vsParseIni(text) {
  const cfg = {};
  let section = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      cfg[section] = {};
    } else if (section) {
      const eq = line.indexOf('=');
      if (eq >= 0) cfg[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      else cfg[section][line] = '';
    }
  }
  return cfg;
}

function _vsSerializeIni(cfg) {
  const order = ['Settings', 'FanControl', 'Sentinel', 'SentinelWhitelist', 'SentinelGames', 'AutoPayloads', 'CustomPaths', 'Blacklist'];
  const lines  = ['# VOIDSHELL CONFIGURATION'];
  const done   = new Set();
  for (const sec of order) {
    if (!cfg[sec]) continue;
    done.add(sec);
    lines.push('');
    if (sec === 'FanControl')  lines.push('# FAN CONTROL');
    if (sec === 'Sentinel')    lines.push('# SENTINEL CONFIGURATION');
    lines.push(`[${sec}]`);
    for (const [k, v] of Object.entries(cfg[sec])) lines.push(v === '' ? k : `${k}=${v}`);
  }
  for (const sec of Object.keys(cfg)) {
    if (done.has(sec)) continue;
    lines.push(''); lines.push(`[${sec}]`);
    for (const [k, v] of Object.entries(cfg[sec])) lines.push(v === '' ? k : `${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

async function _vsLoadSettings() {
  try {
    const r = await _vsGet('/api/config_raw');
    _vsConfig = _vsParseIni(r.data);
    _vsPopulateSettings();
  } catch(e) { showToast('Could not load settings: ' + e.message, 'error'); }
}

function _vsPopulateSettings() {
  const S   = _vsConfig.Settings         || {};
  const F   = _vsConfig.FanControl       || {};
  const Sen = _vsConfig.Sentinel         || {};
  $('vs-cfg-scan').value       = S.ScanInterval   || 5;
  $('vs-cfg-stable').value     = S.StableWindow   || 10;
  $('vs-cfg-webserver').checked = S.EnableWebServer !== 'false';
  $('vs-cfg-autokill').checked  = S.AutoKill       !== 'false';
  $('vs-cfg-dbpatch').checked   = S.EnableDBPatch  !== 'false';
  $('vs-cfg-fan-en').checked    = F.Enabled === 'true';
  const t = parseInt(F.TargetTemp || '60');
  $('vs-cfg-fan-temp').value       = t;
  $('vs-cfg-fan-temp-val').textContent = `${t}°C`;
  $('vs-cfg-sentinel').checked     = Sen.EnableSentinel  !== 'false';
  $('vs-cfg-sen-notify').checked   = Sen.ShowDebugNotify !== 'false';
  $('vs-cfg-sen-delay').value      = Sen.DefaultDelay    || 10000;
  $('vs-cfg-resume-delay').value   = Sen.ResumeDelay     || 3000;
  $('vs-cfg-fast-resume').checked  = Sen.FastResume      !== 'false';
  $('vs-cfg-whitelist').value  = Object.keys(_vsConfig.SentinelWhitelist || {}).join('\n');
  $('vs-cfg-sen-games').value  = Object.entries(_vsConfig.SentinelGames || {}).map(([k, v]) => v ? `${k}=${v}` : k).join('\n');
  $('vs-cfg-blacklist').value  = Object.keys(_vsConfig.Blacklist    || {}).join('\n');
  $('vs-cfg-custpaths').value  = Object.keys(_vsConfig.CustomPaths  || {}).join('\n');
}

function _vsReadSettings() {
  const cfg = { ..._vsConfig };
  cfg.Settings = {
    ScanInterval:    $('vs-cfg-scan').value,
    StableWindow:    $('vs-cfg-stable').value,
    EnableDBPatch:   $('vs-cfg-dbpatch').checked.toString(),
    EnableWebServer: $('vs-cfg-webserver').checked.toString(),
    AutoKill:        $('vs-cfg-autokill').checked.toString(),
  };
  cfg.FanControl = {
    Enabled:    $('vs-cfg-fan-en').checked.toString(),
    TargetTemp: $('vs-cfg-fan-temp').value,
  };
  cfg.Sentinel = {
    EnableSentinel:   $('vs-cfg-sentinel').checked.toString(),
    DefaultDelay:     $('vs-cfg-sen-delay').value,
    ResumeDelay:      $('vs-cfg-resume-delay').value,
    FastResume:       $('vs-cfg-fast-resume').checked.toString(),
    ShowDebugNotify:  $('vs-cfg-sen-notify').checked.toString(),
  };
  const parseLines = text => text.split('\n').map(l => l.trim()).filter(Boolean);
  cfg.SentinelWhitelist = {};
  parseLines($('vs-cfg-whitelist').value).forEach(id => cfg.SentinelWhitelist[id] = '');
  cfg.SentinelGames = {};
  parseLines($('vs-cfg-sen-games').value).forEach(l => {
    const eq = l.indexOf('=');
    if (eq >= 0) cfg.SentinelGames[l.slice(0, eq).trim()] = l.slice(eq + 1).trim();
    else cfg.SentinelGames[l] = '';
  });
  cfg.Blacklist = {};
  parseLines($('vs-cfg-blacklist').value).forEach(id => cfg.Blacklist[id] = '');
  cfg.CustomPaths = {};
  parseLines($('vs-cfg-custpaths').value).forEach(p => cfg.CustomPaths[p] = '');
  return cfg;
}

async function _vsSaveSettings() {
  try {
    _vsConfig = _vsReadSettings();
    await _vsPost('/api/save_ini', _vsSerializeIni(_vsConfig), 'text');
    showToast('Settings saved', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
}

// — Logs —
async function _vsLoadLogs() {
  try {
    const r = await _vsGet('/api/logs');
    _vsRenderLogs(r.data);
  } catch(e) { console.error('[VS] logs', e); }
}

function _vsRenderLogs(text) {
  const el = $('vs-log-terminal');
  if (!el) return;
  el.innerHTML = '';
  for (const line of text.split('\n').filter(Boolean)) {
    const div = document.createElement('div');
    div.className  = 'vs-log-line';
    if (line.includes('[WARDEN]'))  div.classList.add('vs-log-warden');
    else if (line.includes('[PAYLOAD]')) div.classList.add('vs-log-payload');
    else if (line.includes('[USER]'))    div.classList.add('vs-log-user');
    div.textContent = line;
    el.appendChild(div);
  }
  if ($('vs-autoscroll')?.checked) el.scrollTop = el.scrollHeight;
}

// — Event wiring —
function _vsInitEvents() {
  // Tab bar
  document.querySelectorAll('.vs-tab').forEach(t =>
    t.addEventListener('click', () => _vsSwitchTab(t.dataset.vsTab)));

  // Home — game grid delegation
  $('vs-game-grid')?.addEventListener('click', e => {
    const lb = e.target.closest('.vs-btn-launch');
    const fb = e.target.closest('.vs-btn-fav');
    if (lb) {
      _vsPost('/api/launch', { id: lb.dataset.id })
        .then(() => { showToast(`Launched ${lb.dataset.id}`, 'ok'); setTimeout(_vsRefreshStats, 3000); })
        .catch(err => showToast('Launch failed: ' + err.message, 'error'));
    } else if (fb) {
      const id = fb.dataset.id;
      if (_vsFavs.has(id)) _vsFavs.delete(id); else _vsFavs.add(id);
      localStorage.setItem('vs-favs', JSON.stringify([..._vsFavs]));
      _vsRenderGrid();
    }
  });
  $('vs-search')?.addEventListener('input', e => { _vsSearch = e.target.value; _vsRenderGrid(); });
  $('vs-sort')?.addEventListener('change', e => { _vsSort = e.target.value; _vsRenderGrid(); });
  $('btn-vs-favs-toggle')?.addEventListener('click', () => {
    _vsFavOnly = !_vsFavOnly;
    $('btn-vs-favs-toggle')?.classList.toggle('active', _vsFavOnly);
    _vsRenderGrid();
  });
  $('btn-vs-rescan')?.addEventListener('click', async () => {
    try { await _vsPost('/api/rescan', {}); showToast('Rescan triggered', 'ok'); setTimeout(_vsRefreshLibrary, 3000); }
    catch(e) { showToast('Rescan failed: ' + e.message, 'error'); }
  });
  $('btn-vs-close-game')?.addEventListener('click', async () => {
    try { await _vsPost('/api/game/close', {}); showToast('Close sent', 'ok'); setTimeout(_vsRefreshStats, 3000); }
    catch(e) { showToast('Close failed: ' + e.message, 'error'); }
  });

  // Files
  $('btn-vs-up-left')?.addEventListener('click',  () => { _vsPanels.left.path  = _vsParentPath(_vsPanels.left.path);  _vsLoadPanel('left'); });
  $('btn-vs-up-right')?.addEventListener('click', () => { _vsPanels.right.path = _vsParentPath(_vsPanels.right.path); _vsLoadPanel('right'); });
  $('btn-vs-copy-lr')?.addEventListener('click', () => _vsFsOp('copy', 'left',  'right'));
  $('btn-vs-move-lr')?.addEventListener('click', () => _vsFsOp('move', 'left',  'right'));
  $('btn-vs-copy-rl')?.addEventListener('click', () => _vsFsOp('copy', 'right', 'left'));
  $('btn-vs-move-rl')?.addEventListener('click', () => _vsFsOp('move', 'right', 'left'));
  $('btn-vs-del-left')?.addEventListener('click',  () => _vsFsDelete('left'));
  $('btn-vs-del-right')?.addEventListener('click', () => _vsFsDelete('right'));

  // PKG
  $('btn-vs-pkg-install-url')?.addEventListener('click', async () => {
    const url = $('vs-pkg-url')?.value.trim();
    if (!url) { showToast('Enter a URL', 'error'); return; }
    try {
      await _vsPost('/api/install_url', { url });
      showToast('Install queued', 'ok');
      $('vs-pkg-url').value = '';
    } catch(e) { showToast('Install failed: ' + e.message, 'error'); }
  });
  $('btn-vs-pkg-select')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.pkg';
    inp.onchange = e => {
      _vsPkgFile = e.target.files[0];
      $('vs-pkg-selected').textContent = _vsPkgFile.name;
      $('btn-vs-pkg-upload').disabled  = false;
    };
    inp.click();
  });
  $('btn-vs-pkg-upload')?.addEventListener('click', async () => {
    if (!_vsPkgFile) return;
    try {
      const data = await _vsPkgFile.arrayBuffer();
      await window.pork.vsUpload('/api/fs/upload?dir=/data/pkg_temp', data, _vsPkgFile.name);
      showToast('PKG uploaded', 'ok');
      _vsPkgFile = null;
      $('vs-pkg-selected').textContent = 'No file selected';
      $('btn-vs-pkg-upload').disabled  = true;
      _vsLoadTempFiles();
    } catch(e) { showToast('Upload failed: ' + e.message, 'error'); }
  });
  $('btn-vs-clear-temp')?.addEventListener('click', async () => {
    try {
      await _vsPost('/api/fs/delete', { path: '/data/pkg_temp' });
      showToast('Temp files cleared', 'ok');
      _vsLoadTempFiles();
    } catch(e) { showToast('Clear failed: ' + e.message, 'error'); }
  });

  // Payloads
  $('vs-payload-list')?.addEventListener('click', e => {
    const ib = e.target.closest('.vs-btn-inject');
    if (ib) _vsInjectPayload(ib.dataset.name);
  });
  $('btn-vs-payload-save')?.addEventListener('click', _vsSavePayloadConfig);

  // Settings
  $('vs-cfg-fan-temp')?.addEventListener('input', e => {
    $('vs-cfg-fan-temp-val').textContent = `${e.target.value}°C`;
  });
  $('btn-vs-save-settings')?.addEventListener('click', _vsSaveSettings);
  $('btn-vs-cache-clear')?.addEventListener('click', async () => {
    try { await _vsGet('/api/cache_image'); showToast('Image cache cleared', 'ok'); }
    catch(e) { showToast('Failed: ' + e.message, 'error'); }
  });
  $('btn-vs-repair')?.addEventListener('click', async () => {
    try { await _vsGet('/api/repair'); showToast('Repair triggered', 'ok'); }
    catch(e) { showToast('Failed: ' + e.message, 'error'); }
  });

  // Logs
  $('btn-vs-clear-logs')?.addEventListener('click', async () => {
    try { await _vsPost('/api/logs/clear', {}); showToast('Logs cleared', 'ok'); _vsLoadLogs(); }
    catch(e) { showToast('Failed: ' + e.message, 'error'); }
  });
}

// Toolbar buttons (outside VS body, keep working)
$('btn-vs-load').addEventListener('click', async () => {
  const s  = await window.pork.getSettings();
  const ip = s.ftpHost || '';
  if (!ip) { showToast('PS5 IP not set. Configure FTP Settings first.', 'error'); return; }
  _vsInitialized = false;
  loadVoidshell();
});

$('btn-vs-save').addEventListener('click', async () => {
  const port = parseInt($('vs-port').value) || 7007;
  await window.pork.setSettings({ voidshellPort: port });
  $('vs-port').value          = port;
  $('s-voidshell-port').value = port;
  showToast('Voidshell port saved.', 'ok');
});

$('btn-vs-refresh').addEventListener('click', () => { _vsRefreshAll().catch(() => {}); });

$('btn-vs-open-ext').addEventListener('click', async () => {
  const s  = await window.pork.getSettings();
  const ip = s.ftpHost || '';
  const port = parseInt($('vs-port').value) || 7007;
  if (!ip) { showToast('PS5 IP not set. Configure FTP Settings first.', 'error'); return; }
  window.pork.openShell(`http://${ip}:${port}`);
});

$('btn-s-voidshell-save').addEventListener('click', async () => {
  const port = parseInt($('s-voidshell-port').value) || 7007;
  await window.pork.setSettings({ voidshellPort: port });
  $('s-voidshell-port').value = port;
  showToast('Voidshell port saved.', 'ok');
});

// ── Local Save Manager (native GarlicMgr UI) ────────────────────────────────

// ── State ───────────────────────────────────────────────────────────────────
const smState = {
  saves: [], selectedIdx: -1, mounted: false,
  files: [], expanded: new Set(),
  busy: false, tab: 'browse',
};

// ── Terminal log ─────────────────────────────────────────────────────────────
function smLog(msg, cls) {
  const logEl = $('sm-log');
  if (!logEl) return;
  const t = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'sm-ll' + (cls ? ' sm-' + cls : '');
  div.innerHTML = `<span class="sm-lt">${t}</span><span>${escHtml(msg)}</span>`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Confirm modal (replaces native confirm() which is blocked) ───────────────
function smConfirm(message) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;z-index:9900;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;';
    bg.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px 28px;max-width:360px;width:90%;">
      <p style="font-size:14px;color:var(--text);margin-bottom:20px;line-height:1.5;">${escHtml(message)}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-sm" id="smconf-skip">Skip</button>
        <button class="btn btn-sm btn-accent" id="smconf-ok">Replace</button>
      </div></div>`;
    document.body.appendChild(bg);
    bg.querySelector('#smconf-skip').onclick = () => { bg.remove(); resolve(false); };
    bg.querySelector('#smconf-ok').onclick   = () => { bg.remove(); resolve(true);  };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function smFmtBytes(b) {
  if (!b) return '0B';
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'K';
  return (b / 1048576).toFixed(1) + 'M';
}
function smSetBusy(v) {
  smState.busy = v;
  ['btn-sm-dl-zip','btn-sm-dl-enc','btn-sm-dump-usb','btn-sm-upload','btn-sm-unmount']
    .forEach(id => { const el = $(id); if (el) el.disabled = v; });
}
function smShowUsbProgress(pct) {
  const bar = $('sm-usb-progress'); if (bar) bar.hidden = false;
  const fill = $('sm-usb-fill');   if (fill) fill.style.width = pct + '%';
}
function smHideUsbProgress() { const bar = $('sm-usb-progress'); if (bar) bar.hidden = true; }
function smShowUploadProgress(pct, loaded, total) {
  const bar = $('sm-upload-progress'); if (bar) bar.hidden = false;
  const fill = $('sm-upload-fill');   if (fill) fill.style.width = pct + '%';
  const txt  = $('sm-upload-text');   if (txt) txt.textContent = `${smFmtBytes(loaded)} / ${smFmtBytes(total)} (${pct}%)`;
}
function smHideUploadProgress() { const bar = $('sm-upload-progress'); if (bar) bar.hidden = true; }

// ── Load / reload saves ──────────────────────────────────────────────────────
async function loadSaveMgr() {
  const s = await window.pork.getSettings();
  const ip   = s.ftpHost || '';
  const port = s.savemgrPort || 8082;
  $('sm-ip-display').textContent = ip || '(not set — configure FTP Settings)';
  $('sm-port').value = port;
  const ssp = $('s-savemgr-port'); if (ssp) ssp.value = port;
  if (ip) smFetchSaves();
}

async function smFetchSaves() {
  try {
    const d = await window.pork.savemgrRequest('/api/saves');
    smState.saves = d.saves || [];
    smRenderSaves();
    smLog(`Loaded ${smState.saves.length} saves`, 'ok');
  } catch (e) {
    smLog('Failed to load saves: ' + e.message, 'err');
    smState.saves = [];
    smRenderSaves();
  }
}

function smRenderSaves() {
  const el = $('sm-saves-list');
  if (!smState.saves.length) {
    el.innerHTML = '<div class="sm-empty-list">No saves found</div>';
    return;
  }
  el.innerHTML = smState.saves.map((s, i) =>
    `<div class="sm-save-item${i === smState.selectedIdx ? ' active' : ''}" data-idx="${i}">
      <div class="sm-save-tid">${escHtml(s.title_id)}</div>
      <div class="sm-save-name">${escHtml(s.save_name)}</div>
    </div>`
  ).join('');
  el.querySelectorAll('.sm-save-item').forEach(item =>
    item.addEventListener('click', () => smSelectSave(parseInt(item.dataset.idx)))
  );
}

async function smSelectSave(idx) {
  if (smState.busy || smState.tab !== 'browse') return;
  smState.selectedIdx = idx;
  smRenderSaves();
  await smMount(idx);
}

async function smMount(idx) {
  if (smState.busy) return;
  smSetBusy(true);
  const s = smState.saves[idx];
  smLog(`Mounting ${s.title_id}/${s.save_name}...`);
  try {
    const d = await window.pork.savemgrRequest(`/api/mount?idx=${idx}`);
    if (d.error) { smLog('Mount failed: ' + d.error, 'err'); smSetBusy(false); return; }
    smState.mounted = true;
    smState.files   = d.files || [];
    smState.expanded = new Set(smState.files.filter(f => f.dir).map(f => f.name));
    $('sm-save-title-text').textContent   = d.save_title || 'Untitled';
    $('sm-save-title-id').innerHTML       = d.title_id   ? `Title ID: <b>${escHtml(d.title_id)}</b>` : '';
    $('sm-save-account-id').innerHTML     = d.account_id ? `&nbsp;&nbsp;Account: <b style="font-family:monospace">${escHtml(d.account_id)}</b>` : '';
    $('sm-save-ftp-row').textContent      = d.mount      ? `FTP: ${d.mount}` : '';
    $('sm-save-header').hidden = false;
    $('sm-empty-state').hidden = true;
    smLoadIcon();
    smRenderFileTree();
    smLog(`Mounted ${[d.title_id, d.save_title, d.account_id ? '['+d.account_id+']' : ''].filter(Boolean).join(' ')}`, 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

async function smLoadIcon() {
  try {
    const dataUrl = await window.pork.savemgrIcon();
    const img = $('sm-game-icon');
    if (dataUrl) { img.src = dataUrl; img.hidden = false; }
    else img.hidden = true;
  } catch (_) { $('sm-game-icon').hidden = true; }
}

// ── File tree ────────────────────────────────────────────────────────────────
function smRenderFileTree() {
  const tree = $('sm-filetree');
  tree.hidden = false;
  let h = '';
  smState.files.forEach((f, i) => {
    const parts = f.name.split('/'); parts.pop();
    let visible = true, pp = '';
    for (let j = 0; j < parts.length; j++) {
      pp = j ? pp + '/' + parts[j] : parts[j];
      if (!smState.expanded.has(pp)) { visible = false; break; }
    }
    if (!visible) return;
    const depth = f.name.split('/').length - 1;
    const name  = f.name.split('/').pop();
    const pad   = 12 + depth * 16;
    if (f.dir) {
      const open = smState.expanded.has(f.name);
      h += `<div class="sm-fi sm-fi-dir" style="padding-left:${pad}px" data-fidx="${i}">
        <span class="sm-fi-arrow">${open ? '▾' : '▸'}</span> 📁 ${escHtml(name)}</div>`;
    } else {
      const fname = escHtml(f.name).replace(/'/g, "\\'");
      h += `<div class="sm-fi" style="padding-left:${pad}px" data-fname="${escHtml(f.name)}">
        📄 ${escHtml(name)}<span class="sm-fi-sz">${smFmtBytes(f.size)}</span></div>`;
    }
  });
  h += '<div class="sm-tip">Tip: drag &amp; drop files here to add or replace them</div>';
  tree.innerHTML = h;
  tree.querySelectorAll('.sm-fi-dir').forEach(el =>
    el.addEventListener('click', () => {
      const name = smState.files[parseInt(el.dataset.fidx)].name;
      if (smState.expanded.has(name)) smState.expanded.delete(name);
      else smState.expanded.add(name);
      smRenderFileTree();
    })
  );
  tree.querySelectorAll('.sm-fi:not(.sm-fi-dir)').forEach(el =>
    el.addEventListener('contextmenu', e => { e.preventDefault(); smShowCtxMenu(e, el.dataset.fname); })
  );
  smSetupDropZone(tree, smHandleFileDrop);
}

// ── Context menu ─────────────────────────────────────────────────────────────
document.addEventListener('click', () => { const m = $('sm-ctx-menu'); if (m) m.remove(); });

function smShowCtxMenu(e, fname) {
  const old = $('sm-ctx-menu'); if (old) old.remove();
  const m = document.createElement('div');
  m.className = 'sm-ctx'; m.id = 'sm-ctx-menu';
  m.innerHTML = `<div data-action="download">Download</div>
    <div data-action="upload">Upload File</div>
    <div class="sm-ctx-del" data-action="delete">Delete</div>`;
  m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px';
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  if (r.right  > window.innerWidth)  m.style.left = (window.innerWidth  - r.width  - 4) + 'px';
  if (r.bottom > window.innerHeight) m.style.top  = (window.innerHeight - r.height - 4) + 'px';
  m.querySelectorAll('[data-action]').forEach(item => item.addEventListener('click', () => {
    m.remove();
    if (item.dataset.action === 'download') smDownloadFile(fname);
    else if (item.dataset.action === 'upload')   smPickUploadFile();
    else if (item.dataset.action === 'delete')   smDeleteFile(fname);
  }));
}

// ── File operations ──────────────────────────────────────────────────────────
async function smDownloadFile(fname) {
  smLog(`Downloading ${fname}...`);
  try {
    await window.pork.savemgrDownload(`/api/download_file?name=${encodeURIComponent(fname)}`, fname.split('/').pop());
    smLog(`Downloaded ${fname.split('/').pop()}`, 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
}

function smPickUploadFile() {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true;
  input.onchange = () => { if (input.files.length) smHandleFileDrop(Array.from(input.files)); };
  input.click();
}

async function smDeleteFile(fname) {
  const ok = await smConfirm(`Delete ${fname}?`);
  if (!ok) return;
  try {
    const d = await window.pork.savemgrRequest(`/api/delete_file?name=${encodeURIComponent(fname)}`);
    if (d.error) throw new Error(d.error);
    smLog(`Deleted ${fname}`, 'ok');
    await smRefreshFiles();
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
}

async function smRefreshFiles() {
  const d = await window.pork.savemgrRequest('/api/files');
  smState.files = d.files || [];
  smState.expanded = new Set(smState.files.filter(f => f.dir).map(f => f.name));
  smRenderFileTree();
}

async function smHandleFileDrop(files) {
  if (smState.busy || !smState.mounted) return;
  smSetBusy(true);
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.name.endsWith('.zip')) {
        smLog(`Extracting ${file.name} (${smFmtBytes(file.size)})...`);
        const buf = await file.arrayBuffer();
        const d = await window.pork.savemgrUpload('/api/upload', buf);
        smLog(`Extracted ${d.files} files`, 'ok');
      } else {
        const ce = await window.pork.savemgrRequest(`/api/file_exists?name=${encodeURIComponent(file.name)}`);
        if (ce.exists) {
          const replace = await smConfirm(`${file.name} already exists. Replace it?`);
          if (!replace) { smLog(`Skipped ${file.name}`); continue; }
        }
        smLog(`Uploading ${file.name} (${smFmtBytes(file.size)})...`);
        const buf = await file.arrayBuffer();
        const d = await window.pork.savemgrUpload(`/api/upload_file?name=${encodeURIComponent(file.name)}`, buf);
        smHideUploadProgress();
        if (d.ok) smLog(`Added ${file.name}`, 'ok');
        else smLog(d.error || 'Upload failed', 'err');
      }
    }
    await smRefreshFiles();
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
  smHideUploadProgress();
}

// ── Browse actions ────────────────────────────────────────────────────────────
async function smDownloadZip() {
  if (smState.busy) return; smSetBusy(true);
  const s = smState.saves[smState.selectedIdx];
  const filename = s ? `${s.title_id}_${s.save_name}.zip` : 'save.zip';
  smLog('Downloading decrypted zip...');
  try {
    await window.pork.savemgrDownload('/api/download', filename);
    smLog(`Downloaded ${filename}`, 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

async function smDownloadEncrypted() {
  if (smState.busy || smState.selectedIdx < 0) return; smSetBusy(true);
  const s = smState.saves[smState.selectedIdx];
  smLog('Unmounting and downloading encrypted save...');
  try {
    await window.pork.savemgrRequest('/api/unmount');
    smState.mounted = false;
    await window.pork.savemgrDownload(`/api/download_raw?idx=${smState.selectedIdx}`, `${s.title_id}_${s.save_name}`);
    smState.selectedIdx = -1; smState.files = []; smState.expanded = new Set();
    smRenderSaves();
    $('sm-save-header').hidden = true; $('sm-filetree').hidden = true; $('sm-empty-state').hidden = false;
    smLog('Downloaded encrypted save', 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

async function smDumpToUsb() {
  if (smState.busy || smState.selectedIdx < 0) return; smSetBusy(true);
  smLog('Dumping to USB...');
  window.pork.on('savemgr:usb-progress', data => { smShowUsbProgress(data.progress); });
  try {
    const result = await window.pork.savemgrDumpUsb(smState.selectedIdx);
    window.pork.off('savemgr:usb-progress');
    smHideUsbProgress();
    smLog(result.path ? `Dumped to ${result.path} (${smFmtBytes(result.size)})` : 'Dump complete', 'ok');
  } catch (e) { window.pork.off('savemgr:usb-progress'); smHideUsbProgress(); smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

async function smUnmount() {
  if (smState.busy) return; smSetBusy(true);
  try {
    await window.pork.savemgrRequest('/api/unmount');
    smState.mounted = false; smState.selectedIdx = -1; smState.files = []; smState.expanded = new Set();
    smRenderSaves();
    $('sm-save-header').hidden = true; $('sm-filetree').hidden = true; $('sm-empty-state').hidden = false;
    smLog('Unmounted', 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

// ── Sub-tab switching ─────────────────────────────────────────────────────────
function smSwitchTab(tab) {
  smState.tab = tab;
  document.querySelectorAll('.sm-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.smTab === tab)
  );
  document.querySelectorAll('.sm-pane').forEach(pane =>
    pane.hidden = (pane.id !== `sm-pane-${tab}`)
  );
  if (tab === 'browse') smFetchSaves();
}

// ── Decrypt drop ──────────────────────────────────────────────────────────────
async function smHandleDecryptDrop(files) {
  const file = files[0]; if (!file || smState.busy) return;
  smSetBusy(true);
  smLog(`Uploading ${file.name} (${smFmtBytes(file.size)}) for decrypt...`);
  try {
    const buf = await file.arrayBuffer();
    const filename = file.name.replace(/\.[^.]+$/, '') + '.zip';
    const r = await window.pork.savemgrDecrypt(buf, filename);
    if (r.canceled) smLog('Cancelled');
    else smLog(`Decrypted → ${filename} (${smFmtBytes(r.size)})`, 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

// ── Encrypt drop ──────────────────────────────────────────────────────────────
async function smHandleEncryptDrop(files, folderName) {
  if (!files.length || smState.busy) return;
  const aid = $('sm-enc-aid').value.trim();
  smSetBusy(true);
  let totalSize = 0; for (const f of files) totalSize += f.size;
  smLog(`Creating PFS image (${smFmtBytes(totalSize)} of files)...`);
  try {
    const pfs = await window.pork.savemgrCreatePfs(totalSize);
    if (pfs.error) throw new Error(pfs.error);
    smLog('PFS image created', 'ok');
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const raw   = f._path || f.webkitRelativePath || f.name;
      const parts = raw.split('/');
      const relPath = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      smLog(`Uploading (${i+1}/${files.length}) ${relPath}...`);
      const buf = await f.arrayBuffer();
      const d = await window.pork.savemgrUpload(`/api/upload_file?name=${encodeURIComponent(relPath)}`, buf);
      if (!d.ok) throw new Error(d.error || `Upload failed: ${relPath}`);
    }
    smLog(`All ${files.length} files uploaded`, 'ok');
    const name = folderName || 'encrypted_save';
    smLog('Downloading encrypted save...');
    const r = await window.pork.savemgrDownloadNew(name, aid);
    if (r.canceled) smLog('Cancelled');
    else smLog(`Encrypted save downloaded (${smFmtBytes(r.size)})`, 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

// ── Resign drop ───────────────────────────────────────────────────────────────
async function smHandleResignDrop(files) {
  const file = files[0]; if (!file || smState.busy) return;
  const aid = $('sm-resign-aid').value.trim();
  if (!aid) { smLog('Enter new Account ID first', 'err'); return; }
  smSetBusy(true);
  smLog(`Uploading ${file.name} for resign...`);
  try {
    const buf = await file.arrayBuffer();
    const filename = file.name.replace(/\.[^.]+$/, '') + '_resigned';
    const r = await window.pork.savemgrResign(buf, aid, filename);
    if (r.canceled) smLog('Cancelled');
    else smLog(`Resigned → ${filename} (${smFmtBytes(r.size)})`, 'ok');
  } catch (e) { smLog('Error: ' + e.message, 'err'); }
  smSetBusy(false);
}

// ── Drop zone setup ───────────────────────────────────────────────────────────
function smSetupDropZone(el, handler, folderMode) {
  el.ondragover  = e => { e.preventDefault(); el.classList.add('sm-drag-over'); };
  el.ondragleave = e => { e.preventDefault(); el.classList.remove('sm-drag-over'); };
  el.ondrop = async e => {
    e.preventDefault(); el.classList.remove('sm-drag-over');
    if (folderMode) {
      const items = e.dataTransfer.items, entries = [];
      for (let i = 0; i < items.length; i++) {
        const ent = items[i].webkitGetAsEntry?.(); if (ent) entries.push(ent);
      }
      if (entries.length && entries[0].isDirectory) {
        const files = await smReadFolderEntries(entries[0], '');
        handler(files, entries[0].name);
      } else if (e.dataTransfer.files.length) handler(Array.from(e.dataTransfer.files));
    } else {
      if (e.dataTransfer.files.length) handler(Array.from(e.dataTransfer.files));
    }
  };
  const btn = el.querySelector('.sm-browse-btn');
  if (btn) btn.onclick = e => {
    e.stopPropagation();
    const input = document.createElement('input'); input.type = 'file';
    if (folderMode) input.webkitdirectory = true;
    input.onchange = () => {
      if (!input.files.length) return;
      if (folderMode) { const prefix = input.files[0].webkitRelativePath.split('/')[0]; handler(Array.from(input.files), prefix); }
      else handler(Array.from(input.files));
    };
    input.click();
  };
}

async function smReadFolderEntries(entry, basePath) {
  return new Promise(resolve => {
    if (entry.isFile) { entry.file(f => { f._path = basePath + f.name; resolve([f]); }); }
    else if (entry.isDirectory) {
      const reader = entry.createReader(), all = [];
      const readBatch = () => reader.readEntries(entries => {
        if (!entries.length) { Promise.all(all).then(arrs => resolve(arrs.flat())); return; }
        for (const e of entries) all.push(smReadFolderEntries(e, basePath + entry.name + '/'));
        readBatch();
      });
      readBatch();
    } else resolve([]);
  });
}

// ── Event wiring (run once on startup) ───────────────────────────────────────
(function smInitEvents() {
  document.querySelectorAll('.sm-tab').forEach(btn =>
    btn.addEventListener('click', () => smSwitchTab(btn.dataset.smTab))
  );

  $('btn-sm-load').addEventListener('click', async () => {
    const s = await window.pork.getSettings();
    const ip = s.ftpHost || '';
    const port = parseInt($('sm-port').value) || 8082;
    if (!ip) { showToast('PS5 IP not set. Configure FTP Settings first.', 'error'); return; }
    await window.pork.setSettings({ savemgrPort: port });
    smFetchSaves();
  });

  $('btn-sm-save').addEventListener('click', async () => {
    const port = parseInt($('sm-port').value) || 8082;
    await window.pork.setSettings({ savemgrPort: port });
    const ssp = $('s-savemgr-port'); if (ssp) ssp.value = port;
    showToast('Save Manager port saved.', 'ok');
  });

  $('btn-sm-open-ext').addEventListener('click', async () => {
    const s = await window.pork.getSettings();
    const ip = s.ftpHost || ''; const port = parseInt($('sm-port').value) || 8082;
    if (!ip) { showToast('PS5 IP not set.', 'error'); return; }
    window.pork.openShell(`http://${ip}:${port}`);
  });

  $('btn-sm-dl-zip').addEventListener('click',   smDownloadZip);
  $('btn-sm-dl-enc').addEventListener('click',   smDownloadEncrypted);
  $('btn-sm-dump-usb').addEventListener('click', smDumpToUsb);
  $('btn-sm-unmount').addEventListener('click',  smUnmount);
  $('btn-sm-upload').addEventListener('click',   smPickUploadFile);

  smSetupDropZone($('sm-decrypt-drop'), smHandleDecryptDrop, false);
  smSetupDropZone($('sm-encrypt-drop'), (f, n) => smHandleEncryptDrop(f, n), true);
  smSetupDropZone($('sm-resign-drop'),  smHandleResignDrop,  false);

  // Drag-drop onto the right panel (file browser)
  const rp = $('sm-right-pane');
  rp.ondragover  = e => { e.preventDefault(); if (smState.mounted) rp.classList.add('sm-drag-over'); };
  rp.ondragleave = e => { e.preventDefault(); rp.classList.remove('sm-drag-over'); };
  rp.ondrop = e => {
    e.preventDefault(); rp.classList.remove('sm-drag-over');
    if (smState.mounted && e.dataTransfer.files.length) smHandleFileDrop(Array.from(e.dataTransfer.files));
  };

  $('btn-sm-push-payload').addEventListener('click', async () => {
    const btn = $('btn-sm-push-payload'), st = $('sm-push-status');
    btn.disabled = true; st.textContent = 'Installing\u2026';
    try {
      const res = await window.pork.savemgrPushPayload();
      st.textContent = res.appended
        ? 'Installed \u2713 \u2014 garlic-savemgr.elf uploaded and added to autoload.txt. Restart your PS5 to apply.'
        : 'Installed \u2713 \u2014 garlic-savemgr.elf uploaded (already in autoload.txt). Restart your PS5 to apply.';
    } catch (e) { st.textContent = 'Error: ' + e.message; }
    btn.disabled = false;
  });

  const ssBtn = $('btn-s-savemgr-save');
  if (ssBtn) ssBtn.addEventListener('click', async () => {
    const port = parseInt($('s-savemgr-port').value) || 8082;
    await window.pork.setSettings({ savemgrPort: port });
    showToast('Save Manager port saved.', 'ok');
  });
})();

// ── Payload Manager Settings modal ────────────────────────────────────────────

$('btn-payload-settings').addEventListener('click', async () => {
  const s = await window.pork.getSettings();
  $('pm-local-path').value  = s.payloadLocalPath  || '';
  $('pm-remote-path').value = s.payloadRemotePath || '';
  $('payload-settings-overlay').hidden = false;
});

$('btn-pm-browse-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (folder) $('pm-local-path').value = folder;
});

$('btn-pm-settings-save').addEventListener('click', async () => {
  await window.pork.setSettings({
    payloadLocalPath:  $('pm-local-path').value.trim(),
    payloadRemotePath: $('pm-remote-path').value.trim(),
  });
  $('payload-settings-overlay').hidden = true;
});

['payload-settings-close', 'btn-pm-settings-cancel'].forEach(id =>
  $(id).addEventListener('click', () => { $('payload-settings-overlay').hidden = true; })
);

// ── Transfer Manager ──────────────────────────────────────────────────────────

function fmtSpeed(bps) {
  if (!bps || bps < 0) return '—';
  if (bps < 1024)        return `${Math.round(bps)} B/s`;
  if (bps < 1048576)     return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

let _transferState = { jobs: [], paused: false, maxConcurrent: 1, activeCount: 0, queuedCount: 0 };

function renderTransferPage(st) {
  _transferState = st;

  // Stats bar
  $('tstat-active').textContent    = st.activeCount;
  $('tstat-queued').textContent    = st.queuedCount;
  $('tstat-concurrent').textContent = st.maxConcurrent;

  const slider = $('transfer-concurrent-slider');
  if (slider && parseInt(slider.value) !== st.maxConcurrent) slider.value = st.maxConcurrent;

  // Total speed from all active jobs
  const totalSpeed = st.jobs
    .filter(j => j.status === 'active')
    .reduce((sum, j) => sum + (j.progress?.speedBps || 0), 0);
  $('tstat-speed').textContent = fmtSpeed(totalSpeed);

  // Pause/resume button
  const pauseBtn = $('btn-transfer-pause');
  if (pauseBtn) {
    pauseBtn.textContent = st.paused ? '▶ Resume All' : '⏸ Pause All';
  }

  // Job list
  const list = $('transfers-list');
  const empty = $('transfers-empty');
  const visibleJobs = st.jobs.filter(j => j.status !== 'cancelled');

  if (!visibleJobs.length) {
    list.innerHTML = '';
    empty.hidden   = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = visibleJobs.map(job => {
    const statusText = {
      queued:    'Queued',
      active:    'Transferring…',
      done:      'Done',
      error:     'Error',
      cancelled: 'Cancelled',
    }[job.status] || job.status;

    const typeLabel = { upload: 'UPLOAD', download: 'DOWNLOAD', pork: 'PORK' }[job.type] || job.type.toUpperCase();
    const typeClass = { upload: 'type-upload', download: 'type-download', pork: 'type-pork' }[job.type] || '';

    const pct  = job.progress?.percent || 0;
    const speed = job.status === 'active' ? fmtSpeed(job.progress?.speedBps) : '';
    const file  = job.progress?.file || '';
    const filesDone  = job.progress?.filesDone  || 0;
    const filesTotal = job.progress?.filesTotal || 0;
    const transferred = job.progress?.transferred || 0;
    const total       = job.progress?.total || 0;

    const showCancel  = job.status === 'queued' || job.status === 'active';
    const showBar     = job.status === 'active' || job.status === 'done';

    const currentBytes    = job.progress?.currentBytes    || 0;
    const currentFileSize = job.progress?.currentFileSize || 0;

    // File counter or single-file byte progress
    const sizeStr = filesTotal > 1
      ? `File ${filesDone}/${filesTotal}`
      : (total > 0 ? `${fmt(transferred)} / ${fmt(total)}` : '');

    // Current-file byte progress for directory uploads (shows activity on large files)
    const fileByteStr = (filesTotal > 1 && currentFileSize > 0 && job.status === 'active')
      ? `${fmt(currentBytes)} / ${fmt(currentFileSize)}`
      : '';

    const pctLabel = (showBar && job.status === 'active') ? `${pct}%` : (job.status === 'done' ? '100%' : '');

    return `
      <div class="transfer-item transfer-item-${job.status}">
        <div class="transfer-item-header">
          <span class="transfer-label" title="${escHtml(job.localPath || job.remotePath || '')}">${escHtml(job.label)}</span>
          <span class="transfer-type-badge ${typeClass}">${typeLabel}</span>
          <span class="transfer-status-text">${statusText}</span>
          ${showCancel ? `<button class="btn-cancel-transfer" data-job-id="${job.id}" title="Cancel">×</button>` : ''}
        </div>
        ${showBar ? `
        <div class="transfer-progress-wrap">
          <div class="transfer-progress-bar">
            <div class="transfer-progress-fill" style="width:${pct}%"></div>
          </div>
          ${pctLabel ? `<span class="transfer-pct-label">${pctLabel}</span>` : ''}
        </div>` : ''}
        <div class="transfer-meta">
          ${speed    ? `<span class="transfer-speed">${speed}</span>` : ''}
          ${file     ? `<span class="transfer-file">${escHtml(file)}</span>` : ''}
          ${fileByteStr ? `<span class="transfer-sizes">${fileByteStr}</span>` : sizeStr ? `<span class="transfer-sizes">${sizeStr}</span>` : ''}
          ${job.error ? `<span class="transfer-error">${escHtml(job.error)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function updateNavTransferBadge(st) {
  const badge = $('nav-transfer-badge');
  if (!badge) return;
  const n = (st.activeCount || 0) + (st.queuedCount || 0);
  badge.hidden      = n === 0;
  badge.textContent = n;
}

// ── PS Avatar ─────────────────────────────────────────────────────────────────

let _xavatarClient     = null;
let _xavatarLastResult = null;            // { buffer: ArrayBuffer, filename: string }
const _xavatarThumbCache = new Map();     // remotePath → blob URL

function loadXavatar() {
  // Refresh the library on every navigate; only initialise the converter once.
  loadXavatarLibrary();

  if (_xavatarClient) return;

  if (!window.XavatarClient) {
    $('xavatar-status').textContent = 'XavatarClient not available — ensure the module script loaded.';
    return;
  }

  // Build the API object — prefer the dedicated xavatarAPI bridge; fall back to
  // the pork bridge channel so conversion still works even if the separate
  // xavatarElectronModule preload failed to expose window.xavatarAPI.
  let _xavApi = window.xavatarAPI;
  if (!_xavApi) {
    console.warn('[Porkfolio] window.xavatarAPI not found — using pork fallback for conversion.');
    _xavApi = {
      async convertFromCanvas(canvas, opts = {}) {
        const ctx    = canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const rgba   = new Uint8Array(imgData.data.buffer);
        const res    = await window.pork.xavatarConvertCanvas(
          rgba, canvas.width, canvas.height, opts.filename || 'avatar'
        );
        if (!res || !res.ok) throw new Error((res && res.error) || 'Conversion failed');
        return { buffer: res.buffer && res.buffer.buffer ? res.buffer.buffer : res.buffer, filename: res.filename };
      }
    };
  }

  _xavatarClient = new window.XavatarClient({ api: _xavApi });

  const dropZone   = $('xavatar-drop-zone');
  const fileInput  = $('xavatar-file-input');
  const preview    = $('xavatar-preview');
  const status     = $('xavatar-status');
  const convertBtn = $('btn-xavatar-convert');
  const sendBtn    = $('btn-xavatar-send-ps5');

  const convProgress = $('xavatar-conv-progress');
  const convBar      = $('xavatar-conv-bar');

  function _xavatarSetProgress(pct, label) {
    if (!convProgress) return;
    convProgress.hidden = pct == null;
    if (pct != null) {
      convBar.style.width = `${pct}%`;
      convBar.textContent = label || '';
    }
  }

  _xavatarClient.on('image-ready', (canvas) => {
    const ctx = preview.getContext('2d');
    preview.width  = canvas.width;
    preview.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    preview.hidden = false;
    convertBtn.disabled = false;
    sendBtn.disabled = false;
    _xavatarLastResult = null;   // new image — invalidate previous conversion
    _xavatarSetProgress(null);
    status.textContent = 'Image loaded — convert & download, or send directly to PS5';
    dropZone.classList.add('xavatar-drop-zone--has-image');
  });

  _xavatarClient.on('load-error', (err) => {
    status.textContent = 'Failed to load image: ' + err.message;
  });

  _xavatarClient.on('convert-start', () => {
    convertBtn.disabled = true;
    convertBtn.textContent = 'Converting…';
    status.textContent = 'Converting…';
  });

  _xavatarClient.on('convert-error', (err) => {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert & Download';
    _xavatarSetProgress(null);
    status.textContent = 'Error: ' + err.message;
  });

  _xavatarClient.wireFileInput(fileInput);
  _xavatarClient.wireDropZone(dropZone);
  _xavatarClient.wirePaste(document);

  $('btn-xavatar-browse').addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', (e) => {
    if (e.target !== $('btn-xavatar-browse')) fileInput.click();
  });

  dropZone.addEventListener('dragover',  () => dropZone.classList.add('xavatar-drop-zone--over'));
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('xavatar-drop-zone--over'));
  dropZone.addEventListener('drop',      () => dropZone.classList.remove('xavatar-drop-zone--over'));

  convertBtn.addEventListener('click', async () => {
    status.textContent = '';
    _xavatarSetProgress(null);
    try {
      const result = await _xavatarClient.convert();
      _xavatarLastResult = result;
      convertBtn.disabled = false;
      convertBtn.textContent = 'Convert & Download';
      const saved = await window.pork.xavatarSaveFile(result.buffer, result.filename);
      status.textContent = saved?.saved ? `Saved: ${result.filename}` : 'Converted — not saved.';
    } catch (err) {
      convertBtn.disabled = false;
      convertBtn.textContent = 'Convert & Download';
      if (!$('xavatar-status').textContent) {
        status.textContent = 'Error: ' + err.message;
      }
    }
  });

  sendBtn.addEventListener('click', async () => {
    if (!_xavatarClient?._masterCanvas) return;
    convertBtn.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Working…';
    status.textContent = '';
    try {
      // ── Step 1: Convert ──────────────────────────────────────────────────
      _xavatarSetProgress(10, 'Converting…');
      status.textContent = 'Converting image to .xavatar…';
      const result = await _xavatarClient.convert();
      _xavatarLastResult = result;

      // ── Step 2: Random filename ──────────────────────────────────────────
      const pad    = n => String(n).padStart(5, '0');
      const rnd    = pad(Math.floor(Math.random() * 100000));
      const rndName = `porkfolio${rnd}.xavatar`;
      _xavatarSetProgress(55, 'Uploading…');
      status.textContent = `Queuing upload → /data/AVATARS/${rndName}…`;

      // ── Step 3: Upload ──────────────────────────────────────────────────
      await window.pork.xavatarUploadToPs5(result.buffer, rndName);
      _xavatarSetProgress(100, 'Queued ✓');
      status.textContent  = `Queued → /data/AVATARS/${rndName}`;
      sendBtn.textContent = '↗ Send to PS5';
      sendBtn.disabled    = false;
      convertBtn.disabled = false;
      convertBtn.textContent = 'Convert & Download';
      if ($('xavatar-notify-toggle')?.checked) {
        window.pork.psnotifySend('XAvatar Queued', rndName).catch(() => {});
      }
      setTimeout(() => _xavatarSetProgress(null), 3000);
    } catch (e) {
      _xavatarSetProgress(null);
      convertBtn.disabled = false;
      sendBtn.disabled = false;
      sendBtn.textContent = '↗ Send to PS5';
      convertBtn.textContent = 'Convert & Download';
      status.textContent = 'Error: ' + e.message;
    }
  });

  $('btn-xavatar-refresh-lib').addEventListener('click', loadXavatarLibrary);
}

function _xavatarFmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadXavatarLibrary() {
  const listEl  = $('xavatar-library-list');
  const emptyEl = $('xavatar-library-empty');
  if (!listEl) return;

  listEl.innerHTML = '<div class="jb-list-placeholder" style="padding:18px 14px">Loading…</div>';
  emptyEl.hidden = true;

  try {
    const files = await window.pork.ftpListDir('/data/AVATARS');
    const xavs  = files.filter(f => !f.isDir);

    if (!xavs.length) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }

    emptyEl.hidden = true;
    listEl.innerHTML = '<div class="xavatar-lib-grid">' +
      xavs.map(f => {
        const rpath = `/data/AVATARS/${escHtml(f.name)}`;
        return `<div class="xavatar-lib-card" data-xa-card-path="${rpath}" data-xa-card-name="${escHtml(f.name)}">
          <div class="xavatar-thumb-wrap">
            <img class="xavatar-thumb" data-xa-path="${rpath}" src="" alt="${escHtml(f.name)}">
            <div class="xavatar-thumb-placeholder">&#128100;</div>
          </div>
          <div class="xavatar-lib-card-info">
            <span class="xavatar-lib-card-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
            <span class="xavatar-lib-card-size">${_xavatarFmtSize(f.size)}</span>
          </div>
          <div class="xavatar-lib-card-actions">
            <button class="btn btn-xs" title="Download .xavatar" data-xa="download" data-xa-path="${rpath}" data-xa-name="${escHtml(f.name)}">&#8659;</button>
            <button class="btn btn-xs btn-danger" title="Delete from PS5" data-xa="delete" data-xa-path="${rpath}" data-xa-name="${escHtml(f.name)}">&#10005;</button>
          </div>
        </div>`;
      }).join('') + '</div>';

    _setupXavatarThumbObserver(listEl);
  } catch (err) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = 'Failed to load library: ' + err.message;
  }
}

/** Attach IntersectionObserver to lazily load thumbnails as cards scroll into view */
function _setupXavatarThumbObserver(container) {
  const imgs = container.querySelectorAll('img.xavatar-thumb');
  if (!imgs.length) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        observer.unobserve(img);
        _loadXavatarThumb(img, img.dataset.xaPath);
      }
    });
  }, { rootMargin: '120px', threshold: 0.01 });
  imgs.forEach(img => observer.observe(img));
}

/** Fetch + extract avatar.png from a .xavatar on FTP, cache as blob URL */
async function _getXavatarThumbUrl(rpath) {
  let url = _xavatarThumbCache.get(rpath);
  if (!url) {
    const xavBuf = await window.pork.ftpDownloadFile(rpath);
    const pngBuf = await window.pork.xavatarExtractPng(xavBuf);
    const blob   = new Blob([pngBuf], { type: 'image/png' });
    url = URL.createObjectURL(blob);
    _xavatarThumbCache.set(rpath, url);
  }
  return url;
}

/** Load one thumbnail into an img element */
async function _loadXavatarThumb(img, rpath) {
  const card = img.closest?.('.xavatar-lib-card');
  try {
    const url  = await _getXavatarThumbUrl(rpath);
    img.src    = url;
    img.onload  = () => card?.classList.add('xavatar-thumb-loaded');
    img.onerror = () => card?.classList.add('xavatar-thumb-error');
  } catch (_) {
    card?.classList.add('xavatar-thumb-error');
  }
}

// ── XAvatar full-size modal ───────────────────────────────────────────────────

let _xavatarModalPath = null;

function _xavatarOpenModal(rpath, name) {
  _xavatarModalPath = rpath;
  const modal = $('xavatar-thumb-modal');
  const img   = $('xavatar-modal-img');
  const namEl = $('xavatar-modal-name');
  img.src           = '';
  img.alt           = 'Loading…';
  namEl.textContent = name;
  modal.hidden      = false;
  // reset modal send button
  const sendBtn = $('btn-xavatar-modal-send');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '↗ Send to PS5'; }
  _getXavatarThumbUrl(rpath)
    .then(url => { if (_xavatarModalPath === rpath) { img.src = url; img.alt = name; } })
    .catch(() => { if (_xavatarModalPath === rpath) img.alt = 'Preview unavailable'; });
}

// Close modal on backdrop click or close button
document.addEventListener('click', e => {
  const modal = $('xavatar-thumb-modal');
  if (!modal || modal.hidden) return;
  if (e.target === modal || e.target.id === 'btn-xavatar-modal-close') {
    modal.hidden = true;
    _xavatarModalPath = null;
  }
});

// ── XAvatar: format picker dialog ──────────────────────────────────────────
function _xavatarPickFormat() {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.style.cssText = [
      'border:none',
      'border-radius:10px',
      'padding:22px 26px 18px',
      'background:var(--bg2,#1e1e2e)',
      'color:var(--fg,#cdd6f4)',
      'box-shadow:0 8px 32px rgba(0,0,0,.65)',
      'text-align:center',
      'min-width:260px',
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-50%)',
      'margin:0',
    ].join(';');
    dlg.innerHTML = [
      '<p style="margin:0 0 16px;font-size:14px;font-weight:600;">Choose download format</p>',
      '<div style="display:flex;gap:10px;justify-content:center;">',
      '  <button class="btn btn-teal" id="_xa-fmt-xav" style="min-width:96px;">.xavatar</button>',
      '  <button class="btn" id="_xa-fmt-png" style="min-width:96px;">.png</button>',
      '  <button class="btn" id="_xa-fmt-cancel" style="min-width:74px;opacity:.7;">Cancel</button>',
      '</div>',
    ].join('');
    document.body.appendChild(dlg);
    dlg.showModal();
    const done = (val) => { dlg.removeEventListener('close', onClose); dlg.close(); dlg.remove(); resolve(val); };
    const onClose = () => { dlg.remove(); resolve(null); };
    dlg.addEventListener('close', onClose);
    dlg.querySelector('#_xa-fmt-xav').addEventListener('click',    () => done('xavatar'));
    dlg.querySelector('#_xa-fmt-png').addEventListener('click',    () => done('png'));
    dlg.querySelector('#_xa-fmt-cancel').addEventListener('click', () => done(null));
  });
}

// Modal action buttons
document.addEventListener('DOMContentLoaded', () => {
  const modalDownload = $('btn-xavatar-modal-download');
  const modalToPng    = $('btn-xavatar-modal-topng');
  const modalSend     = $('btn-xavatar-modal-send');
  if (!modalDownload) return;

  modalDownload.addEventListener('click', async () => {
    if (!_xavatarModalPath) return;
    const fmt = await _xavatarPickFormat();
    if (!fmt) return;
    const name = $('xavatar-modal-name')?.textContent || 'avatar.xavatar';
    modalDownload.disabled = true;
    try {
      const buf = await window.pork.ftpDownloadFile(_xavatarModalPath);
      if (fmt === 'png') {
        const pngName = name.replace(/\.xavatar$/i, '') + '.png';
        const pngBuf  = await window.pork.xavatarExtractPng(buf);
        await window.pork.xavatarSaveFile(pngBuf, pngName);
      } else {
        await window.pork.xavatarSaveFile(buf, name);
      }
    } catch (err) { showToast('Download failed: ' + err.message, 'error'); }
    modalDownload.disabled = false;
  });

  modalToPng.addEventListener('click', async () => {
    if (!_xavatarModalPath) return;
    const name    = $('xavatar-modal-name')?.textContent || 'avatar';
    const pngName = name.replace(/\.xavatar$/i, '') + '.png';
    modalToPng.disabled = true;
    try {
      const xavBuf = await window.pork.ftpDownloadFile(_xavatarModalPath);
      const pngBuf = await window.pork.xavatarExtractPng(xavBuf);
      await window.pork.xavatarSaveFile(pngBuf, pngName);
    } catch (err) { showToast('PNG save failed: ' + err.message, 'error'); }
    modalToPng.disabled = false;
  });

  modalSend.addEventListener('click', async () => {
    if (!_xavatarModalPath) return;
    const name = $('xavatar-modal-name')?.textContent || 'avatar.xavatar';
    modalSend.disabled = true;
    modalSend.textContent = 'Sending…';
    try {
      const buf = await window.pork.ftpDownloadFile(_xavatarModalPath);
      await window.pork.xavatarUploadToPs5(buf, name);
      modalSend.textContent = '↗ Send to PS5';
      modalSend.disabled = false;
      showToast(`Queued: /data/AVATARS/${name}`, 'success');
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
      modalSend.textContent = '↗ Send to PS5';
      modalSend.disabled = false;
    }
  });
});

// ── XAvatar: card thumbnail click → open modal ────────────────────────────────
document.addEventListener('click', e => {
  const card = e.target.closest('.xavatar-lib-card');
  if (card && !e.target.closest('[data-xa]')) {
    _xavatarOpenModal(card.dataset.xaCardPath, card.dataset.xaCardName);
  }
});

// ── XAvatar: library card action buttons (↓ download / ✕ delete) ─────────────
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-xa]');
  if (!btn) return;
  const action = btn.dataset.xa;
  const rpath  = btn.dataset.xaPath;
  const name   = btn.dataset.xaName;
  btn.disabled = true;

  try {
    if (action === 'download') {
      const fmt = await _xavatarPickFormat();
      if (!fmt) { btn.disabled = false; return; }
      const buf = await window.pork.ftpDownloadFile(rpath);
      if (fmt === 'png') {
        const pngName = name.replace(/\.xavatar$/i, '') + '.png';
        const pngBuf  = await window.pork.xavatarExtractPng(buf);
        await window.pork.xavatarSaveFile(pngBuf, pngName);
      } else {
        await window.pork.xavatarSaveFile(buf, name);
      }

    } else if (action === 'delete') {
      if (!confirm(`Delete /data/AVATARS/${name} from your PS5?`)) { btn.disabled = false; return; }
      await window.pork.ftpDeleteFile(rpath);
      btn.closest('.xavatar-lib-card')?.remove();
      _xavatarThumbCache.delete(rpath);
      const grid = $('xavatar-library-list')?.querySelector('.xavatar-lib-grid');
      if (grid && !grid.children.length) $('xavatar-library-empty').hidden = false;
    }
  } catch (err) {
    showToast('XAvatar: ' + err.message, 'error');
  }
  btn.disabled = false;
});

// ── System View ───────────────────────────────────────────────────────────────

async function loadSystemView() {
  $('sv-status-codec').textContent = svDetectCodec().label;
  await enumerateSvDevices();
  let autoLoad = false;
  // Restore all persisted system-view settings
  try {
    const s = await window.pork.getSettings();
    if (s.svResolution) $('sv-resolution').value = s.svResolution;
    if (s.svGifFps)     $('sv-gif-fps').value     = s.svGifFps;
    if (s.svVidQuality) $('sv-vid-quality').value  = s.svVidQuality;
    if (s.svHotkeys)    _svHotkeys = { ..._svHotkeys, ...s.svHotkeys };
    autoLoad = !!s.svAutoLoad;
    $('sv-auto-load').checked = autoLoad;
    // Restore saved device selections only if nothing is currently selected
    const videoSel = $('sv-video-device');
    const audioSel = $('sv-audio-device');
    if (!videoSel.value && s.svVideoDevice &&
        [...videoSel.options].some(o => o.value === s.svVideoDevice)) {
      videoSel.value = s.svVideoDevice;
    }
    if (!audioSel.value && s.svAudioDevice &&
        [...audioSel.options].some(o => o.value === s.svAudioDevice)) {
      audioSel.value = s.svAudioDevice;
    }
  } catch (_) {}
  // Re-attach existing stream if still active (user navigated away and back)
  if (_svStream && !_svStream.active) _svStream = null;
  if (_svStream) {
    // Re-attach video-only (AudioContext keeps running independently)
    $('sv-video').srcObject = new MediaStream(_svStream.getVideoTracks());
    $('sv-video').muted = true;
    $('sv-no-signal').classList.add('hidden');
    $('btn-sv-mute').disabled    = false;
    $('btn-sv-popout').disabled  = false;
    $('btn-sv-record').disabled  = false;
    $('btn-sv-vid-rec').disabled = false;
    $('sv-ctx-popout').disabled  = false;
    updateSvMuteBtn();
    svSetLive($('sv-video-device').selectedOptions[0]?.text || '');
  } else if ($('sv-video-device').value) {
    // Auto-start stream if a device is already selected
    await startSvStream();
  }
}

async function enumerateSvDevices() {
  let devices;
  try {
    // A brief getUserMedia call is needed to unlock device labels in some browsers
    if (!_svStream) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach(t => t.stop());
      } catch (_) {}
    }
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    console.error('enumerateDevices failed:', e);
    return;
  }

  const prevVideo = $('sv-video-device').value;
  const prevAudio = $('sv-audio-device').value;

  // Video
  const videoSel = $('sv-video-device');
  while (videoSel.options.length > 1) videoSel.remove(1);
  devices.filter(d => d.kind === 'videoinput').forEach(d => {
    videoSel.add(new Option(d.label || `Camera ${d.deviceId.slice(0,8)}`, d.deviceId));
  });

  // Audio
  const audioSel = $('sv-audio-device');
  while (audioSel.options.length > 1) audioSel.remove(1);
  devices.filter(d => d.kind === 'audioinput').forEach(d => {
    audioSel.add(new Option(d.label || `Mic ${d.deviceId.slice(0,8)}`, d.deviceId));
  });

  // Restore previous selection if device still present
  if (prevVideo && [...videoSel.options].some(o => o.value === prevVideo)) videoSel.value = prevVideo;
  if (prevAudio && [...audioSel.options].some(o => o.value === prevAudio)) audioSel.value = prevAudio;
}

function _svAudioStop() {
  if (_svAudioCtx) { _svAudioCtx.close().catch(() => {}); _svAudioCtx = null; }
  _svAudioGain = null;
}

async function startSvStream() {
  if (_svRecording) stopSvRecording();
  if (_svStream) { _svStream.getTracks().forEach(t => t.stop()); _svStream = null; }
  _svAudioStop();
  $('sv-video').srcObject = null;

  const videoId = $('sv-video-device').value;
  if (!videoId) {
    $('sv-no-signal-msg').textContent = 'Select a video source above to begin';
    $('sv-no-signal').classList.remove('hidden');
    $('btn-sv-mute').disabled    = true;
    $('btn-sv-popout').disabled  = true;
    $('btn-sv-record').disabled  = true;
    $('btn-sv-vid-rec').disabled = true;
    $('sv-ctx-popout').disabled  = true;
    svSetIdle('No device selected');
    return;
  }

  $('sv-no-signal-msg').textContent = 'Starting stream…';

  const audioId = $('sv-audio-device').value;
  const res = $('sv-resolution').value; // "1920x1080" or ""
  const [rW, rH] = res ? res.split('x').map(Number) : [];
  const videoConstraint = { deviceId: { exact: videoId } };
  if (rW) { videoConstraint.width = { ideal: rW }; videoConstraint.height = { ideal: rH }; }
  const constraints = {
    video: videoConstraint,
    // Disable all browser audio processing — essential for capture cards.
    // These defaults add latency and mangle game/console audio.
    audio: audioId ? {
      deviceId:         { exact: audioId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
      channelCount:     2,
    } : false,
  };

  try {
    _svStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Feed only video tracks to the video element.  Chromium syncs audio
    // to the video element's clock, which introduces ~150-300 ms of buffering.
    // Routing audio separately via AudioContext (latencyHint:'interactive')
    // drops that to ~20-40 ms and eliminates the choppiness.
    $('sv-video').srcObject = new MediaStream(_svStream.getVideoTracks());
    $('sv-video').muted = true; // always; audio is handled by AudioContext below

    const audioTracks = _svStream.getAudioTracks();
    if (audioId && audioTracks.length) {
      _svAudioCtx  = new AudioContext({ latencyHint: 'interactive' });
      _svAudioGain = _svAudioCtx.createGain();
      _svAudioGain.gain.value = _svMuted ? 0 : 1;
      _svAudioCtx.createMediaStreamSource(new MediaStream(audioTracks))
        .connect(_svAudioGain)
        .connect(_svAudioCtx.destination);
    }

    $('sv-no-signal').classList.add('hidden');
    $('btn-sv-mute').disabled    = false;
    $('btn-sv-popout').disabled  = false;
    $('btn-sv-record').disabled  = false;
    $('btn-sv-vid-rec').disabled = false;
    $('sv-ctx-popout').disabled  = false;
    updateSvMuteBtn();
    svSetLive($('sv-video-device').selectedOptions[0]?.text || videoId);
  } catch (e) {
    $('sv-no-signal-msg').textContent = `Error: ${e.message}`;
    $('sv-no-signal').classList.remove('hidden');
    $('btn-sv-mute').disabled    = true;
    $('btn-sv-popout').disabled  = true;
    $('btn-sv-record').disabled  = true;
    $('btn-sv-vid-rec').disabled = true;
    $('sv-ctx-popout').disabled  = true;
    svSetIdle(`Error: ${e.message}`);
  }
}

function updateSvMuteBtn() {
  $('btn-sv-mute').textContent = _svMuted ? '🔇 Unmute' : '🔊 Mute';
}

// ── System View — status bar ───────────────────────────────────────────────────
function svSetLive(label) {
  $('sv-status-dot').className   = 'sv-status-dot live';
  $('sv-status-text').textContent = `Live — ${label}`;
}
function svSetIdle(msg = 'No device selected') {
  $('sv-status-dot').className    = 'sv-status-dot';
  $('sv-status-text').textContent  = msg;
  $('sv-status-res').textContent   = '';
}
function svSetSaving() {
  $('sv-status-dot').className    = 'sv-status-dot saving';
  $('sv-status-text').textContent  = 'Saving video…';
}

$('sv-video').addEventListener('loadedmetadata', () => {
  const { videoWidth: w, videoHeight: h } = $('sv-video');
  if (w && h) $('sv-status-res').textContent = `${w}×${h}`;
});

// ── System View — codec detection ─────────────────────────────────────────────
function svDetectCodec() {
  const candidates = [
    { mime: 'video/mp4;codecs="avc1.640032,mp4a.40.2"', ext: 'mp4', label: 'H264/AAC · MP4' },
    { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4', label: 'H264/AAC · MP4' },
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2',          ext: 'mp4', label: 'H264/AAC · MP4' },
    { mime: 'video/mp4',                                 ext: 'mp4', label: 'MP4' },
    { mime: 'video/webm;codecs="vp9,opus"',              ext: 'webm', label: 'VP9/Opus · WebM' },
    { mime: 'video/webm;codecs="vp8,opus"',              ext: 'webm', label: 'VP8/Opus · WebM' },
    { mime: 'video/webm',                                ext: 'webm', label: 'WebM' },
  ];
  return candidates.find(c => MediaRecorder.isTypeSupported(c.mime))
      || { mime: '', ext: 'webm', label: 'WebM (default)' };
}

// ── System View — video recording ─────────────────────────────────────────────
function svFmtBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function svFmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function svUpdateVidStatus() {
  const elapsed = _svVidPaused
    ? _svVidStart
    : Date.now() - _svVidStart;
  $('sv-vid-rec-time').textContent = svFmtTime(elapsed);
  $('sv-vid-rec-size').textContent = _svVidBytes > 0 ? ` · ${svFmtBytes(_svVidBytes)}` : '';
}

async function startSvVidRecording() {
  if (!_svStream) return;

  const codec = svDetectCodec();
  _svVidMimeType = codec.mime;
  _svVidExt      = codec.ext;
  $('sv-status-codec').textContent = codec.label;

  const bitrate = parseInt($('sv-vid-quality').value) || 50_000_000;
  const name    = `porkfolio-${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.${_svVidExt}`;

  _svVidWritable = null;
  _svVidChunks   = null;
  try {
    const accept = _svVidExt === 'mp4' ? { 'video/mp4': ['.mp4'] } : { 'video/webm': ['.webm'] };
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: `${_svVidExt.toUpperCase()} Video`, accept }],
    });
    _svVidWritable = await handle.createWritable();
  } catch (e) {
    if (e.name === 'AbortError') return;
    _svVidChunks = [];
  }

  _svVidBytes = 0; _svVidPaused = false; _svVidStart = Date.now();

  const recOpts = { videoBitsPerSecond: bitrate, audioBitsPerSecond: 256_000 };
  if (_svVidMimeType) recOpts.mimeType = _svVidMimeType;
  _svVidRecorder = new MediaRecorder(_svStream, recOpts);

  _svVidRecorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return;
    _svVidBytes += e.data.size;
    if (_svVidWritable) { try { await _svVidWritable.write(e.data); } catch (_) {} }
    else if (_svVidChunks) _svVidChunks.push(e.data);
  };

  _svVidRecorder.onstop = async () => {
    clearInterval(_svVidTimer);
    svSetSaving();
    if (_svVidWritable) {
      try { await _svVidWritable.close(); } catch (_) {}
      _svVidWritable = null;
    } else if (_svVidChunks?.length) {
      const blob = new Blob(_svVidChunks, { type: _svVidMimeType || 'video/webm' });
      const url  = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
      _svVidChunks = null;
    }
    _svVidRecorder = null;
    svSetVidIdle();
    if (_svStream) svSetLive($('sv-video-device').selectedOptions[0]?.text || '');
  };

  _svVidRecorder.start(500);

  $('btn-sv-vid-rec').hidden   = true;
  $('btn-sv-vid-pause').hidden = false;
  $('btn-sv-vid-stop').hidden  = false;
  $('sv-vid-rec-status').hidden = false;
  $('sv-vid-rec-label').textContent = 'REC';
  $('sv-vid-rec-status').className  = 'sv-vid-rec-status';
  $('btn-sv-record').disabled = true;  // no GIF while video recording

  _svVidTimer = setInterval(svUpdateVidStatus, 500);
}

function pauseSvVidRecording() {
  if (!_svVidRecorder) return;
  if (_svVidPaused) {
    _svVidRecorder.resume();
    _svVidStart   = Date.now() - _svVidStart;
    _svVidPaused  = false;
    $('btn-sv-vid-pause').textContent      = '⏸ Pause';
    $('sv-vid-rec-label').textContent       = 'REC';
    $('sv-vid-rec-status').className        = 'sv-vid-rec-status';
  } else {
    _svVidRecorder.pause();
    _svVidStart  = Date.now() - _svVidStart;
    _svVidPaused = true;
    $('btn-sv-vid-pause').textContent      = '▶ Resume';
    $('sv-vid-rec-label').textContent       = 'PAUSED';
    $('sv-vid-rec-status').className        = 'sv-vid-rec-status paused';
  }
}

function stopSvVidRecording() {
  if (!_svVidRecorder) return;
  if (_svVidPaused) { _svVidRecorder.resume(); _svVidPaused = false; }
  _svVidRecorder.stop();
}

function svSetVidIdle() {
  $('btn-sv-vid-rec').hidden    = false;
  $('btn-sv-vid-pause').hidden  = true;
  $('btn-sv-vid-stop').hidden   = true;
  $('sv-vid-rec-status').hidden = true;
  $('btn-sv-vid-pause').textContent = '⏸ Pause';
  $('sv-vid-rec-label').textContent  = 'REC';
  $('sv-vid-rec-status').className   = 'sv-vid-rec-status';
  $('btn-sv-record').disabled = !_svStream;
  _svVidPaused = false;
}

// ── System View — recording helpers ───────────────────────────────────────────

function getSvRecCtx() {
  if (!_svRecCanvas) {
    _svRecCanvas = document.createElement('canvas');
    _svRecCanvas.width = GIF_W; _svRecCanvas.height = GIF_H;
    _svRecCtx = _svRecCanvas.getContext('2d');
  }
  return _svRecCtx;
}

function startSvRecording() {
  if (_svRecording || !_svStream) return;
  const fps       = parseInt($('sv-gif-fps').value) || 10;
  _svRecording = true; _svRecFrames = []; _svRecStart = Date.now();
  $('btn-sv-record').textContent = '⏹ Stop & Save';
  $('sv-rec-status').hidden = false;
  const ctx = getSvRecCtx();
  const vid = $('sv-video');
  _svRecInterval = setInterval(() => {
    ctx.drawImage(vid, 0, 0, GIF_W, GIF_H);
    _svRecFrames.push(new Uint8ClampedArray(ctx.getImageData(0, 0, GIF_W, GIF_H).data.buffer));
  }, Math.round(1000 / fps));
  _svRecTimer = setInterval(() => {
    const s = Math.floor((Date.now() - _svRecStart) / 1000);
    $('sv-rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function stopSvRecording() {
  if (!_svRecording) return;
  clearInterval(_svRecInterval); clearInterval(_svRecTimer);
  _svRecording = false;
  $('btn-sv-record').textContent = '⏺ Record GIF';
  $('sv-rec-status').hidden = true;
  $('sv-rec-time').textContent = '0:00';
  if (!_svRecFrames.length) return;
  const fps   = parseInt($('sv-gif-fps').value) || 10;
  const enc   = new GifEncoder(GIF_W, GIF_H, { fps });
  for (const f of _svRecFrames) enc.addFrame(f);
  _svRecFrames = [];
  const bytes = enc.encode();
  const url   = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
  const a     = Object.assign(document.createElement('a'), {
    href: url, download: `porkfolio-${Date.now()}.gif`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// System View — event handlers (attached once at startup)
$('sv-video-device').addEventListener('change', () => {
  window.pork.setSettings({ svVideoDevice: $('sv-video-device').value });
  startSvStream();
});
$('sv-audio-device').addEventListener('change', () => {
  window.pork.setSettings({ svAudioDevice: $('sv-audio-device').value });
  startSvStream();
});
$('btn-sv-refresh-devices').addEventListener('click', enumerateSvDevices);

$('sv-resolution').addEventListener('change', () => {
  window.pork.setSettings({ svResolution: $('sv-resolution').value });
  if ($('sv-video-device').value) startSvStream();
});
$('sv-gif-fps').addEventListener('change', () =>
  window.pork.setSettings({ svGifFps: $('sv-gif-fps').value }));
$('sv-vid-quality').addEventListener('change', () =>
  window.pork.setSettings({ svVidQuality: $('sv-vid-quality').value }));

$('sv-auto-load').addEventListener('change', () => {
  window.pork.setSettings({ svAutoLoad: $('sv-auto-load').checked });
});

$('btn-sv-mute').addEventListener('click', () => {
  _svMuted = !_svMuted;
  if (_svAudioGain) _svAudioGain.gain.value = _svMuted ? 0 : 1;
  updateSvMuteBtn();
});

// In-app fullscreen: CSS-based fixed overlay — requestFullscreen() is
// unreliable in Electron's frameless window and silently fails.
function svToggleFullscreen() {
  const wrap = $('sv-viewer-wrap');
  const entering = !wrap.classList.contains('sv-viewer-wrap--fullscreen');
  wrap.classList.toggle('sv-viewer-wrap--fullscreen', entering);
  $('btn-sv-fullscreen').title = entering ? 'Exit Fullscreen (Esc)' : 'Fullscreen (or double-click)';
  $('btn-sv-fullscreen').innerHTML = entering ? '&#x2715;' : '&#x26F6;';
}

$('btn-sv-fullscreen').addEventListener('click', svToggleFullscreen);

$('sv-viewer-wrap').addEventListener('dblclick', svToggleFullscreen);

$('btn-sv-record').addEventListener('click', () => {
  _svRecording ? stopSvRecording() : startSvRecording();
});

$('btn-sv-vid-rec').addEventListener('click',   startSvVidRecording);
$('btn-sv-vid-pause').addEventListener('click', pauseSvVidRecording);
$('btn-sv-vid-stop').addEventListener('click',  stopSvVidRecording);

// Right-click context menu on video area
const _svCtxMenu = $('sv-ctx-menu');
$('sv-viewer-wrap').addEventListener('contextmenu', e => {
  e.preventDefault();
  const x = Math.min(e.clientX, window.innerWidth  - 164);
  const y = Math.min(e.clientY, window.innerHeight -  80);
  _svCtxMenu.style.left = `${x}px`;
  _svCtxMenu.style.top  = `${y}px`;
  _svCtxMenu.hidden = false;
});
document.addEventListener('click', () => { _svCtxMenu.hidden = true; });
$('sv-ctx-fs').addEventListener('click', svToggleFullscreen);
$('sv-ctx-popout').addEventListener('click', () => $('btn-sv-popout').click());

navigator.mediaDevices.addEventListener('devicechange', () => enumerateSvDevices().catch(() => {}));

$('btn-sv-popout').addEventListener('click', async () => {
  const videoId = $('sv-video-device').value;
  const audioId = $('sv-audio-device').value;
  const resolution = $('sv-resolution').value;
  if (_svRecording) stopSvRecording();
  // Stop the main stream — the pop-out will start its own
  if (_svStream) { _svStream.getTracks().forEach(t => t.stop()); _svStream = null; }
  _svAudioStop();
  $('sv-video').srcObject = null;
  $('sv-no-signal').classList.remove('hidden');
  $('sv-no-signal-msg').textContent = 'Stream moved to pop-out window';
  $('btn-sv-mute').disabled = true;
  $('btn-sv-popout').disabled = true;
  $('btn-sv-record').disabled = true;
  await window.pork.openSystemViewPopout(videoId, audioId, resolution);
});

// When pop-out closes, auto-restart stream in main window if device still selected
window.pork.on('system-view:popout-closed', () => {
  if ($('page-system-view')?.classList.contains('active') && $('sv-video-device').value) {
    startSvStream();
  }
});

// ── System View mini-cards (Transfers / Jailbreak) ────────────────────────────

function svMiniGetStatus() {
  const sel = $('sv-video-device');
  const opt = sel?.selectedOptions?.[0];
  return (opt && opt.value) ? `Capture device: ${opt.text}` : 'No capture device selected.';
}

['transfers', 'jailbreak'].forEach(pageId => {
  $(`sv-mini-${pageId}-hdr`).addEventListener('click', () => {
    const card = $(`sv-mini-${pageId}`);
    card.classList.toggle('open');
    if (card.classList.contains('open')) {
      $(`sv-mini-${pageId}-status`).textContent = svMiniGetStatus();
    }
  });

  $(`btn-sv-mini-${pageId}-nav`).addEventListener('click', () => navigate('system-view'));

  $(`btn-sv-mini-${pageId}-popout`).addEventListener('click', async () => {
    const videoId    = $('sv-video-device').value;
    const audioId    = $('sv-audio-device').value;
    const resolution = $('sv-resolution').value;
    try {
      await window.pork.openSystemViewPopout(videoId, audioId, resolution);
    } catch (e) {
      setStatus(e.message, 'error');
    }
  });
});

async function loadTransfers() {
  try {
    const st = await window.pork.transferState();
    renderTransferPage(st);
    updateNavTransferBadge(st);
  } catch (_) {}
}

// Global transfer:update listener (always active, not page-specific)
window.pork.on('transfer:update', st => {
  renderTransferPage(st);
  updateNavTransferBadge(st);
});

document.querySelectorAll('.nav-link').forEach(a =>
  a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.page); })
);

// ── Connection state ──────────────────────────────────────────────────────────
function setConnected(on) {
  state.connected = on;
  const dot   = $('conn-dot');
  const label = $('conn-label');
  const badge = $('dash-conn-badge');
  const sbConn = $('sb-conn');

  dot.className   = `dot ${on ? 'green' : 'red'}`;
  label.textContent = on ? 'Connected' : 'Disconnected';
  badge.textContent = on ? 'Online' : 'Offline';
  badge.className   = `badge ${on ? 'badge-green' : 'badge-red'}`;
  sbConn.textContent = on ? '🟢 Connected' : '⚫ Disconnected';

  $('btn-connect').disabled    = on;
  $('btn-disconnect').disabled = !on;
  $('btn-scan').disabled       = !on;

  // Re-evaluate PS5 action buttons — only enabled when connected AND a location is stored
  const deleteBtn  = $('btn-manage-delete-ps5');
  const backupBtn  = $('btn-manage-backup-ps5');
  if (deleteBtn) deleteBtn.disabled = !on || !state.currentGame?.ftp_path;
  if (backupBtn) backupBtn.disabled = !on || !state.currentGame?.ftp_path;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const stats = await window.pork.getStats();
    $('s-total').textContent    = stats.totalGames;
    $('s-installed').textContent = stats.installed;
    $('s-backedup').textContent  = stats.backedUp;
    $('s-backups').textContent   = stats.totalBackups;
  } catch (_) {}
  renderPinnedTiles();
}

async function renderPinnedTiles() {
  const grid  = $('dash-pinned-grid');
  const empty = $('dash-pinned-empty');
  if (!grid) return;
  try {
    const s      = await window.pork.getSettings();
    const pinned = new Set(s.pinnedCards || []);
    const cards  = PINNABLE_CARDS.filter(c => pinned.has(c.id));

    grid.innerHTML = '';
    if (!cards.length) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      for (const c of cards) {
        const tile = document.createElement('div');
        tile.className = 'dash-pinned-tile';
        tile.dataset.navPage = c.page;
        tile.innerHTML = `
          <div class="dash-pinned-tile-title">${escHtml(c.label)}</div>
          <div class="dash-pinned-tile-page">${escHtml(_PIN_PAGE_LABELS[c.page] || c.page)}</div>
          <div class="dash-pinned-tile-hint">${escHtml(c.hint)}</div>
          <button class="btn btn-sm dash-pinned-tile-open">Open &rarr;</button>`;
        grid.appendChild(tile);
      }
    }

    // Sync all pin button visual states across the whole page
    document.querySelectorAll('.btn-pin').forEach(btn => {
      btn.classList.toggle('pinned', pinned.has(btn.dataset.pinId));
    });
  } catch (_) {}
}

// ── FTP Connect ───────────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', async () => {
  const host  = $('d-host').value.trim();
  const ports = $('d-ports').value.split(',').map(p => p.trim()).filter(Boolean);
  if (!ports.length) ports.push('21');
  if (!host) { setStatus('Enter a host address', 'error'); return; }

  // Credential fields start blank. Fall back to stored settings when blank
  // so the user can click Connect without re-typing every session.
  const saved    = await window.pork.getSettings();
  const user     = $('d-user').value.trim() || saved.ftpUser || '';
  const password = $('d-pass').value        || saved.ftpPass || '';

  $('btn-connect').disabled = true;
  setStatus('Connecting…');
  try {
    const result = await window.pork.ftpConnect({ host, ports, user, password });
    setConnected(true);
    setStatus('Connected', 'ok');
    $('sb-sync').textContent = `Connected on :${result?.port || ports[0]} at ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    setConnected(false);
    setStatus(`Connection failed: ${e.message}`, 'error');
    $('btn-connect').disabled = false;
  }
});

$('btn-disconnect').addEventListener('click', async () => {
  await window.pork.ftpDisconnect();
  setConnected(false);
  setStatus('Disconnected');
});

// ── FTP Scan ──────────────────────────────────────────────────────────────────
$('btn-scan').addEventListener('click', async () => {
  const prog = $('scan-progress');
  prog.hidden = false;
  prog.textContent = 'Scanning PS5 game folders…';
  $('btn-scan').disabled = true;

  window.pork.on('ftp:progress', ({ current, game }) => {
    prog.textContent = `[${current}] Found: ${game.title || game.game_id}`;
  });

  try {
    const { count } = await window.pork.ftpScan();
    prog.textContent = `Scan complete — ${count} game(s) found.`;
    $('sb-sync').textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
    setStatus(`Scanned ${count} games`, 'ok');
    await loadDashboard();
  } catch (e) {
    prog.textContent = `Error: ${e.message}`;
    setStatus(e.message, 'error');
  } finally {
    window.pork.off('ftp:progress');
    $('btn-scan').disabled = false;
  }
});

// ── Games page ────────────────────────────────────────────────────────────────
async function loadGames() {
  try {
    state.games = await window.pork.listGames({});
    // Refresh hash summaries (fire-and-forget so badges update when ready)
    window.pork.hashGameSummary().then(summaries => {
      _populateHashMaps(summaries);
      renderGames();
    }).catch(() => {});
    renderGames();
    await refreshFirmwareFilters();
    await refreshConvQueuePanel();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function getFilteredGames() {
  return state.games.filter(g => {
    const q = state.search.toLowerCase();
    if (q && !g.title.toLowerCase().includes(q) && !g.game_id.toLowerCase().includes(q) &&
        !(g.prospero_name || '').toLowerCase().includes(q)) return false;
    if (state.filter === 'installed')   return g.installed;
    if (state.filter === 'backed_up')   return g.backed_up;
    if (state.filter === 'not_backed')  return g.installed && !g.backed_up;
    if (state.firmwareFilter !== 'all') {
      const labels = (g.firmware_labels || '').split(',').filter(Boolean);
      if (!labels.includes(state.firmwareFilter)) return false;
    }
    return true;
  }).sort((a, b) => {
    let av = a[state.sortCol] ?? '', bv = b[state.sortCol] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return state.sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });
}

function renderGames() {
  const list  = getFilteredGames();
  const tbody = $('games-tbody');
  const empty = $('games-empty');

  tbody.innerHTML = '';
  empty.style.display = list.length ? 'none' : 'block';

  for (const g of list) {
    const tr = document.createElement('tr');
    tr.className = 'game-row';
    tr.dataset.id = g.game_id;
    // Compact status cell: readable tags instead of cryptic symbols
    const patchesOnly = g.backup_count === 0 && g.backpork_count > 0;
    const _hs = _gameHashSummary.get(g.game_id);
    const hashTag = _hs
      ? _hs.community_mismatch
        ? `<span class="s-tag s-hash-fail" title="⚠ Community hash check FAILED — files may be modified or contain brick code">⚠ Hash Fail</span>`
        : _hs.community_matches > 0
          ? `<span class="s-tag s-hash-ok" title="Community verified: ${_hs.community_matches}/${_hs.hash_count} files match known-good hashes">✓ Verified</span>`
          : `<span class="s-tag s-hash-local" title="${_hs.hash_count} file(s) hashed — not yet in community list">⧭ Hashed</span>`
      : '';
    const statusHtml = `<div class="game-status-col">
      ${g.installed ? `<span class="s-tag s-ps5" title="Currently installed on PS5">PS5</span>` : ''}
      ${g.backup_count > 0 ? `<span class="s-tag s-num" title="${g.backup_count} local backup(s)">${g.backup_count} bkp</span>` : ''}
      ${g.backed_up ? `<span class="s-tag s-backed" title="Marked as backed up">&#10003;</span>` : ''}
      ${patchesOnly ? `<span class="s-tag s-warn" title="Only backpork patches found &mdash; no local game backup exists">Patches only</span>` : ''}
      ${hashTag}
    </div>`;
    if (patchesOnly) tr.classList.add('game-row-patches-only');
    tr.innerHTML = `
      <td>
        <div class="game-title-cell">
          ${g.prospero_icon_url
            ? `<img src="${escHtml(g.prospero_icon_url)}" class="game-row-icon" alt="" onerror="this.style.display='none'">`
            : '<div class="game-row-icon game-row-icon-empty"></div>'}
          <span>${escHtml(g.prospero_name || g.title || g.game_id)}</span>
        </div>
      </td>
      <td><code>${escHtml(g.game_id)}</code></td>
      <td>${escHtml(g.version || g.prospero_version || '—')}</td>
      <td>${g.backup_size ? fmt(g.backup_size) : (g.size ? fmt(g.size) : (g.prospero_size || '—'))}</td>
      <td>${renderFwPills(g.firmware_labels)}</td>
      <td>${statusHtml}</td>
      <td class="game-actions-cell">
        ${patchesOnly
          ? `<span class="patches-only-hint" title="No game backup found &mdash; only patch folders exist for this title. Back up or download the base game first.">&#9888; No game backup</span>`
          : `<button class="btn btn-sm btn-teal" data-action="install" data-id="${escHtml(g.game_id)}" title="Add to PS5 install queue (Raw Dumps direct upload)">
          &#11014; Add to Install Queue
        </button>
        <button class="btn btn-sm" data-action="convert" data-id="${escHtml(g.game_id)}" title="Convert game (FFPKG / ExFAT) and optionally upload to PS5">
          &#9881; Convert
        </button>`
        }
      </td>`;
    tbody.appendChild(tr);
  }

  // Click delegation: action buttons take priority; otherwise whole row opens detail
  tbody.onclick = async e => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      if (btn.dataset.action === 'install') {
        await openInstallModal(btn.dataset.id, 'pfs');
      } else if (btn.dataset.action === 'convert') {
        const s = await window.pork.getSettings();
        const mode = (s.gameConversionMode === 'pfs' || !s.gameConversionMode) ? 'ffpkg' : s.gameConversionMode;
        await openInstallModal(btn.dataset.id, mode);
      }
      return;
    }
    const row = e.target.closest('tr.game-row[data-id]');
    if (row) openModal(row.dataset.id);
  };
}

// Sorting
document.querySelectorAll('#games-table th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    if (state.sortCol === th.dataset.col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortCol = th.dataset.col; state.sortDir = 'asc'; }
    renderGames();
  });
});

// Filter buttons
document.querySelectorAll('.fbtn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderGames();
  })
);

// Search
$('games-search').addEventListener('input', e => {
  state.search = e.target.value;
  renderGames();
});

// ── Backups page ──────────────────────────────────────────────────────────────
async function loadBackups() {
  try {
    // Use listGames so we get one entry per game with prospero metadata + backup_size
    const all = await window.pork.listGames({});
    // Keep games that have a local backup OR at least one backpork entry
    state.backups = all.filter(g => g.backup_count > 0 || g.firmware_labels);
    populateBackupsRegionFilter();
    renderBackups();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function populateBackupsRegionFilter() {
  const sel   = $('backups-region-filter');
  const cur   = sel.value;
  const regions = [...new Set(
    state.backups.map(g => g.prospero_region || '').filter(Boolean).sort()
  )];
  sel.innerHTML = '<option value="">All Regions</option>'
    + regions.map(r => `<option value="${escHtml(r)}"${r === cur ? ' selected' : ''}>${escHtml(r)}</option>`).join('');
}

function renderBackups() {
  const search  = ($('backups-search')?.value || '').toLowerCase();
  const region  = $('backups-region-filter')?.value || '';
  const list    = $('backups-list');
  const empty   = $('backups-empty');

  const filtered = state.backups.filter(g => {
    if (region && (g.prospero_region || '') !== region) return false;
    if (search) {
      const name = (g.prospero_name || g.title || g.game_id).toLowerCase();
      if (!name.includes(search) && !g.game_id.toLowerCase().includes(search)) return false;
    }
    return true;
  });

  empty.hidden = filtered.length > 0;
  list.innerHTML = filtered.map(g => {
    const name        = escHtml(g.prospero_name || g.title || g.game_id);
    const region      = g.prospero_region ? `<span class="pill pill-region">${escHtml(g.prospero_region)}</span>` : '';
    const iconHtml    = g.prospero_icon_url
      ? `<img class="backup-card-icon" src="${escHtml(g.prospero_icon_url)}" alt="" onerror="this.style.display='none'">`
      : `<div class="backup-card-icon backup-card-icon-empty"></div>`;

    const backporks   = g.firmware_labels ? g.firmware_labels.split(',').filter(Boolean) : [];
    const patchCount  = g.prospero_patch_count || 0;
    const dlcCount    = tryParseJson(g.prospero_dlc, []).length;
    const localSize   = g.backup_size ? fmt(g.backup_size) : null;

    const badges = [
      localSize                    ? `<span class="bk-badge bk-badge-local">&#128190; ${escHtml(localSize)}</span>` : '',
      backporks.length             ? `<span class="bk-badge bk-badge-backpork">&#128279; ${backporks.length} Backpork${backporks.length !== 1 ? 's' : ''}</span>` : '',
      patchCount                   ? `<span class="bk-badge bk-badge-patch">&#8593; ${patchCount} Update${patchCount !== 1 ? 's' : ''}</span>` : '',
      dlcCount                     ? `<span class="bk-badge bk-badge-dlc">&#43; ${dlcCount} DLC</span>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="backup-card" data-view-game="${escHtml(g.game_id)}">
        ${iconHtml}
        <div class="backup-card-body">
          <div class="backup-card-title">${name} ${region}</div>
          <div class="backup-card-id"><code>${escHtml(g.game_id)}</code></div>
          ${badges ? `<div class="backup-card-badges">${badges}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-accent backup-card-view">View Details</button>
      </div>`;
  }).join('');

  list.onclick = e => {
    const card = e.target.closest('[data-view-game]');
    if (card) openModal(card.dataset.viewGame);
  };
}

// Search + filter live update
$('backups-search')?.addEventListener('input', renderBackups);
$('backups-region-filter')?.addEventListener('change', renderBackups);

$('btn-scan-local').addEventListener('click', async () => {
  $('btn-scan-local').disabled = true;
  setStatus('Scanning local game source folders…');
  try {
    const { total, added } = await window.pork.scanBackups();
    await loadBackups();
    await loadDashboard();
    const msg = added > 0
      ? `Found ${total} game(s) — ${added} new, fetching metadata…`
      : `Scan complete: ${total} game(s) found, none new`;
    setStatus(msg, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    $('btn-scan-local').disabled = false;
  }
});

$('btn-rescan-game-sources').addEventListener('click', async () => {
  const btn = $('btn-rescan-game-sources');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Scanning…';
  setStatus('Scanning local game source folders…');
  try {
    const { total, added } = await window.pork.scanBackups();
    await loadGames();
    await loadDashboard();
    const msg = added > 0
      ? `Found ${total} game(s) — ${added} new, fetching metadata…`
      : `Scan complete: ${total} game(s) found, none new`;
    setStatus(msg, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

$('btn-rescan-all-backporks').addEventListener('click', async () => {
  const btn = $('btn-rescan-all-backporks');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Scanning…';
  setStatus('Rescanning all backpork folders…');
  try {
    const { folders, count } = await window.pork.backporksScanAll();
    await loadBackporks();
    await refreshFirmwareFilters();
    setStatus(`Rescan complete — ${count} game(s) across ${folders} firmware folder(s)`, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ── Database page ─────────────────────────────────────────────────────────────
async function loadDatabase() {
  await loadDbTable('games');
  await loadDbTable('backups');
  await loadHashRowsTable();
}

async function loadHashRowsTable() {
  try {
    const rows = await window.pork.dbQuery(
      `SELECT id, game_id, hash_type, firmware_label, file_size,
              SUBSTR(file_hash,1,16) || '…' AS file_hash_short,
              backup_path, verified, hashed_at
       FROM game_hashes ORDER BY hashed_at DESC`
    );
    const countEl = $('hash-rows-count');
    if (countEl) countEl.textContent = `${rows.length} hash row${rows.length !== 1 ? 's' : ''}`;
    renderDbTableEl('db-hash-rows-table', rows);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

async function loadDbTable(name) {
  try {
    const sql  = name === 'games'
      ? 'SELECT id, title, game_id, version, size, installed, backed_up, last_scanned FROM games ORDER BY title'
      : 'SELECT id, game_id, backup_type, size, backup_path, created_at FROM backups ORDER BY created_at DESC';
    const rows = await window.pork.dbQuery(sql);
    renderDbTableEl(`db-${name}-table`, rows);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function renderDbTableEl(tableId, rows) {
  const table = $(tableId);
  if (!rows.length) {
    table.innerHTML = '';
    return;
  }
  const cols = Object.keys(rows[0]);
  table.innerHTML = `
    <thead><tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map(r => `<tr>${cols.map(c => `<td>${escHtml(r[c] ?? '—')}</td>`).join('')}</tr>`).join('')}
    </tbody>`;
}

// DB Tabs
document.querySelectorAll('.db-tab').forEach(tab =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.db-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.db-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`dbtab-${tab.dataset.dbtab}`).classList.add('active');
    if (tab.dataset.dbtab === 'hash-rows') loadHashRowsTable();
    if (tab.dataset.dbtab === 'hashes')    loadHashDbContent();
  })
);

// Query runner
$('btn-run-query').addEventListener('click', async () => {
  const sql = $('query-input').value.trim();
  if (!sql) return;
  const out = $('query-results');
  try {
    const rows = await window.pork.dbQuery(sql);
    if (!rows.length) { out.innerHTML = '<div class="empty-msg">Query returned no rows.</div>'; return; }
    const cols = Object.keys(rows[0]);
    out.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${escHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) {
    out.innerHTML = `<div class="empty-msg" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
});

// Exports
$('btn-export-sql').addEventListener('click', async () => {
  const p = await window.pork.exportSql();
  if (p) setStatus(`Exported to ${p}`, 'ok');
});
$('btn-export-games-csv').addEventListener('click', async () => {
  const p = await window.pork.exportCsv('games');
  if (p) setStatus(`Exported to ${p}`, 'ok');
});
$('btn-export-backups-csv').addEventListener('click', async () => {
  const p = await window.pork.exportCsv('backups');
  if (p) setStatus(`Exported to ${p}`, 'ok');
});
$('btn-export-hashes').addEventListener('click', async () => {
  const p = await window.pork.hashExport();
  if (p) setStatus(`Hash DB exported to ${p}`, 'ok');
});

// ── Hash Database tab ───────────────────────────────────────────────────────────────────────
async function loadHashDbContent() {
  try {
    const info = await window.pork.hashCommunityInfo();
    const countEl  = $('hdb-community-count');
    const verEl    = $('hdb-community-ver');
    const srcEl    = $('hdb-community-source');
    const localEl  = $('hdb-local-count');
    if (!countEl) return; // tab panel not in DOM
    countEl.textContent = `${info.count} hash${info.count !== 1 ? 'es' : ''}`;
    countEl.className   = info.count > 0 ? 'hash-badge hash-community' : 'hash-badge hash-none';
    verEl.textContent   = info.updated  ? `v${info.version || 1} · ${info.updated}` : '';
    srcEl.textContent   = info.source   === 'imported' ? '(user-imported)' : '(bundled)';
    localEl.textContent = `${info.localCount} hash${info.localCount !== 1 ? 'es' : ''}`;
    localEl.className   = info.localCount > 0 ? 'hash-badge hash-local' : 'hash-badge hash-none';
  } catch (_) {}
  try {
    const summaries = await window.pork.hashGameSummary();
    const list = $('hdb-game-list');
    if (!list) return;
    if (!summaries.length) {
      list.innerHTML = '<div class="hint" style="padding:16px;color:var(--text-dim)">No hashes recorded yet. Open any game, go to Hash Verification, and click \'Hash All Files\'. Or use the Hash All Games / Backporks buttons on those pages.</div>';
      return;
    }
    summaries.sort((a, b) => {
      if (a.community_mismatch !== b.community_mismatch) return a.community_mismatch ? -1 : 1;
      if (a.community_matches !== b.community_matches) return b.community_matches - a.community_matches;
      const typeOrder = { game: 0, backpork: 1 };
      const tDiff = (typeOrder[a.hash_type] ?? 0) - (typeOrder[b.hash_type] ?? 0);
      if (tDiff !== 0) return tDiff;
      return a.game_id.localeCompare(b.game_id);
    });
    list.innerHTML = `<div class="table-wrap" style="margin-top:14px">
      <table style="width:100%">
        <thead><tr><th>Game ID</th><th>Type</th><th>Firmware</th><th>Files Hashed</th><th>Community Matches</th><th>Status</th></tr></thead>
        <tbody>${summaries.map(s => {
          const badge = s.community_mismatch
            ? `<span class="hash-badge hash-mismatch">⚠ Hash Mismatch</span>`
            : s.community_matches > 0
              ? `<span class="hash-badge hash-community">✓ Verified (${s.community_matches}/${s.hash_count})</span>`
              : `<span class="hash-badge hash-local">⧭ Hashed (${s.hash_count})</span>`;
          const typeLabel = s.hash_type === 'backpork'
            ? `<span class="pill" style="background:var(--surface-2);color:var(--text-dim);font-size:10px">Backpork</span>`
            : `<span class="pill" style="background:var(--surface-2);color:var(--text-dim);font-size:10px">Game</span>`;
          const fwLabel = s.firmware_label ? escHtml(s.firmware_label) : '—';
          return `<tr><td><code>${escHtml(s.game_id)}</code></td><td>${typeLabel}</td><td>${fwLabel}</td><td>${s.hash_count}</td><td>${s.community_matches || '—'}</td><td>${badge}</td></tr>`;
        }).join('')}</tbody>
      </table></div>`;
  } catch (_) {}
}

const _fmtBytes = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : b < 1073741824 ? `${(b/1048576).toFixed(1)} MB` : `${(b/1073741824).toFixed(2)} GB`;

let _hashBulkRunning = false;

function _setBulkProgress({ show = true, pct = 0, status = '', fileStatus = '' } = {}) {
  const wrap   = $('bulk-hash-progress');
  const bar    = $('bulk-hash-bar');
  const pctEl  = $('bulk-hash-pct');
  const statEl = $('hash-all-games-status');
  const fileEl = $('bulk-hash-file-status');
  if (!wrap) return;
  wrap.style.display  = show ? 'flex' : 'none';
  if (bar)    bar.style.width          = `${pct}%`;
  if (pctEl)  pctEl.textContent        = `${pct}%`;
  if (statEl) statEl.textContent       = status;
  if (fileEl) fileEl.textContent       = fileStatus;
}

async function _runBulkHash(source) {
  if (_hashBulkRunning) { showToast('A hash operation is already running.', 'info'); return; }
  _hashBulkRunning = true;

  const isGames      = source === 'local';
  const btnEl        = $(isGames ? 'btn-hash-all-games' : 'btn-hash-all-backporks');
  const backporksStat = $('hash-all-backporks-status');

  btnEl.disabled = true;
  if (isGames) {
    _setBulkProgress({ show: true, pct: 0, status: 'Preparing…', fileStatus: '' });
  } else if (backporksStat) {
    backporksStat.textContent = 'Preparing…';
  }

  try {
    const { results, total, totalFilesHashed, totalBytesHashed } = await window.pork.hashBulk(source);
    const ok   = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    const doneMsg = `Done ✓ — ${ok} game${ok !== 1 ? 's' : ''}, ${totalFilesHashed} file${totalFilesHashed !== 1 ? 's' : ''} (${_fmtBytes(totalBytesHashed || 0)})${fail ? `, ${fail} skipped` : ''}`;
    if (isGames) {
      _setBulkProgress({ show: true, pct: 100, status: doneMsg, fileStatus: '' });
      // Fade the progress block away after a few seconds
      setTimeout(() => _setBulkProgress({ show: false }), 6000);
    } else if (backporksStat) {
      backporksStat.textContent = doneMsg;
    }
    // Refresh hash summaries and re-render badges everywhere
    const summaries = await window.pork.hashGameSummary();
    _populateHashMaps(summaries);
    renderGames();
    showToast(`Hash complete — ${totalFilesHashed} files (${_fmtBytes(totalBytesHashed || 0)})`, 'ok');
  } catch (e) {
    const errMsg = 'Error: ' + e.message;
    if (isGames) {
      _setBulkProgress({ show: true, pct: 0, status: errMsg, fileStatus: '' });
    } else if (backporksStat) {
      backporksStat.textContent = errMsg;
    }
    showToast('Hash failed: ' + e.message, 'error');
  } finally {
    _hashBulkRunning = false;
    btnEl.disabled = false;
  }
}

window.pork.on('hash:bulk:progress', ({ phase, done, total, percent, gameId, currentFile, fileSize, filePct, totalFilesHashed, totalBytesHashed }) => {
  const backporksStat = $('hash-all-backporks-status');
  const isGamesPage   = !!document.querySelector('#page-games.active');

  const overallStatus = `Game ${done}/${total} (${percent}%) — ${gameId || ''}`
    + (totalFilesHashed ? ` | ${totalFilesHashed} file${totalFilesHashed !== 1 ? 's' : ''} hashed` : '')
    + (totalBytesHashed ? ` | ${_fmtBytes(totalBytesHashed)}` : '');

  let fileStatus = '';
  if (currentFile) {
    const sizeSuffix = fileSize ? ` (${_fmtBytes(fileSize)})` : '';
    const pctSuffix  = (phase === 'file-progress' && filePct != null) ? ` — ${filePct}%` : '';
    fileStatus = `⧭ ${currentFile}${sizeSuffix}${pctSuffix}`;
  } else if (phase === 'backup-done') {
    fileStatus = `✓ ${gameId} complete`;
  }

  // done = completed backups so far (0 during first game's files).
  // Interpolate within the current slot: done/total gets us to the start of this slot,
  // then add filePct spread across one slot width.
  const barPct = (phase === 'file-progress' && filePct != null)
    ? Math.min(100, Math.round(done / (total || 1) * 100 + filePct / (total || 1)))
    : percent;

  _setBulkProgress({ show: true, pct: barPct, status: overallStatus, fileStatus });

  // Mirror to backporks status if the games progress block isn't visible
  if (backporksStat && !isGamesPage) {
    backporksStat.textContent = overallStatus;
  }
});

$('btn-hash-all-games').addEventListener('click', async () => {
  const ok = await showConfirm('Hash All Game Backups?\n\nThis will SHA-256 every file in every local game backup. On large libraries this can take hours.\n\nThe app stays usable while hashing. Continue?');
  if (ok) _runBulkHash('local');
});
$('btn-hash-all-backporks').addEventListener('click', async () => {
  const ok = await showConfirm('Hash All Backpork Backups?\n\nThis will SHA-256 every file in every backpork backup. On large libraries this can take hours.\n\nThe app stays usable while hashing. Continue?');
  if (ok) _runBulkHash('backpork');
});

$('btn-hdb-export').addEventListener('click', async () => {
  const p = await window.pork.hashExport();
  if (p) showToast(`Hash DB exported to ${p}`, 'ok');
});

$('btn-import-community-hashes').addEventListener('click', async () => {
  const btn = $('btn-import-community-hashes');
  btn.disabled = true;
  try {
    const result = await window.pork.hashImportCommunity();
    if (!result) { btn.disabled = false; return; }
    showToast(`Community hash list imported — ${result.count} hashes loaded`, 'ok');
    await loadHashDbContent();
    // Refresh game summaries so badges update immediately
    const summaries = await window.pork.hashGameSummary();
    _populateHashMaps(summaries);
    renderGames();
  } catch (e) {
    showToast('Import failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});
$('btn-clear-db').addEventListener('click', async () => {
  const ok = await showConfirm('This will permanently delete ALL games, backups, hashes, and settings from the database. This cannot be undone. Are you sure?');
  if (!ok) return;
  await window.pork.dbClear();
  loadDatabase();
  loadHashDbContent();
  setStatus('Database cleared.', 'ok');
});

async function _clearHashes() {
  const ok = await showConfirm('Delete all stored hashes from the database? This cannot be undone.');
  if (!ok) return;
  await window.pork.dbClearHashes();
  await loadHashRowsTable();
  await loadHashDbContent();
  const summaries = await window.pork.hashGameSummary();
  _populateHashMaps(summaries);
  renderGames();
  showToast('All hashes cleared.', 'ok');
}

$('btn-clear-hashes').addEventListener('click', _clearHashes);
$('btn-hdb-clear-hashes').addEventListener('click', _clearHashes);

// ── Settings page ─────────────────────────────────────────────────────────────

// ── Accent color helpers ───────────────────────────────────────────────────────
function darkenHex(hex, amount = 0.18) {
  const r = parseInt(hex.slice(1,3), 16) / 255;
  const g = parseInt(hex.slice(3,5), 16) / 255;
  const b = parseInt(hex.slice(5,7), 16) / 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0, l = (max+min)/2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  l = Math.max(0, l - amount);
  const hue2rgb = (p, q, t) => {
    if (t<0) t+=1; if (t>1) t-=1;
    if (t<1/6) return p+(q-p)*6*t;
    if (t<1/2) return q;
    if (t<2/3) return p+(q-p)*(2/3-t)*6;
    return p;
  };
  const q = l < 0.5 ? l*(1+s) : l+s-l*s;
  const p = 2*l - q;
  const toHex = v => Math.round(hue2rgb(p,q,v)*255).toString(16).padStart(2,'0');
  return `#${toHex(h+1/3)}${toHex(h)}${toHex(h-1/3)}`;
}

function applyAccent(hex) {
  // Validate — fall back if bad value
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const root = document.documentElement;
  root.style.setProperty('--accent',     hex);
  root.style.setProperty('--accent-d',   darkenHex(hex));
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  // Keep the swatch and hex input in sync
  const swatch = $('accent-swatch');
  const picker = $('s-accent-color');
  const hexEl  = $('s-accent-hex');
  if (swatch) swatch.style.background = hex;
  if (picker) picker.value = hex;
  if (hexEl)  hexEl.value  = hex.toUpperCase();
}

// ── Auto-save (debounced for text fields) ─────────────────────────────────────
let settingsTimer   = null;
let remoteGamePaths = [];
let localBackupPaths = [];

// Dirty flags — credentials only get saved if the user actually typed in the
// field this session. This lets the fields start blank without overwriting
// stored credentials when other settings auto-save.
let _userDirty = false;
let _passDirty = false;

function scheduleSettingsSave() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(commitSettingsSave, 600);
}

async function commitSettingsSave() {
  const payload = {
    ftpHost:          $('s-host').value.trim(),
    ftpPorts:         $('s-ports').value.split(',').map(p => p.trim()).filter(Boolean),
    backupPaths:      localBackupPaths,
    backupPath:       localBackupPaths[0] || '',
    payloadLocalPath: $('s-payload-local').value.trim(),
    payloadRemotePath:$('s-payload-remote').value.trim(),
    cheatsRemotePath: $('s-cheats-remote').value.trim(),
    discordWebhookUrl: $('s-discord-webhook').value.trim(),
    mediaPsNotifyEnabled: $('s-media-discord-notify').checked,
    autoConnect:      $('s-auto-connect').checked,
    timeFormat:       $('s-time-format').value,
  };
  // Only persist credentials when the user has actively typed in those fields
  if (_userDirty) payload.ftpUser = $('s-user').value.trim();
  if (_passDirty) payload.ftpPass = $('s-pass').value;
  await window.pork.setSettings(payload);
  // Mirror non-sensitive FTP fields to the dashboard quick-connect
  $('d-host').value  = $('s-host').value;
  $('d-ports').value = $('s-ports').value;
  setStatus('Settings saved', 'ok');
}

async function loadSettings() {
  const s = await window.pork.getSettings();
  $('s-host').value  = s.ftpHost  || '';
  $('s-ports').value = (s.ftpPorts && s.ftpPorts.length) ? s.ftpPorts.join(', ') : '1337, 2121, 21';
  // Username and password fields intentionally start blank — they show their
  // placeholder text until the user types. Stored credentials are used by
  // auto-connect and the connect button fallback without being displayed.
  // populate multi-path backup folder list
  localBackupPaths = s.backupPaths || (s.backupPath ? [s.backupPath] : []);
  renderLocalBackupPaths();
  $('s-payload-local').value  = s.payloadLocalPath  || '';
  $('s-payload-remote').value = s.payloadRemotePath || '/data/payloads/';
  $('s-voidshell-port').value = s.voidshellPort || 7007;
  $('s-cheats-remote').value   = s.cheatsRemotePath  || '/data/etaHEN/cheats/';
  $('s-discord-webhook').value = s.discordWebhookUrl || '';
  $('s-media-discord-notify').checked = s.mediaPsNotifyEnabled !== false; // default true
  $('s-auto-connect').checked = s.autoConnect === true;
  _timeFormat = s.timeFormat || '12h';
  $('s-time-format').value = _timeFormat;
  // Mirror to dashboard quick-connect (host/ports only — credentials stay blank)
  $('d-host').value  = s.ftpHost  || '';
  $('d-ports').value = (s.ftpPorts && s.ftpPorts.length) ? s.ftpPorts.join(', ') : '1337, 2121, 21';
  // Apply saved accent color
  applyAccent(s.accentColor || '#BB86FC');
  // Render remote game paths
  remoteGamePaths = s.remoteGamePaths || [];
  renderRemoteGamePaths();
  // Render payload sources list
  await renderSettingsPayloadSources();
  // Load system view hotkeys
  if (s.svHotkeys) _svHotkeys = { ..._svHotkeys, ...s.svHotkeys };
  const hkMap = { 'hk-mute': 'mute', 'hk-gif': 'gif', 'hk-video': 'video', 'hk-fullscreen': 'fullscreen', 'hk-popout': 'popout' };
  Object.entries(hkMap).forEach(([id, action]) => {
    const el = $(id); if (el) el.value = _svHotkeys[action] || '';
  });

  // ── Conversion settings ────────────────────────────────────────────────────
  const convMode = s.gameConversionMode || 'pfs';
  const modeRadio = document.querySelector(`input[name="conv-mode"][value="${convMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  applyConvModeUI(convMode);

  $('s-conv-ufs2-path').value    = s.ufs2ToolPath    || '';
  $('s-conv-exfat-path').value   = s.exfatToolPath   || '';
  $('s-conv-output-dir').value   = s.convOutputDir   || '';
  $('s-conv-temp-dir').value     = s.convTempDir     || '';
  $('s-conv-ftp-upload').checked  = !!s.convFtpUpload;
  $('s-conv-delete-after').checked = !!s.convDeleteAfter;
  $('conv-delete-after-row').hidden = false;
  $('s-conv-delete-after').disabled  = !s.convFtpUpload;
  $('conv-delete-after-row').style.opacity = s.convFtpUpload ? '' : '0.45';

  $('s-conv-psn-enabled').checked  = s.convPsNotifyEnabled !== false;
  $('conv-psn-detail').hidden      = !s.convPsNotifyEnabled;
  $('s-conv-psn-queued').checked   = s.convPsNotifyOnGameQueued  !== false;
  $('s-conv-psn-batch').checked    = s.convPsNotifyOnBatchQueued !== false;
  $('s-conv-psn-copy').checked     = s.convPsNotifyOnCopyStart   !== false;
  $('s-conv-psn-convert').checked  = s.convPsNotifyOnConvertStart!== false;
  $('s-conv-psn-done').checked     = s.convPsNotifyOnJobDone     !== false;

  await refreshConvToolStatus();
}

// FTP / path fields → debounced auto-save
['s-host', 's-ports'].forEach(id =>
  $(id).addEventListener('input', scheduleSettingsSave)
);
// Dashboard host/ports fields mirror settings fields and auto-save
$('d-host').addEventListener('input', () => {
  $('s-host').value = $('d-host').value;
  scheduleSettingsSave();
});
$('d-ports').addEventListener('input', () => {
  $('s-ports').value = $('d-ports').value;
  scheduleSettingsSave();
});
// Credential fields set their dirty flag before scheduling save
$('s-user').addEventListener('input', () => { _userDirty = true; scheduleSettingsSave(); });
$('s-pass').addEventListener('input', () => { _passDirty = true; scheduleSettingsSave(); });

// ── Game Source Folders (multi-path backup) ────────────────────────────────────

function renderLocalBackupPaths() {
  const cont = $('settings-backup-paths-list');
  if (!cont) return;
  if (!localBackupPaths.length) {
    cont.innerHTML = '<p class="hint" style="margin:6px 0">No folders added yet. Click &ldquo;+ Add Folder&hellip;&rdquo; to get started.</p>';
    return;
  }
  cont.innerHTML = localBackupPaths.map((p, i) => `
    <div class="remote-path-row" data-backup-idx="${i}">
      <span class="remote-path-value" title="${escHtml(p)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p)}</span>
      <button class="btn btn-sm btn-backup-path-remove" style="margin-left:auto;flex-shrink:0">&#10005;</button>
    </div>
  `).join('');
}

async function saveLocalBackupPaths() {
  await window.pork.setSettings({
    backupPaths: localBackupPaths,
    backupPath:  localBackupPaths[0] || '',
  });
  setStatus('Settings saved', 'ok');
}

$('settings-backup-paths-list').addEventListener('click', async e => {
  const row = e.target.closest('[data-backup-idx]');
  if (!row || !e.target.closest('.btn-backup-path-remove')) return;
  const idx = Number(row.dataset.backupIdx);
  const ok = await showConfirm(`Remove "${escHtml(localBackupPaths[idx])}" from game source folders?`);
  if (!ok) return;
  localBackupPaths = localBackupPaths.filter((_, i) => i !== idx);
  await saveLocalBackupPaths();
  renderLocalBackupPaths();
});

$('btn-add-backup-path').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  if (localBackupPaths.includes(folder)) { setStatus('That folder is already in the list', 'ok'); return; }
  localBackupPaths = [...localBackupPaths, folder];
  await saveLocalBackupPaths();
  renderLocalBackupPaths();
});

// Payload local folder browse
$('btn-browse-payload-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('s-payload-local').value = folder;
  await commitSettingsSave();
});

// Payload remote path — debounced
$('s-payload-remote').addEventListener('input', scheduleSettingsSave);

// Cheats remote path — debounced
$('s-cheats-remote').addEventListener('input', scheduleSettingsSave);

// Discord webhook URL — debounced
$('s-discord-webhook').addEventListener('input', scheduleSettingsSave);

$('btn-browse-cheats-remote').addEventListener('click', async () => {
  const cur = $('s-cheats-remote').value.trim() || '/';
  const p = await openFtpBrowser(cur);
  if (p) { $('s-cheats-remote').value = p; scheduleSettingsSave(); }
});

// Auto-connect toggle — save immediately on change
$('s-auto-connect').addEventListener('change', commitSettingsSave);

// Time format toggle — save and re-render media grid immediately
$('s-time-format').addEventListener('change', e => {
  _timeFormat = e.target.value;
  commitSettingsSave();
  renderMediaGrid();
});

// Media Discord PS Notify toggle
$('s-media-discord-notify').addEventListener('change', commitSettingsSave);

// ── Conversion settings helpers & event handlers ──────────────────────────────

function applyConvModeUI(mode) {
  const isPfs   = mode === 'pfs';
  const isFfpkg = mode === 'ffpkg';
  const isExfat = mode === 'exfat';
  const isConv  = !isPfs;

  $('conv-ffpkg-fields').hidden   = !isFfpkg;
  $('conv-exfat-fields').hidden   = !isExfat;
  $('conv-shared-fields').hidden  = !isConv;
  $('conv-notify-fields').hidden  = !isConv;

  // Update the conv queue panel badge when mode changes
  const badge = $('conv-queue-mode-badge');
  if (badge) badge.textContent = isPfs ? 'Raw Dumps' : isFfpkg ? 'FFPKG' : 'ExFAT';
}

async function refreshConvToolStatus() {
  const mode = document.querySelector('input[name="conv-mode"]:checked')?.value || 'pfs';
  if (mode === 'ffpkg') {
    try {
      const info  = await window.pork.convToolInfo();
      const el    = $('s-conv-ufs2-status');
      if (!el) return;
      if (info.toolAvailable) {
        el.textContent = '✓ UFS2Tool.exe found';
        el.style.color = 'var(--green)';
      } else {
        el.textContent = info.toolPath ? '✗ File not found at configured path' : '✗ Not configured';
        el.style.color = 'var(--red)';
      }
    } catch (_) {}
  }
  if (mode === 'exfat') {
    try {
      const info = await window.pork.convExfatToolInfo();
      const el   = $('s-conv-exfat-status');
      if (!el) return;
      if (info.toolAvailable) {
        el.textContent = '✓ Found (make_image.bat + New-OsfExfatImage.ps1)';
        el.style.color = 'var(--green)';
      } else if (info.toolPath && !info.batAvailable) {
        el.textContent = '✗ make_image.bat not found in folder';
        el.style.color = 'var(--red)';
      } else if (info.toolPath && !info.psAvailable) {
        el.textContent = '✗ New-OsfExfatImage.ps1 missing from folder';
        el.style.color = 'var(--red)';
      } else {
        el.textContent = info.toolPath ? '✗ Folder not found' : '✗ Not configured';
        el.style.color = 'var(--red)';
      }
    } catch (_) {}
  }
}

// Conv mode radio buttons
document.querySelectorAll('input[name="conv-mode"]').forEach(radio => {
  radio.addEventListener('change', async () => {
    const mode = radio.value;
    applyConvModeUI(mode);
    await window.pork.setSettings({ gameConversionMode: mode });
    await refreshConvToolStatus();
    setStatus('Conversion mode saved', 'ok');
  });
});

// UFS2Method radios
document.querySelectorAll('input[name="ufs2-method"]').forEach(radio => {
  radio.addEventListener('change', async () => {
    await window.pork.setSettings({ ufs2Method: radio.value });
    setStatus('UFS2 method saved', 'ok');
  });
});

// UFS2Tool.exe browse
$('btn-conv-ufs2-pick').addEventListener('click', async () => {
  const info = await window.pork.convToolPick();
  if (!info) return;
  $('s-conv-ufs2-path').value = info.toolPath || '';
  const el = $('s-conv-ufs2-status');
  if (el) {
    el.textContent = info.toolAvailable ? '✓ UFS2Tool.exe found' : '✗ File not found';
    el.style.color = info.toolAvailable ? 'var(--green)' : 'var(--red)';
  }
  setStatus('UFS2Tool path saved', 'ok');
});

// ExFAT tool folder browse
$('btn-conv-exfat-pick').addEventListener('click', async () => {
  const info = await window.pork.convExfatToolPick();
  if (!info) return;
  $('s-conv-exfat-path').value = info.toolPath || '';
  await refreshConvToolStatus();
  setStatus('ExFAT tool path saved', 'ok');
});

// Output directory browse
$('btn-conv-output-pick').addEventListener('click', async () => {
  const p = await window.pork.convPickOutputDir();
  if (!p) return;
  $('s-conv-output-dir').value = p;
  setStatus('Output directory saved', 'ok');
});

// Temp directory browse
$('btn-conv-temp-pick').addEventListener('click', async () => {
  const p = await window.pork.convPickTempDir();
  if (!p) return;
  $('s-conv-temp-dir').value = p;
  setStatus('Temp directory saved', 'ok');
});

// FTP upload checkbox
$('s-conv-ftp-upload').addEventListener('change', async function() {
  const ftpEnabled = this.checked;
  $('s-conv-delete-after').disabled  = !ftpEnabled;
  $('conv-delete-after-row').style.opacity = ftpEnabled ? '' : '0.45';
  if (!ftpEnabled) {
    $('s-conv-delete-after').checked = false;
    await window.pork.setSettings({ convFtpUpload: false, convDeleteAfter: false });
  } else {
    await window.pork.setSettings({ convFtpUpload: true });
  }
  setStatus('Settings saved', 'ok');
});

// Delete after checkbox
$('s-conv-delete-after').addEventListener('change', async function() {
  await window.pork.setSettings({ convDeleteAfter: this.checked });
  setStatus('Settings saved', 'ok');
});

// PS Notify enabled toggle
$('s-conv-psn-enabled').addEventListener('change', async function() {
  $('conv-psn-detail').hidden = !this.checked;
  await window.pork.setSettings({ convPsNotifyEnabled: this.checked });
  setStatus('Settings saved', 'ok');
});

// PS Notify detail checkboxes
[
  ['s-conv-psn-queued',  'convPsNotifyOnGameQueued'],
  ['s-conv-psn-batch',   'convPsNotifyOnBatchQueued'],
  ['s-conv-psn-copy',    'convPsNotifyOnCopyStart'],
  ['s-conv-psn-convert', 'convPsNotifyOnConvertStart'],
  ['s-conv-psn-done',    'convPsNotifyOnJobDone'],
].forEach(([id, key]) => {
  $(id).addEventListener('change', function() {
    window.pork.setSettings({ [key]: this.checked });
  });
});

// FTP port preset chips — click to append if not already present
$('settings-ftp-presets').addEventListener('click', e => {
  const btn = e.target.closest('[data-add-port]');
  if (!btn) return;
  const port    = btn.dataset.addPort;
  const current = $('s-ports').value.split(',').map(p => p.trim()).filter(Boolean);
  if (!current.includes(port)) {
    current.push(port);
    $('s-ports').value = current.join(', ');
    commitSettingsSave();
  }
});

// ── System View hotkey capture ─────────────────────────────────────────────────
{
  const hkMap = { 'hk-mute': 'mute', 'hk-gif': 'gif', 'hk-video': 'video', 'hk-fullscreen': 'fullscreen', 'hk-popout': 'popout' };
  Object.entries(hkMap).forEach(([id, action]) => {
    const input = $(id);
    if (!input) return;
    input.addEventListener('focus', () => {
      input.dataset.prev = input.value;
      input.value = '';
      input.placeholder = 'press a key…';
      input.classList.add('capturing');
    });
    input.addEventListener('blur', () => {
      if (!input.value) input.value = input.dataset.prev || '';
      input.placeholder = '—';
      input.classList.remove('capturing');
    });
    input.addEventListener('keydown', async e => {
      e.preventDefault();
      if (e.key === 'Escape') { input.value = input.dataset.prev || ''; input.blur(); return; }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      input.value = key;
      _svHotkeys[action] = key;
      input.blur();
      await window.pork.setSettings({ svHotkeys: { ..._svHotkeys } });
      setStatus('Hotkey saved', 'ok');
    });
  });
}

// ── Remote Game Locations ──────────────────────────────────────────────────────

function renderRemoteGamePaths() {
  const cont = $('settings-remote-paths-list');
  if (!remoteGamePaths.length) {
    cont.innerHTML = '<p class="hint" style="margin:6px 0">No paths configured. Scan will use standard PS5 paths.</p>';
    return;
  }
  cont.innerHTML = remoteGamePaths.map((p, i) => `
    <div class="remote-path-row" data-idx="${i}">
      <span class="remote-path-label">${escHtml(p.label)}</span>
      <span class="remote-path-value" title="${escHtml(p.path)}">${escHtml(p.path)}</span>
      <button class="btn btn-sm btn-remote-path-remove" style="margin-left:auto">&#10005;</button>
    </div>
  `).join('');
}

async function saveRemoteGamePaths() {
  await window.pork.setSettings({ remoteGamePaths });
  setStatus('Settings saved', 'ok');
}

$('btn-add-remote-path').addEventListener('click', async () => {
  const label = $('new-remote-label').value.trim();
  const path  = $('new-remote-path').value.trim();
  if (!path) { setStatus('Enter a remote path', 'error'); return; }
  remoteGamePaths = [...remoteGamePaths, { label: label || path, path }];
  await saveRemoteGamePaths();
  renderRemoteGamePaths();
  $('new-remote-label').value = '';
  $('new-remote-path').value  = '';
});

$('settings-remote-paths-list').addEventListener('click', async e => {
  const row = e.target.closest('[data-idx]');
  if (!row || !e.target.closest('.btn-remote-path-remove')) return;
  const idx = Number(row.dataset.idx);
  const ok = await showConfirm(`Remove "${escHtml(remoteGamePaths[idx]?.label)}" from remote game paths?`);
  if (!ok) return;
  remoteGamePaths = remoteGamePaths.filter((_, i) => i !== idx);
  await saveRemoteGamePaths();
  renderRemoteGamePaths();
});

// ── FTP Browser ───────────────────────────────────────────────────────────────

let ftpBrowserResolve = null;
let ftpBrowserCwd = '/';

function openFtpBrowser(startPath = '/') {
  return new Promise(resolve => {
    ftpBrowserResolve = resolve;
    $('ftp-browser-overlay').hidden = false;
    ftpBrowserNavigate(startPath);
  });
}

function closeFtpBrowser(result) {
  $('ftp-browser-overlay').hidden = true;
  if (ftpBrowserResolve) { ftpBrowserResolve(result); ftpBrowserResolve = null; }
}

async function ftpBrowserNavigate(path) {
  ftpBrowserCwd = path;
  $('ftp-browser-cwd').textContent = path;
  $('ftp-browser-up').disabled = (path === '/');
  const body = $('ftp-browser-body');
  body.innerHTML = '<div class="ftp-browser-loading">Loading…</div>';
  try {
    const entries = await window.pork.ftpListDir(path);
    if (!entries.length) {
      body.innerHTML = '<div class="ftp-browser-loading">Empty folder.</div>';
      return;
    }
    body.innerHTML = entries.map(e => `
      <div class="ftp-browser-entry ${e.isDir ? 'ftp-entry-dir' : 'ftp-entry-file'}"
           data-name="${escHtml(e.name)}" data-isdir="${e.isDir}">
        <span class="ftp-entry-icon">${e.isDir ? '📁' : '📄'}</span>
        <span class="ftp-entry-name">${escHtml(e.name)}</span>
      </div>
    `).join('');
  } catch (e) {
    body.innerHTML = `<div class="ftp-browser-loading" style="color:var(--red)">Error: ${escHtml(e.message)}</div>`;
  }
}

$('ftp-browser-body').addEventListener('click', e => {
  const entry = e.target.closest('.ftp-entry-dir');
  if (!entry) return;
  const name = entry.dataset.name;
  const next = (ftpBrowserCwd.endsWith('/') ? ftpBrowserCwd : ftpBrowserCwd + '/') + name;
  ftpBrowserNavigate(next);
});

$('ftp-browser-up').addEventListener('click', () => {
  const parts = ftpBrowserCwd.replace(/\/$/, '').split('/').filter(Boolean);
  parts.pop();
  ftpBrowserNavigate('/' + parts.join('/') || '/');
});

$('ftp-browser-select').addEventListener('click', () => closeFtpBrowser(ftpBrowserCwd));
$('ftp-browser-cancel').addEventListener('click', () => closeFtpBrowser(null));
$('ftp-browser-close').addEventListener('click',  () => closeFtpBrowser(null));

$('btn-browse-ftp').addEventListener('click', async () => {
  if (!state.connected) { setStatus('Connect to FTP first to browse remote paths', 'error'); return; }
  const selected = await openFtpBrowser(ftpBrowserCwd || '/');
  if (!selected) return;
  // Auto-add immediately — no separate "+ Add" click required
  if (remoteGamePaths.some(p => p.path === selected)) {
    setStatus('That path is already in the list', 'ok');
    return;
  }
  const label = $('new-remote-label').value.trim()
    || selected.replace(/\/$/, '').split('/').filter(Boolean).pop()
    || selected;
  remoteGamePaths = [...remoteGamePaths, { label, path: selected }];
  await saveRemoteGamePaths();
  renderRemoteGamePaths();
  $('new-remote-label').value = '';
  $('new-remote-path').value  = '';
});

// Add payload source
$('btn-add-payload-source').addEventListener('click', async () => {
  const name = $('new-source-name').value.trim();
  const url  = $('new-source-url').value.trim();
  if (!name || !url) { setStatus('Enter both a name and a source URL', 'error'); return; }
  try {
    await window.pork.payloadSourcesAdd(name, url);
    $('new-source-name').value = '';
    $('new-source-url').value  = '';
    await renderSettingsPayloadSources();
    setStatus(`Source "${name}" added`, 'ok');
  } catch (e) {
    setStatus(`Failed to add source: ${e.message}`, 'error');
  }
});

// Delegated clicks in settings payload source list
$('settings-payload-sources').addEventListener('click', async e => {
  const row = e.target.closest('[data-source-id]');
  if (!row) return;
  const id = Number(row.dataset.sourceId);

  if (e.target.closest('.btn-source-remove')) {
    const ok = await showConfirm('Remove this payload source? Downloaded files will not be deleted.');
    if (!ok) return;
    await window.pork.payloadSourcesRemove(id);
    await renderSettingsPayloadSources();
  } else if (e.target.closest('.source-toggle')) {
    await window.pork.payloadSourcesToggle(id);
    await renderSettingsPayloadSources();
  }
});

// ── Accent color picker ────────────────────────────────────────────────────────
$('s-accent-color').addEventListener('input', async e => {
  const hex = e.target.value;
  applyAccent(hex);
  $('s-accent-hex').value = hex.toUpperCase();
  await window.pork.setSettings({ accentColor: hex });
});

// Hex text field — let user type a hex value directly
$('s-accent-hex').addEventListener('input', e => {
  const raw = e.target.value.trim();
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    applyAccent(hex);
    window.pork.setSettings({ accentColor: hex });
  }
});

$('btn-reset-accent').addEventListener('click', async () => {
  const def = '#BB86FC';
  applyAccent(def);
  await window.pork.setSettings({ accentColor: def });
  setStatus('Accent color reset to default', 'ok');
});

// ── Confirm dialog helper ──────────────────────────────────────────────────────
function showConfirm(message) {
  return new Promise(resolve => {
    $('confirm-message').textContent = message;
    $('confirm-overlay').hidden = false;

    function cleanup(result) {
      $('confirm-overlay').hidden = true;
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
  });
}

// ── Destination picker (for upload/pork when multiple remote paths are configured) ──

function showDestinationPicker(paths) {
  return new Promise(resolve => {
    const list = $('dest-picker-list');
    list.innerHTML = paths.map((p, i) => `
      <button class="dest-picker-option" data-idx="${i}">
        <span class="dest-opt-label">${escHtml(p.label)}</span>
        <span class="dest-opt-path">${escHtml(p.path)}</span>
      </button>
    `).join('');
    $('dest-picker-overlay').hidden = false;

    let resolved = false;
    function cleanup(result) {
      if (resolved) return;
      resolved = true;
      $('dest-picker-overlay').hidden = true;
      resolve(result);
    }
    list.querySelectorAll('.dest-picker-option').forEach((btn, i) => {
      btn.addEventListener('click', () => cleanup(paths[i]), { once: true });
    });
    $('dest-picker-cancel').addEventListener('click', () => cleanup(null), { once: true });
  });
}

// Ensure a game has an ftp_path set (prompting if needed). Returns the path or null if cancelled.
async function ensureGameFtpPath(gameId) {
  const g = state.currentGame?.game_id === gameId ? state.currentGame
          : (await window.pork.listGames({})).find(x => x.game_id === gameId);

  if (g?.ftp_path) return g.ftp_path;

  // No stored path — pick one
  let basePath = null;
  if (remoteGamePaths.length === 0) {
    // No locations configured — use default, but don't store (user hasn't set up locations)
    return `/mnt/sandbox/pfsmnt/${gameId}-app0`;
  } else if (remoteGamePaths.length === 1) {
    basePath = remoteGamePaths[0].path;
  } else {
    const chosen = await showDestinationPicker(remoteGamePaths);
    if (!chosen) return null;
    basePath = chosen.path;
  }

  const ftp_path = basePath.replace(/\/?$/, '/') + gameId + '-app0';
  await window.pork.updateGame({ game_id: gameId, fields: { ftp_path } });
  if (state.currentGame?.game_id === gameId) {
    state.currentGame = { ...state.currentGame, ftp_path };
    renderManageInstallLocation(state.currentGame);
  }
  return ftp_path;
}

$('btn-refresh-all-meta').addEventListener('click', async () => {
  const ok = await showConfirm(
    'This will clear all cached Prospero metadata and re-fetch every game from scratch. ' +
    'Background fetches will queue automatically. Continue?'
  );
  if (!ok) return;

  $('btn-refresh-all-meta').disabled = true;
  setStatus('Queueing metadata refresh for all games…');
  try {
    const { queued } = await window.pork.prosperoRefreshAll();
    setStatus(`Refreshing metadata for ${queued} game(s) in background…`, 'ok');
  } catch (e) {
    setStatus(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('btn-refresh-all-meta').disabled = false;
  }
});

// ── Firmware helpers ───────────────────────────────────────────────────────────
function renderFwPills(firmware_labels) {
  if (!firmware_labels) return '<span style="color:var(--text-dim)">—</span>';
  return firmware_labels.split(',').filter(Boolean)
    .map(l => `<span class="fw-pill">${escHtml(l)}</span>`).join('');
}

async function refreshFirmwareFilters() {
  const labels = await window.pork.firmwareLabels();
  const row    = $('firmware-filter-row');
  const cont   = $('firmware-filter-btns');

  if (!labels.length) { row.hidden = true; return; }
  row.hidden = false;

  cont.innerHTML = `<button class="fwbtn${state.firmwareFilter === 'all' ? ' active' : ''}" data-fw="all">All</button>` +
    labels.map(l => `<button class="fwbtn${state.firmwareFilter === l ? ' active' : ''}" data-fw="${escHtml(l)}">${escHtml(l)}</button>`).join('');

  cont.onclick = e => {
    const btn = e.target.closest('.fwbtn');
    if (!btn) return;
    state.firmwareFilter = btn.dataset.fw;
    cont.querySelectorAll('.fwbtn').forEach(b => b.classList.toggle('active', b.dataset.fw === state.firmwareFilter));
    renderGames();
  };
}

// ── Backporks page ─────────────────────────────────────────────────────────────
async function loadBackporks() {
  const folders = await window.pork.backporksList();
  // Refresh hash summaries so game-row badges are current
  try {
    const summaries = await window.pork.hashGameSummary();
    _populateHashMaps(summaries);
  } catch (_) {}
  const list    = $('backpork-list');
  const empty   = $('backpork-empty');

  list.innerHTML = '';
  empty.style.display = folders.length ? 'none' : 'block';

  for (const f of folders) {
    // Fetch the games in this folder
    const games = await window.pork.backporksGames(f.name);

    const card = document.createElement('div');
    card.className = 'backpork-card';

    const gamesHtml = games.length ? games.map(g => {
      const title   = g.prospero_name || g.title || g.game_id;
      const porked  = g.porked_firmware === f.name;
      const _bhs    = _backporkHashSummary.get(g.game_id + '|' + f.name) || _gameHashSummary.get(g.game_id);
      const hashPill = _bhs
        ? _bhs.community_mismatch
          ? `<span class="backpork-porked-pill hash-pill-fail" title="⚠ Community hash check FAILED — may contain modified or malicious files">⚠ Hash Fail</span>`
          : _bhs.community_matches > 0
            ? `<span class="backpork-porked-pill hash-pill-ok" title="Community verified: ${_bhs.community_matches}/${_bhs.hash_count} files">✓ Verified</span>`
            : `<span class="backpork-porked-pill hash-pill-local" title="${_bhs.hash_count} file(s) hashed">⧭ Hashed</span>`
        : '';
      return `
        <div class="backpork-game-row">
          ${g.prospero_icon_url
            ? `<img class="backpork-game-icon" src="${escHtml(g.prospero_icon_url)}" alt="" onerror="this.style.display='none'"/>`
            : '<div class="backpork-game-icon"></div>'}
          <div class="backpork-game-info">
            <div class="backpork-game-title" title="${escHtml(title)}">${escHtml(title)}</div>
            <div class="backpork-game-id">${escHtml(g.game_id)}</div>
          </div>
          ${porked ? `<span class="backpork-porked-pill">✓ Porked</span>` : ''}
          ${hashPill}
          <div class="backpork-game-actions">
            <button class="btn btn-sm" data-bp-view="${escHtml(g.game_id)}">View</button>
            <button class="btn btn-sm btn-teal"
                    data-bp-pork="${escHtml(g.game_id)}"
                    data-bp-fw="${escHtml(f.name)}"
                    data-bp-path="${escHtml(f.path)}"
                    ${!state.connected ? 'disabled title="Connect to PS5 first"' : ''}>
              Pork ▶
            </button>
          </div>
        </div>`;
    }).join('') : '<div class="backpork-game-row" style="color:var(--text-dim);font-size:12px">No games detected — click Rescan</div>';

    card.innerHTML = `
      <div class="backpork-card-header">
        <div class="backpork-badge">${escHtml(f.name)}</div>
        <div class="backpork-info">
          <div class="backpork-path" title="${escHtml(f.path)}">${escHtml(f.path)}</div>
          <div class="backpork-count"><strong>${games.length}</strong> game(s) detected</div>
        </div>
        <div class="backpork-actions">
          <button class="btn btn-sm btn-teal" data-action="scan" data-id="${f.id}">&#8635; Rescan</button>
          <button class="btn btn-sm btn-danger" data-action="remove" data-id="${f.id}">Remove</button>
        </div>
      </div>
      <div class="backpork-games">${gamesHtml}</div>`;

    list.appendChild(card);
  }

  list.onclick = async e => {
    // Rescan / Remove
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'scan') {
        btn.disabled = true; btn.textContent = 'Scanning…';
        try {
          const { count } = await window.pork.backporksScan(id);
          setStatus(`Rescan complete — ${count} game(s) found`, 'ok');
          await loadBackporks();
          await refreshFirmwareFilters();
        } catch (err) { setStatus(err.message, 'error'); }
      }
      if (btn.dataset.action === 'remove') {
        await window.pork.backporksRemove(id);
        setStatus('Folder removed', 'ok');
        await loadBackporks();
        await refreshFirmwareFilters();
      }
      return;
    }

    // View game
    const viewBtn = e.target.closest('[data-bp-view]');
    if (viewBtn) { openModal(viewBtn.dataset.bpView); return; }

    // Pork from backporks page
    const porkBtn = e.target.closest('[data-bp-pork]');
    if (porkBtn && !porkBtn.disabled) {
      const gameId     = porkBtn.dataset.bpPork;
      const folderName = porkBtn.dataset.bpFw;
      const folderPath = porkBtn.dataset.bpPath;

      // Ensure a destination is remembered before porking
      const ftpDest = await ensureGameFtpPath(gameId);
      if (!ftpDest) return; // user cancelled picker

      porkBtn.disabled = true;
      porkBtn.textContent = 'Queuing…';
      setStatus(`Queuing ${gameId} (${folderName}) for install…`);
      try {
        await window.pork.backporksPork(gameId, folderName, folderPath);
        setStatus(`${gameId} queued — see Transfers tab for progress`, 'ok');
        await loadBackporks();
      } catch (err) {
        setStatus(`Pork failed: ${err.message}`, 'error');
        porkBtn.disabled = false;
        porkBtn.textContent = 'Pork ▶';
      }
    }
  };
}

// Refresh backporks page when auto-scan completes on launch
window.pork.on('backporks:scan:complete', async ({ folders, count }) => {
  if (count > 0) showToast(`Backporks: ${count} game${count !== 1 ? 's' : ''} across ${folders} firmware folder${folders !== 1 ? 's' : ''}`, 'info');
  if (document.querySelector('.page.active')?.id === 'page-backporks') await loadBackporks();
  await refreshFirmwareFilters();
});

$('btn-create-fw-folder').addEventListener('click', () => {
  $('new-fw-form').hidden = !$('new-fw-form').hidden;
  if (!$('new-fw-form').hidden) $('new-fw-name').focus();
});
$('btn-new-fw-cancel').addEventListener('click', () => {
  $('new-fw-form').hidden = true;
  $('new-fw-name').value = '';
  $('new-fw-parent').value = '';
});
$('btn-new-fw-browse').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (folder) $('new-fw-parent').value = folder;
});
$('btn-new-fw-create').addEventListener('click', async () => {
  const name       = $('new-fw-name').value.trim();
  const parentPath = $('new-fw-parent').value.trim();
  if (!name)       { setStatus('Enter a firmware version (e.g. 11.50.0)', 'error'); return; }
  if (!parentPath) { setStatus('Select a parent folder', 'error'); return; }
  if (!/^\d+\.\d+\.\d+$/.test(name)) { setStatus('Version must follow x.x.x format (e.g. 11.50.0)', 'error'); return; }
  try {
    $('btn-new-fw-create').disabled = true;
    const { path: created } = await window.pork.backporksCreateFolder(name, parentPath);
    showToast(`Created firmware folder ${name}`, 'ok');
    $('new-fw-form').hidden = true;
    $('new-fw-name').value = '';
    $('new-fw-parent').value = '';
    await loadBackporks();
    await refreshFirmwareFilters();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('btn-new-fw-create').disabled = false;
  }
});

$('btn-add-backpork').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;

  $('btn-add-backpork').disabled = true;
  setStatus('Scanning firmware folders…');
  try {
    const { folders, count } = await window.pork.backporksAddRoot(folder);
    setStatus(`Found ${folders} firmware folder(s) — ${count} game(s) detected`, 'ok');
    await loadBackporks();
    await refreshFirmwareFilters();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('btn-add-backpork').disabled = false;
  }
});

// ── Hash verification ──────────────────────────────────────────────────────────
let hashingInProgress = false;

window.pork.on('hash:progress', ({ percent }) => {
  const fill  = $('hash-progress-fill');
  const label = $('hash-progress-label');
  if (fill)  fill.style.width = `${percent}%`;
  if (label) label.textContent = `Hashing… ${percent}%`;
});

async function renderHashSection(game_id, backups) {
  const section = $('modal-hash-section');
  const badge   = $('modal-hash-community-badge');
  badge.hidden    = true;
  badge.className = 'hash-badge'; // reset class each render

  // Include both local and backpork backups — all game files deserve verification.
  if (!backups.length) { section.hidden = true; return; }
  section.hidden = false;

  const { localHashes, communityMatches, communityMismatch } = await window.pork.hashStatus(game_id);
  const communitySet = new Set(communityMatches.map(h => h.file_hash));

  // Badge above hash list: mismatch warning takes priority over verified check.
  const allInCommunity = localHashes.length > 0 && communityMatches.length === localHashes.length;
  if (communityMismatch && localHashes.length > 0) {
    badge.hidden    = false;
    badge.className = 'hash-badge hash-mismatch';
    badge.textContent = '⚠ Community Hash Mismatch — files may be modified or contain brick code';
  } else if (allInCommunity) {
    badge.hidden    = false;
    badge.className = 'hash-badge hash-community';
    badge.textContent = 'Community Verified ✓';
  }

  // Each backup is a folder — show aggregate hash status for the whole folder.
  $('modal-hash-list').innerHTML = backups.map(b => {
    const folderName     = b.backup_path.replace(/\\/g, '/').split('/').pop();
    const hashedCount    = localHashes.length;
    const communityCount = communityMatches.length;

    if (hashedCount === 0) {
      return `
        <div class="hash-entry">
          <div class="hash-entry-info">
            <span class="hash-filename">${escHtml(folderName)}</span>
            <span class="hash-badge hash-none">Not hashed</span>
          </div>
          <div class="hash-entry-status">
            <button class="btn btn-sm btn-teal hash-btn-add"
                    data-path="${escHtml(b.backup_path)}"
                    data-game="${escHtml(game_id)}"
                    data-source="${escHtml(b.source || 'local')}">Hash All Files</button>
          </div>
        </div>`;
    }

    const allCommunity = communityCount === hashedCount;
    const statusBadge  = allCommunity
      ? `<span class="hash-badge hash-community">${communityCount} file${communityCount !== 1 ? 's' : ''} community ✓</span>`
      : communityMismatch
        ? `<span class="hash-badge hash-mismatch">⚠ Hash Mismatch — ${hashedCount} local hash${hashedCount !== 1 ? 'es' : ''} don't match community list</span>`
        : `<span class="hash-badge hash-local">${hashedCount} file${hashedCount !== 1 ? 's' : ''} hashed</span>`
          + (communityCount > 0 ? ` <span class="hash-badge hash-community">${communityCount} community ✓</span>` : '');

    return `
      <div class="hash-entry">
        <div class="hash-entry-info">
          <span class="hash-filename">${escHtml(folderName)}</span>
          ${statusBadge}
        </div>
        <div class="hash-entry-status">
          <button class="btn btn-sm hash-btn-reverify"
                  data-path="${escHtml(b.backup_path)}"
                  data-game="${escHtml(game_id)}"
                  data-source="${escHtml(b.source || 'local')}">Re-verify All</button>
        </div>
      </div>`;
  }).join('');
}

async function runHash(backup_path, game_id, verified = 1, hash_type = 'game') {
  if (hashingInProgress) return;
  hashingInProgress = true;

  // Disable all hash buttons while running
  $('modal-hash-list').querySelectorAll('button').forEach(b => b.disabled = true);

  const prog = $('modal-hash-progress');
  const fill = $('hash-progress-fill');
  fill.style.width = '0%';
  prog.hidden = false;

  try {
    const { hashes } = await window.pork.hashCompute(backup_path, game_id);
    let communityCount = 0;
    for (const h of hashes) {
      const { communityMatch } = await window.pork.hashAdd({
        game_id, file_hash: h.file_hash, file_size: h.file_size, backup_path: h.backup_path, verified, hash_type,
      });
      if (communityMatch) communityCount++;
    }

    prog.hidden = true;
    if (communityCount > 0) {
      setStatus(`${hashes.length} file(s) hashed — ${communityCount} community match(es) ✓`, 'ok');
    } else {
      setStatus(`${hashes.length} file(s) hashed — will appear in the next community update`, 'ok');
    }

    // Re-render the hash section with fresh data
    const backups = await window.pork.listBackups(game_id);
    await renderHashSection(game_id, backups);
  } catch (e) {
    prog.hidden = true;
    setStatus(`Hash failed: ${e.message}`, 'error');
    // Re-enable buttons on error
    $('modal-hash-list').querySelectorAll('button').forEach(b => b.disabled = false);
  } finally {
    hashingInProgress = false;
  }
}

// Hash button delegation — attached once on the hash list container
$('modal-hash-list').addEventListener('click', async e => {
  if (hashingInProgress) return;

  // ── Hash & Add (not yet in DB) ─────────────────────────────────────────────
  const addBtn = e.target.closest('.hash-btn-add');
  if (addBtn) {
    await runHash(addBtn.dataset.path, addBtn.dataset.game, 1, addBtn.dataset.source === 'backpork' ? 'backpork' : 'game');
    return;
  }

  // ── Re-verify (already in DB) — show inline confirm first ─────────────────
  const reverifyBtn = e.target.closest('.hash-btn-reverify');
  if (reverifyBtn) {
    const statusEl = reverifyBtn.closest('.hash-entry-status');
    const path     = reverifyBtn.dataset.path;
    const game     = reverifyBtn.dataset.game;
    const source   = reverifyBtn.dataset.source;

    // Replace button with inline confirm
    reverifyBtn.style.display = 'none';
    const confirm = document.createElement('div');
    confirm.className = 'hash-confirm';
    confirm.innerHTML = `
      <span class="hash-confirm-msg">Game works?</span>
      <button class="btn btn-sm btn-teal hash-confirm-yes">Yes, verify</button>
      <button class="btn btn-sm hash-confirm-no">Cancel</button>`;
    statusEl.appendChild(confirm);

    confirm.querySelector('.hash-confirm-yes').addEventListener('click', async () => {
      confirm.remove();
      await runHash(path, game, 1, source === 'backpork' ? 'backpork' : 'game');
    });
    confirm.querySelector('.hash-confirm-no').addEventListener('click', () => {
      confirm.remove();
      reverifyBtn.style.display = '';
    });
    return;
  }
});

// ── Manage panel ──────────────────────────────────────────────────────────────
let uploadInProgress = false;
let uploadLocalPath  = null;

window.pork.on('ftp:upload:progress', info => {
  const log = $('manage-upload-log');
  if (!log) return;
  // Directory upload shape has filesTotal; single-file shape has bytes/size
  if (info.filesTotal != null) {
    const pct = info.filesTotal > 0 ? Math.round((info.filesDone / info.filesTotal) * 100) : 0;
    log.textContent = `Uploading… File ${info.filesDone}/${info.filesTotal}  (${pct}%)${info.file ? '  ' + info.file : ''}`;
  } else {
    const done  = info.bytes  || 0;
    const total = info.size   || 0;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
    log.textContent = `Uploading… ${pct}%  (${fmt(done)} / ${fmt(total)})`;
  }
});

async function renderManagePanel(g, backups) {
  // ── Backup file list (local only — backpork entries shown in Backpork Versions) ─
  const list    = $('manage-backup-list');
  backups       = backups.filter(b => b.source !== 'backpork');
  $('mtab-manage-count').textContent = backups.length || '';

  if (!backups.length) {
    list.innerHTML = '<div class="prospero-placeholder">No backup files recorded.</div>';
  } else {
    list.innerHTML = backups.map(b => {
      const filename = b.backup_path.replace(/\\/g, '/').split('/').pop();
      return `
        <div class="manage-backup-item" data-backup-id="${b.id}" data-game="${escHtml(g.game_id)}"
             data-local="${escHtml(b.backup_path)}" data-folder="${escHtml(b.backup_path)}">
          <div class="manage-backup-info">
            <span class="manage-filename" title="${escHtml(b.backup_path)}">${escHtml(filename)}</span>
            <span class="manage-size">${fmt(b.size)}</span>
            <span class="pill pill-num">${escHtml(b.backup_type || 'dump')}</span>
          </div>
          <div class="manage-backup-actions">
            <button class="btn btn-sm manage-btn-folder">Open Folder</button>
            <button class="btn btn-sm btn-teal manage-btn-upload">Upload to PS5</button>
            <button class="btn btn-sm btn-danger manage-btn-remove">Remove Record</button>
          </div>
        </div>`;
    }).join('');
  }

  // ── Upload section state ────────────────────────────────────────────────────
  uploadLocalPath = null;
  $('manage-remote-path').value = '';
  $('manage-remote-path').readOnly = true;
  $('btn-manage-upload').disabled = true;
  $('manage-upload-log').hidden = true;

  // ── Backed-up / Installed status buttons ─────────────────────────────────────
  const toggleBackedBtn = $('btn-manage-toggle-backed');
  if (g.backed_up) {
    toggleBackedBtn.textContent = 'Clear Backed Up Status';
    toggleBackedBtn.className   = 'btn btn-danger';
  } else {
    toggleBackedBtn.textContent = 'Mark as Backed Up';
    toggleBackedBtn.className   = 'btn btn-teal';
  }
  const toggleInstBtn = $('btn-manage-toggle-installed');
  if (g.installed) {
    toggleInstBtn.textContent = 'Mark as Not Installed';
    toggleInstBtn.className   = 'btn btn-danger';
  } else {
    toggleInstBtn.textContent = 'Mark as Installed';
    toggleInstBtn.className   = 'btn';
  }

  // ── Install location display ──────────────────────────────────────────────────
  renderManageInstallLocation(g);

  // ── Backpork versions section ────────────────────────────────────────────────
  await renderBackporkSection(g);
}

// ── Manage: install location display ─────────────────────────────────────────

function renderManageInstallLocation(g) {
  const locRow    = $('manage-install-location');
  const noLocRow  = $('manage-no-location');
  const locPath   = $('manage-loc-path');
  const deleteBtn = $('btn-manage-delete-ps5');
  const backupBtn = $('btn-manage-backup-ps5');

  if (g?.ftp_path) {
    locRow.hidden   = false;
    noLocRow.hidden = true;
    locPath.textContent = g.ftp_path;
    deleteBtn.disabled  = !state.connected;
    backupBtn.disabled  = !state.connected;
  } else {
    locRow.hidden   = true;
    noLocRow.hidden = false;
    locPath.textContent = '';
    deleteBtn.disabled  = true;
    backupBtn.disabled  = true;
  }
}

$('btn-manage-forget-loc').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const gameId = state.currentGame.game_id;
  await window.pork.updateGame({ game_id: gameId, fields: { ftp_path: '' } });
  state.currentGame = { ...state.currentGame, ftp_path: '' };
  renderManageInstallLocation(state.currentGame);
  setStatus('PS5 install location forgotten', 'ok');
});

$('btn-manage-backup-ps5').addEventListener('click', async () => {
  if (!state.currentGame || !state.connected) return;
  const { game_id, ftp_path } = state.currentGame;
  if (!ftp_path) { setStatus('No PS5 location stored — run a scan first', 'error'); return; }

  const btn = $('btn-manage-backup-ps5');
  btn.disabled = true;
  try {
    await window.pork.ftpDownloadFolder(game_id);
    setStatus('Backup queued — see Transfers for progress', 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    btn.disabled = !state.connected || !state.currentGame?.ftp_path;
  }
});

$('btn-manage-delete-ps5').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const g = state.currentGame;
  if (!g.ftp_path) { setStatus('No PS5 location stored — cannot delete', 'error'); return; }

  const ok = await showConfirm(
    `Delete "${g.title || g.game_id}" from PS5?\n\nFolder: ${g.ftp_path}\n\nThis cannot be undone.`
  );
  if (!ok) return;

  const btn = $('btn-manage-delete-ps5');
  btn.disabled    = true;
  btn.textContent = 'Deleting…';

  try {
    await window.pork.ftpDeleteGame(g.game_id);
    state.currentGame = { ...g, installed: 0, ftp_path: '' };
    state.games = await window.pork.listGames({});
    renderManageInstallLocation(state.currentGame);
    const toggleInstBtn = $('btn-manage-toggle-installed');
    toggleInstBtn.textContent = 'Mark as Installed';
    toggleInstBtn.className   = 'btn';
    setStatus(`${g.title || g.game_id} deleted from PS5`, 'ok');
  } catch (err) {
    setStatus(`Delete failed: ${err.message}`, 'error');
  } finally {
    btn.textContent = 'Delete from PS5';
    btn.disabled    = !state.connected || !state.currentGame?.ftp_path;
  }
});

// ── Backpork section in Manage tab ────────────────────────────────────────────
let porkInProgress = false;

window.pork.on('backporks:pork:progress', ({ file, filesDone, filesTotal, bytesOverall }) => {
  const fill  = $('pork-progress-fill');
  const label = $('pork-progress-label');
  const pct   = filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0;
  if (fill)  fill.style.width = `${pct}%`;
  if (label) label.textContent = `Uploading ${filesDone + 1}/${filesTotal}: ${escHtml(file || '')}`;
});

async function renderBackporkSection(g) {
  const section   = $('manage-backpork-section');
  const entries   = await window.pork.backporksEntries(g.game_id);

  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;

  // Porked-to status
  const statusEl = $('manage-porked-status');
  if (g.porked_firmware) {
    const when = g.porked_at ? `  ·  ${new Date(g.porked_at).toLocaleDateString()}` : '';
    statusEl.innerHTML = `
      <div class="manage-porked-status">
        ✓ Porked to firmware <strong>${escHtml(g.porked_firmware)}</strong>${escHtml(when)}
        <button class="clear-pork btn btn-sm" data-game="${escHtml(g.game_id)}">Clear</button>
      </div>`;
  } else {
    statusEl.innerHTML = '';
  }

  // Entry list
  const listEl = $('manage-backpork-list');
  listEl.innerHTML = entries.map(e => {
    const gamePath    = e.game_path || e.folder_path;
    const displayPath = gamePath.replace(/\\/g, '/').split('/').pop();
    return `
    <div class="manage-backpork-entry"
         data-fw="${escHtml(e.folder_name)}"
         data-path="${escHtml(e.folder_path)}"
         data-game="${escHtml(g.game_id)}">
      <span class="manage-backpork-fw">${escHtml(e.folder_name)}</span>
      <span class="manage-backpork-path" title="${escHtml(gamePath)}">${escHtml(displayPath)}</span>
      <button class="btn btn-sm manage-btn-view-backpork"
              data-open="${escHtml(gamePath)}">View Backpork</button>
      <button class="btn btn-sm btn-teal pork-btn"
              ${!state.connected ? 'disabled title="Connect to PS5 first"' : ''}>
        Pork to PS5
      </button>
    </div>`;
  }).join('');

  // Reset progress bar
  $('manage-pork-progress').hidden = true;
  $('pork-progress-fill').style.width = '0%';
}

// Clear porked status
$('manage-porked-status').addEventListener('click', async e => {
  const btn = e.target.closest('.clear-pork');
  if (!btn) return;
  const gameId = btn.dataset.game;
  await window.pork.updateGame({ game_id: gameId, fields: { porked_firmware: null, porked_at: null } });
  state.games = await window.pork.listGames({});
  const updated = state.games.find(x => x.game_id === gameId) || state.currentGame;
  state.currentGame = { ...state.currentGame, porked_firmware: null, porked_at: null };
  await renderBackporkSection(state.currentGame);
  setStatus('Porked status cleared', 'ok');
});

// Backpork list click delegation
$('manage-backpork-list').addEventListener('click', async e => {
  // ── View Backpork folder ─────────────────────────────────────────────────────
  const viewBtn = e.target.closest('.manage-btn-view-backpork');
  if (viewBtn) {
    window.pork.openShell(viewBtn.dataset.open);
    return;
  }

  // Pork to PS5
  const btn = e.target.closest('.pork-btn');
  if (!btn || porkInProgress) return;
  const entry = btn.closest('.manage-backpork-entry');
  if (!entry) return;

  const gameId     = entry.dataset.game;
  const folderName = entry.dataset.fw;
  const folderPath = entry.dataset.path;

  // Ensure a destination is remembered before porking
  const ftpDest = await ensureGameFtpPath(gameId);
  if (!ftpDest) return; // user cancelled picker

  porkInProgress = true;
  btn.disabled   = true;
  $('manage-pork-progress').hidden = false;
  $('pork-progress-fill').style.width = '0%';
  $('pork-progress-label').textContent = 'Starting…';
  setStatus(`Porking ${gameId} (${folderName})…`);

  try {
    const { remotePath } = await window.pork.backporksPork(gameId, folderName, folderPath);
    $('manage-pork-progress').hidden = true;
    setStatus(`Porked to PS5 at ${remotePath}`, 'ok');

    // Refresh game state
    state.games = await window.pork.listGames({});
    const updated = state.games.find(x => x.game_id === gameId);
    if (updated) {
      state.currentGame = updated;
      await renderBackporkSection(updated);
      // Update installed toggle
      const toggleInstBtn = $('btn-manage-toggle-installed');
      toggleInstBtn.textContent = 'Mark as Not Installed';
      toggleInstBtn.className   = 'btn btn-danger';
    }
  } catch (err) {
    $('manage-pork-progress').hidden = true;
    setStatus(`Pork failed: ${err.message}`, 'error');
  } finally {
    porkInProgress = false;
    btn.disabled   = false;
  }
});

// Toggle installed status
$('btn-manage-toggle-installed').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const g      = state.currentGame;
  const newVal = g.installed ? 0 : 1;
  await window.pork.updateGame({ game_id: g.game_id, fields: { installed: newVal } });
  state.currentGame = { ...g, installed: newVal };
  const toggleInstBtn = $('btn-manage-toggle-installed');
  toggleInstBtn.textContent = newVal ? 'Mark as Not Installed' : 'Mark as Installed';
  toggleInstBtn.className   = newVal ? 'btn btn-danger' : 'btn';
  setStatus(newVal ? 'Marked as installed' : 'Marked as not installed', 'ok');
});

// ── Delegation for all manage-panel interactions (attached once, never re-bound)
$('manage-backup-list').addEventListener('click', async e => {
  const item = e.target.closest('.manage-backup-item');
  if (!item) return;

  const backupId = Number(item.dataset.backupId);
  const gameId   = item.dataset.game;
  const local    = item.dataset.local;
  const folder   = item.dataset.folder;

  // ── Open Folder ─────────────────────────────────────────────────────────────
  if (e.target.closest('.manage-btn-folder')) {
    window.pork.openShell(folder);
    return;
  }

  // ── Upload to PS5 — inline expand ───────────────────────────────────────────
  if (e.target.closest('.manage-btn-upload')) {
    if (uploadInProgress) return;

    // Resolve destination (prompts if multiple locations configured and none stored)
    const baseFtp = await ensureGameFtpPath(gameId);
    if (!baseFtp) return; // user cancelled picker

    uploadLocalPath = local;
    const filename   = local.replace(/\\/g, '/').split('/').pop();
    const remotePath = baseFtp.replace(/\/?$/, '/') + filename;

    const inp = $('manage-remote-path');
    inp.value    = remotePath;
    inp.readOnly = false;
    inp.focus();
    $('btn-manage-upload').disabled = !state.connected;

    // Highlight selected item
    document.querySelectorAll('.manage-backup-item').forEach(el =>
      el.classList.toggle('manage-item-selected', el === item)
    );
    return;
  }

  // ── Remove backup record ─────────────────────────────────────────────────────
  if (e.target.closest('.manage-btn-remove')) {
    const btn = e.target.closest('.manage-btn-remove');
    btn.disabled = true;
    try {
      await window.pork.deleteBackup(backupId);
      setStatus('Backup record removed', 'ok');

      // Refresh the modal's backup-dependent sections
      const backups      = await window.pork.listBackups(gameId);
      const localBackups = backups.filter(b => b.source !== 'backpork');
      state.games   = await window.pork.listGames({});
      const g       = state.games.find(x => x.game_id === gameId) || state.currentGame;
      state.currentGame = g;

      await renderManagePanel(g, backups);
      await renderHashSection(gameId, backups);
      $('modal-backup-list').innerHTML = localBackups.length
        ? localBackups.map(b => `<li><span>${escHtml(b.backup_path)}</span><span>${fmt(b.size)}</span></li>`).join('')
        : '<li style="justify-content:center">No backups recorded</li>';
    } catch (err) {
      setStatus(err.message, 'error');
      btn.disabled = false;
    }
    return;
  }
});

$('btn-manage-upload').addEventListener('click', async () => {
  if (uploadInProgress || !uploadLocalPath) return;
  const remotePath = $('manage-remote-path').value.trim();
  if (!remotePath) { setStatus('Enter a remote path on the PS5', 'error'); return; }

  uploadInProgress = true;
  $('btn-manage-upload').disabled = true;
  const log = $('manage-upload-log');
  log.hidden    = false;
  log.textContent = 'Starting upload…';

  try {
    await window.pork.ftpUpload({ localPath: uploadLocalPath, remotePath });
    log.textContent = 'Upload complete ✓';
    setStatus('Uploaded to PS5 successfully', 'ok');
    uploadLocalPath = null;
    $('manage-remote-path').value    = '';
    $('manage-remote-path').readOnly = true;
    document.querySelectorAll('.manage-item-selected').forEach(el => el.classList.remove('manage-item-selected'));
  } catch (e) {
    log.textContent = `Upload failed: ${e.message}`;
    setStatus(e.message, 'error');
    $('btn-manage-upload').disabled = false;
  } finally {
    uploadInProgress = false;
  }
});

$('btn-manage-toggle-backed').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const g = state.currentGame;
  const newVal = g.backed_up ? 0 : 1;
  await window.pork.updateGame({ game_id: g.game_id, fields: { backed_up: newVal } });
  state.currentGame = { ...g, backed_up: newVal };
  const backups = await window.pork.listBackups(g.game_id);
  await renderManagePanel(state.currentGame, backups);
  setStatus(newVal ? 'Marked as backed up' : 'Backed up status cleared', 'ok');
});

$('btn-manage-refresh-meta').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const { game_id } = state.currentGame;
  $('btn-manage-refresh-meta').disabled = true;
  setStatus('Refreshing metadata…');
  try {
    await window.pork.prosperoFetch(game_id);
    setStatus('Metadata refreshed', 'ok');
  } catch (e) {
    setStatus(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('btn-manage-refresh-meta').disabled = false;
  }
});

// ── Modal tab switching ────────────────────────────────────────────────────────
document.querySelectorAll('.modal-tab').forEach(tab =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.modal-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`mpanel-${tab.dataset.mtab}`).classList.add('active');
  })
);

function resetModalTabs() {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.modal-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.modal-tab[data-mtab="info"]').classList.add('active');
  $('mpanel-info').classList.add('active');
}

// ── Prospero render helpers ───────────────────────────────────────────────────
function renderProsperoData(g) {
  const hasProspero = !!g.prospero_fetched_at;

  // ── Banner (cover art background) ───────────────────────────────────────────
  const banner = $('modal-banner');
  if (hasProspero && g.prospero_banner_url) {
    const img = new Image();
    img.onload  = () => { banner.style.backgroundImage = `url('${g.prospero_banner_url}')`; };
    img.onerror = () => { banner.style.backgroundImage = ''; };
    img.src = g.prospero_banner_url;
  } else {
    banner.style.backgroundImage = '';
  }

  // ── Icon ────────────────────────────────────────────────────────────────────
  const icon = $('modal-icon');
  icon.onerror = () => { icon.hidden = true; };
  if (hasProspero && g.prospero_icon_url) {
    icon.src    = g.prospero_icon_url;
    icon.hidden = false;
  } else {
    icon.hidden = true;
    icon.src    = '';
  }

  // ── Tab badges ──────────────────────────────────────────────────────────────
  const patchCount   = hasProspero ? (g.prospero_patch_count || 0) : 0;
  const dlcArr       = hasProspero ? tryParseJson(g.prospero_dlc, []) : [];
  const regionArr    = hasProspero ? tryParseJson(g.prospero_other_regions, []) : [];
  $('mtab-patch-count').textContent   = patchCount  || '';
  $('mtab-dlc-count').textContent     = dlcArr.length   || '';
  $('mtab-regions-count').textContent = regionArr.length || '';

  if (!hasProspero) {
    $('modal-patches-content').innerHTML = '<div class="prospero-placeholder">Fetching patch data…</div>';
    $('modal-dlc-content').innerHTML     = '<div class="prospero-placeholder">Fetching DLC data…</div>';
    $('modal-regions-content').innerHTML = '<div class="prospero-placeholder">Fetching region data…</div>';
    return;
  }

  // Description is always the generic ProsperoPatches template — never useful, keep hidden.
  $('modal-description').hidden = true;

  // ── Patches ─────────────────────────────────────────────────────────────────
  const patches = tryParseJson(g.prospero_patches, []);
  if (patches.length) {
    $('modal-patches-content').innerHTML = `
      <ul class="patch-list">
        ${patches.map(p => `
          <li class="patch-item${p.isLatest ? ' patch-item-latest' : ''}">
            <div class="patch-header">
              <span class="patch-ver">v${escHtml(p.contentVer || '?')}</span>
              ${p.isLatest ? '<span class="patch-latest">LATEST</span>' : ''}
              <span class="patch-meta">
                <span title="File size">${escHtml(p.filesize || '—')}</span>
                <span title="Required firmware">FW ${escHtml(p.requiredFirmware || '?')}</span>
                <span title="Import date">${escHtml(p.importDate || '')}</span>
              </span>
            </div>
            ${p.changelogPreview ? `<div class="patch-changelog">${escHtml(p.changelogPreview)}</div>` : ''}
          </li>`).join('')}
      </ul>`;
  } else {
    $('modal-patches-content').innerHTML = '<div class="prospero-placeholder">No patch updates found</div>';
  }

  // ── DLC ──────────────────────────────────────────────────────────────────────
  const dlc = dlcArr;
  if (dlc.length) {
    $('modal-dlc-content').innerHTML = `
      <ul class="dlc-list">
        ${dlc.map(d => `
          <li class="dlc-item">
            ${d.iconUrl ? `<img class="dlc-icon" src="${escHtml(d.iconUrl)}" alt="" onerror="this.style.display='none'"/>` : '<div class="dlc-icon"></div>'}
            <div>
              <div class="dlc-name">${escHtml(d.name || d.contentid || '—')}</div>
              <div class="dlc-meta">
                ${d.contentVer ? `v${escHtml(d.contentVer)}` : ''}
                ${d.filesize   ? ` · ${escHtml(d.filesize)}` : ''}
                ${d.requiredFirmware ? ` · FW ${escHtml(d.requiredFirmware)}` : ''}
              </div>
            </div>
          </li>`).join('')}
      </ul>`;
  } else {
    $('modal-dlc-content').innerHTML = '<div class="prospero-placeholder">No additional content</div>';
  }

  // ── Regions (mark ones we own) ───────────────────────────────────────────────
  const regions = regionArr;
  if (regions.length) {
    $('modal-regions-content').innerHTML = `
      <div class="region-pills">
        ${regions.map(r => {
          const isOwned = r.titleid === g.game_id;
          return `
            <button class="region-pill${isOwned ? ' owned' : ''}" data-tid="${escHtml(r.titleid)}">
              <code>${escHtml(r.titleid)}</code>
              <span>${escHtml(r.region || '')}</span>
            </button>`;
        }).join('')}
      </div>`;
    $('modal-regions-content').querySelector('.region-pills')?.addEventListener('click', e => {
      const pill = e.target.closest('[data-tid]');
      if (pill) openModal(pill.dataset.tid);
    });
  } else {
    $('modal-regions-content').innerHTML = '<div class="prospero-placeholder">No other regions found</div>';
  }
}

function tryParseJson(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch (_) { return fallback; }
}

// ── Conversion Queue Panel ────────────────────────────────────────────────────

// ── Conv job live-patch cache ───────────────────────────────────────────────────────
const convJobsCache = new Map();

// Update a single conv-job-row in-place without an IPC roundtrip or full re-render.
// Called directly from the conv:job-update event (which already carries the full job).
function patchConvJobCard(job) {
  convJobsCache.set(job.id, job);
  const card = document.querySelector(`.conv-job-row[data-conv-id="${job.id}"]`);
  // New card or status change → do a full panel refresh (handles transitions + new jobs)
  if (!card || card.dataset.convStatus !== job.status) {
    refreshConvQueuePanel().catch(() => {});
    return;
  }
  // Incremental patch: progress bar, phase text, log box
  const pct = job.progress?.percent ?? 0;
  const bar = card.querySelector('.conv-job-bar');
  if (bar) bar.style.width = `${pct}%`;

  const phaseEl = card.querySelector('.conv-job-phase');
  if (phaseEl) phaseEl.textContent = job.progress?.phase || job.status;

  const log     = (job.progress?.log ?? []).join('\n');
  const showLog = (job.status === 'running' || job.status === 'error') && log;
  let lb = card.querySelector('.conv-log-box');
  if (showLog) {
    if (!lb) {
      lb = document.createElement('pre');
      lb.className      = 'conv-log-box';
      lb.dataset.logLen = '0';
      card.appendChild(lb);
    }
    if (lb.dataset.logLen !== String(job.progress?.log?.length)) {
      lb.textContent    = log;
      lb.scrollTop      = lb.scrollHeight;
      lb.dataset.logLen = String(job.progress?.log?.length ?? 0);
    }
  }
}

async function refreshConvQueuePanel() {
  try {
    const jobs   = await window.pork.convQueueList();
    const paused = await window.pork.convQueueIsPaused();
    const s      = await window.pork.getSettings();
    const panel  = $('conv-queue-panel');
    if (!panel) return;
    panel.hidden = false;

    const mode = s.gameConversionMode || 'pfs';

    // ── Mode switcher button states ──────────────────────────────────────────
    document.querySelectorAll('.conv-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.convMode === mode);
    });

    // ── Not-configured warning ───────────────────────────────────────────────
    const warnEl  = $('conv-mode-warn');
    const warnTxt = $('conv-mode-warn-text');
    let warnMsg = '';
    if (mode === 'ffpkg' && !s.ufs2ToolPath) {
      warnMsg = 'FFPKG mode requires UFS2Tool.exe — set the path in Game Conversion settings.';
    } else if (mode === 'exfat' && !s.exfatToolPath) {
      warnMsg = 'ExFAT mode requires make_image.bat — set the ExFAT tool folder in Game Conversion settings.';
    }
    if (warnEl) {
      warnEl.hidden = !warnMsg;
      if (warnTxt) warnTxt.textContent = warnMsg;
    }

    // ── Not-admin warning (inline, always visible when applicable) ───────────
    const adminWarnEl = $('conv-admin-warn');
    if (adminWarnEl) {
      if (mode === 'ffpkg' || mode === 'exfat') {
        let isElevated = false;
        try { isElevated = await window.pork.isAdmin(); } catch (_) {}
        adminWarnEl.hidden = isElevated;
      } else {
        adminWarnEl.hidden = true;
      }
    }

    const listEl  = $('conv-queue-list');
    const emptyEl = $('conv-queue-empty');
    if (listEl) {
      listEl.innerHTML = jobs.map(j => renderConvJobRowHtml(j)).join('');
      // Seed live-patch cache and scroll all log boxes to bottom so errors are visible
      jobs.forEach(j => convJobsCache.set(j.id, j));
      listEl.querySelectorAll('.conv-log-box').forEach(lb => { lb.scrollTop = lb.scrollHeight; });
    }
    if (emptyEl) emptyEl.hidden   = jobs.length > 0;

    const startBtn = $('btn-conv-start');
    if (startBtn) {
      const hasQueued = jobs.some(j => j.status === 'queued');
      startBtn.disabled    = !paused || !hasQueued;
      startBtn.textContent = paused ? '▶ Start Queue' : '⏸ Running…';
    }
  } catch (_) {}
}

// Mode switcher buttons in the queue panel
$('conv-queue-panel').addEventListener('click', async e => {
  const modeBtn = e.target.closest('.conv-mode-btn');
  if (modeBtn) {
    const mode = modeBtn.dataset.convMode;
    await window.pork.setSettings({ gameConversionMode: mode });
    // Sync the Settings page radio if it exists
    const radio = document.querySelector(`#conv-mode-${mode}`);
    if (radio) radio.checked = true;
    applyConvModeUI(mode);
    await refreshConvQueuePanel();
    return;
  }
  if (e.target.closest('#btn-conv-goto-settings')) {
    navigate('settings');
    // Scroll the conversion card into view after a brief paint delay
    setTimeout(() => {
      const card = $('settings-conversion-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }
});

function renderConvJobRowHtml(job) {
  const pct      = job.progress?.percent ?? 0;
  const phase    = escHtml(job.progress?.phase || job.status);
  const log      = (job.progress?.log ?? []).join('\n');
  const showLog  = (job.status === 'running' || job.status === 'error') && log;
  const barClass = job.status === 'done'    ? 'conv-bar-done'
                 : job.status === 'error'   ? 'conv-bar-error'
                 : job.status === 'running' ? 'conv-bar-running'
                 : '';
  const cancelBtn = (job.status === 'queued' || job.status === 'running')
    ? `<button class="btn btn-sm btn-danger" data-conv-cancel="${job.id}" style="padding:2px 6px;font-size:10px">✕</button>`
    : '';
  const retryBtn = (job.status === 'error' || job.status === 'cancelled')
    ? `<button class="btn btn-sm" data-conv-retry="${job.id}" style="padding:2px 6px;font-size:10px">↺</button>`
    : '';
  return `<div class="conv-job-row" data-conv-id="${job.id}" data-conv-status="${escHtml(job.status)}">
    <div class="conv-job-summary">
      <span class="conv-job-id">#${job.id}</span>
      <span class="conv-job-game" title="${escHtml(job.game_id)}">${escHtml(job.game_name || job.game_id)}</span>
      <span class="conv-job-mode">${escHtml((job.mode || '').toUpperCase())}</span>
      <span class="conv-job-phase">${phase}</span>
      <div class="conv-job-bar-wrap"><div class="conv-job-bar ${barClass}" style="width:${pct}%"></div></div>
      <span class="conv-job-status conv-status-${job.status}">${escHtml(job.status)}</span>
      <div class="conv-job-actions">${cancelBtn}${retryBtn}</div>
    </div>
    ${showLog ? `<pre class="conv-log-box" data-log-len="${(job.progress?.log?.length ?? 0)}">${escHtml(log)}</pre>` : ''}
    ${job.error ? `<div class="conv-job-error">✗ ${escHtml(job.error)}</div>` : ''}
  </div>`;
}

// ── Admin-warning modal helpers ─────────────────────────────────────────────
function showAdminWarning() {
  $('admin-warn-overlay').hidden = false;
}
$('admin-warn-close').addEventListener('click', () => {
  $('admin-warn-overlay').hidden = true;
});
$('admin-warn-overlay').addEventListener('click', (e) => {
  if (e.target === $('admin-warn-overlay')) $('admin-warn-overlay').hidden = true;
});

// Returns true if safe to proceed, false if user should be blocked (not-admin + needs elevation)
async function guardAdminForConv() {
  const s    = await window.pork.getSettings();
  const mode = s.gameConversionMode || 'pfs';
  if (mode === 'pfs') return true; // Raw Dumps is a plain FTP upload, no elevation needed
  let ok = false;
  try {
    ok = await window.pork.isAdmin();
  } catch (_) {
    // isAdmin call failed — treat as not-admin (fail-secure)
    ok = false;
  }
  if (!ok) { showAdminWarning(); return false; }
  return true;
}

$('btn-conv-start').addEventListener('click', async () => {
  if (!await guardAdminForConv()) return;
  await window.pork.convQueueStart();
  await refreshConvQueuePanel();
});

$('btn-conv-clear-done').addEventListener('click', async () => {
  await window.pork.convQueueClearDone();
  await refreshConvQueuePanel();
});

$('btn-conv-cleanup-temp').addEventListener('click', async () => {
  const btn = $('btn-conv-cleanup-temp');
  btn.disabled = true;
  btn.textContent = '\u{1F9F9} Cleaning\u2026';
  try {
    const res = await window.pork.convQueueCleanupTemp();
    const parts = [];
    if (res.deletedDirs)  parts.push(`${res.deletedDirs} temp folder${res.deletedDirs  > 1 ? 's' : ''}`);
    if (res.deletedFiles) parts.push(`${res.deletedFiles} partial file${res.deletedFiles > 1 ? 's' : ''}`);
    btn.textContent = parts.length ? `\u2713 Removed ${parts.join(' + ')}` : '\u2713 Nothing to clean';
    if (res.errors?.length) console.warn('[CleanTemp]', res.errors);
  } catch (e) {
    btn.textContent = '\u2717 Cleanup failed';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '\u{1F9F9} Clean Temp'; }, 3000);
});

$('btn-conv-queue-toggle').addEventListener('click', () => {
  const body = $('conv-queue-body');
  const collapsed = body.hidden;
  body.hidden = !collapsed;
  $('btn-conv-queue-toggle').textContent = collapsed ? '↑' : '↓';
});

$('conv-queue-list').addEventListener('click', async e => {
  const cancelBtn = e.target.closest('[data-conv-cancel]');
  if (cancelBtn) {
    await window.pork.convQueueCancel(Number(cancelBtn.dataset.convCancel));
    await refreshConvQueuePanel();
    return;
  }
  const retryBtn = e.target.closest('[data-conv-retry]');
  if (retryBtn) {
    await window.pork.convQueueRetry(Number(retryBtn.dataset.convRetry));
    await refreshConvQueuePanel();
  }
});

// ── Install-to-PS5 modal ───────────────────────────────────────────────────────

let _installBackporkEntries = [];

async function openInstallModal(game_id, startMode) {
  const games = await window.pork.listGames({});
  const g = games.find(x => x.game_id === game_id);
  if (!g) return;

  $('install-modal-game-label').textContent = g.prospero_name || g.title || game_id;
  $('install-overlay').dataset.gameId   = game_id;
  $('install-overlay').dataset.gameName = g.prospero_name || g.title || game_id;

  // Pick the local game backup (source='local'), not a backpork patch
  const backups     = await window.pork.listBackups(game_id);
  const localBackup = backups.find(b => b.source === 'local' && b.backup_type === 'folder')
                   ?? backups.find(b => b.source === 'local')
                   ?? backups[0];
  const latest = localBackup;
  $('install-overlay').dataset.backupPath = latest?.backup_path || '';

  // ── PFS section ─────────────────────────────────────────────────────────────
  const hintEl = $('install-backup-hint');
  if (hintEl) {
    if (latest) {
      hintEl.textContent = `Source: ${latest.backup_path}`;
      hintEl.title       = latest.backup_path;
    } else {
      hintEl.textContent = 'No local backup found — use Browse folder to select one';
      hintEl.title       = '';
    }
  }

  // Resolve FTP path
  let ftpPath = g.ftp_path || '';
  const noPathsConfigured = remoteGamePaths.length === 0;
  if (!ftpPath && !noPathsConfigured) {
    const base = remoteGamePaths[0].path.replace(/\/?$/, '/');
    ftpPath = base + game_id + '-app';
  }
  const ftpPathEl = $('install-ftp-path');
  if (ftpPathEl) ftpPathEl.value = ftpPath;
  const warn = $('install-no-path-warn');
  if (warn) warn.hidden = !!ftpPath;

  // Backpork selector — PFS section
  const entries = await window.pork.backporksEntries(game_id);
  _installBackporkEntries = entries;
  const bpSel = $('install-backpork-select');
  if (bpSel) {
    bpSel.innerHTML = '<option value="">None</option>' +
      entries.map((e, i) => `<option value="${i}">${escHtml(e.folder_name)}</option>`).join('');
  }

  // ── Conv section (FFPKG / ExFAT) ────────────────────────────────────────────
  const convHintEl = $('install-conv-backup-hint');
  if (convHintEl) {
    if (latest) {
      convHintEl.textContent = `Source: ${latest.backup_path}`;
      convHintEl.title       = latest.backup_path;
    } else {
      convHintEl.textContent = 'No local backup found — use Browse folder to select one';
      convHintEl.title       = '';
    }
  }

  // Backpork selector — Conv section
  // Only show firmware entries where game_path is known (i.e. the game has a patch in that folder).
  // The option value is the ORIGINAL index into _installBackporkEntries so the lookup in the
  // confirm handler still works regardless of how many entries are filtered out.
  const convBpSel = $('install-conv-backpork-select');
  if (convBpSel) {
    convBpSel.innerHTML = '<option value="">None</option>' +
      entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !!e.game_path)          // skip firmware folders with no patch for this game
        .map(({ e, i }) => `<option value="${i}">${escHtml(e.folder_name)}</option>`)
        .join('');
  }

  // Pre-fill conv FTP path: use the parent directory of the game FTP path so
  // the converted file (e.g. PPSA03644.exfat) lands next to the game folders.
  // main.js will append the output filename automatically.
  const convFtpPathEl = $('install-conv-ftp-path');
  if (convFtpPathEl) {
    let convDir = '';
    if (g.ftp_path) {
      // Parent of the existing game folder path, with trailing slash
      convDir = g.ftp_path.replace(/\/[^\/]+\/?$/, '') || '/';
      if (!convDir.endsWith('/')) convDir += '/';
    } else if (!noPathsConfigured) {
      convDir = remoteGamePaths[0].path.replace(/\/?$/, '/');
    }
    convFtpPathEl.value = convDir;
  }

  // Pre-fill conv FTP upload / delete-after from settings
  const s = await window.pork.getSettings();
  const convFtpUploadEl = $('install-conv-ftp-upload');
  if (convFtpUploadEl) {
    convFtpUploadEl.checked = !!s.convFtpUpload;
    const convFtpFields = $('install-conv-ftp-fields');
    if (convFtpFields) convFtpFields.style.display = convFtpUploadEl.checked ? 'block' : 'none';
  }
  const convDelEl = $('install-conv-delete-after');
  if (convDelEl) convDelEl.checked = !!s.convDeleteAfter;

  // Tool warning for conv section
  const convToolWarn = $('install-conv-tool-warn');
  if (convToolWarn) {
    const currentMode = s.gameConversionMode || 'pfs';
    if (currentMode === 'ffpkg') {
      const info = s.ufs2ToolPath ? await window.pork.convToolInfo().catch(() => null) : null;
      convToolWarn.hidden = !!info?.toolAvailable;
    } else if (currentMode === 'exfat') {
      const info = s.exfatToolPath ? await window.pork.convExfatToolInfo().catch(() => null) : null;
      convToolWarn.hidden = !!info?.toolAvailable;
    } else {
      convToolWarn.hidden = true;
    }
  }

  // ── Activate the correct mode tab ────────────────────────────────────────────
  const currentMode = s.gameConversionMode || 'pfs';
  _applyInstallModeTab(currentMode);

  updateInstallConfirmState(currentMode, latest, ftpPath);
  $('install-overlay').hidden = false;
}

function _applyInstallModeTab(mode) {
  document.querySelectorAll('.install-mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.installMode === mode)
  );
  const pfsSec  = $('install-pfs-section');
  const convSec = $('install-conv-section');
  if (pfsSec)  pfsSec.hidden  = mode !== 'pfs';
  if (convSec) convSec.hidden = mode === 'pfs';
}

function updateInstallConfirmState(mode, latest, ftpPath) {
  const confirmBtn = $('btn-install-confirm');
  if (!confirmBtn) return;
  if (mode === 'pfs') {
    const backupPath = $('install-overlay').dataset.backupPath;
    const fp         = ftpPath !== undefined ? ftpPath : ($('install-ftp-path')?.value?.trim() || '');
    confirmBtn.disabled = !backupPath || !state.connected || !fp;
  } else {
    // For FFPKG/ExFAT: just need a backup path (FTP upload is optional)
    const backupPath = $('install-overlay').dataset.backupPath;
    confirmBtn.disabled = !backupPath;
  }
}

// Mode tab click delegation on install overlay
$('install-overlay').addEventListener('click', e => {
  const tab = e.target.closest('.install-mode-tab');
  if (!tab) return;
  const mode = tab.dataset.installMode;
  _applyInstallModeTab(mode);
  updateInstallConfirmState(mode);
});

$('btn-install-browse-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('install-overlay').dataset.backupPath = folder;
  $('install-backup-hint').textContent = `Source: ${folder}`;
  $('install-backup-hint').title = folder;
  // Also sync conv backup hint
  const convHint = $('install-conv-backup-hint');
  if (convHint) { convHint.textContent = `Source: ${folder}`; convHint.title = folder; }
  const ftpPath = $('install-ftp-path').value.trim();
  $('btn-install-confirm').disabled = !ftpPath || !state.connected;
  // Persist the manually-chosen path so it survives modal close/reopen
  const gameId = $('install-overlay').dataset.gameId;
  if (gameId) window.pork.addBackup(gameId, folder).catch(() => {});
});

$('btn-install-browse-ftp').addEventListener('click', async () => {
  const current = $('install-ftp-path').value.replace('(searching PS5…)', '') || '/';
  const selected = await openFtpBrowser(current);
  if (selected) $('install-ftp-path').value = selected;
});

$('btn-install-confirm').addEventListener('click', async () => {
  const game_id    = $('install-overlay').dataset.gameId;
  const backupPath = $('install-overlay').dataset.backupPath;

  // Determine active mode from tab selection
  const activeTab = document.querySelector('.install-mode-tab.active');
  const mode = activeTab?.dataset.installMode || 'pfs';

  if (!backupPath) { setStatus('No local backup found for this game', 'error'); return; }

  $('btn-install-confirm').disabled = true;
  $('btn-install-confirm').textContent = 'Queueing…';

  try {
    if (mode === 'pfs') {
      // ── PFS mode: existing behavior ─────────────────────────────────────────
      const ftpPath = $('install-ftp-path').value.trim();
      if (!ftpPath)        { setStatus('No PS5 path — configure Remote Game Paths in Settings first', 'error'); return; }
      if (!state.connected){ setStatus('Connect to PS5 first', 'error'); return; }

      const bpIdx = $('install-backpork-select').value;
      let pork = null;
      if (bpIdx !== '') {
        const bp = _installBackporkEntries[Number(bpIdx)];
        if (bp) pork = { folder_name: bp.folder_name, folder_path: bp.folder_path };
      }

      await window.pork.ftpInstallPfs({ game_id, localPath: backupPath, remotePath: ftpPath, pork });
      await window.pork.updateGame({ game_id, fields: { ftp_path: ftpPath, installed: 1 } });

      setStatus('Install queued — see Transfers tab for progress', 'ok');

    } else {
      // ── FFPKG / ExFAT mode ──────────────────────────────────────────────────
      const ftpUploadCb = $('install-conv-ftp-upload');
      const ftpUpload   = ftpUploadCb?.checked ?? false;
      const ftpPath     = ftpUpload ? ($('install-conv-ftp-path')?.value?.trim() || '') : '';
      const deleteAfter = ftpUpload && ($('install-conv-delete-after')?.checked ?? false);

      const bpIdx = $('install-conv-backpork-select')?.value ?? '';
      let backpork_path = '';
      let firmware_label = '';
      if (bpIdx !== '') {
        const bp = _installBackporkEntries[Number(bpIdx)];
        // Use bp.game_path (the game-specific patch subfolder, e.g. G:\Backporks\11.50.0\PPSA21837-app0)
        // NOT bp.folder_path (the firmware folder G:\Backporks\11.50.0 which contains ALL games' patches).
        // Using folder_path would copy every game's patch into workerDir and produce a corrupt image.
        if (bp && bp.game_path) { backpork_path = bp.game_path; firmware_label = bp.folder_name; }
      }

      const game_name = $('install-overlay').dataset.gameName || game_id;
      await window.pork.convQueueAdd({
        game_id,
        game_name,
        game_path:      backupPath,
        backpork_path,
        firmware_label,
        mode,
        ftpUpload,
        ftpRemotePath:  ftpPath,
        deleteAfter,
      });

      await refreshConvQueuePanel();
      setStatus(`${mode.toUpperCase()} conversion queued — see Conversion Queue on Games page`, 'ok');
    }
  } catch (e) {
    setStatus('Queue failed: ' + e.message, 'error');
  } finally {
    $('install-overlay').hidden = true;
    $('btn-install-confirm').disabled = false;
    $('btn-install-confirm').textContent = '⬆ Queue Install';
  }
});

['install-close', 'btn-install-cancel'].forEach(id =>
  $(id).addEventListener('click', () => { $('install-overlay').hidden = true; })
);

$('install-conv-ftp-upload').addEventListener('change', function () {
  const fields = $('install-conv-ftp-fields');
  if (fields) fields.style.display = this.checked ? 'block' : 'none';
});

$('btn-install-conv-browse-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('install-overlay').dataset.backupPath = folder;
  // Sync both backup hints
  const hint     = $('install-backup-hint');
  const convHint = $('install-conv-backup-hint');
  if (hint)     { hint.textContent     = `Source: ${folder}`; hint.title     = folder; }
  if (convHint) { convHint.textContent = `Source: ${folder}`; convHint.title = folder; }
  updateInstallConfirmState(document.querySelector('.install-mode-tab.active')?.dataset.installMode || 'pfs');
  // Persist the manually-chosen path so it survives modal close/reopen
  const gameId = $('install-overlay').dataset.gameId;
  if (gameId) window.pork.addBackup(gameId, folder).catch(() => {});
});

$('btn-install-conv-browse-ftp').addEventListener('click', async () => {
  const current = $('install-conv-ftp-path')?.value?.replace('(searching PS5…)', '') || '/';
  const selected = await openFtpBrowser(current);
  if (selected && $('install-conv-ftp-path')) $('install-conv-ftp-path').value = selected;
});

// ── Modal ─────────────────────────────────────────────────────────────────────
async function openModal(game_id) {
  try {
    const games = await window.pork.listGames({});
    const g = games.find(x => x.game_id === game_id);
    if (!g) return;
    state.currentGame = g;

    resetModalTabs();

    // Header
    const displayName = g.prospero_name || g.title || g.game_id;
    $('modal-title').textContent    = displayName;
    $('modal-subtitle').textContent = `${g.game_id}  ·  ${g.prospero_region || g.version ? (g.prospero_region || '') + (g.version ? '  v' + g.version : '') : 'version unknown'}`;

    // Info table — local + prospero metadata
    const patches      = tryParseJson(g.prospero_patches, []);
    const fwVersions   = [...new Set(patches.map(p => p.requiredFirmware).filter(Boolean))];
    const fwDisplay    = fwVersions.length ? fwVersions.join(', ') : '—';
    const dlc          = tryParseJson(g.prospero_dlc, []);
    const infoRows = [
      ['Game ID',              g.game_id],
      ['Content ID',           g.content_id || g.prospero_content_id || '—'],
      ['Version',              g.version || g.prospero_version || '—'],
      ['Size',                 g.backup_size ? fmt(g.backup_size) : (g.size ? fmt(g.size) : (g.prospero_size || '—'))],
      ['Installed',            g.installed  ? 'Yes' : 'No'],
      ['Backed Up',            g.backed_up  ? 'Yes' : 'No'],
      ['Porked To',            g.porked_firmware ? `${g.porked_firmware}${g.porked_at ? '  (' + new Date(g.porked_at).toLocaleDateString() + ')' : ''}` : '—'],
      ['Publisher',            g.prospero_publisher    || '—'],
      ['Publisher ID',         g.prospero_publisher_id || '—'],
      ['Region',               g.prospero_region       || '—'],
      ['Last Updated',         g.prospero_last_updated || '—'],
      ['Required Firmware',    fwDisplay],
      ['DLC Available',        dlc.length ? `${dlc.length} item(s)` : 'None'],
      ['FTP Path',             g.ftp_path   || '—'],
      ['Last Scanned',         g.last_scanned ? new Date(g.last_scanned).toLocaleString() : '—'],
      ['Metadata Age',         g.prospero_fetched_at ? fmtAge(Date.now() - g.prospero_fetched_at) : 'Never fetched'],
    ];
    $('modal-info').innerHTML = infoRows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('');

    // Backup list
    const backups      = await window.pork.listBackups(game_id);
    const localBackups = backups.filter(b => b.source !== 'backpork');
    $('modal-backup-list').innerHTML = localBackups.length
      ? localBackups.map(b => `<li><span>${escHtml(b.backup_path)}</span><span>${fmt(b.size)}</span></li>`).join('')
      : '<li style="justify-content:center">No backups recorded</li>';

    // Hash verification section (Info tab)
    await renderHashSection(game_id, backups);

    // Manage tab
    await renderManagePanel(g, backups);

    // Prospero tabs
    renderProsperoData(g);

    // Cheats tab
    renderCheatsPanel(g);

    $('btn-modal-backup').disabled  = true; // enabled async below if folder found on FTP
    $('btn-modal-install').disabled = !state.connected || !backups.length;
    $('modal-overlay').hidden = false;

    // Async: check FTP for the game folder and enable Backup button only if found
    if (state.connected) {
      window.pork.ftpFindGame(game_id).then(ftpPath => {
        if (ftpPath) {
          $('btn-modal-backup').disabled = false;
          // Update stored ftp_path if the scan found a different or new path
          if (ftpPath !== g.ftp_path) {
            window.pork.updateGame({ game_id, fields: { ftp_path: ftpPath, installed: 1 } });
            state.currentGame.ftp_path = ftpPath;
          }
        }
      }).catch(() => {});
    }
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function fmtAge(ms) {
  if (ms < 60000)       return 'Just now';
  if (ms < 3600000)     return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000)    return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

$('btn-modal-mark').addEventListener('click', async () => {
  if (!state.currentGame) return;
  await window.pork.updateGame({ game_id: state.currentGame.game_id, fields: { backed_up: 1 } });
  setStatus('Marked as backed up', 'ok');
  closeModal();
  if (document.querySelector('.page.active')?.id === 'page-games') loadGames();
});

$('btn-modal-backup').addEventListener('click', async () => {
  if (!state.currentGame || !state.connected) return;
  const { ftp_path, game_id } = state.currentGame;
  if (!ftp_path) { setStatus('No FTP path recorded for this game — run a scan first', 'error'); return; }
  try {
    await window.pork.ftpDownloadFolder(game_id);
    setStatus('Backup queued — see Transfers for progress', 'ok');
    closeModal();
  } catch (e) {
    setStatus(e.message, 'error');
  }
});

// "Install to PS5" — upload the most recent local backup to the game's FTP path
$('btn-modal-install').addEventListener('click', async () => {
  if (!state.currentGame || !state.connected) return;
  const g = state.currentGame;
  const ftpPath = await ensureGameFtpPath(g.game_id);
  if (!ftpPath) return; // user cancelled path selection

  // Pick the most recent backup for this game
  let backups;
  try { backups = await window.pork.listBackups(g.game_id); } catch { backups = []; }
  if (!backups.length) { setStatus('No local backups found — add one via the Manage tab', 'error'); return; }

  const latest = backups.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  try {
    await window.pork.ftpUpload({ localPath: latest.backup_path, remotePath: ftpPath });
    setStatus('Install queued — see Transfers for progress', 'ok');
    closeModal();
  } catch (e) {
    setStatus(`Install failed: ${e.message}`, 'error');
  }
});

$('btn-modal-refresh').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const { game_id } = state.currentGame;
  $('btn-modal-refresh').disabled = true;
  setStatus('Refreshing metadata…');
  try {
    await window.pork.prosperoFetch(game_id);
    setStatus('Metadata refreshed', 'ok');
  } catch (e) {
    setStatus(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('btn-modal-refresh').disabled = false;
  }
});

function closeModal() {
  $('modal-overlay').hidden = true;
  state.currentGame = null;
  // Reset banner
  $('modal-banner').style.backgroundImage = '';
  // Reset icon
  const icon = $('modal-icon');
  icon.src = ''; icon.hidden = true;
  // Reset description
  $('modal-description').hidden = true;
  $('modal-description').textContent = '';
  // Reset hash section
  $('modal-hash-section').hidden = true;
  $('modal-hash-progress').hidden = true;
  $('hash-progress-fill').style.width = '0%';
  // Reset manage section
  uploadLocalPath = null;
  uploadInProgress = false;
  porkInProgress   = false;
  $('manage-remote-path').value    = '';
  $('manage-remote-path').readOnly = true;
  $('btn-manage-upload').disabled  = true;
  $('manage-upload-log').hidden    = true;
  $('mtab-manage-count').textContent = '';
  $('manage-backpork-section').hidden = true;
  $('manage-pork-progress').hidden    = true;
  $('pork-progress-fill').style.width = '0%';
}

$('modal-close').addEventListener('click', closeModal);
$('btn-modal-close2').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── System View hotkeys ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Escape always exits in-app fullscreen, regardless of active page
  if (e.key === 'Escape' && $('sv-viewer-wrap').classList.contains('sv-viewer-wrap--fullscreen')) {
    e.preventDefault();
    svToggleFullscreen();
    return;
  }
  if (!$('page-system-view')?.classList.contains('active')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === _svHotkeys.mute)            { e.preventDefault(); $('btn-sv-mute').click(); }
  else if (k === _svHotkeys.gif)        { e.preventDefault(); $('btn-sv-record').click(); }
  else if (k === _svHotkeys.video)      { e.preventDefault(); $('btn-sv-vid-rec').click(); }
  else if (k === _svHotkeys.fullscreen) { e.preventDefault(); svToggleFullscreen(); }
  else if (k === _svHotkeys.popout)     { e.preventDefault(); $('btn-sv-popout').click(); }
});

// Auto-scan toast on launch
window.pork.on('local:scan:complete', async ({ total, added }) => {
  if (total === 0) return; // nothing found, stay quiet
  if (added > 0) {
    showToast(`Auto-scan: found ${added} new game${added !== 1 ? 's' : ''} (${total} total) — fetching metadata…`, 'ok');
  } else {
    showToast(`Auto-scan: ${total} game${total !== 1 ? 's' : ''} already tracked`, 'info');
  }

  // Refresh whichever page is currently visible
  const activePage = document.querySelector('.page.active')?.id;
  if (activePage === 'page-dashboard') loadDashboard();
  if (activePage === 'page-games')     loadGames();
  if (activePage === 'page-backups')   loadBackups();
});

// Toast when Prospero background queue finishes
window.pork.on('prospero:queue:done', ({ fetched, failed }) => {
  if (fetched > 0 && failed === 0) {
    showToast(`Metadata fetched for ${fetched} game${fetched !== 1 ? 's' : ''}`, 'ok');
  } else if (fetched > 0) {
    showToast(`Metadata fetched for ${fetched} game${fetched !== 1 ? 's' : ''} (${failed} failed)`, 'info');
  } else if (failed > 0) {
    showToast(`Metadata fetch failed for ${failed} game${failed !== 1 ? 's' : ''}`, 'error', 8000);
  }
});

// Live-refresh modal when background fetch completes
window.pork.on('prospero:updated', async ({ game_id, data }) => {
  // Reload games list in background so future opens have fresh data
  state.games = await window.pork.listGames({});

  // Update cheat icon map and any visible cheat card for this game
  if (data.iconUrl) {
    _cheatIconMap.set(game_id, data.iconUrl);
    document.querySelectorAll(`.cheat-card[data-cusa="${game_id}"]`).forEach(card => {
      const empty = card.querySelector('.cheat-card-icon-empty');
      if (!empty) return;
      const img = document.createElement('img');
      img.className = 'cheat-card-icon';
      img.alt = '';
      img.src = data.iconUrl;
      img.onerror = () => { img.style.display = 'none'; };
      empty.replaceWith(img);
    });
  }

  // If the modal is open for this game, refresh it
  if (state.currentGame?.game_id === game_id) {
    const updated = state.games.find(g => g.game_id === game_id);
    if (updated) {
      state.currentGame = updated;
      $('modal-title').textContent    = updated.prospero_name || updated.title || game_id;
      $('modal-subtitle').textContent = `${updated.game_id}  ·  ${updated.prospero_region || (updated.version ? 'v' + updated.version : '')}`;

      // Refresh info table with new metadata
      const patches    = tryParseJson(updated.prospero_patches, []);
      const fwVersions = [...new Set(patches.map(p => p.requiredFirmware).filter(Boolean))];
      const dlc        = tryParseJson(updated.prospero_dlc, []);
      const infoRows   = [
        ['Game ID',           updated.game_id],
        ['Content ID',        updated.content_id || updated.prospero_content_id || '—'],
        ['Version',           updated.version || updated.prospero_version || '—'],
        ['Size',              updated.backup_size ? fmt(updated.backup_size) : (updated.size ? fmt(updated.size) : (updated.prospero_size || '—'))],
        ['Installed',         updated.installed  ? 'Yes' : 'No'],
        ['Backed Up',         updated.backed_up  ? 'Yes' : 'No'],
        ['Porked To',         updated.porked_firmware ? `${updated.porked_firmware}${updated.porked_at ? '  (' + new Date(updated.porked_at).toLocaleDateString() + ')' : ''}` : '—'],
        ['Publisher',         updated.prospero_publisher    || '—'],
        ['Publisher ID',      updated.prospero_publisher_id || '—'],
        ['Region',            updated.prospero_region       || '—'],
        ['Last Updated',      updated.prospero_last_updated || '—'],
        ['Required Firmware', fwVersions.length ? fwVersions.join(', ') : '—'],
        ['DLC Available',     dlc.length ? `${dlc.length} item(s)` : 'None'],
        ['FTP Path',          updated.ftp_path   || '—'],
        ['Last Scanned',      updated.last_scanned ? new Date(updated.last_scanned).toLocaleString() : '—'],
        ['Metadata Age',      updated.prospero_fetched_at ? fmtAge(Date.now() - updated.prospero_fetched_at) : 'Never fetched'],
      ];
      $('modal-info').innerHTML = infoRows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('');

      renderProsperoData(updated);
    }
  }
});

// ── Payload Manager ───────────────────────────────────────────────────────────

async function renderSettingsPayloadSources() {
  const sources = await window.pork.payloadSourcesList();
  const cont    = $('settings-payload-sources');
  if (!sources.length) {
    cont.innerHTML = '<p class="hint" style="margin:6px 0">No sources yet. Add one below.</p>';
    return;
  }
  cont.innerHTML = sources.map(s => `
    <div class="payload-settings-source-row" data-source-id="${s.id}">
      <input type="checkbox" class="source-toggle" ${s.enabled ? 'checked' : ''}/>
      <span class="payload-settings-source-name">${escHtml(s.name)}</span>
      <span class="payload-settings-source-url" title="${escHtml(s.github_url)}">${escHtml(s.github_url)}</span>
      ${s.latest_tag ? `<span class="payload-tag-chip">${escHtml(s.latest_tag)}</span>` : ''}
      <button class="btn btn-sm btn-source-remove" style="margin-left:auto">&#10005;</button>
    </div>
  `).join('');
}

function payloadStatusBadge(file) {
  if (file.local_hash && file.remote_hash) {
    if (file.local_hash === file.remote_hash) return '<span class="badge badge-green">&#10003; Up to date</span>';
    return '<span class="badge badge-yellow">&#8595; Update available</span>';
  }
  if (file.local_hash) return '<span class="badge badge-dim">Downloaded (no checksum)</span>';
  if (file.remote_hash) return '<span class="badge badge-dim">Not downloaded</span>';
  return '<span class="badge badge-dim">—</span>';
}

function payloadActionBtn(file, source_id) {
  const upToDate  = !!(file.local_hash && file.remote_hash && file.local_hash === file.remote_hash);
  const hasUpdate = !!(file.local_hash && file.remote_hash && file.local_hash !== file.remote_hash);

  const dlLabel = hasUpdate ? '&#8595;&nbsp;Update' : '&#8595;&nbsp;Download';
  const dlCls   = hasUpdate ? 'btn btn-sm btn-teal btn-payload-download' : 'btn btn-sm btn-payload-download';
  const dlBtn   = !upToDate
    ? `<button class="${dlCls}"
        data-source-id="${source_id}"
        data-asset-name="${escHtml(file.asset_name)}"
        data-asset-url="${escHtml(file.asset_url || '')}"
        data-version="${escHtml(file.version || '')}">${dlLabel}</button>`
    : '';

  // Show ↑ PS5 button whenever the file has been downloaded locally
  const pushBtn = file.local_path
    ? `<button class="btn btn-sm btn-payload-push-remote"
        data-local-path="${escHtml(file.local_path)}"
        data-filename="${escHtml(file.asset_name)}"
        title="Upload to PS5 via FTP transfer queue">&#8593;&nbsp;PS5</button>`
    : '';

  return (dlBtn || pushBtn)
    ? `<span style="display:inline-flex;gap:4px">${dlBtn}${pushBtn}</span>`
    : '';
}

function renderPayloadSourceCheckList(results) {
  const cont = $('payload-sources-check-list');
  if (!results || !results.length) {
    cont.innerHTML = '<p class="hint" style="margin:8px 0">No enabled sources. Add sources in Settings → Payload Remote Sources.</p>';
    return;
  }
  cont.innerHTML = results.map(({ source, files, error }) => {
    const tag  = source.latest_tag ? `<span class="payload-tag-chip">${escHtml(source.latest_tag)}</span>` : '';
    const ts   = source.last_checked ? `<span class="hint" style="font-size:10px">checked ${new Date(source.last_checked).toLocaleString()}</span>` : '';
    const errRow = error ? `<p class="hint" style="color:var(--red);margin:4px 0">${escHtml(error)}</p>` : '';
    const rows = (files || []).filter(f =>
      /\.(bin|elf|js)$/i.test(f.asset_name) &&
      !/sha256|checksums|sha2|sums/i.test(f.asset_name)
    ).map(f => `
      <tr>
        <td class="payload-asset-name">${escHtml(f.asset_name)}</td>
        <td>${payloadStatusBadge(f)}</td>
        <td class="payload-hash-snippet">${f.remote_hash ? f.remote_hash.slice(0, 12) + '…' : '—'}</td>
        <td class="hint">${escHtml(f.version || '—')}</td>
        <td>${payloadActionBtn(f, source.id)}</td>
      </tr>
    `).join('');
    return `
      <div class="payload-check-source">
        <div class="payload-check-source-header">
          <span class="payload-check-source-name">${escHtml(source.name)}</span>
          ${tag} ${ts}
        </div>
        ${errRow}
        ${rows ? `<table class="payload-asset-table"><tbody>${rows}</tbody></table>` : '<p class="hint">No assets found.</p>'}
      </div>
    `;
  }).join('');
}

async function renderLocalPayloads() {
  let files;
  try { files = await window.pork.payloadListLocal(); } catch { files = []; }
  const list  = $('payload-local-list');
  const empty = $('payload-local-empty');
  if (!files.length) {
    list.innerHTML  = '';
    empty.hidden    = false;
    return;
  }
  empty.hidden   = true;
  list.innerHTML = files.map(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const extClass = { elf: 'al-ext-elf', bin: 'al-ext-bin', js: 'al-ext-js' }[ext] || '';
    return `<div class="al-file-card payload-local-card">
      <span class="al-ext ${extClass}">${escHtml(ext || '?')}</span>
      <span class="al-file-name" title="${escHtml(f.local_path)}">${escHtml(f.name)}</span>
      <span class="payload-card-size">${fmt(f.size)}</span>
      ${payloadStatusBadge(f)}
      <div class="payload-card-actions">
        <button class="btn btn-sm btn-teal btn-payload-push"
          data-local-path="${escHtml(f.local_path)}"
          data-filename="${escHtml(f.name)}" title="Push to PS5 via FTP transfer queue">&#8593;&nbsp;FTP</button>
        <button class="btn btn-sm btn-payload-delete-local"
          data-id="${f.db_id ?? ''}"
          data-local-path="${escHtml(f.local_path)}" title="Delete local file">&#128465;</button>
      </div>
    </div>`;
  }).join('');
}

async function renderPayloadSender() {
  let files;
  try { files = await window.pork.payloadListLocal(); } catch { files = []; }
  const list  = $('payload-sender-list');
  const empty = $('payload-sender-empty');
  if (!files.length) {
    list.innerHTML = '';
    empty.hidden   = false;
    return;
  }
  empty.hidden   = true;
  const status = $('payload-sender-status');
  if (status) status.textContent = '';
  list.innerHTML = files.map(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const extClass = { elf: 'al-ext-elf', bin: 'al-ext-bin', js: 'al-ext-js' }[ext] || '';
    return `<div class="al-file-card payload-sender-card">
      <span class="al-ext ${extClass}">${escHtml(ext || '?')}</span>
      <span class="al-file-name" title="${escHtml(f.local_path)}">${escHtml(f.name)}</span>
      <span class="payload-card-size">${fmt(f.size)}</span>
      <button class="btn btn-sm btn-teal btn-payload-tcp-send"
        data-local-path="${escHtml(f.local_path)}"
        data-filename="${escHtml(f.name)}">&#x21D2; Send</button>
    </div>`;
  }).join('');
}

// Jailbreak page event handlers

$('btn-payload-check-all').addEventListener('click', async () => {
  const btn = $('btn-payload-check-all');
  const status = $('payload-check-status');
  btn.disabled = true;
  status.textContent = 'Checking…';
  try {
    const results = await window.pork.payloadCheckUpdates();
    renderPayloadSourceCheckList(results);
    await renderLocalPayloads();
    status.textContent = `Done — ${results.length} source(s) checked`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    setStatus(`Payload check failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Download / update asset
$('payload-sources-check-list').addEventListener('click', async e => {
  // ── Push to PS5 ──
  const pushBtn = e.target.closest('.btn-payload-push-remote');
  if (pushBtn) {
    const local_path = pushBtn.dataset.localPath;
    const filename   = pushBtn.dataset.filename;
    const origText   = pushBtn.textContent;
    pushBtn.disabled    = true;
    pushBtn.textContent = 'Queuing…';
    try {
      await window.pork.payloadPush({ local_path, filename });
      setStatus(`${filename} queued for FTP transfer to PS5`, 'ok');
      navigate('transfers');
    } catch (err) {
      setStatus(`FTP push failed: ${err.message}`, 'error');
      pushBtn.disabled    = false;
      pushBtn.textContent = origText;
    }
    return;
  }

  // ── Download / Update (local copy) ──
  const dlBtn = e.target.closest('.btn-payload-download');
  if (!dlBtn) return;
  const source_id  = Number(dlBtn.dataset.sourceId);
  const asset_name = dlBtn.dataset.assetName;
  const asset_url  = dlBtn.dataset.assetUrl;
  const version    = dlBtn.dataset.version;
  dlBtn.disabled = true;
  dlBtn.textContent = 'Downloading…';
  try {
    await window.pork.payloadDownload({ source_id, asset_name, asset_url, version });
    setStatus(`Downloaded ${asset_name}`, 'ok');
    // Re-check this source to refresh status badges (also reveals ↑ PS5 button)
    const results = await window.pork.payloadCheckUpdates(source_id);
    renderPayloadSourceCheckList(results);
    await renderLocalPayloads();
  } catch (err) {
    setStatus(`Download failed: ${err.message}`, 'error');
    dlBtn.disabled = false;
    dlBtn.textContent = '↓ Retry';
  }
});

// Push local payload to PS5
$('payload-local-list').addEventListener('click', async e => {
  const pushBtn = e.target.closest('.btn-payload-push');
  if (pushBtn) {
    const local_path = pushBtn.dataset.localPath;
    const filename   = pushBtn.dataset.filename;
    try {
      await window.pork.payloadPush({ local_path, filename });
      setStatus(`${filename} queued for transfer`, 'ok');
      navigate('transfers');
    } catch (e2) {
      setStatus(`Push failed: ${e2.message}`, 'error');
    }
    return;
  }

  const delBtn = e.target.closest('.btn-payload-delete-local');
  if (delBtn) {
    const ok = await showConfirm(`Delete local file "${delBtn.dataset.localPath}"?`);
    if (!ok) return;
    try {
      const id         = delBtn.dataset.id ? Number(delBtn.dataset.id) : null;
      const local_path = delBtn.dataset.localPath;
      await window.pork.payloadDeleteLocal({ id, local_path });
      await renderLocalPayloads();
    } catch (e2) {
      setStatus(`Delete failed: ${e2.message}`, 'error');
    }
  }
});

$('btn-payload-list-remote')?.addEventListener('click', () => {}); // legacy ref — section replaced by PS5 Payload Sender

// TCP payload sender — clicking Send streams the local file to PS5 on the specified port
$('payload-sender-list').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-payload-tcp-send');
  if (!btn) return;
  const local_path = btn.dataset.localPath;
  const filename   = btn.dataset.filename;
  const port       = parseInt($('payload-sender-port')?.value || '9021', 10);
  const status     = $('payload-sender-status');
  btn.disabled     = true;
  btn.textContent  = 'Sending\u2026';
  if (status) { status.textContent = `Sending ${filename} on port ${port}\u2026`; status.style.color = ''; }
  try {
    await window.pork.payloadTcpSend({ localPath: local_path, port, filename });
    if (status) { status.textContent = `\u2713 ${filename} sent \u2014 PS5 notified`; status.style.color = 'var(--teal)'; }
    setStatus(`${filename} sent to PS5 on port ${port}`, 'ok');
  } catch (e2) {
    if (status) { status.textContent = `Error: ${e2.message}`; status.style.color = 'var(--red)'; }
    setStatus(`TCP send failed: ${e2.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '\u21D2 Send';
  }
});

// Autoloader — save a PS5 file to local payloads folder
$('autoloader-file-list').addEventListener('click', async e => {
  const saveBtn = e.target.closest('.btn-al-save-local');
  if (saveBtn) {
    e.stopPropagation(); // don't also add to sequence
    const filename = saveBtn.dataset.filename;
    const orig = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '⋯';
    try {
      await window.pork.autoloaderSaveLocal({ filename });
      setStatus(`${filename} saved to local payloads`, 'ok');
      saveBtn.textContent = '✓';
      await renderLocalPayloads();
      await renderPayloadSender();
      setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 2000);
    } catch (e2) {
      setStatus(`Save failed: ${e2.message}`, 'error');
      saveBtn.textContent = orig;
      saveBtn.disabled = false;
    }
    return;
  }
  // Original behaviour: click card to add to sequence
  const card = e.target.closest('[data-al-add]');
  if (!card) return;
  _alSequence.push({ type: 'payload', filename: card.dataset.alAdd });
  _alRenderSequence();
  $('btn-autoloader-save').disabled = false;
});

// Progress events for payload downloads
window.pork.on('payload:download:progress', ({ asset_name, percent }) => {
  // Update download button label if it's still visible
  const btn = document.querySelector(`.btn-payload-download[data-asset-name="${CSS.escape(asset_name)}"]`);
  if (btn) btn.textContent = `${percent}%`;
});

// ── PS5 Autoloader ─────────────────────────────────────────────────────────────
let _alSequence = []; // { type: 'payload'|'delay', filename?: string, ms?: number }
let _alHeader   = ''; // comment block preserved from original file

const _AL_DEFAULT_HEADER =
`#
# ps5_autoloader - autoload.txt
# Edited with Porkfolio
# -----------------------------------------------------------------------------------------
# Usage:
# - Put one filename per line (e.g., payload.elf or script.js).
# - Supported payload types: .elf, .bin, .js
# - Lines starting with '!' are sleep commands (example: !1000 sleeps for 1000 ms).
# -----------------------------------------------------------------------------------------
`;

function _alParse(content) {
  if (!content) return { header: _AL_DEFAULT_HEADER, entries: [] };
  const lines = content.split(/\r?\n/);
  const headerLines = [];
  const entries = [];
  let headerDone = false;
  for (const line of lines) {
    const t = line.trim();
    if (!headerDone) {
      if (t.startsWith('#') || t === '') { headerLines.push(line); continue; }
      headerDone = true;
    }
    if (t === '' || t.startsWith('#')) continue;
    if (t.startsWith('!')) {
      const ms = parseInt(t.slice(1), 10);
      if (!isNaN(ms)) entries.push({ type: 'delay', ms });
    } else {
      entries.push({ type: 'payload', filename: t });
    }
  }
  const header = headerLines.join('\n').trimEnd() + '\n\n';
  return { header: header || _AL_DEFAULT_HEADER, entries };
}

function _alSerialize(header, entries) {
  const lines = [header.trimEnd(), ''];
  for (const e of entries)
    lines.push(e.type === 'delay' ? `!${e.ms}` : e.filename);
  return lines.join('\n') + '\n';
}

// drag-and-drop state
let _alDragIdx = -1;

function _alSecsFmt(ms) {
  const s = ms / 1000;
  return s === Math.floor(s) ? s.toFixed(1) + 's' : s.toFixed(2) + 's';
}

function _alBuildRow(entry, i) {
  const del = `<button class="al-del" data-al="remove" data-idx="${i}" title="Remove">&#10005;</button>`;
  if (entry.type === 'delay') {
    const capped = Math.min(entry.ms, 10000);
    const presets = [250, 500, 1000, 2000, 3000, 5000].map(p => {
      const lbl = p < 1000 ? `${p}ms` : `${p / 1000}s`;
      const active = entry.ms === p ? ' al-preset-active' : '';
      return `<button class="al-preset${active}" data-al="preset" data-idx="${i}" data-ms="${p}">${lbl}</button>`;
    }).join('');
    return `<div class="al-row al-delay" draggable="true" data-idx="${i}">
      <span class="al-grip" title="Drag to reorder">&#8942;&#8942;</span>
      <span class="al-delay-clock">&#9201;</span>
      <div class="al-delay-body">
        <div class="al-delay-top">
          <span class="al-delay-lbl">Wait</span>
          <input class="al-delay-num" type="number" min="0" max="60000" step="50"
                 value="${entry.ms}" data-al="delay-num" data-idx="${i}">
          <span class="al-delay-ms">ms</span>
          <span class="al-delay-secs" data-idx="${i}">(${_alSecsFmt(entry.ms)})</span>
          <div class="al-presets">${presets}</div>
        </div>
        <input class="al-slider" type="range" min="0" max="10000" step="50"
               value="${capped}" data-al="delay-slider" data-idx="${i}">
      </div>
      ${del}
    </div>`;
  }
  const ext = (entry.filename.split('.').pop() || '').toLowerCase();
  const extClass = { elf: 'al-ext-elf', bin: 'al-ext-bin', js: 'al-ext-js' }[ext] || '';
  return `<div class="al-row al-payload" draggable="true" data-idx="${i}">
    <span class="al-grip" title="Drag to reorder">&#8942;&#8942;</span>
    <span class="al-ext ${extClass}">${escHtml(ext || '?')}</span>
    <span class="al-name" title="${escHtml(entry.filename)}">${escHtml(entry.filename)}</span>
    <button class="al-ins-delay" data-al="ins-delay" data-idx="${i}" title="Insert delay after this payload">&#43;&#9201;</button>
    ${del}
  </div>`;
}

function _alRenderSequence() {
  const seq = $('autoloader-sequence');
  if (!seq) return;
  if (!_alSequence.length) {
    seq.innerHTML = `<div class="al-empty">
      <div class="al-empty-icon">&#128196;</div>
      <div>No entries yet.</div>
      <div class="al-empty-hint">Click a file on the left to add it to the sequence.</div>
    </div>`;
    return;
  }
  seq.innerHTML = _alSequence.map(_alBuildRow).join('');
  // attach drag-and-drop
  seq.querySelectorAll('.al-row[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => {
      _alDragIdx = parseInt(row.dataset.idx, 10);
      row.classList.add('al-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('al-dragging');
      seq.querySelectorAll('.al-drag-over').forEach(r => r.classList.remove('al-drag-over'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      seq.querySelectorAll('.al-drag-over').forEach(r => r.classList.remove('al-drag-over'));
      if (parseInt(row.dataset.idx, 10) !== _alDragIdx) row.classList.add('al-drag-over');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const toIdx = parseInt(row.dataset.idx, 10);
      if (_alDragIdx === -1 || _alDragIdx === toIdx) return;
      const [item] = _alSequence.splice(_alDragIdx, 1);
      _alSequence.splice(toIdx, 0, item);
      _alDragIdx = -1;
      _alRenderSequence();
      $('btn-autoloader-save').disabled = false;
    });
  });
}

function _alRenderFiles(files) {
  const list = $('autoloader-file-list');
  if (!list) return;
  const payloads = files.filter(f => !f.isDir && /\.(elf|bin|js)$/i.test(f.name));
  if (!payloads.length) {
    list.innerHTML = '<p class="hint autoloader-empty-hint">No .elf / .bin / .js files found in /data/ps5_autoloader.</p>';
    return;
  }
  list.innerHTML = payloads.map(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const extClass = { elf: 'al-ext-elf', bin: 'al-ext-bin', js: 'al-ext-js' }[ext] || '';
    return `<div class="al-file-card" data-al-add="${escHtml(f.name)}" title="Click to add to sequence">
      <span class="al-ext ${extClass}">${escHtml(ext)}</span>
      <span class="al-file-name">${escHtml(f.name)}</span>
      <button class="btn-al-save-local" data-filename="${escHtml(f.name)}" title="Save to local payloads folder">&#8675;</button>
      <span class="al-file-add">&#43;</span>
    </div>`;
  }).join('');
}

async function loadAutoloader() {
  const btn    = $('btn-autoloader-refresh');
  const status = $('autoloader-status');
  btn.disabled = true;
  status.textContent = 'Loading…';
  try {
    // Sequential — basic-ftp rejects concurrent operations on the same client
    const files   = await window.pork.autoloaderList();
    const content = await window.pork.autoloaderRead();
    const { header, entries } = _alParse(content);
    _alHeader   = header;
    _alSequence = entries;
    _alRenderFiles(files);
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
    status.textContent = content
      ? `Loaded \u2014 ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
      : 'autoload.txt not found \u2014 sequence is empty';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function saveAutoloader() {
  const btn    = $('btn-autoloader-save');
  const status = $('autoloader-status');
  btn.disabled = true;
  status.textContent = 'Saving\u2026';
  try {
    const content = _alSerialize(_alHeader, _alSequence);
    await window.pork.autoloaderSave(content);
    status.textContent = 'Saved to PS5 \u2713';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    btn.disabled = false;
  }
}

$('btn-autoloader-refresh').addEventListener('click', loadAutoloader);
$('btn-autoloader-save').addEventListener('click', saveAutoloader);

$('btn-autoloader-add-delay').addEventListener('click', () => {
  _alSequence.push({ type: 'delay', ms: 1000 });
  _alRenderSequence();
  $('btn-autoloader-save').disabled = false;
});

// Sequence: clicks (remove, preset, insert-delay)
$('autoloader-sequence').addEventListener('click', e => {
  const btn = e.target.closest('[data-al]');
  if (!btn) return;
  const action = btn.dataset.al;
  const idx    = parseInt(btn.dataset.idx, 10);
  if (action === 'remove') {
    _alSequence.splice(idx, 1);
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
  } else if (action === 'preset') {
    const ms = parseInt(btn.dataset.ms, 10);
    _alSequence[idx].ms = ms;
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
  } else if (action === 'ins-delay') {
    // Insert a 1-second delay immediately after this payload
    _alSequence.splice(idx + 1, 0, { type: 'delay', ms: 1000 });
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
  }
});

// Sequence: live slider / number sync (no full re-render needed)
$('autoloader-sequence').addEventListener('input', e => {
  const el  = e.target;
  const al  = el.dataset.al;
  if (!al) return;
  const idx = parseInt(el.dataset.idx, 10);
  if (al === 'delay-num' || al === 'delay-slider') {
    const ms = Math.max(0, parseInt(el.value, 10) || 0);
    _alSequence[idx].ms = ms;
    const row    = el.closest('.al-row');
    const num    = row.querySelector('[data-al="delay-num"]');
    const slider = row.querySelector('[data-al="delay-slider"]');
    const secs   = row.querySelector('.al-delay-secs');
    if (num)    num.value    = ms;
    if (slider) slider.value = Math.min(ms, 10000);
    if (secs)   secs.textContent = `(${_alSecsFmt(ms)})`;
    // Update active preset highlights without re-render
    row.querySelectorAll('.al-preset').forEach(p =>
      p.classList.toggle('al-preset-active', parseInt(p.dataset.ms, 10) === ms)
    );
    $('btn-autoloader-save').disabled = false;
  }
});

// ── Autoloader Snapshots ─────────────────────────────────────────────────────────────────────────────
async function renderAutoloaderSnapshots() {
  const list = $('snapshot-list');
  if (!list) return;
  list.innerHTML = '<p class="hint autoloader-empty-hint">Loading…</p>';
  try {
    const snaps = await window.pork.snapshotList();
    if (!snaps.length) {
      list.innerHTML = '<p class="hint autoloader-empty-hint">No snapshots yet. Take one above.</p>';
      return;
    }
    list.innerHTML = snaps.map(s => {
      const d       = new Date(s.createdAt);
      const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const fc      = (s.files || []).length;
      const alStr   = s.hasAutoload ? ' + autoload.txt' : '';
      return `<div class="snapshot-card">
        <div class="snapshot-card-info">
          <span class="snapshot-card-label">${escHtml(s.label || 'Snapshot')}</span>
          <span class="snapshot-card-meta">${dateStr} \u2014 ${fc} payload${fc !== 1 ? 's' : ''}${alStr}</span>
        </div>
        <div class="snapshot-card-actions">
          <button class="btn btn-teal btn-sm btn-snap-restore" data-snap-id="${escHtml(s.id)}">&uarr; Restore</button>
          <button class="btn btn-sm btn-snap-delete" data-snap-id="${escHtml(s.id)}" title="Delete snapshot">&#10005;</button>
        </div>
      </div>`;
    }).join('');

    // Attach direct listeners to each button — avoids event-delegation issues
    list.querySelectorAll('.btn-snap-restore').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id  = btn.dataset.snapId;
        const ok  = await showConfirm('Restore this snapshot to your PS5?\n\nAll payload files and autoload.txt will be uploaded back to /data/ps5_autoloader, overwriting whatever is currently there.');
        if (!ok) return;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⋯ Uploading…';
        try {
          const res = await window.pork.snapshotRestore(id);
          btn.textContent = '✓ Restored';
          const errNote = res.errors?.length ? ` (${res.errors.length} file${res.errors.length !== 1 ? 's' : ''} failed)` : '';
          showToast(`Snapshot restored ✓ — ${res.fileCount} file${res.fileCount !== 1 ? 's' : ''} uploaded to PS5${errNote}`, res.errors?.length ? 'info' : 'ok');
          setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
        } catch (er) {
          btn.textContent = orig;
          btn.disabled = false;
          showToast('Restore failed: ' + er.message, 'error');
        }
      });
    });

    list.querySelectorAll('.btn-snap-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.snapId;
        const ok = await showConfirm('Delete this snapshot? This cannot be undone.');
        if (!ok) return;
        try {
          await window.pork.snapshotDelete(id);
          await renderAutoloaderSnapshots();
        } catch (er) {
          showToast('Delete failed: ' + er.message, 'error');
        }
      });
    });

  } catch (e) {
    list.innerHTML = `<p class="hint autoloader-empty-hint" style="color:var(--red)">Error: ${escHtml(e.message)}</p>`;
  }
}

// (Snapshot restore/delete listeners are attached directly inside renderAutoloaderSnapshots)

$('btn-snapshot-take').addEventListener('click', async () => {
  const btn    = $('btn-snapshot-take');
  const status = $('snapshot-take-status');
  const label  = $('snapshot-label').value.trim() || 'Snapshot';
  btn.disabled = true;
  status.textContent = 'Downloading from PS5\u2026';
  try {
    const { meta } = await window.pork.snapshotTake(label);
    const fc    = meta.files.length;
    const alStr = meta.hasAutoload ? ' + autoload.txt' : '';
    status.textContent = `Saved \u2713 \u2014 ${fc} payload${fc !== 1 ? 's' : ''}${alStr}`;
    $('snapshot-label').value = '';
    await renderAutoloaderSnapshots();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

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
      dlBtn.disabled = false;
      dlBtn.textContent = '↓ Download';
      setStatus(err.message, 'error');
    }
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

// ── Cheats page ───────────────────────────────────────────────────────────────

let _cheatsDownloading = false;

function fmtEta(sec) {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

let _cheatsSearchTimer = null;

// Map of cusa_id → prospero_icon_url, built once per loadCheats() call
let _cheatIconMap = new Map();

async function loadCheats() {
  // Hide the progress panel unless a download is actively running
  if (!_cheatsDownloading) {
    $('cheats-dl-panel').hidden = true;
    $('btn-cheats-download-all').disabled = false;
  }

  // Build icon map from games — reuse state.games if already loaded, otherwise fetch
  try {
    const games = state.games.length ? state.games : await window.pork.listGames({});
    _cheatIconMap = new Map(games.map(g => [g.game_id, g.prospero_icon_url || '']));
  } catch (_) {}

  // Update stats bar
  try {
    const stats = await window.pork.cheatsStats();
    $('cheats-stat-files').textContent  = `${stats.files ?? 0} files cached`;
    $('cheats-stat-games').textContent  = `covering ${stats.games ?? 0} games`;
    const badge = $('nav-cheats-badge');
    if (stats.files > 0) {
      badge.textContent = stats.files;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (_) {}

  // Render with current search
  const q = $('cheats-search').value.trim();
  await renderCheatResults(q);

  // Unmatched section (only shown when not searching)
  if (!q) await renderUnmatchedCheats();
  else $('cheats-unmatched-section').hidden = true;
}

// ── GarlicSaves ──────────────────────────────────────────────────────────────
let _garlicBusy   = false;
let _garlicHooked = false;

async function loadGarlic() {
  if (!_garlicHooked) {
    _garlicHooked = true;

    $('btn-garlic-site').addEventListener('click', e => {
      e.preventDefault();
      window.pork.openShell('https://garlicsaves.com');
    });
    $('garlic-contribute-link').addEventListener('click', e => {
      e.preventDefault();
      window.pork.openShell('https://garlicsaves.com/contribute');
    });

    // Start Working — show confirm modal
    $('btn-garlic-start').addEventListener('click', () => {
      if (_garlicBusy) return;
      $('garlic-confirm-overlay').hidden = false;
    });

    // Modal: Cancel
    $('btn-garlic-confirm-cancel').addEventListener('click', () => {
      $('garlic-confirm-overlay').hidden = true;
    });

    // Modal: Confirm — run the worker
    $('btn-garlic-confirm-ok').addEventListener('click', async () => {
      $('garlic-confirm-overlay').hidden = true;
      if (_garlicBusy) return;
      _garlicBusy = true;
      $('btn-garlic-start').disabled = true;
      $('garlic-progress-area').hidden = false;
      $('garlic-progress-text').textContent = 'Starting…';
      $('garlic-progress-bar').style.width  = '0%';
      try {
        await window.pork.garlicStart();
        $('garlic-status-badge').hidden = false;
        showToast('GarlicSaves worker started! Restart PS5 to stop.', 'success');
      } catch (e) {
        $('garlic-progress-text').textContent = 'Error: ' + e.message;
        showToast('Failed to start worker: ' + e.message, 'error');
      } finally {
        _garlicBusy = false;
        $('btn-garlic-start').disabled = false;
      }
    });

    // Live progress events
    window.pork.on('garlic:progress', ({ msg, percent }) => {
      const txt = $('garlic-progress-text');
      const bar = $('garlic-progress-bar');
      if (txt) txt.textContent = msg;
      if (bar && percent != null) bar.style.width = Math.min(100, percent) + '%';
    });
  }
}

function _garlicShowProgress(show) {
  $('garlic-progress-area').hidden = !show;
  if (show) {
    $('garlic-progress-text').textContent = 'Starting…';
    $('garlic-progress-bar').style.width  = '0%';
  }
}


let _lazyIconCancel = false;

// Fetch icons from prosperopatches.com for cheat entries not already in the icon map.
// Throttled at one request per 500 ms, capped at 100 entries, cancellable.
async function lazyFetchCheatIcons(cusaIds) {
  _lazyIconCancel = true;                        // cancel any prior run
  await new Promise(r => setTimeout(r, 20));     // let prior loop see the flag
  _lazyIconCancel = false;

  const toFetch = cusaIds.slice(0, 100);
  for (let i = 0; i < toFetch.length; i++) {
    if (_lazyIconCancel) break;
    const id = toFetch[i];
    try {
      const { iconUrl } = await window.pork.prosperoFetchIcon(id);
      if (_lazyIconCancel) break;
      if (iconUrl) {
        _cheatIconMap.set(id, iconUrl);
        // Update every visible card for this game
        document.querySelectorAll(`.cheat-card[data-cusa="${id}"]`).forEach(card => {
          const empty = card.querySelector('.cheat-card-icon-empty');
          if (!empty) return;
          const img = document.createElement('img');
          img.className = 'cheat-card-icon';
          img.alt = '';
          img.src = iconUrl;
          img.onerror = () => { img.style.display = 'none'; };
          empty.replaceWith(img);
        });
      }
    } catch (_) {}
    if (!_lazyIconCancel && i < toFetch.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function renderCheatResults(query) {
  const list  = $('cheats-list');
  const empty = $('cheats-empty');
  list.innerHTML = '<div class="empty-msg">Loading…</div>';
  empty.hidden = true;

  try {
    // Both cheatsAll() and cheatsSearch() return flat rows: { cusa_id, title, file_count }
    const rows = query
      ? await window.pork.cheatsSearch(query)
      : await window.pork.cheatsAll();

    list.innerHTML = '';
    if (!rows || rows.length === 0) {
      empty.hidden = false;
      return;
    }

    for (const row of rows) {
      const card = document.createElement('div');
      card.className = 'cheat-card';
      card.dataset.cusa = row.cusa_id;
      const fc      = row.file_count ?? 1;
      const iconUrl = _cheatIconMap.get(row.cusa_id) || '';
      const iconHtml = iconUrl
        ? `<img src="${escHtml(iconUrl)}" class="cheat-card-icon" alt="" onerror="this.style.display='none'">`
        : `<div class="cheat-card-icon cheat-card-icon-empty"></div>`;
      card.innerHTML = `
        <div class="cheat-card-header">
          ${iconHtml}
          <div class="cheat-card-info">
            <div class="cheat-card-title-row">
              <span class="cheat-card-id">${escHtml(row.cusa_id)}</span>
              <span class="cheat-card-title">${escHtml(row.title || row.cusa_id)}</span>
            </div>
            <span class="cheat-card-meta">${fc} version${fc !== 1 ? 's' : ''} cached</span>
          </div>
        </div>`;
      list.appendChild(card);
    }

    // Background-fetch icons for entries that have no icon in the map
    const missing = rows.filter(r => r.cusa_id && !_cheatIconMap.get(r.cusa_id)).map(r => r.cusa_id);
    if (missing.length > 0) lazyFetchCheatIcons(missing);
  } catch (e) {
    list.innerHTML = `<div class="empty-msg" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// Renders per-version file block inside modal cheat panel (has full data field)
function renderCheatFileBlock(f) {
  let parsed;
  try { parsed = typeof f.data === 'string' ? JSON.parse(f.data) : f.data; } catch (_) { parsed = null; }
  const mods = parsed?.mods ?? [];
  const modsHtml = mods.map(m => `
    <div class="cheat-mod-row">
      <span class="cheat-mod-name">${escHtml(m.name || '?')}</span>
      <span class="cheat-mod-type">${escHtml(m.type || '')}</span>
    </div>`).join('');

  return `
    <div class="cheat-file-block">
      <div class="cheat-file-ver">v${escHtml(f.version || '?')} <span style="opacity:.55;font-size:.8em">${escHtml(f.filename || '')}</span></div>
      <div class="cheat-mod-list">${modsHtml || '<span style="opacity:.45">No mods parsed</span>'}</div>
    </div>`;
}

async function renderUnmatchedCheats() {
  const section = $('cheats-unmatched-section');
  const list    = $('cheats-unmatched-list');
  const badge   = $('cheats-unmatched-count');

  try {
    const rows = await window.pork.cheatsUnmatched();
    if (!rows || rows.length === 0) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    badge.textContent = rows.length;

    list.innerHTML = rows.map(r => `
      <div class="cheat-unmatched-row" data-filename="${escHtml(r.filename)}">
        <div class="cheat-unmatched-info">
          <span class="cheat-unmatched-title">${escHtml(r.title || r.filename)}</span>
          <span class="cheat-unmatched-file">${escHtml(r.filename)}</span>
        </div>
        <div class="cheat-unmatched-assign">
          <input type="text" class="unmatched-cusa-input" placeholder="CUSA00000" maxlength="9" spellcheck="false" aria-label="Assign game ID"/>
          <button class="btn btn-sm btn-accent btn-assign-cusa">Assign</button>
        </div>
      </div>`).join('');
  } catch (e) {
    section.hidden = false;
    list.innerHTML = `<div class="empty-msg" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// Assign CUSA ID delegation
$('cheats-unmatched-list').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-assign-cusa');
  if (!btn) return;
  const row      = btn.closest('.cheat-unmatched-row');
  const filename = row?.dataset.filename;
  const input    = row?.querySelector('.unmatched-cusa-input');
  const cusaId   = input?.value.trim().toUpperCase();

  if (!filename || !cusaId || !/^[A-Z]{4}\d{5}$/.test(cusaId)) {
    input?.focus();
    input?.classList.add('input-error');
    setTimeout(() => input?.classList.remove('input-error'), 1200);
    return;
  }

  btn.disabled = true;
  btn.textContent = '…';
  try {
    await window.pork.cheatsAssign(filename, cusaId);
    row.style.opacity = '0';
    row.style.transition = 'opacity .3s';
    setTimeout(() => renderUnmatchedCheats(), 320);
    // Refresh stats / matched list
    loadCheats();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Assign';
    setStatus(`Assign failed: ${err.message}`, 'error');
  }
});

// Search input (debounced)
$('cheats-search').addEventListener('input', () => {
  clearTimeout(_cheatsSearchTimer);
  _cheatsSearchTimer = setTimeout(() => {
    const q = $('cheats-search').value.trim();
    renderCheatResults(q);
    if (!q) renderUnmatchedCheats();
    else $('cheats-unmatched-section').hidden = true;
  }, 350);
});

// Download-all
$('btn-cheats-download-all').addEventListener('click', async () => {
  _cheatsDownloading = true;
  $('cheats-dl-panel').hidden = false;
  $('cheats-dl-title').textContent = 'Fetching cheat index…';
  $('cheats-dl-bar').style.width = '0%';
  $('cheats-dl-count').textContent = '0 / 0';
  $('cheats-dl-pct').textContent = '0%';
  $('cheats-dl-saved').textContent = 'Saved: 0';
  $('cheats-dl-failed').textContent = 'Failed: 0';
  $('cheats-dl-eta').textContent = 'ETA: —';
  $('cheats-dl-current').textContent = '';
  $('btn-cheats-download-all').disabled = true;
  try {
    await window.pork.cheatsDownloadAll();
  } catch (e) {
    _cheatsDownloading = false;
    $('cheats-dl-title').textContent = `Error: ${e.message}`;
    $('btn-cheats-download-all').disabled = false;
  }
});

// Cancel download
$('btn-cheats-dl-cancel').addEventListener('click', async () => {
  await window.pork.cheatsCancel();
  $('cheats-dl-title').textContent = 'Cancelling…';
});

// Progress IPC events
window.pork.on('cheats:dl:start', ({ total }) => {
  $('cheats-dl-title').textContent = `Downloading cheat database…`;
  $('cheats-dl-count').textContent = `0 / ${total}`;
  $('cheats-dl-bar').style.width = '0%';
});

window.pork.on('cheats:dl:progress', ({ done, total, saved, failed, etaSec, current, pct }) => {
  $('cheats-dl-bar').style.width  = `${pct}%`;
  $('cheats-dl-count').textContent = `${done} / ${total}`;
  $('cheats-dl-pct').textContent   = `${pct}%`;
  $('cheats-dl-saved').textContent  = `Saved: ${saved}`;
  $('cheats-dl-failed').textContent = `Failed: ${failed}`;
  $('cheats-dl-eta').textContent    = `ETA: ${fmtEta(etaSec)}`;
  $('cheats-dl-current').textContent = current || '';
});

window.pork.on('cheats:dl:done', ({ saved, failed, cancelled }) => {
  _cheatsDownloading = false;
  $('cheats-dl-bar').style.width = cancelled ? $('cheats-dl-bar').style.width : '100%';
  $('cheats-dl-title').textContent = cancelled
    ? `Download cancelled — ${saved} saved, ${failed} failed`
    : `Done — ${saved} saved, ${failed} failed`;
  $('cheats-dl-pct').textContent   = cancelled ? '' : '100%';
  $('cheats-dl-eta').textContent   = '';
  $('cheats-dl-current').textContent = '';
  $('btn-cheats-download-all').disabled = false;
  // Refresh stats + list
  loadCheats();
});

// ── Cheats FTP install ─────────────────────────────────────────────────────────

$('btn-cheats-ftp-install').addEventListener('click', async () => {
  // Reset panel to instruction state
  $('cheats-ftp-progress-wrap').hidden = true;
  $('cheats-ftp-bar').style.width = '0%';
  $('cheats-ftp-phase').textContent = 'Preparing…';
  $('cheats-ftp-count').textContent = '';
  $('cheats-ftp-pct').textContent = '0%';
  $('cheats-ftp-current').textContent = '';
  $('cheats-ftp-title').textContent = 'Install Cheats via FTP';
  $('btn-cheats-ftp-go').disabled = false;
  $('btn-cheats-ftp-go').textContent = '↑ Install Now';
  // Populate path from settings
  const s = await window.pork.getSettings();
  const configuredPath = (s.cheatsRemotePath || '').trim();
  $('cheats-ftp-path').value = configuredPath || '/data/etaHEN/cheats/';
  $('cheats-ftp-no-path-warn').hidden = !!configuredPath;
  $('cheats-ftp-panel').hidden = false;
});

$('btn-cheats-ftp-browse').addEventListener('click', async () => {
  const cur = $('cheats-ftp-path').value.trim() || '/';
  const p = await openFtpBrowser(cur);
  if (p) $('cheats-ftp-path').value = p;
});

$('btn-cheats-ftp-close').addEventListener('click', () => {
  $('cheats-ftp-panel').hidden = true;
});

$('btn-cheats-ftp-go').addEventListener('click', async () => {
  $('btn-cheats-ftp-go').disabled = true;
  $('btn-cheats-ftp-go').textContent = 'Installing…';
  $('cheats-ftp-progress-wrap').hidden = false;
  try {
    const remotePath = $('cheats-ftp-path').value.trim() || '/data/etaHEN/cheats/';
    await window.pork.cheatsFtpInstall(remotePath);
  } catch (e) {
    $('cheats-ftp-title').textContent = `Error: ${e.message}`;
    $('btn-cheats-ftp-go').disabled = false;
    $('btn-cheats-ftp-go').textContent = '↑ Retry';
  }
});

window.pork.on('cheats:ftp:start', ({ total }) => {
  $('cheats-ftp-count').textContent = `0 / ${total}`;
});

window.pork.on('cheats:ftp:progress', ({ phase, done, total, pct, current }) => {
  $('cheats-ftp-bar').style.width  = `${pct}%`;
  $('cheats-ftp-pct').textContent  = `${pct}%`;
  $('cheats-ftp-count').textContent = `${done} / ${total}`;
  $('cheats-ftp-phase').textContent = phase === 'write' ? 'Writing files…' : 'Uploading to PS5…';
  $('cheats-ftp-current').textContent = current || '';
});

window.pork.on('cheats:ftp:done', ({ count }) => {
  $('cheats-ftp-bar').style.width   = '100%';
  $('cheats-ftp-pct').textContent   = '100%';
  $('cheats-ftp-phase').textContent = `Done — ${count} cheats installed`;
  $('cheats-ftp-current').textContent = '';
  $('cheats-ftp-title').textContent  = 'Install complete ✓';
  $('btn-cheats-ftp-go').disabled    = false;
  $('btn-cheats-ftp-go').textContent = '↑ Install Again';
});

// ── Cheats modal panel ─────────────────────────────────────────────────────────

async function renderCheatsPanel(game) {
  const body  = $('modal-cheats-body');
  const badge = $('mtab-cheats-count');
  body.innerHTML = '<div class="prospero-placeholder">Loading cheats…</div>';
  badge.textContent = '';

  try {
    const cusaId = game.game_id;
    const files  = await window.pork.cheatsForGame(cusaId);

    if (!files || files.length === 0) {
      // Nothing cached — offer to fetch on-demand
      body.innerHTML = `
        <div class="modal-cheat-fetch">
          <p>No cached cheats found for <code>${escHtml(cusaId)}</code>.</p>
          <button id="btn-modal-fetch-cheats" class="btn btn-accent">Fetch from Repository</button>
        </div>`;
      $('btn-modal-fetch-cheats').addEventListener('click', async () => {
        $('btn-modal-fetch-cheats').disabled = true;
        $('btn-modal-fetch-cheats').textContent = 'Fetching…';
        try {
          const index = await window.pork.cheatsFetchIndex();
          const matching = index.filter(e => e.cusaId === cusaId);
          if (matching.length === 0) {
            body.innerHTML = `<div class="prospero-placeholder">No cheats found in repository for ${escHtml(cusaId)}.</div>`;
            return;
          }
          // Download each matching file via the download-all path is overkill;
          // just inform and direct to the Cheats page to cache all.
          body.innerHTML = `
            <div class="modal-cheat-fetch">
              <p>Found <strong>${matching.length}</strong> cheat file(s) for ${escHtml(cusaId)} in the repository.</p>
              <p style="opacity:.7">Use <em>Cache All Cheats</em> on the Cheats page to download the full database, then come back here.</p>
            </div>`;
        } catch (e) {
          body.innerHTML = `<div class="prospero-placeholder" style="color:var(--red)">Fetch failed: ${escHtml(e.message)}</div>`;
        }
      });
      return;
    }

    badge.textContent = files.length;
    const modCount = files.reduce((n, f) => {
      try { const d = typeof f.data === 'string' ? JSON.parse(f.data) : f.data; return n + (d?.mods?.length ?? 0); } catch (_) { return n; }
    }, 0);

    body.innerHTML = files.map(f => renderCheatFileBlock(f)).join('');
    badge.textContent = `${modCount}`;
  } catch (e) {
    body.innerHTML = `<div class="prospero-placeholder" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// ── External links — open in default browser via shell ────────────────────────
document.addEventListener('click', e => {
  const link = e.target.closest('a.external-link[data-url]');
  if (link) { e.preventDefault(); window.pork.openShell(link.dataset.url); }
});

// ── Pin button — toggle card pinned to dashboard ──────────────────────────────
document.addEventListener('click', async e => {
  const btn = e.target.closest('.btn-pin');
  if (!btn) return;
  e.stopPropagation(); // prevent tile nav from firing if btn is inside a tile
  const pinId = btn.dataset.pinId;
  if (!pinId) return;
  const s      = await window.pork.getSettings();
  const pinned = new Set(s.pinnedCards || []);
  if (pinned.has(pinId)) pinned.delete(pinId);
  else                   pinned.add(pinId);
  await window.pork.setSettings({ pinnedCards: [...pinned] });
  // Update pin button visuals everywhere
  document.querySelectorAll(`.btn-pin[data-pin-id="${pinId}"]`).forEach(b =>
    b.classList.toggle('pinned', pinned.has(pinId))
  );
  // If on dashboard, refresh pinned grid immediately
  if (document.querySelector('#page-dashboard.active')) renderPinnedTiles();
});

// ── Dashboard pinned tile — navigate on click ─────────────────────────────────
document.addEventListener('click', e => {
  const tile = e.target.closest('.dash-pinned-tile[data-nav-page]');
  if (tile) navigate(tile.dataset.navPage);
});

// ── Title bar ─────────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click', () => window.pork.minimize());
$('btn-max').addEventListener('click', () => window.pork.maximize());
$('btn-cls').addEventListener('click', () => window.pork.close());
$('sidebar-donate').addEventListener('click', () => window.pork.openDonate());
$('titlebar-x-link').addEventListener('click', e => {
  e.preventDefault();
  window.pork.openShell('https://x.com/StonedModder');
});

// ── Conversion job updates ────────────────────────────────────────────────────
window.pork.on('conv:job-update', (job) => {
  if (document.querySelector('#page-games.active')) {
    patchConvJobCard(job);
  }
});
window.pork.on('conv:queue:paused-change', () => {
  if (document.querySelector('#page-games.active')) {
    refreshConvQueuePanel().catch(() => {});
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // Load settings and dashboard in parallel — they're independent IPC calls.
  const [s] = await Promise.all([
    window.pork.getSettings(),
    loadSettings(),
    loadDashboard(),
  ]);

  // Restore FTP connection state immediately so the UI isn't blank while devices enumerate.
  let connected = false;
  try {
    ({ connected } = await window.pork.ftpStatus());
    setConnected(connected);
  } catch (_) {}

  if (!connected && s.autoConnect && s.ftpHost) {
    setStatus('Auto-connecting…');
    try {
      const autoPorts = (s.ftpPorts && s.ftpPorts.length) ? s.ftpPorts : ['1337', '2121', '21'];
      await window.pork.ftpConnect({
        host:     s.ftpHost,
        ports:    autoPorts,
        user:     s.ftpUser || '',
        password: s.ftpPass || '',
      });
      setConnected(true);
      setStatus('Connected', 'ok');
      $('sb-sync').textContent = `Connected at ${new Date().toLocaleTimeString()}`;
    } catch (_) {
      setConnected(false);
      setStatus('Auto-connect failed — enter credentials and connect manually', 'error');
    }
  }

  // Enumerate capture devices in the background — this calls getUserMedia which
  // can take several seconds; don't block connection state or the rest of init.
  enumerateSvDevices().then(() => {
    const videoSel = $('sv-video-device');
    const audioSel = $('sv-audio-device');
    if (s.svVideoDevice && [...videoSel.options].some(o => o.value === s.svVideoDevice))
      videoSel.value = s.svVideoDevice;
    if (s.svAudioDevice && [...audioSel.options].some(o => o.value === s.svAudioDevice))
      audioSel.value = s.svAudioDevice;
    if (s.svResolution) $('sv-resolution').value = s.svResolution;

    if (s.svAutoLoad) {
      const videoId    = videoSel.value;
      const audioId    = audioSel.value;
      const resolution = $('sv-resolution').value;
      window.pork.openSystemViewPopout(videoId, audioId, resolution).catch(() => {});
    }
  }).catch(() => {});

  // Keep device list fresh whenever the OS adds/removes a device
  navigator.mediaDevices.addEventListener('devicechange', () => enumerateSvDevices().catch(() => {}));
})();
