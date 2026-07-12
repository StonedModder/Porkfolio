'use strict';
/* global api */

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`;
  return n ? `${n} B` : '—';
}

function el(id)  { return document.getElementById(id); }
function qs(sel) { return document.querySelector(sel); }
function qsa(sel){ return [...document.querySelectorAll(sel)]; }

function pillHtml(status) {
  const labels = { queued:'Queued', running:'Running', done:'Done', error:'Error', cancelled:'Cancelled' };
  return `<span class="pill ${status}">${labels[status] || status}</span>`;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── State ─────────────────────────────────────────────────────────────────────

let settings   = {};
let games      = [];        // scanned game entries
let firmware   = [];        // firmware folders with .games[]
let jobs       = new Map(); // id → job
let patchIndex = new Map(); // game_id → Set<fw.name>  (rebuilt whenever firmware changes)
let queuePaused = true;     // mirrors main-process queuePaused flag

// ── Tabs ──────────────────────────────────────────────────────────────────────

qsa('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.tab').forEach(t => t.classList.remove('active'));
    qsa('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    el(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

function applyToolStatus(info) {
  const badge = el('tool-badge');
  const status = el('s-tool-status');
  if (info && info.toolAvailable) {
    badge.textContent  = 'UFS2Tool: OK';
    badge.className    = 'tool-badge ok';
    if (status) { status.textContent = '✓ Found'; status.style.color = 'var(--success)'; }
  } else {
    badge.textContent  = 'UFS2Tool: not configured';
    badge.className    = 'tool-badge err';
    if (status) {
      status.textContent = info?.toolPath ? '✗ File not found' : '✗ Not set';
      status.style.color = 'var(--error)';
    }
  }
  if (el('s-tool')) el('s-tool').value = (info && info.toolPath) ? info.toolPath : '';
}
function applyExfatToolStatus(info) {
  const status = el('s-exfat-tool-status');
  if (!status) return;
  if (!info) { status.textContent = ''; return; }
  el('s-exfat-tool').value = info.toolPath || '';
  if (info.toolAvailable) {
    status.textContent = '\u2713 Found (make_image.bat + New-OsfExfatImage.ps1)';
    status.style.color = 'var(--success)';
  } else if (info.toolPath && !info.psAvailable && info.batAvailable) {
    status.textContent = '\u2717 New-OsfExfatImage.ps1 missing from folder';
    status.style.color = 'var(--error)';
  } else if (info.toolPath && !info.batAvailable) {
    status.textContent = '\u2717 make_image.bat not found in folder';
    status.style.color = 'var(--error)';
  } else {
    status.textContent = info.toolPath ? '\u2717 Folder not found' : '\u2717 Not set';
    status.style.color = 'var(--error)';
  }
}
async function refreshToolStatus() {
  try {
    const info = await api.toolInfo();
    applyToolStatus(info);
    return info;
  } catch (_) { return null; }
}

async function refreshExfatToolStatus() {
  try {
    const info = await api.exfatToolInfo();
    applyExfatToolStatus(info);
    return info;
  } catch (_) { return null; }
}

async function init() {
  // tool badge
  await refreshToolStatus();
  await refreshExfatToolStatus();

  settings = await api.getSettings();
  renderSettings();

  // load queue from main (persisted across reloads via IPC)
  const existingJobs = await api.queueList();
  for (const j of existingJobs) { jobs.set(j.id, j); }
  renderQueue();

  // sync Go!! button with current paused state
  queuePaused = await api.queueIsPaused();
  updateGoButton();

  // subscribe to live job updates
  api.onJobUpdate(job => {
    jobs.set(job.id, job);
    renderQueue();
    updateQueueBadge();
    updateGoButton();
  });

  // subscribe to paused-state changes broadcast from main
  api.onQueuePausedChange(val => {
    queuePaused = val;
    updateGoButton();
  });
}

// ── Settings panel ────────────────────────────────────────────────────────────

function renderSettings() {
  el('s-tool').value   = settings.toolPath       || '';
  el('s-temp').value   = settings.tempWorkerDir  || '';
  el('s-output').value = settings.outputDir      || '';
  el('s-method').value = settings.ufs2Method     || 'makefs';
  if (el('s-exfat-tool')) el('s-exfat-tool').value = settings.exfatToolPath || '';
  applyModeVisibility(settings.gameMode || 'ffpkg');
  renderSourceChips();
  renderRootChips();
  renderNotifySettings();
}

function renderNotifySettings() {
  const enabled = !!settings.psNotifyEnabled;
  el('s-notify-enabled').checked          = enabled;
  el('s-notify-ip').value                 = settings.psNotifyIp   || '';
  el('s-notify-port').value               = settings.psNotifyPort != null ? settings.psNotifyPort : 6969;
  el('s-notify-game-queued').checked      = settings.psNotifyOnGameQueued   !== false;
  el('s-notify-batch-queued').checked     = settings.psNotifyOnBatchQueued  !== false;
  el('s-notify-copy-start').checked       = settings.psNotifyOnCopyStart    !== false;
  el('s-notify-convert-start').checked    = settings.psNotifyOnConvertStart !== false;
  el('s-notify-job-done').checked         = settings.psNotifyOnJobDone      !== false;
  el('s-notify-config').style.display     = enabled ? 'flex' : 'none';
}

function applyModeVisibility(mode) {
  const isExfat = mode === 'exfat';
  // Show/hide UFS2 method row based on mode
  const methodRow  = el('s-method-row');
  if (methodRow) methodRow.style.display = isExfat ? 'none' : '';
  // Keep Games tab mode selector in sync
  if (el('pork-mode-select')) el('pork-mode-select').value = mode;
  // Update queue button label to show output format
  const qBtn = el('pork-queue-btn');
  if (qBtn) qBtn.textContent = isExfat ? 'Add to Queue (.exfat)' : 'Add to Queue (.ffpkg)';
}

function renderSourceChips() {
  const c = el('settings-sources');
  const srcs = settings.gameSources || [];
  if (!srcs.length) {
    c.innerHTML = '<p class="about-text" style="font-style:italic;">No source folders added.</p>';
    return;
  }
  c.innerHTML = srcs.map(s =>
    `<div class="chip">${escHtml(s)}<span class="rm" data-src="${escHtml(s)}" title="Remove">✕</span></div>`
  ).join('');
  c.querySelectorAll('.rm').forEach(rm => {
    rm.addEventListener('click', async () => {
      settings = await api.removeGameSource(rm.dataset.src);
      renderSettings();
    });
  });
}

function renderRootChips() {
  const roots   = settings.backporkRoots   || [];
  const folders = settings.backporkFolders || [];
  const c = el('settings-roots');

  if (!roots.length && !folders.length) {
    c.innerHTML = '<p class="about-text" style="font-style:italic;">No backpork roots added.</p>';
    return;
  }
  let html = '';
  for (const r of roots) {
    html += `<div class="chip" style="margin-bottom:4px;">[R] ${escHtml(r)} (root)<span class="rm" data-root="${escHtml(r)}" title="Remove">\u2715</span></div>`;
  }
  for (const f of folders) {
    html += `<div class="chip" style="margin-bottom:4px;">[F] ${escHtml(f.name)} — ${escHtml(f.path)}<span class="rm" data-folder="${escHtml(f.path)}" title="Remove">✕</span></div>`;
  }
  c.innerHTML = html;
  c.querySelectorAll('[data-root]').forEach(rm => {
    rm.addEventListener('click', async () => {
      settings = await api.removeBackporkRoot(rm.dataset.root);
      renderSettings();
      loadFirmware();
    });
  });
  c.querySelectorAll('[data-folder]').forEach(rm => {
    rm.addEventListener('click', async () => {
      const res = await api.removeBackporkFolder(rm.dataset.folder);
      firmware = res;
      settings = await api.getSettings();
      renderSettings();
      renderFirmware();
    });
  });
}

el('s-tool-pick').addEventListener('click', async () => {
  const info = await api.toolPick();
  if (info) {
    applyToolStatus(info);
    settings = await api.getSettings();
  }
});

el('s-exfat-tool-pick').addEventListener('click', async () => {
  const info = await api.exfatToolPick();
  if (info) {
    applyExfatToolStatus(info);
    settings = await api.getSettings();
  }
});

// save on change
el('s-method').addEventListener('change', async () => {
  settings = await api.setSettings({ ufs2Method: el('s-method').value });
});

el('pork-mode-select').addEventListener('change', async () => {
  const mode = el('pork-mode-select').value;
  settings = await api.setSettings({ gameMode: mode });
  applyModeVisibility(mode);
});

async function pickDir(inputId, settingKey, title) {
  const p = await api.pickFolder(title);
  if (!p) return;
  el(inputId).value = p;
  settings = await api.setSettings({ [settingKey]: p });
}

el('s-temp-pick').addEventListener('click',   () => pickDir('s-temp',   'tempWorkerDir', 'Temp Worker Folder'));
el('s-output-pick').addEventListener('click', () => pickDir('s-output', 'outputDir',     'Output Folder'));
el('s-temp-open').addEventListener('click',   () => { if (settings.tempWorkerDir)  api.openPath(settings.tempWorkerDir); });
el('s-output-open').addEventListener('click', () => { if (settings.outputDir)       api.openPath(settings.outputDir); });

// ── Notifications settings ────────────────────────────────────────────────────────

el('s-notify-enabled').addEventListener('change', async () => {
  settings = await api.setSettings({ psNotifyEnabled: el('s-notify-enabled').checked });
  el('s-notify-config').style.display = settings.psNotifyEnabled ? 'flex' : 'none';
});

el('s-notify-ip').addEventListener('change', async () => {
  settings = await api.setSettings({ psNotifyIp: el('s-notify-ip').value.trim() });
});

el('s-notify-port').addEventListener('change', async () => {
  const p = parseInt(el('s-notify-port').value, 10);
  settings = await api.setSettings({ psNotifyPort: (p > 0 && p <= 65535) ? p : 6969 });
});

el('s-notify-test').addEventListener('click', async () => {
  const btn = el('s-notify-test');
  const res = el('s-notify-test-result');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  res.textContent = '';
  res.style.color = 'var(--muted)';
  try {
    const result = await api.notifyTest();
    if (result.ok) {
      btn.textContent = 'Sent!';
      res.textContent = '✓ Notification delivered';
      res.style.color = 'var(--success)';
    } else {
      btn.textContent = 'Failed';
      res.textContent = `✗ ${result.reason || 'Unknown error'}`;
      res.style.color = 'var(--error)';
    }
  } catch (e) {
    btn.textContent = 'Error';
    res.textContent = `✗ ${e.message}`;
    res.style.color = 'var(--error)';
  }
  setTimeout(() => {
    btn.textContent = 'Test';
    btn.disabled = false;
  }, 2500);
});

[
  ['s-notify-game-queued',   'psNotifyOnGameQueued'],
  ['s-notify-batch-queued',  'psNotifyOnBatchQueued'],
  ['s-notify-copy-start',    'psNotifyOnCopyStart'],
  ['s-notify-convert-start', 'psNotifyOnConvertStart'],
  ['s-notify-job-done',      'psNotifyOnJobDone'],
].forEach(([id, key]) => {
  el(id).addEventListener('change', async () => {
    settings = await api.setSettings({ [key]: el(id).checked });
  });
});

el('s-add-game-source').addEventListener('click', async () => {
  const res = await api.addGameSource();
  if (!res) return;
  settings = await api.getSettings();
  renderSettings();
  games = res.games;
  renderGames();
});

el('s-add-bp-root').addEventListener('click', async () => {
  const res = await api.addBackporkRoot();
  if (!res) return;
  firmware = res;
  settings = await api.getSettings();
  renderSettings();
  renderFirmware();
});

el('s-add-bp-folder').addEventListener('click', async () => {
  const res = await api.addBackporkFolder();
  if (!res) return;
  firmware = res;
  settings = await api.getSettings();
  renderSettings();
  renderFirmware();
});

// ── Patch index ──────────────────────────────────────────────────────────────
// Maps game_id → Set of firmware names that contain a patch for that game
function buildPatchIndex() {
  patchIndex = new Map();
  for (const fw of firmware) {
    for (const g of fw.games) {
      if (!patchIndex.has(g.game_id)) patchIndex.set(g.game_id, new Set());
      patchIndex.get(g.game_id).add(fw.name);
    }
  }
}

function coverageHtml(game_id) {
  const fwNames = patchIndex.get(game_id);
  if (!fwNames || !fwNames.size) {
    return firmware.length
      ? '<span class="fw-tag none">none</span>'
      : '<span style="color:var(--muted);font-size:11px;">—</span>';
  }
  return [...fwNames].sort().map(n => `<span class="fw-tag has">${escHtml(n)}</span>`).join('');
}

// ── Games panel ───────────────────────────────────────────────────────────────

function renderGames() {
  const count = games.length;
  el('games-count').textContent = count;
  el('games-sub').textContent   = count ? `${count} game(s) found` : '';

  if (!count) {
    el('games-empty').style.display       = '';
    el('games-table-outer').style.display = 'none';
    el('pork-selection-panel').style.display = 'none';
    el('filter-notice').style.display = 'none';
    return;
  }

  el('games-empty').style.display       = 'none';
  el('games-table-outer').style.display = '';
  el('pork-selection-panel').style.display = '';

  const tbody = el('games-tbody');
  tbody.innerHTML = games.map(g => `
    <tr data-game-id="${escHtml(g.game_id)}">
      <td class="check"><input type="checkbox" class="game-cb" value="${escHtml(g.game_id)}"></td>
      <td class="mono">${escHtml(g.game_id)}</td>
      <td>${escHtml(g.folder_name)}</td>
      <td>${fmtBytes(g.size)}</td>
      <td class="coverage-col">${coverageHtml(g.game_id)}</td>
      <td style="color:var(--muted);font-size:11px;">${escHtml(g.source_root)}</td>
      <td>
        <button class="open-game-btn" data-path="${escHtml(g.source_path)}" title="Open in Explorer" style="padding:3px 8px;">Open</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('.open-game-btn').forEach(b => {
    b.addEventListener('click', () => api.openPath(b.dataset.path));
  });

  tbody.querySelectorAll('.game-cb').forEach(cb => {
    cb.addEventListener('change', updateSelectionCount);
  });

  el('games-check-all').checked = false;
  applyFirmwareFilter();
  updateSelectionCount();
  populateFirmwareSelect();
}

