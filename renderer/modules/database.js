// ── Database page ─────────────────────────────────────────────────────────────
async function loadDatabase() {
  await loadDbTable('games');
  await loadDbTable('backups');
  await loadHashRowsTable();
}

async function loadHashRowsTable() {
  try {
    const rows = await window.pork.dbQuery(
      `SELECT id, game_id, hash_type, firmware_label, file_size,
              SUBSTR(file_hash,1,16) || '…' AS file_hash_short,
              backup_path, verified, hashed_at
       FROM game_hashes ORDER BY hashed_at DESC`
    );
    const countEl = $('hash-rows-count');
    if (countEl) countEl.textContent = `${rows.length} hash row${rows.length !== 1 ? 's' : ''}`;
    renderDbTableEl('db-hash-rows-table', rows, 'hashes');
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

async function loadDbTable(name) {
  try {
    const sql  = name === 'games'
      ? 'SELECT id, title, game_id, version, size, installed, backed_up, last_scanned FROM games ORDER BY title'
      : 'SELECT id, game_id, backup_type, size, backup_path, created_at FROM backups ORDER BY created_at DESC';
    const rows = await window.pork.dbQuery(sql);
    renderDbTableEl(`db-${name}-table`, rows, name);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function renderDbTableEl(tableId, rows, tableName) {
  const table = $(tableId);
  if (!table) return;
  // Hide toolbar when table reloads
  const toolbar = $(`toolbar-${tableName}`);
  if (toolbar) toolbar.hidden = true;

  if (!rows.length) {
    table.innerHTML = '';
    return;
  }
  const cols = Object.keys(rows[0]);
  const hasId = cols.includes('id');
  table.innerHTML = `
    <thead><tr>${hasId ? '<th class="db-row-cb"><input type="checkbox" class="db-select-all" data-table="' + tableName + '"></th>' : ''}${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map(r => {
        const rowId = hasId ? r.id : '';
        return `<tr data-row-id="${rowId}">${hasId ? `<td class="db-row-cb"><input type="checkbox" class="db-row-check" data-table="${tableName}" value="${rowId}"></td>` : ''}${cols.map(c => `<td>${escHtml(r[c] ?? '—')}</td>`).join('')}</tr>`;
      }).join('')}
    </tbody>`;

  if (!hasId) return;

  // Wire up "select all" header checkbox
  const selectAllCb = table.querySelector('.db-select-all');
  if (selectAllCb) {
    selectAllCb.addEventListener('change', () => {
      table.querySelectorAll('.db-row-check').forEach(cb => {
        cb.checked = selectAllCb.checked;
        cb.closest('tr').classList.toggle('db-row-selected', selectAllCb.checked);
      });
      _updateRowToolbar(tableName);
    });
  }

  // Wire up individual row checkboxes
  table.querySelectorAll('.db-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('tr').classList.toggle('db-row-selected', cb.checked);
      _updateRowToolbar(tableName);
    });
  });
}

function _getCheckedIds(tableName) {
  const tableEl = tableName === 'games' ? $('db-games-table')
    : tableName === 'backups' ? $('db-backups-table')
    : $('db-hash-rows-table');
  if (!tableEl) return [];
  return [...tableEl.querySelectorAll('.db-row-check:checked')].map(cb => Number(cb.value));
}

function _updateRowToolbar(tableName) {
  const ids = _getCheckedIds(tableName);
  const toolbar = $(`toolbar-${tableName}`);
  if (!toolbar) return;
  toolbar.hidden = ids.length === 0;
  const countEl = $(`toolbar-${tableName}-count`);
  if (countEl) countEl.textContent = `${ids.length} selected`;
}

// DB Tabs
document.querySelectorAll('.db-tab').forEach(tab =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.db-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.db-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`dbtab-${tab.dataset.dbtab}`).classList.add('active');
    if (tab.dataset.dbtab === 'hash-rows') loadHashRowsTable();
    if (tab.dataset.dbtab === 'hashes')    loadHashDbContent();
  })
);

