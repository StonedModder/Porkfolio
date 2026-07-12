// ── VoidShell (native) ────────────────────────────────────────────────────────
let _vsInterval         = null;
let _vsFsProgInterval   = null;
let _vsPkgProgInterval  = null;
let _vsInitialized      = false;
let _vsLibrary          = [];
let _vsConfig           = {};
let _vsFavs             = new Set((() => {
  try { return JSON.parse(localStorage.getItem('vs-favs') || '[]'); }
  catch { return []; } // corrupt localStorage shouldn't break module load
})());
let _vsFavOnly          = false;
let _vsSort             = 'name';
let _vsSearch           = '';
let _vsPkgFile          = null;
let _vsActiveGame       = '';
let _vsHasSuccessfulRefresh = false;
const _vsImgCache       = {};
let _vsPanels = {
  left:  { path: '/mnt/usb0', selection: null },
  right: { path: '/data',     selection: null },
};

function pauseVoidshellPolling() {
  if (_vsInterval) clearInterval(_vsInterval);
  _vsInterval = null;
}

async function loadVoidshell(options = {}) {
  const background = !!options.background;
  const s = await window.pork.getSettings();
  const ip   = s.ftpHost || '';
  const port = s.voidshellPort || 7007;
  $('vs-ip-display').textContent = ip || '(not set — configure FTP Settings)';
  $('vs-port').value             = port;
  $('s-voidshell-port').value    = port;
  if (!ip) {
    pauseVoidshellPolling();
    return;
  }
  if (!_vsInitialized) { _vsInitialized = true; _vsInitEvents(); }
  if (background && !_vsHasSuccessfulRefresh) {
    pauseVoidshellPolling();
    return;
  }
  await _vsRefreshAll({ silent: background });
  pauseVoidshellPolling();
  if (!background) _vsInterval = setInterval(_vsRefreshStats, 5000);
}

// — Helpers —
async function _vsGet(path)              { return window.pork.vsRequest(path); }
async function _vsPost(path, body, t)    { return window.pork.vsPost(path, body, t); }
async function _vsPkgGet(path)           { return window.pork.vsPkgRequest(path); }
async function _vsPkgPost(path, body, t) { return window.pork.vsPkgPost(path, body, t); }

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

async function _vsLoadImg(imgEl, primaryPath, fallbackPath) {
  const el = typeof imgEl === 'string' ? $(imgEl) : imgEl;
  if (!el) return;
  // Check cache
  const cached = _vsImgCache[primaryPath];
  if (cached) { el.src = cached; return; }
  const src = await window.pork.vsImage(primaryPath);
  if (src) {
    _vsImgCache[primaryPath] = src;
    el.src = src;
  } else if (fallbackPath) {
    const src2 = await window.pork.vsImage(fallbackPath);
    if (src2) { _vsImgCache[primaryPath] = src2; el.src = src2; }
  }
}

// — Tab switching —
function _vsSwitchTab(name) {
  document.querySelectorAll('.vs-tab').forEach(t => t.classList.toggle('active', t.dataset.vsTab === name));
  document.querySelectorAll('.vs-pane').forEach(p => p.classList.toggle('active', p.id === `vs-pane-${name}`));
  if (name === 'logs')     _vsLoadLogs();
  if (name === 'settings') _vsLoadSettings();
  if (name === 'payloads') _vsLoadPayloads();
  if (name === 'pkg')      _vsLoadPkgs();
  if (name === 'files')    { _vsLoadPanel('left'); _vsLoadPanel('right'); }
}

// — Stats & Library —
async function _vsRefreshAll(options = {}) {
  const [statsOk, libraryOk] = await Promise.all([
    _vsRefreshStats(options),
    _vsRefreshLibrary(options),
  ]);
  if (statsOk || libraryOk) _vsHasSuccessfulRefresh = true;
}

async function _vsRefreshStats(options = {}) {
  const silent = !!options.silent;
  try {
    const r = await _vsGet('/api/stats');
    if (r.ok) {
      _vsApplyStats(r.data);
      return true;
    }
  } catch(e) {
    if (!silent) console.error('[VS] stats', e);
  }
  return false;
}

