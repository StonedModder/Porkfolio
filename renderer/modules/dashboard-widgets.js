'use strict';

// ── Dashboard Interactive Mini-Widgets ────────────────────────────────────────
// Renders and drives interactive tool tiles pinned to the dashboard.
// Called from connection.js renderPinnedTiles() for cards with type:'widget'
// or type:'vs-widget'.

// Off-screen canvas used by the XAvatar widget for pixel conversion
const _dwXaCanvas = document.createElement('canvas');
let _dwXaFilename = 'avatar';

// ── Render ─────────────────────────────────────────────────────────────────────
// Returns an innerHTML string for a given pinnable card.
function _renderWidgetTile(card) {
  switch (card.id) {
    case 'psnotify':
      return `
        <div class="dash-widget-hdr">&#128226; Send Notification</div>
        <input class="dash-widget-input" data-dw-key="psnotify-msg" placeholder="Message&#8230;" maxlength="120">
        <input class="dash-widget-input" data-dw-key="psnotify-sub" placeholder="Sub-message (optional)&#8230;" maxlength="120">
        <div class="dash-widget-row">
          <button class="btn btn-sm btn-teal dash-widget-btn" data-dw-action="psnotify-send">&#128226; Send</button>
          <span class="dash-widget-status" data-dw-status="psnotify"></span>
        </div>
        <div class="dash-widget-row" style="margin-top:4px">
          <button class="btn btn-sm dash-pinned-tile-open" data-nav-page="psnotify">Open &rarr;</button>
        </div>`;

    case 'payload-mgr':
      return `
        <div class="dash-widget-hdr">&#8680; Quick Payload Send</div>
        <select class="dash-widget-select" data-dw-key="payload-file">
          <option value="">Loading payloads&#8230;</option>
        </select>
        <div class="dash-widget-row">
          <span class="dash-widget-port-lbl">Port</span>
          <input type="number" class="dash-widget-port-input" data-dw-key="payload-port" value="9021" min="1" max="65535">
          <button class="btn btn-sm btn-teal dash-widget-btn" data-dw-action="payload-send">&#8680; Send</button>
          <span class="dash-widget-status" data-dw-status="payload"></span>
        </div>
        <div class="dash-widget-row" style="margin-top:4px">
          <button class="btn btn-sm dash-pinned-tile-open" data-nav-page="jailbreak">Open &rarr;</button>
        </div>`;

    case 'xavatar-convert':
      return `
        <div class="dash-widget-hdr">&#128100; XAvatar Quick Send</div>
        <div class="dash-widget-drop" data-dw-drop="xavatar">Drop image or click to browse</div>
        <div class="dash-widget-row">
          <button class="btn btn-sm dash-widget-btn" data-dw-action="xavatar-browse">Browse&#8230;</button>
          <button class="btn btn-sm btn-teal dash-widget-btn" data-dw-action="xavatar-send" disabled>&#8599; Send to PS5</button>
          <span class="dash-widget-status" data-dw-status="xavatar"></span>
        </div>
        <div class="dash-widget-row" style="margin-top:4px">
          <button class="btn btn-sm dash-pinned-tile-open" data-nav-page="xavatar">Open &rarr;</button>
        </div>`;

    case 'vs-logs':
      return `
        <div class="dash-widget-hdr">&#128203; VoidShell Logs</div>
        <div class="dash-widget-log" data-dw-log="vs-logs">&#8212;</div>
        <div class="dash-widget-row">
          <button class="btn btn-xs dash-widget-btn" data-dw-action="vs-logs-refresh">&#8635; Refresh</button>
          <button class="btn btn-xs btn-red dash-widget-btn" data-dw-action="vs-logs-clear">Clear</button>
          <button class="btn btn-xs dash-pinned-tile-open" data-nav-page="voidshell">Open &rarr;</button>
        </div>`;

    case 'dash-savemgr':
      return `
        <div class="dash-widget-hdr">&#128190; Save Manager</div>
        <div class="dash-widget-savelist" data-dw-list="savemgr">Click Reload to fetch saves.</div>
        <div class="dash-widget-row">
          <button class="btn btn-sm dash-widget-btn" data-dw-action="savemgr-reload">&#8635; Reload</button>
          <span class="dash-widget-status" data-dw-status="savemgr"></span>
          <button class="btn btn-sm dash-pinned-tile-open" data-nav-page="savemgr">Open &rarr;</button>
        </div>`;

    default:
      // Fallback: plain nav tile for unknown widget IDs
      return `
        <div class="dash-pinned-tile-title">${escHtml(card.label)}</div>
        <div class="dash-pinned-tile-hint">${escHtml(card.hint)}</div>
        <button class="btn btn-sm dash-pinned-tile-open" data-nav-page="${escHtml(card.page)}">Open &rarr;</button>`;
  }
}

