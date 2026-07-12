// ── ELF Arsenal (successor to VoidShell) ─────────────────────────────────────
// Dual-pane PS5 file manager + ELF launcher, driven by the ELF Arsenal web API
// on :6969 (proxied through the main process via window.pork.ea*). Ported from
// elf-arsenal/assets/app.js (the /api/fs/* surface) into Porkfolio's UI shell.

let _eaInit = false;
const _eaState = {
  left:  { path: localStorage.getItem('ea_path_left')  || '/data', sel: null },
  right: { path: localStorage.getItem('ea_path_right') || '/mnt/usb0', sel: null },
};
let _eaConnected = false;

function _eaEsc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s ?? ''); }
function _eaToast(msg, kind) { if (typeof showToast === 'function') showToast(msg, kind); }

function _eaFmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function _eaNormalize(p) {
  if (!p) return '/';
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function _eaParent(p) {
  p = _eaNormalize(p);
  if (p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function _eaJoin(dir, name) {
  return _eaNormalize((dir === '/' ? '' : dir) + '/' + name);
}

function _eaBuildUI() {
  const root = document.getElementById('page-elf-arsenal');
  if (!root) return;
  const pane = (side) => `
    <div class="ea-pane" data-side="${side}" style="display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <div class="ea-pane-head" style="display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid var(--border);background:rgba(var(--accent-rgb),.05)">
        <button class="btn btn-xs ea-up" data-side="${side}" title="Up one level">↑</button>
        <input class="ea-path" data-side="${side}" value="${_eaEsc(_eaState[side].path)}" spellcheck="false"
               style="flex:1;font-family:monospace;font-size:12px" />
        <button class="btn btn-xs ea-go" data-side="${side}">Go</button>
      </div>
      <div class="ea-list" id="ea-list-${side}" data-side="${side}" style="flex:1;overflow:auto;min-height:220px"></div>
      <div class="ea-pane-actions" style="display:flex;flex-wrap:wrap;gap:4px;padding:6px;border-top:1px solid var(--border)">
        <button class="btn btn-xs ea-mkdir"    data-side="${side}">＋ Folder</button>
        <button class="btn btn-xs ea-rename"   data-side="${side}">Rename</button>
        <button class="btn btn-xs btn-red ea-delete" data-side="${side}">Delete</button>
        <button class="btn btn-xs ea-download" data-side="${side}">Download</button>
        <button class="btn btn-xs ea-launch"   data-side="${side}">▶ Launch</button>
        <button class="btn btn-xs ea-copy"     data-side="${side}">Copy →</button>
        <button class="btn btn-xs ea-move"     data-side="${side}">Move →</button>
      </div>
    </div>`;

  root.innerHTML = `
    <div class="voidshell-toolbar">
      <div class="voidshell-controls">
        <span class="embed-page-title">ELF Arsenal</span>
        <span id="ea-conn-status" class="hint">Not connected</span>
        <button id="ea-btn-connect" class="btn btn-sm">Connect</button>
        <button id="ea-btn-refresh" class="btn btn-xs">⟳ Refresh</button>
        <button id="ea-btn-upload"  class="btn btn-xs">⬆ Upload…</button>
      </div>
      <div class="voidshell-controls" id="ea-usb-bar" style="gap:4px"></div>
    </div>
    <div id="ea-job" hidden style="margin:0 12px 8px;padding:8px 12px;border:1px solid var(--border);border-radius:6px">
      <span id="ea-job-text" class="hint"></span>
      <button id="ea-job-cancel" class="btn btn-xs btn-red" style="margin-left:8px">Cancel</button>
    </div>
    <div id="ea-panes" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;min-height:0">
      ${pane('left')}
      ${pane('right')}
    </div>`;

  // ── Toolbar ────────────────────────────────────────────────────────────────
  document.getElementById('ea-btn-connect').addEventListener('click', () => eaConnect(true));
  document.getElementById('ea-btn-refresh').addEventListener('click', () => { eaLoadDir('left'); eaLoadDir('right'); });
  document.getElementById('ea-btn-upload').addEventListener('click', () => eaUpload('left'));
  document.getElementById('ea-job-cancel').addEventListener('click', async () => {
    await window.pork.eaJobCancel().catch(() => {});
    _eaToast('Job cancel requested', 'info');
  });

  // ── Per-pane controls (delegated) ───────────────────────────────────────────
  root.querySelectorAll('.ea-up').forEach(b => b.addEventListener('click', () => {
    const side = b.dataset.side; eaNav(side, _eaParent(_eaState[side].path));
  }));
  root.querySelectorAll('.ea-go').forEach(b => b.addEventListener('click', () => {
    const side = b.dataset.side; eaNav(side, root.querySelector(`.ea-path[data-side="${side}"]`).value);
  }));
  root.querySelectorAll('.ea-path').forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') eaNav(inp.dataset.side, inp.value);
  }));
  root.querySelectorAll('.ea-mkdir').forEach(b => b.addEventListener('click', () => eaMkdir(b.dataset.side)));
  root.querySelectorAll('.ea-rename').forEach(b => b.addEventListener('click', () => eaRename(b.dataset.side)));
  root.querySelectorAll('.ea-delete').forEach(b => b.addEventListener('click', () => eaDelete(b.dataset.side)));
  root.querySelectorAll('.ea-download').forEach(b => b.addEventListener('click', () => eaDownload(b.dataset.side)));
  root.querySelectorAll('.ea-launch').forEach(b => b.addEventListener('click', () => eaLaunch(b.dataset.side)));
  root.querySelectorAll('.ea-copy').forEach(b => b.addEventListener('click', () => eaTransfer(b.dataset.side, 'copy')));
  root.querySelectorAll('.ea-move').forEach(b => b.addEventListener('click', () => eaTransfer(b.dataset.side, 'move')));

  // File list click delegation
  ['left', 'right'].forEach(side => {
    const list = document.getElementById(`ea-list-${side}`);
    list.addEventListener('click', e => {
      const row = e.target.closest('.ea-fs-item');
      if (!row) return;
      if (row.dataset.dir === '1') { eaNav(side, _eaJoin(_eaState[side].path, row.dataset.name)); }
      else { _eaSelect(side, row.dataset.name); }
    });
    list.addEventListener('dblclick', e => {
      const row = e.target.closest('.ea-fs-item');
      if (row && row.dataset.dir === '1') eaNav(side, _eaJoin(_eaState[side].path, row.dataset.name));
    });
  });
}

