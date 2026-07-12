// ── System View hotkeys ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Escape always exits in-app fullscreen, regardless of active page
  if (e.key === 'Escape' && $('sv-viewer-wrap')?.classList.contains('sv-viewer-wrap--fullscreen')) {
    e.preventDefault();
    svToggleFullscreen();
    return;
  }
  if (!$('page-system-view')?.classList.contains('active')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === _svHotkeys.mute)            { e.preventDefault(); $('btn-sv-mute').click(); }
  else if (k === _svHotkeys.gif)        { e.preventDefault(); $('btn-sv-record').click(); }
  else if (k === _svHotkeys.video)      { e.preventDefault(); $('btn-sv-vid-rec').click(); }
  else if (k === _svHotkeys.fullscreen) { e.preventDefault(); svToggleFullscreen(); }
  else if (k === _svHotkeys.popout)     { e.preventDefault(); $('btn-sv-popout').click(); }
});

// Auto-scan toast on launch
window.pork.on('local:scan:complete', async ({ total, added }) => {
  if (added > 0) {
    showToast(`Auto-scan: found ${added} new game${added !== 1 ? 's' : ''} (${total} total) — fetching metadata…`, 'ok');
  } else if (total > 0) {
    showToast(`Auto-scan: ${total} game${total !== 1 ? 's' : ''} already tracked`, 'info');
  }
  // Always refresh the active page so pruned/stale game rows clear from the UI
  // even when 0 games were found this scan.
  const activePage = document.querySelector('.page.active')?.id;
  if (activePage === 'page-dashboard') loadDashboard();
  if (activePage === 'page-games')     loadGames();
  if (activePage === 'page-backups')   loadBackups();
});

// Toast when Prospero background queue finishes
window.pork.on('prospero:queue:done', ({ fetched, failed }) => {
  if (fetched > 0 && failed === 0) {
    showToast(`Metadata fetched for ${fetched} game${fetched !== 1 ? 's' : ''}`, 'ok');
  } else if (fetched > 0) {
    showToast(`Metadata fetched for ${fetched} game${fetched !== 1 ? 's' : ''} (${failed} failed)`, 'info');
  } else if (failed > 0) {
    showToast(`Metadata fetch failed for ${failed} game${failed !== 1 ? 's' : ''}`, 'error', 8000);
  }
});

// Live-refresh modal when background fetch completes
window.pork.on('prospero:updated', async ({ game_id, data }) => {
  // Reload games list in background so future opens have fresh data
  state.games = await window.pork.listGames({});
  renderGames(); // Redraw table so icon/name/metadata show without requiring a page nav

  // Update cheat icon map and any visible cheat card for this game
  if (data.iconUrl) {
    _cheatIconMap.set(game_id, data.iconUrl);
    document.querySelectorAll(`.cheat-card[data-cusa="${game_id}"]`).forEach(card => {
      const empty = card.querySelector('.cheat-card-icon-empty');
      if (!empty) return;
      const img = document.createElement('img');
      img.className = 'cheat-card-icon';
      img.alt = '';
      img.src = data.iconUrl;
      img.onerror = () => { img.style.display = 'none'; };
      empty.replaceWith(img);
    });
  }

  // If the modal is open for this game, refresh it
  if (state.currentGame?.game_id === game_id) {
    const updated = state.games.find(g => g.game_id === game_id);
    if (updated) {
      state.currentGame = updated;
      $('modal-title').textContent    = updated.prospero_name || updated.title || game_id;
      $('modal-subtitle').textContent = `${updated.game_id}  ·  ${updated.prospero_region || (updated.version ? 'v' + updated.version : '')}`;

      // Refresh info table with new metadata
      const patches    = tryParseJson(updated.prospero_patches, []);
      const fwVersions = [...new Set(patches.map(p => p.requiredFirmware).filter(Boolean))];
      const dlc        = tryParseJson(updated.prospero_dlc, []);
      const infoRows   = [
        ['Game ID',           updated.game_id],
        ['Content ID',        updated.content_id || updated.prospero_content_id || '—'],
        ['Version',           updated.version || updated.prospero_version || '—'],
        ['Size',              updated.backup_size ? fmt(updated.backup_size) : (updated.size ? fmt(updated.size) : (updated.prospero_size || '—'))],
        ['Installed',         updated.installed  ? 'Yes' : 'No'],
        ['Backed Up',         updated.backed_up  ? 'Yes' : 'No'],
        ['Porked To',         updated.porked_firmware ? `${updated.porked_firmware}${updated.porked_at ? '  (' + new Date(updated.porked_at).toLocaleDateString() + ')' : ''}` : '—'],
        ['Publisher',         updated.prospero_publisher    || '—'],
        ['Publisher ID',      updated.prospero_publisher_id || '—'],
        ['Region',            updated.prospero_region       || '—'],
        ['Last Updated',      updated.prospero_last_updated || '—'],
        ['Required Firmware', fwVersions.length ? fwVersions.join(', ') : '—'],
        ['DLC Available',     dlc.length ? `${dlc.length} item(s)` : 'None'],
        ['FTP Path',          updated.ftp_path   || '—'],
        ['Last Scanned',      updated.last_scanned ? new Date(updated.last_scanned).toLocaleString() : '—'],
        ['Metadata Age',      updated.prospero_fetched_at ? fmtAge(Date.now() - updated.prospero_fetched_at) : 'Never fetched'],
      ];
      $('modal-info').innerHTML = infoRows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('');

      renderProsperoData(updated);
    }
  }
});

