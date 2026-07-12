// ── Accent color picker ────────────────────────────────────────────────────────
$('s-accent-color').addEventListener('input', async e => {
  const hex = e.target.value;
  applyAccent(hex);
  $('s-accent-hex').value = hex.toUpperCase();
  await window.pork.setSettings({ accentColor: hex });
});

// Hex text field — let user type a hex value directly
$('s-accent-hex').addEventListener('input', e => {
  const raw = e.target.value.trim();
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    applyAccent(hex);
    window.pork.setSettings({ accentColor: hex });
  }
});

$('btn-reset-accent').addEventListener('click', async () => {
  const def = '#BB86FC';
  applyAccent(def);
  await window.pork.setSettings({ accentColor: def });
  setStatus('Accent color reset to default', 'ok');
});

// ── Confirm dialog helper ──────────────────────────────────────────────────────
function showConfirm(message) {
  return new Promise(resolve => {
    $('confirm-message').textContent = message;
    $('confirm-overlay').hidden = false;

    function cleanup(result) {
      $('confirm-overlay').hidden = true;
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
  });
}

// ── Prompt (input) dialog helper ─────────────────────────────────────────────
function showPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    $('prompt-message').textContent = message;
    $('prompt-input').value = defaultValue;
    $('prompt-overlay').hidden = false;
    setTimeout(() => $('prompt-input').focus(), 50);

    function cleanup(result) {
      $('prompt-overlay').hidden = true;
      $('prompt-ok').removeEventListener('click', onOk);
      $('prompt-cancel').removeEventListener('click', onCancel);
      $('prompt-input').removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk()     { cleanup($('prompt-input').value); }
    function onCancel() { cleanup(null); }
    function onKey(e)   { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); }
    $('prompt-ok').addEventListener('click', onOk);
    $('prompt-cancel').addEventListener('click', onCancel);
    $('prompt-input').addEventListener('keydown', onKey);
  });
}

// ── Destination picker (for upload/pork when multiple remote paths are configured) ──

function showDestinationPicker(paths) {
  return new Promise(resolve => {
    const list = $('dest-picker-list');
    list.innerHTML = paths.map((p, i) => `
      <button class="dest-picker-option" data-idx="${i}">
        <span class="dest-opt-label">${escHtml(p.label)}</span>
        <span class="dest-opt-path">${escHtml(p.path)}</span>
      </button>
    `).join('');
    $('dest-picker-overlay').hidden = false;

    let resolved = false;
    function cleanup(result) {
      if (resolved) return;
      resolved = true;
      $('dest-picker-overlay').hidden = true;
      // #dest-picker-cancel is a persistent element; remove our handler so it
      // doesn't accumulate across opens when the user picks an option instead.
      $('dest-picker-cancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    const onCancel = () => cleanup(null);
    // Option buttons live in list.innerHTML, which is re-rendered each open, so
    // their listeners die with the old DOM — no cleanup needed for those.
    list.querySelectorAll('.dest-picker-option').forEach((btn, i) => {
      btn.addEventListener('click', () => cleanup(paths[i]), { once: true });
    });
    $('dest-picker-cancel').addEventListener('click', onCancel);
  });
}

// Ensure a game has an ftp_path set (prompting if needed). Returns the path or null if cancelled.
async function ensureGameFtpPath(gameId) {
  const g = state.currentGame?.game_id === gameId ? state.currentGame
          : (await window.pork.listGames({})).find(x => x.game_id === gameId);

  if (g?.ftp_path) return g.ftp_path;

  // No stored path — pick one
  let basePath = null;
  if (remoteGamePaths.length === 0) {
    // No locations configured — use default, but don't store (user hasn't set up locations)
    return `/mnt/sandbox/pfsmnt/${gameId}-app0`;
  } else if (remoteGamePaths.length === 1) {
    basePath = remoteGamePaths[0].path;
  } else {
    const chosen = await showDestinationPicker(remoteGamePaths);
    if (!chosen) return null;
    basePath = chosen.path;
  }

  const ftp_path = basePath.replace(/\/?$/, '/') + gameId + '-app0';
  await window.pork.updateGame({ game_id: gameId, fields: { ftp_path } });
  if (state.currentGame?.game_id === gameId) {
    state.currentGame = { ...state.currentGame, ftp_path };
    renderManageInstallLocation(state.currentGame);
  }
  return ftp_path;
}

$('btn-refresh-all-meta').addEventListener('click', async () => {
  const ok = await showConfirm(
    'This will clear all cached Prospero metadata and re-fetch every game from scratch. ' +
    'Background fetches will queue automatically. Continue?'
  );
  if (!ok) return;

  $('btn-refresh-all-meta').disabled = true;
  setStatus('Queueing metadata refresh for all games…');
  try {
    const { queued } = await window.pork.prosperoRefreshAll();
    setStatus(`Refreshing metadata for ${queued} game(s) in background…`, 'ok');
  } catch (e) {
    setStatus(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('btn-refresh-all-meta').disabled = false;
  }
});

// ── Firmware helpers ───────────────────────────────────────────────────────────
function renderFwPills(firmware_labels) {
  if (!firmware_labels) return '<span style="color:var(--text-dim)">—</span>';
  return firmware_labels.split(',').filter(Boolean)
    .map(l => `<span class="fw-pill fw-pill-patched" title="Backporked for firmware ${escHtml(l)}">&#x1F527; ${escHtml(l)}</span>`).join('');
}

async function refreshFirmwareFilters() {
  const labels = await window.pork.firmwareLabels();
  const row    = $('firmware-filter-row');
  const cont   = $('firmware-filter-btns');

  if (!labels.length) { row.hidden = true; return; }
  row.hidden = false;

  cont.innerHTML = `<button class="fwbtn${state.firmwareFilter === 'all' ? ' active' : ''}" data-fw="all">All</button>` +
    labels.map(l => `<button class="fwbtn${state.firmwareFilter === l ? ' active' : ''}" data-fw="${escHtml(l)}">${escHtml(l)}</button>`).join('');

  cont.onclick = e => {
    const btn = e.target.closest('.fwbtn');
    if (!btn) return;
    state.firmwareFilter = btn.dataset.fw;
    cont.querySelectorAll('.fwbtn').forEach(b => b.classList.toggle('active', b.dataset.fw === state.firmwareFilter));
    renderGames();
  };
}

