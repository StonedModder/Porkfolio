// ── Games page ────────────────────────────────────────────────────────────────
async function loadGames() {
  try {
    state.games = await window.pork.listGames({});
    // Refresh hash summaries (fire-and-forget so badges update when ready)
    window.pork.hashGameSummary().then(summaries => {
      _populateHashMaps(summaries);
      renderGames();
    }).catch(() => {});
    renderGames();
    await refreshFirmwareFilters();
    await refreshConvQueuePanel();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function getFilteredGames() {
  return state.games.filter(g => {
    const q = state.search.toLowerCase();
    if (q && !g.title.toLowerCase().includes(q) && !g.game_id.toLowerCase().includes(q) &&
        !(g.prospero_name || '').toLowerCase().includes(q)) return false;
    // Status and firmware are independent filter dimensions — compute status as a
    // boolean so both can compose (previously the status branches returned early,
    // silently disabling the firmware filter).
    let statusOk = true;
    if (state.filter === 'installed')       statusOk = !!g.installed;
    else if (state.filter === 'backed_up')  statusOk = !!g.backed_up;
    else if (state.filter === 'not_backed') statusOk = g.installed && !g.backed_up;
    if (!statusOk) return false;
    if (state.firmwareFilter !== 'all') {
      const labels = (g.firmware_labels || '').split(',').filter(Boolean);
      if (!labels.includes(state.firmwareFilter)) return false;
    }
    return true;
  }).sort((a, b) => {
    let av = a[state.sortCol] ?? '', bv = b[state.sortCol] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av === bv) return 0;
    return state.sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });
}

function renderGames() {
  const list  = getFilteredGames();
  const tbody = $('games-tbody');
  const empty = $('games-empty');

  tbody.innerHTML = '';
  empty.style.display = list.length ? 'none' : 'block';

  for (const g of list) {
    const tr = document.createElement('tr');
    tr.className = 'game-row';
    tr.dataset.id = g.game_id;
    // Compact status cell: readable tags instead of cryptic symbols
    const patchesOnly = g.backup_count === 0 && g.backpork_count > 0;
    const _hs = _gameHashSummary.get(g.game_id);
    const hashTag = _hs
      ? _hs.community_mismatch
        ? `<span class="s-tag s-hash-fail" title="⚠ Community hash check FAILED — files may be modified or contain brick code">⚠ Hash Fail</span>`
        : _hs.community_matches > 0
          ? `<span class="s-tag s-hash-ok" title="Community verified: ${_hs.community_matches}/${_hs.hash_count} files match known-good hashes">✓ Verified</span>`
          : `<span class="s-tag s-hash-local" title="${_hs.hash_count} file(s) hashed — not yet in community list">⧭ Hashed</span>`
      : '';
    const fwLabels = (g.firmware_labels || '').split(',').filter(Boolean);
    const patchedTag = fwLabels.length
      ? `<span class="s-tag s-patched" title="Backporked for: ${escHtml(fwLabels.join(', '))}">&#x1F527; ${escHtml(fwLabels.join(', '))}</span>`
      : '';
    const statusHtml = `<div class="game-status-col">
      ${g.installed ? `<span class="s-tag s-ps5" title="Currently installed on PS5">PS5</span>` : ''}
      ${g.backup_count > 0 ? `<span class="s-tag s-num" title="${g.backup_count} local backup(s)">${g.backup_count} bkp</span>` : ''}
      ${g.backed_up ? `<span class="s-tag s-backed" title="Marked as backed up">&#10003;</span>` : ''}
      ${patchesOnly ? `<span class="s-tag s-warn" title="Only backpork patches found &mdash; no local game backup exists">Patches only</span>` : ''}
      ${patchedTag}
      ${hashTag}
    </div>`;
    if (patchesOnly) tr.classList.add('game-row-patches-only');
    tr.innerHTML = `
      <td>
        <div class="game-title-cell">
          ${g.prospero_icon_url
            ? `<img src="${escHtml(g.prospero_icon_url)}" class="game-row-icon" alt="" onerror="this.style.display='none'">`
            : '<div class="game-row-icon game-row-icon-empty"></div>'}
          <span>${escHtml(g.prospero_name || g.title || g.game_id)}</span>
        </div>
      </td>
      <td><code>${escHtml(g.game_id)}</code></td>
      <td>${escHtml(g.version || g.prospero_version || '—')}</td>
      <td>${g.backup_size ? fmt(g.backup_size) : (g.size ? fmt(g.size) : (g.prospero_size || '—'))}</td>
      <td>${renderFwPills(g.firmware_labels)}</td>
      <td>${statusHtml}</td>
      <td class="game-actions-cell">
        ${patchesOnly
          ? `<span class="patches-only-hint" title="No game backup found &mdash; only patch folders exist for this title. Back up or download the base game first.">&#9888; No game backup</span>`
          : `<button class="btn btn-sm btn-teal" data-action="install" data-id="${escHtml(g.game_id)}" title="Add to PS5 install queue (Raw Dumps direct upload)">
          &#11014; Add to Install Queue
        </button>
        <button class="btn btn-sm" data-action="convert" data-id="${escHtml(g.game_id)}" title="Convert game (FFPKG / ExFAT) and optionally upload to PS5">
          &#9881; Convert
        </button>`
        }
      </td>`;
    tbody.appendChild(tr);
  }

  // Click delegation: action buttons take priority; otherwise whole row opens detail
  tbody.onclick = async e => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      if (btn.dataset.action === 'install') {
        await openInstallModal(btn.dataset.id, 'pfs');
      } else if (btn.dataset.action === 'convert') {
        const s = await window.pork.getSettings();
        const mode = (s.gameConversionMode === 'pfs' || !s.gameConversionMode) ? 'ffpkg' : s.gameConversionMode;
        await openInstallModal(btn.dataset.id, mode);
      }
      return;
    }
    const row = e.target.closest('tr.game-row[data-id]');
    if (row) openModal(row.dataset.id);
  };
}

// Sorting
document.querySelectorAll('#games-table th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    if (state.sortCol === th.dataset.col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortCol = th.dataset.col; state.sortDir = 'asc'; }
    renderGames();
  });
});

// Filter buttons
document.querySelectorAll('.fbtn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderGames();
  })
);

// Search
$('games-search').addEventListener('input', e => {
  state.search = e.target.value;
  renderGames();
});