async function _vsRefreshLibrary(options = {}) {
  const silent = !!options.silent;
  try {
    const r = await _vsGet('/api/library');
    if (r.ok) {
      _vsLibrary = r.data.games || [];
      _vsRenderGrid();
      return true;
    }
  } catch(e) {
    if (!silent) console.error('[VS] library', e);
  }
  return false;
}

function _vsApplyStats(s) {
  // active_game is empty string or 'MENU' when no game is running
  const hasGame = s.active_game && s.active_game !== 'MENU' && s.active_game !== '';
  _vsActiveGame = hasGame ? s.active_game : '';
  // Status bar
  $('vs-username').textContent    = s.username || '—';
  $('vs-active-game').textContent = hasGame ? `${s.active_game}` : 'No game running';
  $('vs-temp-soc').textContent    = `${s.soc}°C `;
  $('vs-temp-cpu').textContent    = `${s.cpu}°C `;
  $('vs-uptime').textContent      = s.sys_uptime || '—';
  if (s.userid) _vsLoadImg('vs-avatar', `/api/avatar?id=${s.userid}&rev=${s.userid}`);
  // Hero
  $('vs-hero-title').textContent  = hasGame ? _vsGameName(s.active_game) : 'No game running';
  $('vs-hero-id').textContent     = hasGame ? s.active_game : '';
  $('btn-vs-close-game').hidden   = !hasGame;
  if (hasGame) {
    _vsLoadImg('vs-hero-art', `/assets/pic?id=${s.active_game}`, `/assets/icon?id=${s.active_game}`);
  } else {
    const el = $('vs-hero-art'); if (el) el.src = '';
  }
  // Stat cards
  $('vs-stat-soc').textContent    = `${s.soc}°C`;
  $('vs-stat-cpu').textContent    = `${s.cpu}°C`;
  $('vs-stat-uptime').textContent = s.sys_uptime || '—';
  $('vs-stat-lib').textContent    = `${s.total || 0}`;
  $('vs-stat-lib-sub').textContent = s.ps != null ? `PS: ${s.ps}` : '';
  // Keep pinned VS dashboard tiles fresh while the stats interval runs
  if (document.querySelector('#page-dashboard.active')) _updateVsDashTiles().catch(() => {});
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
        <div class="vs-card-name">${escHtml(g.name)}</div>
        <div class="vs-card-meta">${escHtml(g.id)} · v${escHtml(g.version)}</div>
        <div class="vs-card-actions">
          <button class="btn btn-xs btn-accent vs-btn-launch" data-id="${g.id}">▶</button>
          <button class="btn btn-xs vs-btn-fav${isFav ? ' active' : ''}" data-id="${g.id}">★</button>
        </div>
      </div>`;
    grid.appendChild(card);
    _vsLoadImg(`vs-art-${g.id}`, `/assets/pic?id=${g.id}`, `/assets/icon?id=${g.id}`);
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
    // Update safety lock checkbox from server response
    const safetyEl = $('vs-safety-mode');
    if (safetyEl && r.data.safety_lock != null) {
      safetyEl.checked = r.data.safety_lock === true || r.data.safety_lock === 'true';
    }
    _vsRenderPanel(side, r.data.items || []);
  } catch(e) { listEl.innerHTML = `<div class="vs-empty-msg vs-err">Error: ${e.message}</div>`; }
}

function _vsRenderPanel(side, items) {
  const listEl = $(`vs-list-${side}`);
  _vsPanels[side].selection = null;
  if (!items.length) { listEl.innerHTML = '<div class="vs-empty-msg">Empty</div>'; return; }
  items.sort((a, b) => {
    const aDir = a.is_dir === true || String(a.is_dir) === 'true';
    const bDir = b.is_dir === true || String(b.is_dir) === 'true';
    return bDir - aDir || a.name.localeCompare(b.name);
  });
  listEl.innerHTML = '';
  for (const item of items) {
    const isDir = item.is_dir === true || String(item.is_dir) === 'true';
    const el = document.createElement('div');
    el.className      = 'vs-fs-item' + (isDir ? ' vs-fs-dir' : '');
    el.dataset.name   = item.name;
    const sz = isDir ? '' : `<span class="vs-fs-size">${_vsFormatBytes(item.size || 0)}</span>`;
    el.innerHTML = `<span class="vs-fs-icon">${isDir ? '📁' : '📄'}</span><span class="vs-fs-name">${escHtml(item.name)}</span>${sz}`;
    el.addEventListener('click', () => {
      if (isDir) {
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
  const srcPath = (src.path.replace(/\/$/, '') + '/' + src.selection).replace('//', '/');
  const dstPath = (_vsPanels[dstSide].path.replace(/\/$/, '') + '/' + src.selection).replace('//', '/');
  try {
    // POST /api/fs/copy or /api/fs/move with plain text "srcPath|dstPath"
    const r = await _vsPost(`/api/fs/${op}`, `${srcPath}|${dstPath}`, 'text');
    if (r.data && r.data.status === 'started') {
      showToast(`${op.toUpperCase()} started`, 'ok');
      _vsStartFsProgress();
    } else {
      showToast(r.data?.msg || 'Failed to start', 'error');
    }
  } catch(e) { showToast(`${op} failed: ${e.message}`, 'error'); }
}

async function _vsFsDelete(side) {
  const panel = _vsPanels[side];
  if (!panel.selection) { showToast('Select a file first', 'error'); return; }
  const path = (panel.path.replace(/\/$/, '') + '/' + panel.selection).replace('//', '/');
  try {
    // POST /api/fs/delete with plain text path
    const r = await _vsPost('/api/fs/delete', path, 'text');
    const status = r.data?.status || r.data;
    if (status === 'started' || status === 'ok') {
      showToast('Deletion started', 'ok');
      _vsStartFsProgress();
    } else {
      showToast(r.data?.msg || 'Delete failed', 'error');
      _vsLoadPanel(side);
    }
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
      const isBusy = p.busy === true || p.busy === 'true';
      $('vs-fs-prog-lbl').textContent  = `${p.task || ''}: ${p.file || ''} (${p.speed || ''})`;
      $('vs-fs-prog-fill').style.width = `${p.percent || 0}%`;
      $('vs-fs-prog-pct').textContent  = `${p.percent || 0}%`;
      if (!isBusy) {
        clearInterval(_vsFsProgInterval);
        _vsFsProgInterval = null;
        setTimeout(() => { const w = $('vs-fs-prog-wrap'); if (w) w.hidden = true; }, 2000);
        _vsLoadPanel('left');
        _vsLoadPanel('right');
      }
    } catch {}
  }, 1000);
}

// — PKG Manager (port 9200) —
async function _vsLoadPkgs() {
  const el = $('vs-pkg-temp-list');
  if (!el) return;
  el.innerHTML = '<div class="vs-empty-msg">Loading…</div>';
  try {
    const r = await _vsPkgGet(`/list?t=${Date.now()}`);
    const files = r.ok ? (r.data.files || []) : [];
    if (!files.length) { el.innerHTML = '<div class="vs-empty-msg">No packages queued.</div>'; return; }
    el.innerHTML = '';
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'vs-pkg-temp-row';
      row.innerHTML = `
        <span class="vs-pkg-temp-name">${escHtml(f.name || f.path)}</span>
        <button class="btn btn-xs btn-accent vs-btn-pkg-install" data-path="${escHtml(f.path)}">Install</button>
        <button class="btn btn-xs btn-red vs-btn-pkg-delete" data-path="${escHtml(f.path)}">✕</button>`;
      row.querySelector('.vs-btn-pkg-install').addEventListener('click', async () => {
        try {
          await _vsPkgPost('/install_existing', f.path, 'text');
          showToast(`Installing: ${f.name || f.path}`, 'ok');
          _vsStartPkgProgress();
        } catch(e) { showToast('Install failed: ' + e.message, 'error'); }
      });
      row.querySelector('.vs-btn-pkg-delete').addEventListener('click', async () => {
        try {
          await _vsPkgPost('/delete', f.path, 'text');
          showToast('Deleted', 'ok');
          setTimeout(_vsLoadPkgs, 500);
        } catch(e) { showToast('Delete failed: ' + e.message, 'error'); }
      });
      el.appendChild(row);
    }
  } catch { el.innerHTML = '<div class="vs-empty-msg">Could not reach PKG server (port 9200).</div>'; }
}

function _vsStartPkgProgress() {
  if (_vsPkgProgInterval) return; // already polling
  _vsPkgProgInterval = setInterval(async () => {
    try {
      const r = await _vsPkgGet('/progress');
      if (!r.ok) return;
      const d = r.data;
      if (!d.busy) {
        clearInterval(_vsPkgProgInterval);
        _vsPkgProgInterval = null;
        showToast('Installation complete', 'ok');
        _vsLoadPkgs();
      }
    } catch {
      clearInterval(_vsPkgProgInterval);
      _vsPkgProgInterval = null;
    }
  }, 1000);
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
      <input type="number" class="vs-pl-seq vs-num-input" value="${p.order || 0}" min="0" max="99" title="Order">
      <span class="vs-payload-name">${escHtml(p.name)}</span>
      <button class="btn btn-xs btn-accent vs-btn-inject" data-name="${escHtml(p.name)}">Inject</button>`;
    el.appendChild(row);
  }
}