function _eaSelect(side, name) {
  _eaState[side].sel = name;
  const list = document.getElementById(`ea-list-${side}`);
  if (!list) return;
  list.querySelectorAll('.ea-fs-item').forEach(r =>
    r.classList.toggle('ea-selected', r.dataset.name === name));
}

async function eaConnect(userTriggered) {
  const statusEl = document.getElementById('ea-conn-status');
  if (statusEl) statusEl.textContent = 'Connecting…';
  const v = await window.pork.eaVersion().catch(() => ({ connected: false }));
  _eaConnected = !!v.connected;
  if (statusEl) {
    if (v.connected) {
      statusEl.textContent = `Connected${v.tag ? ' · ' + v.tag : ''}`;
      statusEl.style.color = 'var(--green)';
    } else {
      statusEl.textContent = 'Offline — is ELF Arsenal running on :6969?';
      statusEl.style.color = 'var(--red)';
    }
  }
  if (v.connected) {
    eaLoadUsb();
    eaLoadDir('left');
    eaLoadDir('right');
  } else if (userTriggered) {
    _eaToast('Could not reach ELF Arsenal on the PS5 (:6969). Check IP and that ELF Arsenal is running.', 'error');
  }
}

async function eaLoadUsb() {
  const bar = document.getElementById('ea-usb-bar');
  if (!bar) return;
  const usb = await window.pork.eaUsb().catch(() => null);
  const mounts = usb && (usb.mounts || usb.entries || usb.devices) || [];
  const quick = [
    { label: '/data', path: '/data' },
    { label: 'usb0', path: '/mnt/usb0' },
    { label: 'ext', path: '/mnt/ext0' },
    { label: '/system_data', path: '/system_data' },
    ...(Array.isArray(mounts) ? mounts.map(m => ({ label: (m.name || m.path || '').split('/').pop() || m, path: m.path || m })) : []),
  ];
  bar.innerHTML = quick.map(qk =>
    `<button class="btn btn-xs ea-quick" data-path="${_eaEsc(qk.path)}" title="Open in left pane">${_eaEsc(qk.label)}</button>`).join('');
  bar.querySelectorAll('.ea-quick').forEach(b =>
    b.addEventListener('click', () => eaNav('left', b.dataset.path)));
}

function eaNav(side, path) {
  _eaState[side].path = _eaNormalize(path);
  _eaState[side].sel = null;
  const inp = document.querySelector(`.ea-path[data-side="${side}"]`);
  if (inp) inp.value = _eaState[side].path;
  localStorage.setItem(`ea_path_${side}`, _eaState[side].path);
  eaLoadDir(side);
}