// Query runner
$('btn-run-query').addEventListener('click', async () => {
  const sql = $('query-input').value.trim();
  if (!sql) return;
  const out = $('query-results');
  try {
    const rows = await window.pork.dbQuery(sql);
    if (!rows.length) { out.innerHTML = '<div class="empty-msg">Query returned no rows.</div>'; return; }
    const cols = Object.keys(rows[0]);
    out.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${escHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) {
    out.innerHTML = `<div class="empty-msg" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
});

// Exports
$('btn-export-sql').addEventListener('click', async () => {
  const p = await window.pork.exportSql();
  if (p) setStatus(`Exported to ${p}`, 'ok');
});
$('btn-export-games-csv').addEventListener('click', async () => {
  const p = await window.pork.exportCsv('games');
  if (p) setStatus(`Exported to ${p}`, 'ok');
});
$('btn-export-backups-csv').addEventListener('click', async () => {
  const p = await window.pork.exportCsv('backups');
  if (p) setStatus(`Exported to ${p}`, 'ok');
});
$('btn-export-hashes').addEventListener('click', async () => {
  const p = await window.pork.hashExport();
  if (p) setStatus(`Hash DB exported to ${p}`, 'ok');
});

// ── Hash Database tab ───────────────────────────────────────────────────────────────────────
async function loadHashDbContent() {
  try {
    const info = await window.pork.hashCommunityInfo();
    const countEl  = $('hdb-community-count');
    const verEl    = $('hdb-community-ver');
    const srcEl    = $('hdb-community-source');
    const localEl  = $('hdb-local-count');
    if (!countEl) return; // tab panel not in DOM
    countEl.textContent = `${info.count} hash${info.count !== 1 ? 'es' : ''}`;
    countEl.className   = info.count > 0 ? 'hash-badge hash-community' : 'hash-badge hash-none';
    verEl.textContent   = info.updated  ? `v${info.version || 1} · ${info.updated}` : '';
    srcEl.textContent   = info.source   === 'imported' ? '(user-imported)' : '(bundled)';
    localEl.textContent = `${info.localCount} hash${info.localCount !== 1 ? 'es' : ''}`;
    localEl.className   = info.localCount > 0 ? 'hash-badge hash-local' : 'hash-badge hash-none';
  } catch (_) {}
  try {
    const summaries = await window.pork.hashGameSummary();
    const list = $('hdb-game-list');
    if (!list) return;
    if (!summaries.length) {
      list.innerHTML = '<div class="hint" style="padding:16px;color:var(--text-dim)">No hashes recorded yet. Open any game, go to Hash Verification, and click \'Hash All Files\'. Or use the Hash All Games / Backporks buttons on those pages.</div>';
      return;
    }
    summaries.sort((a, b) => {
      if (a.community_mismatch !== b.community_mismatch) return a.community_mismatch ? -1 : 1;
      if (a.community_matches !== b.community_matches) return b.community_matches - a.community_matches;
      const typeOrder = { game: 0, backpork: 1 };
      const tDiff = (typeOrder[a.hash_type] ?? 0) - (typeOrder[b.hash_type] ?? 0);
      if (tDiff !== 0) return tDiff;
      return a.game_id.localeCompare(b.game_id);
    });
    list.innerHTML = `<div class="table-wrap" style="margin-top:14px">
      <table style="width:100%">
        <thead><tr><th>Game ID</th><th>Type</th><th>Firmware</th><th>Files Hashed</th><th>Community Matches</th><th>Status</th></tr></thead>
        <tbody>${summaries.map(s => {
          const badge = s.community_mismatch
            ? `<span class="hash-badge hash-mismatch">⚠ Hash Mismatch</span>`
            : s.community_matches > 0
              ? `<span class="hash-badge hash-community">✓ Verified (${s.community_matches}/${s.hash_count})</span>`
              : `<span class="hash-badge hash-local">⧭ Hashed (${s.hash_count})</span>`;
          const typeLabel = s.hash_type === 'backpork'
            ? `<span class="pill" style="background:var(--surface-2);color:var(--text-dim);font-size:10px">Backpork</span>`
            : `<span class="pill" style="background:var(--surface-2);color:var(--text-dim);font-size:10px">Game</span>`;
          const fwLabel = s.firmware_label ? escHtml(s.firmware_label) : '—';
          return `<tr><td><code>${escHtml(s.game_id)}</code></td><td>${typeLabel}</td><td>${fwLabel}</td><td>${s.hash_count}</td><td>${s.community_matches || '—'}</td><td>${badge}</td></tr>`;
        }).join('')}</tbody>
      </table></div>`;
  } catch (_) {}
}

const _fmtBytes = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : b < 1073741824 ? `${(b/1048576).toFixed(1)} MB` : `${(b/1073741824).toFixed(2)} GB`;

let _hashBulkRunning = false;

function _setBulkProgress({ show = true, pct = 0, status = '', fileStatus = '' } = {}) {
  const wrap   = $('bulk-hash-progress');
  const bar    = $('bulk-hash-bar');
  const pctEl  = $('bulk-hash-pct');
  const statEl = $('hash-all-games-status');
  const fileEl = $('bulk-hash-file-status');
  if (!wrap) return;
  wrap.style.display  = show ? 'flex' : 'none';
  if (bar)    bar.style.width          = `${pct}%`;
  if (pctEl)  pctEl.textContent        = `${pct}%`;
  if (statEl) statEl.textContent       = status;
  if (fileEl) fileEl.textContent       = fileStatus;
}

async function _runBulkHash(source) {
  if (_hashBulkRunning) { showToast('A hash operation is already running.', 'info'); return; }
  _hashBulkRunning = true;

  const isGames      = source === 'local';
  const btnEl        = $(isGames ? 'btn-hash-all-games' : 'btn-hash-all-backporks');
  const backporksStat = $('hash-all-backporks-status');

  btnEl.disabled = true;
  if (isGames) {
    _setBulkProgress({ show: true, pct: 0, status: 'Preparing…', fileStatus: '' });
  } else if (backporksStat) {
    backporksStat.textContent = 'Preparing…';
  }

  try {
    const { results, total, totalFilesHashed, totalBytesHashed } = await window.pork.hashBulk(source);
    const ok   = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    const doneMsg = `Done ✓ — ${ok} game${ok !== 1 ? 's' : ''}, ${totalFilesHashed} file${totalFilesHashed !== 1 ? 's' : ''} (${_fmtBytes(totalBytesHashed || 0)})${fail ? `, ${fail} skipped` : ''}`;
    if (isGames) {
      _setBulkProgress({ show: true, pct: 100, status: doneMsg, fileStatus: '' });
      // Fade the progress block away after a few seconds
      setTimeout(() => _setBulkProgress({ show: false }), 6000);
    } else if (backporksStat) {
      backporksStat.textContent = doneMsg;
    }
    // Refresh hash summaries and re-render badges everywhere
    const summaries = await window.pork.hashGameSummary();
    _populateHashMaps(summaries);
    renderGames();
    showToast(`Hash complete — ${totalFilesHashed} files (${_fmtBytes(totalBytesHashed || 0)})`, 'ok');
  } catch (e) {
    const errMsg = 'Error: ' + e.message;
    if (isGames) {
      _setBulkProgress({ show: true, pct: 0, status: errMsg, fileStatus: '' });
    } else if (backporksStat) {
      backporksStat.textContent = errMsg;
    }
    showToast('Hash failed: ' + e.message, 'error');
  } finally {
    _hashBulkRunning = false;
    btnEl.disabled = false;
  }
}

window.pork.on('hash:bulk:progress', ({ phase, done, total, percent, gameId, currentFile, fileSize, filePct, totalFilesHashed, totalBytesHashed }) => {
  const backporksStat = $('hash-all-backporks-status');
  const isGamesPage   = !!document.querySelector('#page-games.active');

  const overallStatus = `Game ${done}/${total} (${percent}%) — ${gameId || ''}`
    + (totalFilesHashed ? ` | ${totalFilesHashed} file${totalFilesHashed !== 1 ? 's' : ''} hashed` : '')
    + (totalBytesHashed ? ` | ${_fmtBytes(totalBytesHashed)}` : '');

  let fileStatus = '';
  if (currentFile) {
    const sizeSuffix = fileSize ? ` (${_fmtBytes(fileSize)})` : '';
    const pctSuffix  = (phase === 'file-progress' && filePct != null) ? ` — ${filePct}%` : '';
    fileStatus = `⧭ ${currentFile}${sizeSuffix}${pctSuffix}`;
  } else if (phase === 'backup-done') {
    fileStatus = `✓ ${gameId} complete`;
  }

  // done = completed backups so far (0 during first game's files).
  // Interpolate within the current slot: done/total gets us to the start of this slot,
  // then add filePct spread across one slot width.
  const barPct = (phase === 'file-progress' && filePct != null)
    ? Math.min(100, Math.round(done / (total || 1) * 100 + filePct / (total || 1)))
    : percent;

  _setBulkProgress({ show: true, pct: barPct, status: overallStatus, fileStatus });

  // Mirror to backporks status if the games progress block isn't visible
  if (backporksStat && !isGamesPage) {
    backporksStat.textContent = overallStatus;
  }
});

$('btn-hash-all-games').addEventListener('click', async () => {
  const ok = await showConfirm('Hash All Game Backups?\n\nThis will SHA-256 every file in every local game backup. On large libraries this can take hours.\n\nThe app stays usable while hashing. Continue?');
  if (ok) _runBulkHash('local');
});
$('btn-hash-all-backporks').addEventListener('click', async () => {
  const ok = await showConfirm('Hash All Backpork Backups?\n\nThis will SHA-256 every file in every backpork backup. On large libraries this can take hours.\n\nThe app stays usable while hashing. Continue?');
  if (ok) _runBulkHash('backpork');
});

$('btn-hdb-export').addEventListener('click', async () => {
  const p = await window.pork.hashExport();
  if (p) showToast(`Hash DB exported to ${p}`, 'ok');
});

$('btn-import-community-hashes').addEventListener('click', async () => {
  const btn = $('btn-import-community-hashes');
  btn.disabled = true;
  try {
    const result = await window.pork.hashImportCommunity();
    if (!result) { btn.disabled = false; return; }
    showToast(`Community hash list imported — ${result.count} hashes loaded`, 'ok');
    await loadHashDbContent();
    // Refresh game summaries so badges update immediately
    const summaries = await window.pork.hashGameSummary();
    _populateHashMaps(summaries);
    renderGames();
  } catch (e) {
    showToast('Import failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});
// ── Selective Clear dialog ──────────────────────────────────────────────────────
$('btn-clear-db').addEventListener('click', () => {
  // Reset all checkboxes
  document.querySelectorAll('#clear-select-options input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  $('clear-select-ok').disabled = true;
  $('clear-select-overlay').hidden = false;
});

// Toggle "Clear Selected" button enable/disable based on any checked
document.querySelectorAll('#clear-select-options input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', () => {
    const anyChecked = [...document.querySelectorAll('#clear-select-options input[type="checkbox"]')].some(c => c.checked);
    $('clear-select-ok').disabled = !anyChecked;
  });
});

// Select All button
$('clear-select-all').addEventListener('click', () => {
  document.querySelectorAll('#clear-select-options input[type="checkbox"]').forEach(cb => { cb.checked = true; });
  $('clear-select-ok').disabled = false;
});

// Cancel
$('clear-select-cancel').addEventListener('click', () => {
  $('clear-select-overlay').hidden = true;
});

// Clear Selected
$('clear-select-ok').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('#clear-select-options input[type="checkbox"]')]
    .filter(cb => cb.checked).map(cb => cb.value);
  if (!checked.length) return;

  const labels = checked.map(v => v.charAt(0).toUpperCase() + v.slice(1));

  // Hide the selection overlay so the confirm dialog is visible on top
  $('clear-select-overlay').hidden = true;
  const ok = await showConfirm(`Permanently delete: ${labels.join(', ')}?\n\nThis cannot be undone.`);
  if (!ok) {
    // User cancelled — re-show the selection overlay with their choices preserved
    $('clear-select-overlay').hidden = false;
    return;
  }

  const opts = {};
  checked.forEach(k => { opts[k] = true; });
  await window.pork.dbClearSelective(opts);

  loadDatabase();
  loadHashDbContent();
  const summaries = await window.pork.hashGameSummary();
  _populateHashMaps(summaries);
  renderGames();
  setStatus(`Cleared: ${labels.join(', ')}`, 'ok');
  showToast(`Cleared: ${labels.join(', ')}`, 'ok');
});

// ── Row-level delete handlers ────────────────────────────────────────────────────
async function _deleteSelectedRows(tableName, dbTable) {
  const ids = _getCheckedIds(tableName);
  if (!ids.length) return;
  const ok = await showConfirm(`Delete ${ids.length} ${tableName} row${ids.length !== 1 ? 's' : ''}?\n\nThis cannot be undone.`);
  if (!ok) return;
  const { deleted } = await window.pork.dbDeleteRows(dbTable, ids);
  showToast(`Deleted ${deleted} ${tableName} row${deleted !== 1 ? 's' : ''}.`, 'ok');
  // Reload the affected table
  if (tableName === 'games')   await loadDbTable('games');
  if (tableName === 'backups') await loadDbTable('backups');
  if (tableName === 'hashes')  await loadHashRowsTable();
  // Refresh game page data
  const summaries = await window.pork.hashGameSummary();
  _populateHashMaps(summaries);
  renderGames();
}

function _selectAllRows(tableName) {
  const tableEl = tableName === 'games' ? $('db-games-table')
    : tableName === 'backups' ? $('db-backups-table')
    : $('db-hash-rows-table');
  tableEl.querySelectorAll('.db-row-check').forEach(cb => { cb.checked = true; cb.closest('tr').classList.add('db-row-selected'); });
  const selectAll = tableEl.querySelector('.db-select-all');
  if (selectAll) selectAll.checked = true;
  _updateRowToolbar(tableName);
}

function _deselectAllRows(tableName) {
  const tableEl = tableName === 'games' ? $('db-games-table')
    : tableName === 'backups' ? $('db-backups-table')
    : $('db-hash-rows-table');
  tableEl.querySelectorAll('.db-row-check').forEach(cb => { cb.checked = false; cb.closest('tr').classList.remove('db-row-selected'); });
  const selectAll = tableEl.querySelector('.db-select-all');
  if (selectAll) selectAll.checked = false;
  _updateRowToolbar(tableName);
}

// Games toolbar
$('btn-delete-games').addEventListener('click', () => _deleteSelectedRows('games', 'games'));
$('btn-select-all-games').addEventListener('click', () => _selectAllRows('games'));
$('btn-deselect-all-games').addEventListener('click', () => _deselectAllRows('games'));

// Backups toolbar
$('btn-delete-backups').addEventListener('click', () => _deleteSelectedRows('backups', 'backups'));
$('btn-select-all-backups').addEventListener('click', () => _selectAllRows('backups'));
$('btn-deselect-all-backups').addEventListener('click', () => _deselectAllRows('backups'));

// Hashes toolbar
$('btn-delete-hashes').addEventListener('click', () => _deleteSelectedRows('hashes', 'game_hashes'));
$('btn-select-all-hashes').addEventListener('click', () => _selectAllRows('hashes'));
$('btn-deselect-all-hashes').addEventListener('click', () => _deselectAllRows('hashes'));

async function _clearHashes() {
  const ok = await showConfirm('Delete all stored hashes from the database? This cannot be undone.');
  if (!ok) return;
  await window.pork.dbClearHashes();
  await loadHashRowsTable();
  await loadHashDbContent();
  const summaries = await window.pork.hashGameSummary();
  _populateHashMaps(summaries);
  renderGames();
  showToast('All hashes cleared.', 'ok');
}

$('btn-clear-hashes').addEventListener('click', _clearHashes);
$('btn-hdb-clear-hashes').addEventListener('click', _clearHashes);