async function _vsInjectPayload(name) {
  try {
    // POST /api/send_payload with plain text filename
    await _vsPost('/api/send_payload', name, 'text');
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
    // POST /api/save_ini with plain text INI body
    await _vsPost('/api/save_ini', _vsSerializeIni(_vsConfig), 'text');
    showToast('Payload config saved', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
}

// — Settings (INI) —
function _vsParseIni(text) {
  const cfg = {};
  let section = null;
  for (const rawLine of (text || '').split('\n')) {
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
    // POST /api/save_ini with plain text INI body
    await _vsPost('/api/save_ini', _vsSerializeIni(_vsConfig), 'text');
    showToast('Settings saved', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
}

// — Logs —
let _vsLogInterval = null;
async function _vsLoadLogs() {
  try {
    const r = await _vsGet('/api/logs');
    _vsRenderLogs(r.data);
  } catch(e) { console.error('[VS] logs', e); }
  // Auto-refresh logs every 2s while logs tab is active
  if (_vsLogInterval) clearInterval(_vsLogInterval);
  _vsLogInterval = setInterval(async () => {
    if (!document.getElementById('vs-pane-logs')?.classList.contains('active')) {
      clearInterval(_vsLogInterval); _vsLogInterval = null; return;
    }
    try {
      const r = await _vsGet('/api/logs');
      _vsRenderLogs(r.data);
    } catch {}
  }, 2000);
}

function _vsRenderLogs(text) {
  const el = $('vs-log-terminal');
  if (!el) return;
  el.innerHTML = '';
  for (const line of (text || '').split('\n').filter(Boolean)) {
    const div = document.createElement('div');
    div.className  = 'vs-log-line';
    if (line.includes('[WARDEN]'))       div.classList.add('vs-log-warden');
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
      // POST /api/launch with plain text game ID
      _vsPost('/api/launch', lb.dataset.id, 'text')
        .then(() => { showToast(`Launching ${lb.dataset.id}…`, 'ok'); setTimeout(_vsRefreshStats, 3000); })
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
    try {
      // POST /api/rescan with no body
      await _vsPost('/api/rescan');
      showToast('Rescan triggered', 'ok');
      setTimeout(_vsRefreshLibrary, 3000);
    } catch(e) { showToast('Rescan failed: ' + e.message, 'error'); }
  });
  $('btn-vs-close-game')?.addEventListener('click', async () => {
    if (!_vsActiveGame) return;
    try {
      // POST /api/game/close with plain text game ID
      await _vsPost('/api/game/close', _vsActiveGame, 'text');
      showToast('Close sent', 'ok');
      setTimeout(_vsRefreshStats, 3000);
    } catch(e) { showToast('Close failed: ' + e.message, 'error'); }
  });

  // Files — safety toggle
  $('vs-safety-mode')?.addEventListener('change', async () => {
    try {
      // POST /api/fs/safety with no body — server toggles the state
      await _vsPost('/api/fs/safety');
      // Reload dir to get updated safety_lock from server
      _vsLoadPanel('left');
    } catch(e) { showToast('Safety toggle failed: ' + e.message, 'error'); }
  });

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
      // POST ${PKG_HOST}/api/install_url with plain text URL
      await _vsPkgPost('/api/install_url', url, 'text');
      showToast('Remote install started', 'ok');
      $('vs-pkg-url').value = '';
      _vsStartPkgProgress();
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
      // Upload to PKG server (port 9200): POST /upload?name=<filename>
      await window.pork.vsPkgUpload(_vsPkgFile.name, data);
      showToast('PKG uploaded — ready to install', 'ok');
      _vsPkgFile = null;
      $('vs-pkg-selected').textContent = 'No file selected';
      $('btn-vs-pkg-upload').disabled  = true;
      _vsLoadPkgs();
    } catch(e) { showToast('Upload failed: ' + e.message, 'error'); }
  });
  $('btn-vs-clear-temp')?.addEventListener('click', async () => {
    try {
      // POST /api/fs/delete with plain text path to voidPKG temp folder
      await _vsPost('/api/fs/delete', '/user/data/voidshell/voidPKG_temp', 'text');
      showToast('Temp files cleared', 'ok');
      setTimeout(_vsLoadPkgs, 800);
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
    try {
      // POST /api/fs/delete with body = cache path
      await _vsPost('/api/fs/delete', '/data/voidshell/cache', 'text');
      showToast('Image cache cleared', 'ok');
    } catch(e) { showToast('Failed: ' + e.message, 'error'); }
  });
  $('btn-vs-repair')?.addEventListener('click', async () => {
    try {
      // POST /api/repair with no body
      await _vsPost('/api/repair');
      showToast('Repair triggered', 'ok');
    } catch(e) { showToast('Failed: ' + e.message, 'error'); }
  });

  // Logs
  $('btn-vs-clear-logs')?.addEventListener('click', async () => {
    try {
      // POST /api/logs/clear with no body
      await _vsPost('/api/logs/clear');
      showToast('Logs cleared', 'ok');
      _vsLoadLogs();
    } catch(e) { showToast('Failed: ' + e.message, 'error'); }
  });

  // ⚙ Pin panel — toggle on button click
  $('btn-vs-pin-settings')?.addEventListener('click', e => {
    e.stopPropagation();
    _vsPopulatePinPanel();
  });

  // Close pin panel when clicking outside it
  document.addEventListener('click', e => {
    const panel = $('vs-pin-panel');
    if (panel && !panel.hidden &&
        !e.target.closest('#vs-pin-panel') &&
        !e.target.closest('#btn-vs-pin-settings')) {
      panel.hidden = true;
    }
  });
}

async function _vsPopulatePinPanel() {
  const panel = $('vs-pin-panel');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }

  const s      = await window.pork.getSettings();
  const pinned = new Set(s.pinnedCards || []);
  const vsCards = PINNABLE_CARDS.filter(c => c.type === 'vs' || c.type === 'vs-widget');

  panel.innerHTML =
    `<div class="vs-pin-panel-title">Pin to Dashboard</div>` +
    vsCards.map(c => `
      <div class="vs-pin-panel-item">
        <button class="btn-pin${pinned.has(c.id) ? ' pinned' : ''}" data-pin-id="${escHtml(c.id)}" title="Toggle pin">&#128204;</button>
        <div>
          <div class="vs-pin-panel-item-label">${escHtml(c.label)}</div>
          <div class="vs-pin-panel-item-hint">${escHtml(c.hint)}</div>
        </div>
      </div>`).join('');

  panel.hidden = false;
}

// Toolbar buttons (outside VS body, keep working)
$('btn-vs-load').addEventListener('click', async () => {
  const s  = await window.pork.getSettings();
  const ip = s.ftpHost || '';
  if (!ip) { showToast('PS5 IP not set. Configure FTP Settings first.', 'error'); return; }
  // Don't reset _vsInitialized — loadVoidshell() already re-runs _vsRefreshAll and
  // restarts polling. Resetting it re-ran _vsInitEvents on every click, re-binding
  // all listeners and leaking a new permanent document click handler each time.
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