// Filter rows by selected firmware — hides games without a patch for that fw
function applyFirmwareFilter() {
  const fwRaw = el('pork-fw-select').value;
  const skipPorking = el('pork-skip-porking')?.checked;
  const notice = el('filter-notice');
  if (!fwRaw || skipPorking) {
    // no filter — show all rows
    qsa('#games-tbody tr').forEach(r => r.style.display = '');
    notice.style.display = 'none';
    return;
  }
  const fw = JSON.parse(fwRaw);
  const fwObj = firmware.find(f => f.path === fw.path);
  if (!fwObj) { notice.style.display = 'none'; return; }

  const patchIds = new Set(fwObj.games.map(g => g.game_id));
  let shown = 0, hidden = 0;
  qsa('#games-tbody tr').forEach(row => {
    const has = patchIds.has(row.dataset.gameId);
    row.style.display = has ? '' : 'none';
    has ? shown++ : hidden++;
  });

  if (hidden === 0) {
    notice.style.display = 'none';
  } else {
    notice.style.display = 'flex';
    el('filter-notice-text').textContent =
      `Showing ${shown} of ${shown + hidden} games with a patch for ${fw.name} — ${hidden} without a patch hidden.`;
  }

  // uncheck any now-hidden rows
  qsa('#games-tbody tr[style*="none"] .game-cb').forEach(cb => { cb.checked = false; });
  updateSelectionCount();
}

