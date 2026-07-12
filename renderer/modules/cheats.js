// ── Cheats page ───────────────────────────────────────────────────────────────

let _cheatsDownloading = false;

function fmtEta(sec) {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

let _cheatsSearchTimer = null;

// Map of cusa_id → prospero_icon_url, built once per loadCheats() call
let _cheatIconMap = new Map();

async function loadCheats() {
  // Hide the progress panel unless a download is actively running
  if (!_cheatsDownloading) {
    $('cheats-dl-panel').hidden = true;
    $('btn-cheats-download-all').disabled = false;
  }

  // Build icon map from games — reuse state.games if already loaded, otherwise fetch
  try {
    const games = state.games.length ? state.games : await window.pork.listGames({});
    _cheatIconMap = new Map(games.map(g => [g.game_id, g.prospero_icon_url || '']));
  } catch (_) {}

  // Update stats bar
  try {
    const stats = await window.pork.cheatsStats();
    $('cheats-stat-files').textContent  = `${stats.files ?? 0} files cached`;
    $('cheats-stat-games').textContent  = `covering ${stats.games ?? 0} games`;
    const badge = $('nav-cheats-badge');
    if (stats.files > 0) {
      badge.textContent = stats.files;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (_) {}

  // Render with current search
  const q = $('cheats-search').value.trim();
  await renderCheatResults(q);

  // Unmatched section (only shown when not searching)
  if (!q) await renderUnmatchedCheats();
  else $('cheats-unmatched-section').hidden = true;
}

// ── GarlicSaves ──────────────────────────────────────────────────────────────
let _garlicBusy   = false;
let _garlicHooked = false;

async function loadGarlic() {
  if (!_garlicHooked) {
    _garlicHooked = true;

    $('btn-garlic-site').addEventListener('click', e => {
      e.preventDefault();
      window.pork.openShell('https://garlicsaves.com');
    });
    $('garlic-contribute-link').addEventListener('click', e => {
      e.preventDefault();
      window.pork.openShell('https://garlicsaves.com/contribute');
    });

    // Start Working — show confirm modal
    $('btn-garlic-start').addEventListener('click', () => {
      if (_garlicBusy) return;
      $('garlic-confirm-overlay').hidden = false;
    });

    // Modal: Cancel
    $('btn-garlic-confirm-cancel').addEventListener('click', () => {
      $('garlic-confirm-overlay').hidden = true;
    });

    // Modal: Confirm — run the worker
    $('btn-garlic-confirm-ok').addEventListener('click', async () => {
      $('garlic-confirm-overlay').hidden = true;
      if (_garlicBusy) return;
      _garlicBusy = true;
      $('btn-garlic-start').disabled = true;
      $('garlic-progress-area').hidden = false;
      $('garlic-progress-text').textContent = 'Starting…';
      $('garlic-progress-bar').style.width  = '0%';
      try {
        await window.pork.garlicStart();
        $('garlic-status-badge').hidden = false;
        showToast('GarlicSaves worker started! Restart PS5 to stop.', 'success');
      } catch (e) {
        $('garlic-progress-text').textContent = 'Error: ' + e.message;
        showToast('Failed to start worker: ' + e.message, 'error');
      } finally {
        _garlicBusy = false;
        $('btn-garlic-start').disabled = false;
      }
    });

    // Live progress events
    window.pork.on('garlic:progress', ({ msg, percent }) => {
      const txt = $('garlic-progress-text');
      const bar = $('garlic-progress-bar');
      if (txt) txt.textContent = msg;
      if (bar && percent != null) bar.style.width = Math.min(100, percent) + '%';
    });
  }
}

function _garlicShowProgress(show) {
  $('garlic-progress-area').hidden = !show;
  if (show) {
    $('garlic-progress-text').textContent = 'Starting…';
    $('garlic-progress-bar').style.width  = '0%';
  }
}


let _lazyIconCancel = false;

// Fetch icons from prosperopatches.com for cheat entries not already in the icon map.
// Throttled at one request per 500 ms, capped at 100 entries, cancellable.
async function lazyFetchCheatIcons(cusaIds) {
  _lazyIconCancel = true;                        // cancel any prior run
  await new Promise(r => setTimeout(r, 20));     // let prior loop see the flag
  _lazyIconCancel = false;

  const toFetch = cusaIds.slice(0, 100);
  for (let i = 0; i < toFetch.length; i++) {
    if (_lazyIconCancel) break;
    const id = toFetch[i];
    try {
      const { iconUrl } = await window.pork.prosperoFetchIcon(id);
      if (_lazyIconCancel) break;
      if (iconUrl) {
        _cheatIconMap.set(id, iconUrl);
        // Update every visible card for this game
        document.querySelectorAll(`.cheat-card[data-cusa="${id}"]`).forEach(card => {
          const empty = card.querySelector('.cheat-card-icon-empty');
          if (!empty) return;
          const img = document.createElement('img');
          img.className = 'cheat-card-icon';
          img.alt = '';
          img.src = iconUrl;
          img.onerror = () => { img.style.display = 'none'; };
          empty.replaceWith(img);
        });
      }
    } catch (_) {}
    if (!_lazyIconCancel && i < toFetch.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function renderCheatResults(query) {
  const list  = $('cheats-list');
  const empty = $('cheats-empty');
  list.innerHTML = '<div class="empty-msg">Loading…</div>';
  empty.hidden = true;

  try {
    // Both cheatsAll() and cheatsSearch() return flat rows: { cusa_id, title, file_count }
    const rows = query
      ? await window.pork.cheatsSearch(query)
      : await window.pork.cheatsAll();

    list.innerHTML = '';
    if (!rows || rows.length === 0) {
      empty.hidden = false;
      return;
    }

    for (const row of rows) {
      const card = document.createElement('div');
      card.className = 'cheat-card';
      card.dataset.cusa = row.cusa_id;
      const fc      = row.file_count ?? 1;
      const iconUrl = _cheatIconMap.get(row.cusa_id) || '';
      const iconHtml = iconUrl
        ? `<img src="${escHtml(iconUrl)}" class="cheat-card-icon" alt="" onerror="this.style.display='none'">`
        : `<div class="cheat-card-icon cheat-card-icon-empty"></div>`;
      card.innerHTML = `
        <div class="cheat-card-header">
          ${iconHtml}
          <div class="cheat-card-info">
            <div class="cheat-card-title-row">
              <span class="cheat-card-id">${escHtml(row.cusa_id)}</span>
              <span class="cheat-card-title">${escHtml(row.title || row.cusa_id)}</span>
            </div>
            <span class="cheat-card-meta">${fc} version${fc !== 1 ? 's' : ''} cached</span>
          </div>
        </div>`;
      list.appendChild(card);
    }

    // Background-fetch icons for entries that have no icon in the map
    const missing = rows.filter(r => r.cusa_id && !_cheatIconMap.get(r.cusa_id)).map(r => r.cusa_id);
    if (missing.length > 0) lazyFetchCheatIcons(missing);
  } catch (e) {
    list.innerHTML = `<div class="empty-msg" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// Renders per-version file block inside modal cheat panel (has full data field)
function renderCheatFileBlock(f) {
  let parsed;
  try { parsed = typeof f.data === 'string' ? JSON.parse(f.data) : f.data; } catch (_) { parsed = null; }
  const mods = parsed?.mods ?? [];
  const modsHtml = mods.map(m => `
    <div class="cheat-mod-row">
      <span class="cheat-mod-name">${escHtml(m.name || '?')}</span>
      <span class="cheat-mod-type">${escHtml(m.type || '')}</span>
    </div>`).join('');

  return `
    <div class="cheat-file-block">
      <div class="cheat-file-ver">v${escHtml(f.version || '?')} <span style="opacity:.55;font-size:.8em">${escHtml(f.filename || '')}</span></div>
      <div class="cheat-mod-list">${modsHtml || '<span style="opacity:.45">No mods parsed</span>'}</div>
    </div>`;
}

async function renderUnmatchedCheats() {
  const section = $('cheats-unmatched-section');
  const list    = $('cheats-unmatched-list');
  const badge   = $('cheats-unmatched-count');

  try {
    const rows = await window.pork.cheatsUnmatched();
    if (!rows || rows.length === 0) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    badge.textContent = rows.length;

    list.innerHTML = rows.map(r => `
      <div class="cheat-unmatched-row" data-filename="${escHtml(r.filename)}">
        <div class="cheat-unmatched-info">
          <span class="cheat-unmatched-title">${escHtml(r.title || r.filename)}</span>
          <span class="cheat-unmatched-file">${escHtml(r.filename)}</span>
        </div>
        <div class="cheat-unmatched-assign">
          <input type="text" class="unmatched-cusa-input" placeholder="CUSA00000" maxlength="9" spellcheck="false" aria-label="Assign game ID"/>
          <button class="btn btn-sm btn-accent btn-assign-cusa">Assign</button>
        </div>
      </div>`).join('');
  } catch (e) {
    section.hidden = false;
    list.innerHTML = `<div class="empty-msg" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// Assign CUSA ID delegation
$('cheats-unmatched-list').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-assign-cusa');
  if (!btn) return;
  const row      = btn.closest('.cheat-unmatched-row');
  const filename = row?.dataset.filename;
  const input    = row?.querySelector('.unmatched-cusa-input');
  const cusaId   = input?.value.trim().toUpperCase();

  if (!filename || !cusaId || !/^[A-Z]{4}\d{5}$/.test(cusaId)) {
    input?.focus();
    input?.classList.add('input-error');
    setTimeout(() => input?.classList.remove('input-error'), 1200);
    return;
  }

  btn.disabled = true;
  btn.textContent = '…';
  try {
    await window.pork.cheatsAssign(filename, cusaId);
    row.style.opacity = '0';
    row.style.transition = 'opacity .3s';
    setTimeout(() => renderUnmatchedCheats(), 320);
    // Refresh stats / matched list
    loadCheats();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Assign';
    setStatus(`Assign failed: ${err.message}`, 'error');
  }
});

// Search input (debounced)
$('cheats-search').addEventListener('input', () => {
  clearTimeout(_cheatsSearchTimer);
  _cheatsSearchTimer = setTimeout(() => {
    const q = $('cheats-search').value.trim();
    renderCheatResults(q);
    if (!q) renderUnmatchedCheats();
    else $('cheats-unmatched-section').hidden = true;
  }, 350);
});

// Download-all
$('btn-cheats-download-all').addEventListener('click', async () => {
  _cheatsDownloading = true;
  $('cheats-dl-panel').hidden = false;
  $('cheats-dl-title').textContent = 'Fetching cheat index…';
  $('cheats-dl-bar').style.width = '0%';
  $('cheats-dl-count').textContent = '0 / 0';
  $('cheats-dl-pct').textContent = '0%';
  $('cheats-dl-saved').textContent = 'Saved: 0';
  $('cheats-dl-failed').textContent = 'Failed: 0';
  $('cheats-dl-eta').textContent = 'ETA: —';
  $('cheats-dl-current').textContent = '';
  $('btn-cheats-download-all').disabled = true;
  try {
    await window.pork.cheatsDownloadAll();
  } catch (e) {
    _cheatsDownloading = false;
    $('cheats-dl-title').textContent = `Error: ${e.message}`;
    $('btn-cheats-download-all').disabled = false;
  }
});

// Cancel download
$('btn-cheats-dl-cancel').addEventListener('click', async () => {
  await window.pork.cheatsCancel();
  $('cheats-dl-title').textContent = 'Cancelling…';
});

// Progress IPC events
window.pork.on('cheats:dl:start', ({ total }) => {
  $('cheats-dl-title').textContent = `Downloading cheat database…`;
  $('cheats-dl-count').textContent = `0 / ${total}`;
  $('cheats-dl-bar').style.width = '0%';
});

window.pork.on('cheats:dl:progress', ({ done, total, saved, failed, etaSec, current, pct }) => {
  $('cheats-dl-bar').style.width  = `${pct}%`;
  $('cheats-dl-count').textContent = `${done} / ${total}`;
  $('cheats-dl-pct').textContent   = `${pct}%`;
  $('cheats-dl-saved').textContent  = `Saved: ${saved}`;
  $('cheats-dl-failed').textContent = `Failed: ${failed}`;
  $('cheats-dl-eta').textContent    = `ETA: ${fmtEta(etaSec)}`;
  $('cheats-dl-current').textContent = current || '';
});

window.pork.on('cheats:dl:done', ({ saved, failed, cancelled }) => {
  _cheatsDownloading = false;
  $('cheats-dl-bar').style.width = cancelled ? $('cheats-dl-bar').style.width : '100%';
  $('cheats-dl-title').textContent = cancelled
    ? `Download cancelled — ${saved} saved, ${failed} failed`
    : `Done — ${saved} saved, ${failed} failed`;
  $('cheats-dl-pct').textContent   = cancelled ? '' : '100%';
  $('cheats-dl-eta').textContent   = '';
  $('cheats-dl-current').textContent = '';
  $('btn-cheats-download-all').disabled = false;
  // Refresh stats + list
  loadCheats();
});

// ── Cheats FTP install ─────────────────────────────────────────────────────────

$('btn-cheats-ftp-install').addEventListener('click', async () => {
  // Reset panel to instruction state
  $('cheats-ftp-progress-wrap').hidden = true;
  $('cheats-ftp-bar').style.width = '0%';
  $('cheats-ftp-phase').textContent = 'Preparing…';
  $('cheats-ftp-count').textContent = '';
  $('cheats-ftp-pct').textContent = '0%';
  $('cheats-ftp-current').textContent = '';
  $('cheats-ftp-title').textContent = 'Install Cheats via FTP';
  $('btn-cheats-ftp-go').disabled = false;
  $('btn-cheats-ftp-go').textContent = '↑ Install Now';
  // Populate path from settings
  const s = await window.pork.getSettings();
  const configuredPath = (s.cheatsRemotePath || '').trim();
  $('cheats-ftp-path').value = configuredPath || '/data/etaHEN/cheats/';
  $('cheats-ftp-no-path-warn').hidden = !!configuredPath;
  $('cheats-ftp-panel').hidden = false;
});

$('btn-cheats-ftp-browse').addEventListener('click', async () => {
  const cur = $('cheats-ftp-path').value.trim() || '/';
  const p = await openFtpBrowser(cur);
  if (p) $('cheats-ftp-path').value = p;
});

$('btn-cheats-ftp-close').addEventListener('click', () => {
  $('cheats-ftp-panel').hidden = true;
});

$('btn-cheats-ftp-go').addEventListener('click', async () => {
  $('btn-cheats-ftp-go').disabled = true;
  $('btn-cheats-ftp-go').textContent = 'Installing…';
  $('cheats-ftp-progress-wrap').hidden = false;
  try {
    const remotePath = $('cheats-ftp-path').value.trim() || '/data/etaHEN/cheats/';
    await window.pork.cheatsFtpInstall(remotePath);
  } catch (e) {
    $('cheats-ftp-title').textContent = `Error: ${e.message}`;
    $('btn-cheats-ftp-go').disabled = false;
    $('btn-cheats-ftp-go').textContent = '↑ Retry';
  }
});

window.pork.on('cheats:ftp:start', ({ total }) => {
  $('cheats-ftp-count').textContent = `0 / ${total}`;
});

window.pork.on('cheats:ftp:progress', ({ phase, done, total, pct, current }) => {
  $('cheats-ftp-bar').style.width  = `${pct}%`;
  $('cheats-ftp-pct').textContent  = `${pct}%`;
  $('cheats-ftp-count').textContent = `${done} / ${total}`;
  $('cheats-ftp-phase').textContent = phase === 'write' ? 'Writing files…' : 'Uploading to PS5…';
  $('cheats-ftp-current').textContent = current || '';
});

window.pork.on('cheats:ftp:done', ({ count }) => {
  $('cheats-ftp-bar').style.width   = '100%';
  $('cheats-ftp-pct').textContent   = '100%';
  $('cheats-ftp-phase').textContent = `Done — ${count} cheats installed`;
  $('cheats-ftp-current').textContent = '';
  $('cheats-ftp-title').textContent  = 'Install complete ✓';
  $('btn-cheats-ftp-go').disabled    = false;
  $('btn-cheats-ftp-go').textContent = '↑ Install Again';
});

// ── Cheats modal panel ─────────────────────────────────────────────────────────

async function renderCheatsPanel(game) {
  const body  = $('modal-cheats-body');
  const badge = $('mtab-cheats-count');
  body.innerHTML = '<div class="prospero-placeholder">Loading cheats…</div>';
  badge.textContent = '';

  try {
    const cusaId = game.game_id;
    const files  = await window.pork.cheatsForGame(cusaId);

    if (!files || files.length === 0) {
      // Nothing cached — offer to fetch on-demand
      body.innerHTML = `
        <div class="modal-cheat-fetch">
          <p>No cached cheats found for <code>${escHtml(cusaId)}</code>.</p>
          <button id="btn-modal-fetch-cheats" class="btn btn-accent">Fetch from Repository</button>
        </div>`;
      $('btn-modal-fetch-cheats').addEventListener('click', async () => {
        const fetchBtn = $('btn-modal-fetch-cheats');
        fetchBtn.disabled = true;
        fetchBtn.textContent = 'Fetching…';
        try {
          const index = await window.pork.cheatsFetchIndex();
          const matching = index.filter(e => e.cusaId === cusaId);
          if (matching.length === 0) {
            body.innerHTML = `<div class="prospero-placeholder">No cheats found in repository for ${escHtml(cusaId)}.</div>`;
            return;
          }
          // Download the cheat database (cached, with progress on the Cheats page),
          // then re-render this game's cheats from the freshly populated cache.
          fetchBtn.textContent = `Downloading ${matching.length} file(s)…`;
          await window.pork.cheatsDownloadAll();
          const cached = await window.pork.cheatsForGame(cusaId);
          if (cached && cached.length) {
            badge.textContent = cached.length;
            body.innerHTML = cached.map(f => renderCheatFileBlock(f)).join('');
          } else {
            body.innerHTML = `<div class="prospero-placeholder">Downloaded, but no cheats cached for ${escHtml(cusaId)}.</div>`;
          }
        } catch (e) {
          body.innerHTML = `<div class="prospero-placeholder" style="color:var(--red)">Fetch failed: ${escHtml(e.message)}</div>`;
        }
      });
      return;
    }

    badge.textContent = files.length;
    const modCount = files.reduce((n, f) => {
      try { const d = typeof f.data === 'string' ? JSON.parse(f.data) : f.data; return n + (d?.mods?.length ?? 0); } catch (_) { return n; }
    }, 0);

    body.innerHTML = files.map(f => renderCheatFileBlock(f)).join('');
    badge.textContent = `${modCount}`;
  } catch (e) {
    body.innerHTML = `<div class="prospero-placeholder" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

