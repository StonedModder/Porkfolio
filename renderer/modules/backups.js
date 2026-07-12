// ── Backups page ──────────────────────────────────────────────────────────────
async function loadBackups() {
  try {
    // Use listGames so we get one entry per game with prospero metadata + backup_size
    const all = await window.pork.listGames({});
    // Keep games that have a local backup OR at least one backpork entry
    state.backups = all.filter(g => g.backup_count > 0 || g.firmware_labels);
    populateBackupsRegionFilter();
    renderBackups();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function populateBackupsRegionFilter() {
  const sel   = $('backups-region-filter');
  const cur   = sel.value;
  const regions = [...new Set(
    state.backups.map(g => g.prospero_region || '').filter(Boolean).sort()
  )];
  sel.innerHTML = '<option value="">All Regions</option>'
    + regions.map(r => `<option value="${escHtml(r)}"${r === cur ? ' selected' : ''}>${escHtml(r)}</option>`).join('');
}

function renderBackups() {
  const search  = ($('backups-search')?.value || '').toLowerCase();
  const region  = $('backups-region-filter')?.value || '';
  const list    = $('backups-list');
  const empty   = $('backups-empty');

  const filtered = state.backups.filter(g => {
    if (region && (g.prospero_region || '') !== region) return false;
    if (search) {
      const name = (g.prospero_name || g.title || g.game_id).toLowerCase();
      if (!name.includes(search) && !g.game_id.toLowerCase().includes(search)) return false;
    }
    return true;
  });

  empty.hidden = filtered.length > 0;
  list.innerHTML = filtered.map(g => {
    const name        = escHtml(g.prospero_name || g.title || g.game_id);
    const region      = g.prospero_region ? `<span class="pill pill-region">${escHtml(g.prospero_region)}</span>` : '';
    const iconHtml    = g.prospero_icon_url
      ? `<img class="backup-card-icon" src="${escHtml(g.prospero_icon_url)}" alt="" onerror="this.style.display='none'">`
      : `<div class="backup-card-icon backup-card-icon-empty"></div>`;

    const backporks   = g.firmware_labels ? g.firmware_labels.split(',').filter(Boolean) : [];
    const patchCount  = g.prospero_patch_count || 0;
    const dlcCount    = tryParseJson(g.prospero_dlc, []).length;
    const localSize   = g.backup_size ? fmt(g.backup_size) : null;

    const badges = [
      localSize                    ? `<span class="bk-badge bk-badge-local">&#128190; ${escHtml(localSize)}</span>` : '',
      backporks.length             ? `<span class="bk-badge bk-badge-backpork">&#128279; ${backporks.length} Backpork${backporks.length !== 1 ? 's' : ''}</span>` : '',
      patchCount                   ? `<span class="bk-badge bk-badge-patch">&#8593; ${patchCount} Update${patchCount !== 1 ? 's' : ''}</span>` : '',
      dlcCount                     ? `<span class="bk-badge bk-badge-dlc">&#43; ${dlcCount} DLC</span>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="backup-card" data-view-game="${escHtml(g.game_id)}">
        ${iconHtml}
        <div class="backup-card-body">
          <div class="backup-card-title">${name} ${region}</div>
          <div class="backup-card-id"><code>${escHtml(g.game_id)}</code></div>
          ${badges ? `<div class="backup-card-badges">${badges}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-accent backup-card-view">View Details</button>
      </div>`;
  }).join('');

  list.onclick = e => {
    const card = e.target.closest('[data-view-game]');
    if (card) openModal(card.dataset.viewGame);
  };
}

// Search + filter live update
$('backups-search')?.addEventListener('input', renderBackups);
$('backups-region-filter')?.addEventListener('change', renderBackups);

$('btn-scan-local').addEventListener('click', async () => {
  $('btn-scan-local').disabled = true;
  setStatus('Scanning local game source folders…');
  try {
    const { total, added } = await window.pork.scanBackups();
    await loadBackups();
    await loadDashboard();
    const msg = added > 0
      ? `Found ${total} game(s) — ${added} new, fetching metadata…`
      : `Scan complete: ${total} game(s) found, none new`;
    setStatus(msg, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    $('btn-scan-local').disabled = false;
  }
});

$('btn-rescan-game-sources').addEventListener('click', async () => {
  const btn = $('btn-rescan-game-sources');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Scanning…';
  setStatus('Scanning local game source folders…');
  try {
    const { total, added } = await window.pork.scanBackups();
    await loadGames();
    await loadDashboard();
    const msg = added > 0
      ? `Found ${total} game(s) — ${added} new, fetching metadata…`
      : `Scan complete: ${total} game(s) found, none new`;
    setStatus(msg, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

$('btn-rescan-all-backporks').addEventListener('click', async () => {
  const btn = $('btn-rescan-all-backporks');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Scanning…';
  setStatus('Rescanning all backpork folders…');
  try {
    const { folders, count, uniqueGames } = await window.pork.backporksScanAll();
    await loadBackporks();
    await refreshFirmwareFilters();
    const uniqueLabel = Number.isFinite(uniqueGames) && uniqueGames > 0
      ? ` across ${uniqueGames} unique game(s)`
      : '';
    setStatus(`Rescan complete — ${count} build(s) in ${folders} firmware folder(s)${uniqueLabel}`, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

