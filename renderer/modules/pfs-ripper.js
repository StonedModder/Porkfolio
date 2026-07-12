// ── PFS Ripper — PS5 PFS/image library browser ───────────────────────────────
// Native port of Deckerr97's "PFS Ripper": browse a library of PS5 image files,
// show cover art (ProsperoPatches), search, view PPSA IDs + versions, export.

let _pfsInit = false;
let _pfsItems = [];
let _pfsSearch = '';
const _pfsIconCache = new Map();

function _pfsEsc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s ?? ''); }
function _pfsToast(m, k) { if (typeof showToast === 'function') showToast(m, k); }
function _pfsFmt(n) {
  if (!n) return '';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function _pfsBuildUI() {
  const root = document.getElementById('page-pfs-ripper');
  if (!root) return;
  root.innerHTML = `
    <div class="voidshell-toolbar">
      <div class="voidshell-controls">
        <span class="embed-page-title">PFS Ripper</span>
        <button id="pfs-add"    class="btn btn-sm">＋ Add Folder</button>
        <button id="pfs-rescan" class="btn btn-xs">⟳ Rescan</button>
        <span id="pfs-count" class="hint"></span>
      </div>
      <div class="voidshell-controls">
        <input id="pfs-search" type="text" placeholder="Search title or ID…" style="width:220px" />
      </div>
    </div>
    <div id="pfs-folders" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px"></div>
    <div id="pfs-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:12px"></div>`;

  document.getElementById('pfs-add').addEventListener('click', async () => {
    await window.pork.pfsFoldersAdd();
    await _pfsRenderFolders();
    await _pfsScan();
  });
  document.getElementById('pfs-rescan').addEventListener('click', () => _pfsScan());
  document.getElementById('pfs-search').addEventListener('input', e => {
    _pfsSearch = e.target.value.toLowerCase();
    _pfsRenderGrid();
  });
}

async function _pfsRenderFolders() {
  const el = document.getElementById('pfs-folders');
  if (!el) return;
  const folders = (await window.pork.pfsFoldersList().catch(() => [])) || [];
  if (!folders.length) {
    el.innerHTML = '<span class="hint">No library folders yet — click “Add Folder”.</span>';
    return;
  }
  el.innerHTML = folders.map(f =>
    `<span class="pill" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border);border-radius:12px;font-size:12px">
       <code style="font-size:11px">${_pfsEsc(f)}</code>
       <button class="btn btn-xs btn-red pfs-folder-rm" data-folder="${_pfsEsc(f)}" title="Remove">✕</button>
     </span>`).join('');
  el.querySelectorAll('.pfs-folder-rm').forEach(b =>
    b.addEventListener('click', async () => {
      await window.pork.pfsFoldersRemove(b.dataset.folder);
      await _pfsRenderFolders();
      await _pfsScan();
    }));
}

async function _pfsScan() {
  const grid = document.getElementById('pfs-grid');
  if (grid) grid.innerHTML = '<div class="vs-empty-msg" style="padding:16px">Scanning…</div>';
  _pfsItems = (await window.pork.pfsScan().catch(() => [])) || [];
  _pfsRenderGrid();
}

function _pfsFiltered() {
  if (!_pfsSearch) return _pfsItems;
  return _pfsItems.filter(it =>
    (it.gameId || '').toLowerCase().includes(_pfsSearch) ||
    (it.file || '').toLowerCase().includes(_pfsSearch));
}

function _pfsRenderGrid() {
  const grid = document.getElementById('pfs-grid');
  const countEl = document.getElementById('pfs-count');
  if (!grid) return;
  const list = _pfsFiltered();
  if (countEl) countEl.textContent = `${list.length} image${list.length !== 1 ? 's' : ''}`;
  if (!list.length) {
    grid.innerHTML = '<div class="vs-empty-msg" style="padding:16px">No images found. Add a folder containing .ffpkg / .pkg / .exfat images.</div>';
    return;
  }
  grid.innerHTML = list.map((it, i) => `
    <div class="pfs-card" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column">
      <div class="pfs-art" data-gid="${_pfsEsc(it.gameId)}" style="aspect-ratio:1;background:rgba(var(--accent-rgb),.08);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-dim)">
        ${it.gameId ? _pfsEsc(it.gameId) : '—'}
      </div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:2px;flex:1">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_pfsEsc(it.file)}">${_pfsEsc(it.gameId || it.file)}</div>
        <div class="hint" style="font-size:11px">
          <span class="pill-num" style="padding:0 4px">${_pfsEsc(it.ext)}</span>
          ${it.version ? ' v' + _pfsEsc(it.version) : ''} · ${_pfsFmt(it.size)}
        </div>
        <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
          <button class="btn btn-xs pfs-export"  data-i="${i}" title="Copy to a folder">Export</button>
          <button class="btn btn-xs pfs-ftp"     data-i="${i}" title="Send to PS5 via FTP">→ PS5</button>
          <button class="btn btn-xs pfs-reveal"  data-i="${i}" title="Show in Explorer">📂</button>
        </div>
      </div>
    </div>`).join('');

  // Lazy-load cover art via ProsperoPatches.
  grid.querySelectorAll('.pfs-art[data-gid]').forEach(el => {
    const gid = el.dataset.gid;
    if (!gid) return;
    _pfsLoadArt(gid, el);
  });

  grid.querySelectorAll('.pfs-export').forEach(b => b.addEventListener('click', () => _pfsExport(list[+b.dataset.i])));
  grid.querySelectorAll('.pfs-ftp').forEach(b => b.addEventListener('click', () => _pfsFtp(list[+b.dataset.i])));
  grid.querySelectorAll('.pfs-reveal').forEach(b => b.addEventListener('click', () => window.pork.pfsReveal(list[+b.dataset.i].path)));
}

async function _pfsLoadArt(gid, el) {
  try {
    let url = _pfsIconCache.get(gid);
    if (url === undefined) {
      url = await window.pork.prosperoFetchIcon(gid).catch(() => null);
      _pfsIconCache.set(gid, url || null);
    }
    if (url && el.isConnected) {
      el.innerHTML = `<img src="${_pfsEsc(url)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">`;
    }
  } catch (_) { /* leave the ID placeholder */ }
}

async function _pfsExport(it) {
  if (!it) return;
  try {
    const r = await window.pork.pfsExportCopy(it.path);
    if (r && r.ok) _pfsToast('Exported to ' + r.dest, 'ok');
  } catch (e) { _pfsToast('Export failed: ' + e.message, 'error'); }
}

async function _pfsFtp(it) {
  if (!it) return;
  try {
    await window.pork.pfsExportFtp(it.path);
    _pfsToast('Queued upload to PS5 — see Transfers', 'ok');
  } catch (e) { _pfsToast('Send failed: ' + e.message, 'error'); }
}

// Entry point invoked by the page router (state.js pageLoaders).
async function loadPfsRipper() {
  if (!_pfsInit) { _pfsInit = true; _pfsBuildUI(); }
  await _pfsRenderFolders();
  await _pfsScan();
}
