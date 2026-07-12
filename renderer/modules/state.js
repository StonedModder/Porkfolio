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
const _pageLoadTimestamps  = new Map();
const _pageLoadModes       = new Map();
const _pageLoadInFlight    = new Map();
let _pageWarmTimer         = null;
let _pageWarmRunning       = false;

const _PAGE_WARM_ORDER = [
  'games', 'backups', 'backporks', 'transfers', 'settings',
  'database', 'jailbreak', 'psnotify', 'xavatar', 'media',
  'cheats', 'garlic', 'elf-arsenal', 'pfs-ripper', 'savemgr', 'system-view',
];

const _PAGE_STALE_MS = {
  dashboard: 15_000,
  transfers: 5_000,
  'system-view': 20_000,
  voidshell: 20_000,
  media: 30_000,
  default: 45_000,
};

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

function _isNarrowLayout() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function setMobileNavOpen(open) {
  document.body.classList.toggle('mobile-nav-open', !!open && _isNarrowLayout());
  const scrim = $('sidebar-scrim');
  if (scrim) scrim.hidden = !document.body.classList.contains('mobile-nav-open');
}

function closeMobileNav() {
  setMobileNavOpen(false);
}

function _pageLoader(page, background = false) {
  const loaders = {
    dashboard:   () => loadDashboard(),
    games:       () => loadGames(),
    backporks:   () => loadBackporks(),
    backups:     () => loadBackups(),
    database:    () => loadDatabase(),
    settings:    () => loadSettings({ background }),
    jailbreak:   () => loadJailbreak(),
    psnotify:    () => loadPsNotify(),
    xavatar:     () => loadXavatar(),
    'system-view': () => loadSystemView(background ? { passive: true } : {}),
    transfers:   () => loadTransfers(),
    media:       () => loadMedia(),
    cheats:      () => loadCheats(),
    garlic:      () => loadGarlic(),
    voidshell:   () => loadVoidshell({ background }),
    'elf-arsenal': () => (typeof loadElfArsenal === 'function' ? loadElfArsenal({ background }) : null),
    'pfs-ripper': () => (typeof loadPfsRipper === 'function' ? loadPfsRipper({ background }) : null),
    savemgr:     () => loadSaveMgr({ background }),
  };
  return loaders[page] || null;
}

function _pageStaleMs(page) {
  return _PAGE_STALE_MS[page] || _PAGE_STALE_MS.default;
}

function pageIsStale(page) {
  const last = _pageLoadTimestamps.get(page) || 0;
  return (Date.now() - last) > _pageStaleMs(page);
}

function ensurePageReady(page, { background = false, force = false } = {}) {
  const loader = _pageLoader(page, background);
  if (!loader) return Promise.resolve();
  const needsActiveHydrate = !background && _pageLoadModes.get(page) === 'background';
  if (!force && !needsActiveHydrate && !pageIsStale(page)) return _pageLoadInFlight.get(page) || Promise.resolve();
  if (_pageLoadInFlight.has(page)) return _pageLoadInFlight.get(page);
  const run = Promise.resolve()
    .then(() => loader())
    .then(() => {
      _pageLoadTimestamps.set(page, Date.now());
      const priorMode = _pageLoadModes.get(page);
      _pageLoadModes.set(page, background && priorMode === 'active' ? 'active' : (background ? 'background' : 'active'));
    })
    .catch(err => console.warn(`[page-load] ${page} failed:`, err))
    .finally(() => {
      if (_pageLoadInFlight.get(page) === run) _pageLoadInFlight.delete(page);
    });
  _pageLoadInFlight.set(page, run);
  return run;
}

function scheduleBackgroundWarm(delay = 600) {
  if (_pageWarmTimer || _pageWarmRunning) return;
  _pageWarmTimer = setTimeout(() => {
    _pageWarmTimer = null;
    startBackgroundWarm().catch(() => {});
  }, delay);
}