// ── Post-render init ───────────────────────────────────────────────────────────
// Called immediately after the tile is appended to the DOM.
function _initWidgetTile(card, tileEl) {
  switch (card.id) {
    case 'payload-mgr':
      _dwPopulatePayloadSelect(tileEl);
      break;
    case 'xavatar-convert':
      _dwWireXavatarDrop(tileEl);
      break;
    case 'vs-logs':
      _dwVsLogsRefresh(tileEl);
      break;
    default:
      break;
  }
}

// ── Payload select population ──────────────────────────────────────────────────
async function _dwPopulatePayloadSelect(tileEl) {
  const sel = tileEl.querySelector('[data-dw-key="payload-file"]');
  if (!sel) return;
  try {
    const files = await window.pork.payloadListLocal();
    if (!files.length) {
      sel.innerHTML = '<option value="">No local payloads</option>';
      return;
    }
    sel.innerHTML = files.map(f =>
      `<option value="${escHtml(f.local_path)}|${escHtml(f.name)}">${escHtml(f.name)}</option>`
    ).join('');
  } catch (_) {
    sel.innerHTML = '<option value="">Error loading payloads</option>';
  }
}

// ── XAvatar drop-zone wiring ───────────────────────────────────────────────────
function _dwWireXavatarDrop(tileEl) {
  const drop = tileEl.querySelector('[data-dw-drop="xavatar"]');
  if (!drop) return;

  drop.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = e => {
      const file = e.target.files[0];
      if (file) _dwLoadXavatarFile(file, tileEl);
    };
    inp.click();
  });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dw-drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dw-drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dw-drag-over');
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) _dwLoadXavatarFile(file, tileEl);
  });
}

async function _dwLoadXavatarFile(file, tileEl) {
  const status  = tileEl.querySelector('[data-dw-status="xavatar"]');
  const sendBtn = tileEl.querySelector('[data-dw-action="xavatar-send"]');
  const drop    = tileEl.querySelector('[data-dw-drop="xavatar"]');
  if (status) status.textContent = 'Loading…';
  try {
    const bmp = await createImageBitmap(file);
    _dwXaCanvas.width  = bmp.width;
    _dwXaCanvas.height = bmp.height;
    _dwXaCanvas.getContext('2d').drawImage(bmp, 0, 0);
    _dwXaFilename = file.name.replace(/\.[^.]+$/, '');
    if (drop) drop.textContent = file.name;
    if (sendBtn) sendBtn.disabled = false;
    if (status) status.textContent = 'Ready';
  } catch (err) {
    if (status) status.textContent = 'Load failed';
  }
}

// ── VS Logs ────────────────────────────────────────────────────────────────────
async function _dwVsLogsRefresh(tileEl) {
  // tileEl is optional — find the log box wherever it is on the dashboard
  const logEl = tileEl
    ? tileEl.querySelector('[data-dw-log="vs-logs"]')
    : document.querySelector('[data-dw-log="vs-logs"]');
  if (!logEl) return;
  try {
    const r = await window.pork.vsRequest('/api/logs');
    if (!r || !r.ok) { logEl.textContent = '(not connected)'; return; }
    const lines = (r.data || '').split('\n').filter(Boolean);
    const tail  = lines.slice(-10);
    logEl.innerHTML = '';
    for (const line of tail) {
      const div = document.createElement('div');
      div.className = 'vs-log-line';
      if (line.includes('[WARDEN]'))       div.classList.add('vs-log-warden');
      else if (line.includes('[PAYLOAD]')) div.classList.add('vs-log-payload');
      else if (line.includes('[USER]'))    div.classList.add('vs-log-user');
      div.textContent = line;
      logEl.appendChild(div);
    }
    logEl.scrollTop = logEl.scrollHeight;
  } catch (_) {
    logEl.textContent = '(error fetching logs)';
  }
}

