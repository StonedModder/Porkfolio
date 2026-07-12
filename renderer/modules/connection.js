// ── Connection state ──────────────────────────────────────────────────────────
function setConnected(on) {
  state.connected = on;
  const dot   = $('conn-dot');
  const label = $('conn-label');
  const badge = $('dash-conn-badge');
  const sbConn = $('sb-conn');

  dot.className   = `dot ${on ? 'green' : 'red'}`;
  label.textContent = on ? 'Connected' : 'Disconnected';
  badge.textContent = on ? 'Online' : 'Offline';
  badge.className   = `badge ${on ? 'badge-green' : 'badge-red'}`;
  sbConn.textContent = on ? '🟢 Connected' : '⚫ Disconnected';

  $('btn-connect').disabled    = on;
  $('btn-disconnect').disabled = !on;
  $('btn-scan').disabled       = !on;

  // Re-evaluate PS5 action buttons — only enabled when connected AND a location is stored
  const deleteBtn  = $('btn-manage-delete-ps5');
  const backupBtn  = $('btn-manage-backup-ps5');
  if (deleteBtn) deleteBtn.disabled = !on || !state.currentGame?.ftp_path;
  if (backupBtn) backupBtn.disabled = !on || !state.currentGame?.ftp_path;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const settings = await window.pork.getSettings();
    const stats = await window.pork.getStats();
    $('s-total').textContent    = stats.totalGames;
    $('s-installed').textContent = stats.installed;
    $('s-backedup').textContent  = stats.backedUp;
    $('s-backups').textContent   = stats.totalBackups;
    if ($('d-host') && document.activeElement !== $('d-host') && !$('d-host').value) {
      $('d-host').value = settings.ftpHost || '';
    }
    if ($('d-ports') && document.activeElement !== $('d-ports') && !$('d-ports').value) {
      $('d-ports').value = (settings.ftpPorts && settings.ftpPorts.length) ? settings.ftpPorts.join(', ') : '1337, 2121, 21';
    }
  } catch (_) {}
  renderPinnedTiles();
}

async function renderPinnedTiles() {
  const grid  = $('dash-pinned-grid');
  const empty = $('dash-pinned-empty');
  if (!grid) return;
  try {
    const s      = await window.pork.getSettings();
    const pinned = new Set(s.pinnedCards || []);
    const cards  = PINNABLE_CARDS.filter(c => pinned.has(c.id));

    grid.innerHTML = '';
    if (!cards.length) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      let hasVsTiles = false;
      for (const c of cards) {
        const tile = document.createElement('div');
        tile.className = 'dash-pinned-tile';
        tile.dataset.navPage = c.page;
        if (c.type === 'widget' || c.type === 'vs-widget') {
          tile.classList.add('dash-pinned-tile--widget');
          tile.removeAttribute('data-nav-page');
          tile.innerHTML = _renderWidgetTile(c);
          grid.appendChild(tile);
          _initWidgetTile(c, tile);
          continue; // already appended
        } else if (c.type === 'vs') {
          hasVsTiles = true;
          tile.dataset.vsStat = c.stat;
          tile.innerHTML = `
            <div class="dash-pinned-tile-title">${escHtml(c.label)}</div>
            <div class="dash-pinned-tile-page">${escHtml(_PIN_PAGE_LABELS[c.page] || c.page)}</div>
            <div class="dash-pinned-tile-vs-val" id="vs-dash-${escHtml(c.stat)}">—</div>
            <div class="dash-pinned-tile-hint">${escHtml(c.hint)}</div>
            <button class="btn btn-sm dash-pinned-tile-open">Open &rarr;</button>`;
        } else {
          tile.innerHTML = `
            <div class="dash-pinned-tile-title">${escHtml(c.label)}</div>
            <div class="dash-pinned-tile-page">${escHtml(_PIN_PAGE_LABELS[c.page] || c.page)}</div>
            <div class="dash-pinned-tile-hint">${escHtml(c.hint)}</div>
            <button class="btn btn-sm dash-pinned-tile-open">Open &rarr;</button>`;
        }
        grid.appendChild(tile);
      }
      if (hasVsTiles) _updateVsDashTiles().catch(() => {});
    }

    // Sync all pin button visual states across the whole page
    document.querySelectorAll('.btn-pin').forEach(btn => {
      btn.classList.toggle('pinned', pinned.has(btn.dataset.pinId));
    });
  } catch (_) {}
}

async function _updateVsDashTiles() {
  try {
    const r = await window.pork.vsRequest('/api/stats');
    if (!r || !r.ok) return;
    const s = r.data;
    const vals = {
      soc:         `${s.soc ?? '—'}°C`,
      cpu:         `${s.cpu ?? '—'}°C`,
      sys_uptime:  s.sys_uptime || '—',
      active_game: (s.active_game && s.active_game !== 'MENU' && s.active_game !== '')
                     ? s.active_game : 'No game',
      total:       `${s.total ?? '—'} games`,
      username:    s.username || '—',
    };
    for (const [stat, val] of Object.entries(vals)) {
      const el = document.getElementById(`vs-dash-${stat}`);
      if (el) el.textContent = val;
    }
  } catch (_) {}
}

// ── FTP Connect ───────────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', async () => {
  const host  = $('d-host').value.trim();
  const ports = $('d-ports').value.split(',').map(p => p.trim()).filter(Boolean);
  if (!ports.length) ports.push('21');
  if (!host) { setStatus('Enter a host address', 'error'); return; }

  // Credential fields start blank. Fall back to stored settings when blank
  // so the user can click Connect without re-typing every session.
  const saved    = await window.pork.getSettings();
  const user     = $('d-user').value.trim() || saved.ftpUser || '';
  const password = $('d-pass').value        || saved.ftpPass || '';

  $('btn-connect').disabled = true;
  setStatus('Connecting…');
  try {
    const result = await window.pork.ftpConnect({ host, ports, user, password });
    setConnected(true);
    setStatus('Connected', 'ok');
    $('sb-sync').textContent = `Connected on :${result?.port || ports[0]} at ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    setConnected(false);
    setStatus(`Connection failed: ${e.message}`, 'error');
    $('btn-connect').disabled = false;
  }
});

$('btn-disconnect').addEventListener('click', async () => {
  await window.pork.ftpDisconnect();
  setConnected(false);
  setStatus('Disconnected');
});

// ── FTP Scan ──────────────────────────────────────────────────────────────────
$('btn-scan').addEventListener('click', async () => {
  const prog = $('scan-progress');
  prog.hidden = false;
  prog.textContent = 'Scanning PS5 game folders…';
  $('btn-scan').disabled = true;

  window.pork.on('ftp:progress', ({ current, game }) => {
    prog.textContent = `[${current}] Found: ${game.title || game.game_id}`;
  });

  try {
    const { count } = await window.pork.ftpScan();
    prog.textContent = `Scan complete — ${count} game(s) found.`;
    $('sb-sync').textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
    setStatus(`Scanned ${count} games`, 'ok');
    await loadDashboard();
  } catch (e) {
    prog.textContent = `Error: ${e.message}`;
    setStatus(e.message, 'error');
  } finally {
    window.pork.off('ftp:progress');
    $('btn-scan').disabled = false;
  }
});

