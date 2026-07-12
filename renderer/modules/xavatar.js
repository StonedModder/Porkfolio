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
    const ftpStatus = await window.pork.ftpStatus().catch(() => ({ connected: false }));
    if (!ftpStatus?.connected) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = 'Connect to PS5 FTP to browse /data/AVATARS.';
      return;
    }

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
function _xavatarBindModalButtons() {
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
}
// Bind now if the DOM is already parsed, otherwise wait — this module may be
// loaded after DOMContentLoaded has already fired.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _xavatarBindModalButtons);
else _xavatarBindModalButtons();

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
      // Native confirm() is blocked in this app — use the in-app confirm modal.
      if (!(await showConfirm(`Delete /data/AVATARS/${name} from your PS5?`))) { btn.disabled = false; return; }
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

