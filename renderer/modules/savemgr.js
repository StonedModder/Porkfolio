// ── Local Save Manager (native GarlicMgr UI) ────────────────────────────────

// ── State ───────────────────────────────────────────────────────────────────
const smState = {
  saves: [], selectedIdx: -1, mounted: false,
  files: [], expanded: new Set(),
  busy: false, tab: 'browse',
};
let _smHasSuccessfulWarm = false;

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
async function loadSaveMgr(options = {}) {
  const background = !!options.background;
  const s = await window.pork.getSettings();
  const ip   = s.ftpHost || '';
  const port = s.savemgrPort || 8082;
  $('sm-ip-display').textContent = ip || '(not set — configure FTP Settings)';
  $('sm-port').value = port;
  const ssp = $('s-savemgr-port'); if (ssp) ssp.value = port;
  if (ip && (!background || _smHasSuccessfulWarm)) await smFetchSaves();
}

async function smFetchSaves() {
  try {
    const d = await window.pork.savemgrRequest('/api/saves');
    smState.saves = d.saves || [];
    _smHasSuccessfulWarm = true;
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