async function _dwVsLogsClear() {
  try {
    await window.pork.vsPost('/api/logs/clear', '', 'text');
    await _dwVsLogsRefresh();
  } catch (_) {}
}

// ── Save Manager ───────────────────────────────────────────────────────────────
async function _dwSavemgrLoad(btn) {
  const tile    = btn.closest('.dash-pinned-tile');
  const listEl  = tile?.querySelector('[data-dw-list="savemgr"]');
  const status  = tile?.querySelector('[data-dw-status="savemgr"]');
  if (!listEl) return;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  if (status) status.textContent = '';
  try {
    const r = await window.pork.savemgrRequest('/api/saves');
    const saves = typeof r === 'string' ? JSON.parse(r) : r;
    if (!saves || !saves.length) {
      listEl.textContent = 'No saves found.';
      if (status) status.textContent = '0 saves';
    } else {
      listEl.innerHTML = saves.slice(0, 8).map((s, i) =>
        `<div class="dash-dw-save-row">
          <span class="dash-dw-save-name" title="${escHtml(s.titleId || '')}">${escHtml(s.name || s.title || s.titleId || `Save ${i}`)}</span>
          <button class="btn btn-xs dash-widget-btn" data-dw-action="savemgr-dl" data-sm-idx="${i}">&#11015; ZIP</button>
        </div>`
      ).join('');
      if (status) status.textContent = `${saves.length} save${saves.length !== 1 ? 's' : ''}`;
    }
  } catch (err) {
    listEl.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = '↻ Reload';
  }
}

async function _dwSavemgrDl(btn) {
  const idx    = btn.dataset.smIdx;
  const tile   = btn.closest('.dash-pinned-tile');
  const status = tile?.querySelector('[data-dw-status="savemgr"]');
  btn.disabled = true;
  btn.textContent = '…';
  if (status) status.textContent = 'Mounting…';
  try {
    await window.pork.savemgrRequest('/api/mount?idx=' + idx);
    if (status) status.textContent = 'Downloading…';
    await window.pork.savemgrDownload('/api/download', `save_${idx}.zip`);
    if (status) status.textContent = '✓ Saved';
    setTimeout(() => { if (status) status.textContent = ''; }, 4000);
  } catch (err) {
    if (status) status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = '⬇ ZIP';
  }
}

// ── Event delegation ───────────────────────────────────────────────────────────
document.addEventListener('click', async e => {
  // "Open →" buttons inside widget tiles — navigate to the full page
  const navBtn = e.target.closest('.dash-pinned-tile-open[data-nav-page]');
  if (navBtn && navBtn.closest('.dash-pinned-tile--widget')) {
    e.stopPropagation();
    navigate(navBtn.dataset.navPage);
    return;
  }

  const btn = e.target.closest('.dash-widget-btn[data-dw-action]');
  if (!btn) return;
  e.stopPropagation();

  switch (btn.dataset.dwAction) {
    case 'psnotify-send':   await _dwPsnotifySend(btn);   break;
    case 'payload-send':    await _dwPayloadSend(btn);    break;
    case 'xavatar-browse':  _dwXavatarBrowseClick(btn);   break;
    case 'xavatar-send':    await _dwXavatarSend(btn);    break;
    case 'vs-logs-refresh': await _dwVsLogsRefresh();     break;
    case 'vs-logs-clear':   await _dwVsLogsClear();       break;
    case 'savemgr-reload':  await _dwSavemgrLoad(btn);    break;
    case 'savemgr-dl':      await _dwSavemgrDl(btn);      break;
  }
});