async function startBackgroundWarm() {
  if (_pageWarmRunning) return;
  _pageWarmRunning = true;
  try {
    for (const page of _PAGE_WARM_ORDER) {
      const active = document.querySelector('.page.active')?.id?.replace('page-', '');
      if (page === active) continue;
      await ensurePageReady(page, { background: true });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    _pageWarmRunning = false;
    scheduleBackgroundWarm(_PAGE_STALE_MS.default);
  }
}

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
  { id: 'payload-mgr',     label: 'Payload Sender',      page: 'jailbreak', type: 'widget', hint: 'Quick-send a payload to PS5 via TCP.' },
  { id: 'psnotify',        label: 'Send Notification',   page: 'psnotify',  type: 'widget', hint: 'Send a PS5 notification from the dashboard.' },
  { id: 'xavatar-convert', label: 'XAvatar Quick Send',  page: 'xavatar',   type: 'widget', hint: 'Convert an image and send to PS5 as .xavatar.' },
  { id: 'xavatar-library', label: 'XAvatar Library',     page: 'xavatar',      hint: 'Manage .xavatar files on your PS5.' },
  { id: 'transfers',       label: 'Transfer Manager',    page: 'transfers',    hint: 'Monitor active and queued FTP transfers.' },
  { id: 'games',           label: 'Games Library',       page: 'games',        hint: 'Browse and manage your PS5 game collection.' },
  { id: 'cheats',          label: 'Cheats',              page: 'cheats',       hint: 'Browse and install game cheats.' },
  { id: 'media',           label: 'Media',               page: 'media',        hint: 'Browse screenshots and video clips from PS5.' },
  { id: 'system-view',     label: 'System View',         page: 'system-view',  hint: 'View your PS5 via capture card stream.' },
  { id: 'backups',         label: 'Backups',             page: 'backups',      hint: 'Browse and manage game backup files.' },
  // VoidShell live-stat tiles
  { id: 'vs-temp-apu',    label: 'VS: APU Temp',        page: 'voidshell', type: 'vs', stat: 'soc',        hint: 'Live APU temperature from VoidShell.' },
  { id: 'vs-temp-cpu',    label: 'VS: CPU Temp',        page: 'voidshell', type: 'vs', stat: 'cpu',        hint: 'Live CPU temperature from VoidShell.' },
  { id: 'vs-uptime',      label: 'VS: Uptime',          page: 'voidshell', type: 'vs', stat: 'sys_uptime', hint: 'PS5 system uptime from VoidShell.' },
  { id: 'vs-active-game', label: 'VS: Active Game',     page: 'voidshell', type: 'vs', stat: 'active_game',hint: 'Currently running game on PS5.' },
  { id: 'vs-library',     label: 'VS: Library',         page: 'voidshell', type: 'vs', stat: 'total',      hint: 'Total installed games on PS5.' },
  { id: 'vs-user',        label: 'VS: User',            page: 'voidshell', type: 'vs', stat: 'username',   hint: 'Active PS5 user account.' },
  // VoidShell widget tiles
  { id: 'vs-logs',        label: 'VS: Logs',            page: 'voidshell', type: 'vs-widget', hint: 'Live VoidShell log tail on the dashboard.' },
  // Other page widgets
  { id: 'dash-savemgr',  label: 'Save Manager',        page: 'savemgr',   type: 'widget',    hint: 'Browse and download PS5 save files.' },
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
  const previousPage = document.querySelector('.page.active')?.id?.replace('page-', '');
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));

  // Embed pages need #content to be overflow:hidden so the iframe can fill available height
  const isEmbed = (page === 'voidshell' || page === 'savemgr');
  document.getElementById('content').classList.toggle('embed-page-active', isEmbed);
  if (previousPage === 'voidshell' && page !== 'voidshell' && typeof pauseVoidshellPolling === 'function') {
    pauseVoidshellPolling();
  }
  ensurePageReady(page, { force: pageIsStale(page) });
  scheduleBackgroundWarm(800);
  closeMobileNav();
  syncPinStates();
}

$('mobile-nav-toggle')?.addEventListener('click', () => {
  setMobileNavOpen(!document.body.classList.contains('mobile-nav-open'));
});

$('sidebar-scrim')?.addEventListener('click', closeMobileNav);

window.addEventListener('resize', () => {
  if (!_isNarrowLayout()) closeMobileNav();
});

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

