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