// ── PSNotify action ────────────────────────────────────────────────────────────
async function _dwPsnotifySend(btn) {
  const tile   = btn.closest('.dash-pinned-tile');
  const msg    = tile?.querySelector('[data-dw-key="psnotify-msg"]')?.value?.trim() || '';
  const sub    = tile?.querySelector('[data-dw-key="psnotify-sub"]')?.value?.trim() || '';
  const status = tile?.querySelector('[data-dw-status="psnotify"]');
  if (!msg) { if (status) { status.textContent = 'Message required'; status.style.color = 'var(--red)'; } return; }
  btn.disabled = true;
  if (status) { status.textContent = 'Sending…'; status.style.color = ''; }
  try {
    await window.pork.psnotifySend(msg, sub);
    if (status) { status.textContent = '✓ Sent'; status.style.color = 'var(--green)'; }
    if (tile) {
      const msgEl = tile.querySelector('[data-dw-key="psnotify-msg"]');
      const subEl = tile.querySelector('[data-dw-key="psnotify-sub"]');
      if (msgEl) msgEl.value = '';
      if (subEl) subEl.value = '';
    }
    setTimeout(() => { if (status) { status.textContent = ''; status.style.color = ''; } }, 3000);
  } catch (err) {
    if (status) { status.textContent = 'Error: ' + err.message; status.style.color = 'var(--red)'; }
  } finally {
    btn.disabled = false;
  }
}

// ── Payload action ─────────────────────────────────────────────────────────────
async function _dwPayloadSend(btn) {
  const tile   = btn.closest('.dash-pinned-tile');
  const sel    = tile?.querySelector('[data-dw-key="payload-file"]');
  const portEl = tile?.querySelector('[data-dw-key="payload-port"]');
  const status = tile?.querySelector('[data-dw-status="payload"]');
  const val    = sel?.value || '';
  if (!val) { if (status) { status.textContent = 'Pick a payload'; status.style.color = 'var(--red)'; } return; }
  const [localPath, filename] = val.split('|');
  const port = parseInt(portEl?.value || '9021', 10);
  btn.disabled = true;
  if (status) { status.textContent = 'Sending…'; status.style.color = ''; }
  try {
    await window.pork.payloadTcpSend({ localPath, port, filename });
    if (status) { status.textContent = `✓ ${filename} sent`; status.style.color = 'var(--green)'; }
    setTimeout(() => { if (status) { status.textContent = ''; status.style.color = ''; } }, 4000);
  } catch (err) {
    if (status) { status.textContent = 'Error: ' + err.message; status.style.color = 'var(--red)'; }
  } finally {
    btn.disabled = false;
  }
}

// ── XAvatar actions ────────────────────────────────────────────────────────────
function _dwXavatarBrowseClick(btn) {
  const tile = btn.closest('.dash-pinned-tile');
  const inp  = document.createElement('input');
  inp.type   = 'file';
  inp.accept = 'image/*';
  inp.onchange = e => {
    const file = e.target.files[0];
    if (file) _dwLoadXavatarFile(file, tile);
  };
  inp.click();
}

async function _dwXavatarSend(btn) {
  const tile   = btn.closest('.dash-pinned-tile');
  const status = tile?.querySelector('[data-dw-status="xavatar"]');
  if (_dwXaCanvas.width === 0) return;
  btn.disabled = true;
  if (status) { status.textContent = 'Converting…'; status.style.color = ''; }
  try {
    const ctx     = _dwXaCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, _dwXaCanvas.width, _dwXaCanvas.height);
    const rgba    = new Uint8Array(imgData.data.buffer);
    const res     = await window.pork.xavatarConvertCanvas(rgba, _dwXaCanvas.width, _dwXaCanvas.height, _dwXaFilename);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Conversion failed');
    if (status) status.textContent = 'Uploading…';
    const pad  = n => String(n).padStart(5, '0');
    const rnd  = pad(Math.floor(Math.random() * 100000));
    const name = `porkfolio${rnd}.xavatar`;
    await window.pork.xavatarUploadToPs5(res.buffer?.buffer || res.buffer, name);
    if (status) { status.textContent = `✓ Queued: ${name}`; status.style.color = 'var(--green)'; }
    setTimeout(() => { if (status) { status.textContent = ''; status.style.color = ''; } }, 5000);
  } catch (err) {
    if (status) { status.textContent = 'Error: ' + err.message; status.style.color = 'var(--red)'; }
  } finally {
    btn.disabled = false;
  }
}