async function eaLoadDir(side) {
  const list = document.getElementById(`ea-list-${side}`);
  if (!list) return;
  list.innerHTML = '<div class="vs-empty-msg" style="padding:12px">Loading…</div>';
  try {
    const data = await window.pork.eaList(_eaState[side].path);
    const entries = (data.entries || []).slice().sort((a, b) =>
      (a.is_dir === b.is_dir) ? a.name.localeCompare(b.name) : (a.is_dir ? -1 : 1));
    if (!entries.length) { list.innerHTML = '<div class="vs-empty-msg" style="padding:12px">Empty</div>'; return; }
    list.innerHTML = entries.map(e => `
      <div class="ea-fs-item vs-fs-item${e.is_dir ? ' vs-fs-dir' : ''}" data-name="${_eaEsc(e.name)}" data-dir="${e.is_dir ? '1' : '0'}"
           style="display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer">
        <span class="vs-fs-icon">${e.is_dir ? '📁' : '📄'}</span>
        <span class="vs-fs-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_eaEsc(e.name)}</span>
        <span class="vs-fs-size" style="opacity:.6;font-size:11px">${e.is_dir ? '' : _eaFmtSize(e.size)}</span>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="vs-empty-msg vs-err" style="padding:12px;color:var(--red)">Error: ${_eaEsc(e.message)}</div>`;
  }
}

function _eaSelected(side) {
  const name = _eaState[side].sel;
  if (!name) { _eaToast('Select a file first', 'info'); return null; }
  return { name, full: _eaJoin(_eaState[side].path, name) };
}

async function eaMkdir(side) {
  const name = await showPrompt('New folder name:', '');
  if (!name) return;
  try {
    await window.pork.eaMkdir(_eaJoin(_eaState[side].path, name));
    _eaToast('Folder created', 'ok'); eaLoadDir(side);
  } catch (e) { _eaToast('Create failed: ' + e.message, 'error'); }
}

async function eaRename(side) {
  const sel = _eaSelected(side); if (!sel) return;
  const name = await showPrompt('Rename to:', sel.name);
  if (!name || name === sel.name) return;
  try {
    await window.pork.eaRename(sel.full, _eaJoin(_eaState[side].path, name));
    _eaToast('Renamed', 'ok'); _eaState[side].sel = null; eaLoadDir(side);
  } catch (e) { _eaToast('Rename failed: ' + e.message, 'error'); }
}

async function eaDelete(side) {
  const sel = _eaSelected(side); if (!sel) return;
  if (!(await showConfirm(`Delete ${sel.full} from your PS5? This cannot be undone.`))) return;
  try {
    await window.pork.eaDelete(sel.full, true);
    _eaToast('Deleted', 'ok'); _eaState[side].sel = null; eaLoadDir(side);
  } catch (e) { _eaToast('Delete failed: ' + e.message, 'error'); }
}

async function eaDownload(side) {
  const sel = _eaSelected(side); if (!sel) return;
  try {
    const r = await window.pork.eaDownload(sel.full, sel.name);
    if (r && r.ok) _eaToast('Downloaded to ' + r.filePath, 'ok');
  } catch (e) { _eaToast('Download failed: ' + e.message, 'error'); }
}

function eaUpload(side) {
  // In Electron a file <input> exposes the absolute path via file.path — no extra IPC needed.
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f || !f.path) return;
    try {
      const remote = _eaJoin(_eaState[side].path, f.name);
      await window.pork.eaUpload(f.path, remote);
      _eaToast('Uploaded', 'ok'); eaLoadDir(side);
    } catch (e) { _eaToast('Upload failed: ' + e.message, 'error'); }
  });
  inp.click();
}

async function eaLaunch(side) {
  const sel = _eaSelected(side); if (!sel) return;
  if (!/\.(elf|bin)$/i.test(sel.name)) {
    if (!(await showConfirm(`${sel.name} isn't an .elf/.bin — launch anyway via hbldr?`))) return;
  }
  try {
    await window.pork.eaLaunch(sel.full, null, false);
    _eaToast('Launched ' + sel.name, 'ok');
  } catch (e) { _eaToast('Launch failed: ' + e.message, 'error'); }
}

// Copy/Move the selected item to the OTHER pane's current directory.
async function eaTransfer(fromSide, op) {
  const sel = _eaSelected(fromSide); if (!sel) return;
  const toSide = fromSide === 'left' ? 'right' : 'left';
  const dest = _eaJoin(_eaState[toSide].path, sel.name);
  if (dest === sel.full) { _eaToast('Source and destination are the same', 'info'); return; }
  const jobEl = document.getElementById('ea-job');
  const jobTx = document.getElementById('ea-job-text');
  if (jobEl) jobEl.hidden = false;
  if (jobTx) jobTx.textContent = `${op === 'copy' ? 'Copying' : 'Moving'} ${sel.name} → ${_eaState[toSide].path}…`;
  try {
    if (op === 'copy') await window.pork.eaCopy(sel.full, dest);
    else               await window.pork.eaMove(sel.full, dest);
    // Poll the fs job until it drains (copy/move can be long-running).
    let guard = 0;
    while (guard++ < 100000) {
      const st = await window.pork.eaJobStatus().catch(() => ({ busy: false }));
      if (!st || !st.busy) break;
      if (jobTx && st.progress != null) jobTx.textContent = `${op === 'copy' ? 'Copying' : 'Moving'} ${sel.name}… ${st.progress}%`;
      await new Promise(r => setTimeout(r, 500));
    }
    _eaToast(op === 'copy' ? 'Copied' : 'Moved', 'ok');
    _eaState[fromSide].sel = null;
    eaLoadDir(fromSide); eaLoadDir(toSide);
  } catch (e) {
    _eaToast(`${op} failed: ` + e.message, 'error');
  } finally {
    if (jobEl) jobEl.hidden = true;
  }
}

// Entry point invoked by the page router (state.js pageLoaders).
async function loadElfArsenal(options = {}) {
  if (!_eaInit) { _eaInit = true; _eaBuildUI(); }
  // Reconnect/refresh whenever the page is shown (skip noisy toast on background warm).
  await eaConnect(false);
}