function getSelectedGames() {
  // Only count checked boxes in visible rows (respects the firmware filter)
  return qsa('#games-tbody tr:not([style*="none"]) .game-cb:checked').map(cb => {
    return games.find(g => g.game_id === cb.value);
  }).filter(Boolean);
}

function updateSelectionCount() {
  const sel = getSelectedGames();
  el('games-sel-count').textContent = sel.length ? `${sel.length} selected` : '';
  updatePorkMatchInfo();
}

// Select-all only affects visible rows
el('games-check-all').addEventListener('change', (e) => {
  qsa('#games-tbody tr:not([style*="none"]) .game-cb').forEach(cb => { cb.checked = e.target.checked; });
  updateSelectionCount();
});
el('games-select-all').addEventListener('click', () => {
  qsa('#games-tbody tr:not([style*="none"]) .game-cb').forEach(cb => { cb.checked = true; });
  el('games-check-all').checked = true;
  updateSelectionCount();
});
el('games-deselect-all').addEventListener('click', () => {
  qsa('#games-tbody .game-cb').forEach(cb => { cb.checked = false; });
  el('games-check-all').checked = false;
  updateSelectionCount();
});

el('filter-clear').addEventListener('click', () => {
  el('pork-fw-select').value = '';
  applyFirmwareFilter();
  updatePorkMatchInfo();
});

