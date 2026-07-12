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

