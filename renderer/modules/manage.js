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