el('games-scan').addEventListener('click', async () => {
  el('games-scan').disabled = true;
  el('games-scan').textContent = 'Scanning…';
  try {
    games = await api.scanGames();
    renderGames();
  } finally {
    el('games-scan').disabled = false;
    el('games-scan').textContent = 'Scan Source Folders';
  }
});

el('games-add-src').addEventListener('click', async () => {
  const res = await api.addGameSource();
  if (!res) return;
  settings = await api.getSettings();
  renderSettings();
  games = res.games;
  renderGames();
});

function populateFirmwareSelect() {
  const sel = el('pork-fw-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— choose firmware —</option>';
  for (const fw of firmware) {
    const opt = document.createElement('option');
    opt.value       = JSON.stringify({ name: fw.name, path: fw.path });
    opt.textContent = `${fw.name}  (${fw.games.length} game${fw.games.length !== 1 ? 's' : ''})`;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

el('pork-fw-select').addEventListener('change', () => {
  applyFirmwareFilter();
  updatePorkMatchInfo();
});

el('pork-mode-select').addEventListener('change', () => {
  updatePorkMatchInfo();
});

el('pork-skip-porking').addEventListener('change', () => {
  const skip = el('pork-skip-porking').checked;
  // Disable/enable the firmware dropdown to signal it's not needed when skipping
  el('pork-fw-select').disabled = skip;
  const fwField = el('pork-fw-field');
  if (fwField) fwField.style.opacity = skip ? '0.4' : '';
  applyFirmwareFilter();
  updatePorkMatchInfo();
});

function updatePorkMatchInfo() {
  const infoEl = el('pork-match-info');
  const fwRaw  = el('pork-fw-select').value;
  const skipPorking = el('pork-skip-porking')?.checked;
  const sel    = getSelectedGames();
  const modeTxt = el('pork-mode-select')?.value === 'exfat' ? 'ExFAT (.exfat)' : 'FFPKG (.ffpkg)';

  // Skip Porking checkbox takes priority — always a convert-only path
  if (skipPorking) {
    if (!sel.length) {
      infoEl.textContent = 'Select games above, then click Add to Queue (no patch will be applied).';
      infoEl.style.color = 'var(--muted)';
    } else {
      infoEl.textContent = `✓ ${sel.length} game(s) selected — will be converted directly as ${modeTxt} with no patch applied.`;
      infoEl.style.color = 'var(--success)';
    }
    return;
  }

  // No firmware selected — still valid, treated as convert-only
  if (!fwRaw || fwRaw === '__none__') {
    if (!sel.length) {
      infoEl.textContent = 'Select games above, then click Add to Queue. A patch is optional.';
      infoEl.style.color = 'var(--muted)';
    } else {
      infoEl.textContent = `✓ ${sel.length} game(s) selected — will be converted directly as ${modeTxt} with no patch applied.`;
      infoEl.style.color = 'var(--success)';
    }
    return;
  }

  const fw    = JSON.parse(fwRaw);
  const fwObj = firmware.find(f => f.path === fw.path);
  if (!fwObj) { infoEl.textContent = ''; return; }

  // With filter active, all visible selected games are guaranteed to have a patch
  if (!sel.length) {
    infoEl.textContent = `Select games above, then click Add to Queue.`;
    infoEl.style.color = 'var(--muted)';
    return;
  }
  infoEl.textContent = `✓ ${sel.length} game(s) selected — all have a patch for ${fw.name}. Ready to queue as ${modeTxt}.`;
  infoEl.style.color = 'var(--success)';
}

el('pork-queue-btn').addEventListener('click', async () => {
  const fwRaw       = el('pork-fw-select').value;
  const skipPorking = el('pork-skip-porking')?.checked;

  const sel = getSelectedGames();
  if (!sel.length) { alert('Select at least one game.'); return; }

  // Read mode from the in-panel selector (authoritative for this action)
  const mode = el('pork-mode-select').value || settings.gameMode || 'ffpkg';
  // Persist so Settings tab and main process stay in sync
  if (mode !== settings.gameMode) {
    settings = await api.setSettings({ gameMode: mode });
    applyModeVisibility(mode);
  }

  const items = [];

  // ── Convert-only (no patch) — skip porking checked, no firmware chosen, or __none__ ──
  if (skipPorking || !fwRaw || fwRaw === '__none__') {
    for (const g of sel) {
      items.push({
        game_id:        g.game_id,
        game_path:      g.source_path,
        backpork_path:  null,
        firmware_label: '',
        mode,
      });
    }
  } else {
  // ── Patched conversion ──────────────────────────────────────────────────
    const fw    = JSON.parse(fwRaw);
    const fwObj = firmware.find(f => f.path === fw.path);
    if (!fwObj) return;
    const patchMap = new Map(fwObj.games.map(g => [g.game_id, g]));
    const skipped  = [];
    for (const g of sel) {
      const patch = patchMap.get(g.game_id);
      if (!patch) { skipped.push(g.game_id); continue; }
      items.push({
        game_id:        g.game_id,
        game_path:      g.source_path,
        backpork_path:  patch.path,
        firmware_label: fw.name,
        mode,
      });
    }
    // Games without a patch are queued as convert-only — a patch is never required
    for (const g of sel) {
      if (skipped.includes(g.game_id)) {
        items.push({
          game_id:        g.game_id,
          game_path:      g.source_path,
          backpork_path:  null,
          firmware_label: '',
          mode,
        });
      }
    }
    if (!items.length) {
      alert('No games could be queued — check your selection.');
      return;
    }
    const ids = await api.queueAddBatch(items);
    qs('.tab[data-tab="queue"]').click();
    if (skipped.length) alert(`Queued ${ids.length} job(s).\n\n${skipped.length} game(s) had no patch for ${fw.name} and were queued as convert-only (no patch):\n${skipped.join(', ')}`);
    return;
  }

  const ids = await api.queueAddBatch(items);
  qs('.tab[data-tab="queue"]').click();
});

// ── Firmware panel ────────────────────────────────────────────────────────────

async function loadFirmware() {
  firmware = await api.listFirmware();
  buildPatchIndex();
  renderFirmware();
  populateFirmwareSelect();
  // refresh coverage column if games are already loaded
  if (games.length) {
    qsa('#games-tbody tr .coverage-col').forEach(td => {
      const gameId = td.closest('tr').dataset.gameId;
      if (gameId) td.innerHTML = coverageHtml(gameId);
    });
  }
  el('fw-count').textContent = firmware.length;
}

function renderFirmware() {
  const list = el('firmware-list');
  el('fw-count').textContent = firmware.length;
  const total = firmware.reduce((s, f) => s + f.games.length, 0);
  el('fw-total-games').textContent = total ? `${total} patchable game(s) total` : '';

  if (!firmware.length) {
    el('fw-empty').style.display = '';
    list.innerHTML = '';
    return;
  }
  el('fw-empty').style.display = 'none';

  list.innerHTML = firmware.map((fw, i) => `
    <div class="firmware-card" id="fwcard-${i}">
      <div class="firmware-card-header" data-idx="${i}">
        <span class="chevron">▶</span>
        <span class="firmware-card-title">${escHtml(fw.name)}</span>
        <span class="firmware-card-meta">${fw.games.length} game${fw.games.length !== 1 ? 's' : ''}</span>
        <span style="color:var(--muted);font-size:11px;margin-left:8px;">${escHtml(fw.path)}</span>
        <div style="display:flex;gap:4px;margin-left:8px;">
          <button class="fw-open-btn" data-path="${escHtml(fw.path)}" style="padding:2px 6px;font-size:11px;" title="Open in Explorer">Open</button>
          <button class="fw-rm-btn" data-path="${escHtml(fw.path)}" style="padding:2px 6px;font-size:11px;" title="Remove">✕</button>
        </div>
      </div>
      <div class="firmware-card-body">
        ${fw.games.length ? `
        <table>
          <thead><tr>
            <th>Title ID</th><th>Folder</th><th>Size</th><th>Action</th>
          </tr></thead>
          <tbody>
            ${fw.games.map(g => `
            <tr>
              <td class="mono">${escHtml(g.game_id)}</td>
              <td>${escHtml(g.folder_name)}</td>
              <td>${fmtBytes(g.size)}</td>
              <td>
                <button class="fw-open-game" data-path="${escHtml(g.path)}" style="padding:2px 6px;font-size:11px;">Open</button>
                <button class="fw-pork-one" data-game-id="${escHtml(g.game_id)}"
                  data-bp-path="${escHtml(g.path)}" data-fw-name="${escHtml(fw.name)}"
                  style="padding:2px 6px;font-size:11px;" title="Queue this single game">Queue</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div style="padding:12px;color:var(--muted);font-size:12px;">No matching game directories found.</div>`}
      </div>
    </div>`).join('');

  // card toggle
  list.querySelectorAll('.firmware-card-header').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      el(`fwcard-${hdr.dataset.idx}`).classList.toggle('open');
    });
  });

  // open buttons
  list.querySelectorAll('.fw-open-btn').forEach(b => {
    b.addEventListener('click', () => api.openPath(b.dataset.path));
  });
  list.querySelectorAll('.fw-open-game').forEach(b => {
    b.addEventListener('click', () => api.openPath(b.dataset.path));
  });

  // remove
  list.querySelectorAll('.fw-rm-btn').forEach(b => {
    b.addEventListener('click', async () => {
      // find if it's a root or a manual folder
      const fwObj = firmware.find(f => f.path === b.dataset.path);
      if (!fwObj) return;
      // check if it came from a root
      const isManual = (settings.backporkFolders || []).some(f => f.path.toLowerCase() === b.dataset.path.toLowerCase());
      const isRoot   = false; // roots show root-level, not individual firmware cards
      if (isManual || !settings.backporkRoots?.some(r => b.dataset.path.toLowerCase().startsWith(r.toLowerCase()))) {
        const res = await api.removeBackporkFolder(b.dataset.path);
        firmware = res;
      } else {
        alert('This patch folder comes from a backpork root. Remove the root in Settings to exclude it.');
        return;
      }
      settings = await api.getSettings();
      renderSettings();
      renderFirmware();
      populateFirmwareSelect();
    });
  });

  // queue single game from firmware panel
  list.querySelectorAll('.fw-pork-one').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gameId    = btn.dataset.gameId;
      const bpPath    = btn.dataset.bpPath;
      const fwName    = btn.dataset.fwName;
      // find game source
      const gameEntry = games.find(g => g.game_id === gameId);
      if (!gameEntry) {
        alert(`Game ${gameId} is not in any scanned game source folder.\nScan your game sources in the Games tab first.`);
        return;
      }
      await api.queueAdd({
        game_id:        gameId,
        game_path:      gameEntry.source_path,
        backpork_path:  bpPath,
        firmware_label: fwName,
      });
      qs('.tab[data-tab="queue"]').click();
    });
  });
}

el('fw-add-root').addEventListener('click', async () => {
  const res = await api.addBackporkRoot();
  if (!res) return;
  firmware = res; settings = await api.getSettings();
  renderSettings(); renderFirmware(); populateFirmwareSelect();
});
el('fw-add-folder').addEventListener('click', async () => {
  const res = await api.addBackporkFolder();
  if (!res) return;
  firmware = res; settings = await api.getSettings();
  renderSettings(); renderFirmware(); populateFirmwareSelect();
});
el('fw-refresh').addEventListener('click', loadFirmware);

// ── Queue panel ───────────────────────────────────────────────────────────────

function updateQueueBadge() {
  const active = [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').length;
  el('queue-badge').textContent = active || [...jobs.values()].length;
}

function renderQueue() {
  const list = el('job-list');
  const arr  = [...jobs.values()].sort((a, b) => b.id - a.id);

  const running   = arr.filter(j => j.status === 'running').length;
  const queued    = arr.filter(j => j.status === 'queued').length;
  const done      = arr.filter(j => j.status === 'done').length;
  const errored   = arr.filter(j => j.status === 'error').length;

  let summary = [];
  if (running)  summary.push(`${running} running`);
  if (queued)   summary.push(`${queued} queued`);
  if (done)     summary.push(`${done} done`);
  if (errored)  summary.push(`${errored} error${errored > 1 ? 's' : ''}`);
  el('queue-summary').textContent = summary.length ? summary.join(' · ') : 'No jobs.';

  el('queue-empty').style.display = arr.length ? 'none' : '';
  updateQueueBadge();

  if (!arr.length) { list.innerHTML = ''; return; }

  // Full re-render only when card count changes or a card needs structural rebuild
  const existingCards = new Set([...list.querySelectorAll('.job-card')].map(c => Number(c.dataset.jobId)));
  const statusChanged = arr.some(j => {
    const card = list.querySelector(`.job-card[data-job-id="${j.id}"]`);
    return card && card.dataset.jobStatus !== j.status;
  });
  const needsFull = statusChanged || arr.some(j => !existingCards.has(j.id)) || existingCards.size !== arr.length;

  if (needsFull) {
    list.innerHTML = arr.map(jobCardHtml).join('');
    bindJobCardEvents(list);
    // Scroll all log boxes to the bottom so errors at the end are visible after re-render
    list.querySelectorAll('.log-box').forEach(lb => { lb.scrollTop = lb.scrollHeight; });
  } else {
    // Incremental: just patch progress bar + phase + pill for each job
    for (const job of arr) {
      const card = list.querySelector(`.job-card[data-job-id="${job.id}"]`);
      if (!card) continue;
      const pct    = job.progress?.percent ?? 0;
      const phase  = job.progress?.phase ?? '';
      const barCls = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : '';

      const fill = card.querySelector('.progress-bar-fill');
      if (fill) { fill.style.width = `${pct}%`; fill.className = `progress-bar-fill ${barCls}`; }

      const phaseEl = card.querySelector('.job-card-phase');
      if (phaseEl) phaseEl.textContent = phase;

      const pctEl = card.querySelector('.job-pct');
      if (pctEl) pctEl.textContent = `${pct}%`;

      // pill/status-badge only changes when job status changes → handled by needsFull re-render path

      // Update log box without scrolling back to top
      const lb = card.querySelector('.log-box');
      if (lb) {
        const log = (job.progress?.log ?? []).join('\n');
        if (lb.dataset.logLen !== String(job.progress?.log?.length)) {
          lb.textContent = log;
          lb.scrollTop   = lb.scrollHeight;
          lb.dataset.logLen = String(job.progress?.log?.length ?? 0);
        }
      }
    }
  }
}

function jobCardHtml(job) {
  const pct    = job.progress?.percent ?? 0;
  const phase  = job.progress?.phase ?? '';
  const log    = (job.progress?.log ?? []).join('\n');
  const barCls = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : '';
  const showLog = job.status !== 'queued';
  const modeLabel = job.mode === 'exfat' ? 'ExFAT' : 'FFPKG';
  const modeCls   = job.mode === 'exfat' ? 'exfat' : 'ffpkg';

  return `
  <div class="job-card" id="jobcard-${job.id}" data-job-id="${job.id}" data-job-status="${escHtml(job.status)}">
    <div class="job-card-header">
      <span class="job-card-id">#${job.id}</span>
      <span class="mode-pill ${modeCls}">${modeLabel}</span>
      <span class="job-card-label">${escHtml(job.game_id)}${job.firmware_label ? ' → ' + escHtml(job.firmware_label) : ''}</span>
      ${pillHtml(job.status)}
      <div class="job-card-actions">
        ${job.status === 'running' || job.status === 'queued'
          ? `<button class="job-cancel-btn danger" data-id="${job.id}" style="padding:2px 8px;font-size:11px;">Cancel</button>` : ''}
        ${job.status === 'error'
          ? `<button class="job-retry-btn" data-id="${job.id}" style="padding:2px 8px;font-size:11px;">↺ Retry</button>` : ''}
        ${job.status === 'done'
          ? `<button class="job-open-btn" data-path="${escHtml(job.output_file || '')}" style="padding:2px 8px;font-size:11px;">Open Output</button>` : ''}
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-bar-fill ${barCls}" style="width:${pct}%"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);">
      <span class="job-card-phase">${escHtml(phase)}</span>
      <span class="job-pct">${pct}%</span>
    </div>
    ${showLog && log ? `<div class="log-box" data-log-len="${(job.progress?.log?.length ?? 0)}">${escHtml(log)}</div>` : ''}
    ${job.error ? `<div style="color:var(--error);font-size:11px;">✗ ${escHtml(job.error)}</div>` : ''}
  </div>`;
}

function bindJobCardEvents(list) {
  list.querySelectorAll('.job-cancel-btn').forEach(b => {
    b.addEventListener('click', () => api.queueCancel(Number(b.dataset.id)));
  });
  list.querySelectorAll('.job-retry-btn').forEach(b => {
    b.addEventListener('click', () => api.queueRetry(Number(b.dataset.id)));
  });
  list.querySelectorAll('.job-open-btn').forEach(b => {
    b.addEventListener('click', () => {
      const dir = b.dataset.path.replace(/[\\/][^\\/]+$/, '');
      api.openPath(dir);
    });
  });
}

function updateGoButton() {
  const btn      = el('queue-go');
  const hint     = el('queue-paused-hint');
  const allJobs  = [...jobs.values()];
  const nQueued  = allJobs.filter(j => j.status === 'queued').length;
  const nRunning = allJobs.filter(j => j.status === 'running').length;

  if (nRunning > 0) {
    btn.disabled      = true;
    btn.textContent   = '⚙ Processing…';
    hint.textContent  = `${nRunning} job${nRunning > 1 ? 's' : ''} running…`;
    hint.style.color  = 'var(--accent2)';
  } else if (queuePaused && nQueued > 0) {
    btn.disabled      = false;
    btn.textContent   = `▶ Go!!  (${nQueued} queued)`;
    hint.textContent  = 'Ready — click Go!! to start processing.';
    hint.style.color  = 'var(--warn)';
  } else if (!queuePaused && nQueued > 0) {
    // started but tickQueue hasn't picked up the next job yet
    btn.disabled      = true;
    btn.textContent   = '⚙ Starting…';
    hint.textContent  = '';
  } else {
    btn.disabled      = true;
    btn.textContent   = '▶ Go!!';
    hint.textContent  = allJobs.length ? 'Queue complete.' : 'Add games then hit Go!!';
    hint.style.color  = 'var(--muted)';
  }
}

el('queue-go').addEventListener('click', async () => {
  await api.queueStart();
  // optimistically update UI — paused-change event will also arrive shortly
  queuePaused = false;
  updateGoButton();
});

el('queue-clear-done').addEventListener('click', async () => {
  const remaining = await api.queueClearDone();
  jobs.clear();
  for (const j of remaining) jobs.set(j.id, j);
  renderQueue();
});

el('queue-cleanup-temp').addEventListener('click', async () => {
  const btn = el('queue-cleanup-temp');
  btn.disabled = true;
  btn.textContent = '🧹 Cleaning…';
  try {
    const res = await api.queueCleanupTemp();
    const parts = [];
    if (res.deletedDirs)  parts.push(`${res.deletedDirs} temp folder${res.deletedDirs  > 1 ? 's' : ''}`);
    if (res.deletedFiles) parts.push(`${res.deletedFiles} partial file${res.deletedFiles > 1 ? 's' : ''}`);
    btn.textContent = parts.length ? `✓ Removed ${parts.join(' + ')}` : '✓ Nothing to clean';
    if (res.errors?.length) console.warn('[CleanTemp] errors:', res.errors);
  } catch (e) {
    btn.textContent = '✗ Cleanup failed';
    console.error('[CleanTemp]', e);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '🧹 Clean Temp'; }, 3000);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

el('x-follow-link').addEventListener('click', (e) => {
  e.preventDefault();
  api.openUrl('https://x.com/StonedModder');
});

(async () => {
  await init();
  await loadFirmware();
  games = await api.scanGames();
  renderGames();
})();
