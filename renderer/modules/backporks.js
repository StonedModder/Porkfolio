// ── Backporks page ─────────────────────────────────────────────────────────────
let _bpgenPageInitStarted = false;
let _bpgenPageInitPromise = null;

// "Apply All" progress delegation. A single persistent transfer:update listener
// (bound once below) forwards to whatever updater the current Apply-All run set.
// This avoids leaking a new listener on every click — and avoids pork.off(), which
// would also remove the global transfer badge listener in system-view.js.
let _bpApplyUpdater = null;
window.pork.on('transfer:update', st => { _bpApplyUpdater?.(st); });

function renderBpgenSdkOptions(pairs, currentValue = '') {
  const sdkSelect = $('bpgen-sdk-pair');
  if (!sdkSelect) return;
  sdkSelect.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All SDK Targets';
  sdkSelect.appendChild(allOpt);
  for (const pair of pairs || []) {
    const opt = document.createElement('option');
    opt.value = String(pair.pair);
    opt.textContent = `SDK Pair ${pair.pair}  -  PS5: ${pair.ps5Ver}  /  PS4: ${pair.ps4Ver}`;
    sdkSelect.appendChild(opt);
  }
  if (currentValue && [...sdkSelect.options].some(o => o.value === String(currentValue))) {
    sdkSelect.value = String(currentValue);
  }
}

function pickReadyBpgenPair(pairs, preferredPair = '') {
  const ready = (pairs || []).filter(p => p.hasLibs).sort((a, b) => a.pair - b.pair);
  if (!ready.length) return null;
  return ready.find(p => String(p.pair) === String(preferredPair)) || ready[0];
}

async function hydrateBpgenCard() {
  const sdkSelect = $('bpgen-sdk-pair');
  if (!sdkSelect) return;

  const [settings, sdkPairs, scan] = await Promise.all([
    window.pork.getSettings().catch(() => ({})),
    window.pork.bpgenSdkPairs().catch(() => []),
    window.pork.bpgenFakelibScan().catch(() => ({ baseDir: '', pairs: [] })),
  ]);

  const savedPair = settings.bpgenSdkPair || '';
  renderBpgenSdkOptions(sdkPairs, savedPair);

  $('bpgen-output-dir').value = settings.bpgenOutputDir || '';
  $('bpgen-fl-basedir').value = scan.baseDir || settings.bpgenFakelibBaseDir || '';
  $('bpgen-fakelib-dir').value = settings.bpgenFakelibDir || '';
  $('bpgen-fw-label').value = settings.bpgenFirmwareLabel || '';

  const activePair = pickReadyBpgenPair(scan.pairs, savedPair);
  if (savedPair === 'all') {
    sdkSelect.value = 'all';
    $('bpgen-fw-label').value = 'All';
  } else if (savedPair && [...sdkSelect.options].some(o => o.value === String(savedPair))) {
    sdkSelect.value = String(savedPair);
  } else if (activePair) {
    // Prefer a ready fakelib pair for the initial UI state, but do not
    // overwrite persisted settings just because the page was opened.
    sdkSelect.value = String(activePair.pair);
    if (!$('bpgen-fw-label').value.trim()) $('bpgen-fw-label').value = `${activePair.pair}.xx`;
    if (!$('bpgen-fakelib-dir').value.trim()) $('bpgen-fakelib-dir').value = activePair.dir || '';
  }
}

function ensureBpgenPageInit() {
  if (_bpgenPageInitPromise) return _bpgenPageInitPromise;
  _bpgenPageInitPromise = hydrateBpgenCard().catch(err => {
    console.error('[backporks] bpgen hydrate failed', err);
  });
  return _bpgenPageInitPromise;
}

async function loadBackporks() {
  ensureBpgenPageInit();
  const folders = await window.pork.backporksList();
  // Refresh hash summaries so game-row badges are current
  try {
    const summaries = await window.pork.hashGameSummary();
    _populateHashMaps(summaries);
  } catch (_) {}
  const list    = $('backpork-list');
  const empty   = $('backpork-empty');

  list.innerHTML = '<div class="backpork-game-row" style="color:var(--text-dim);font-size:12px">Loading firmware folders…</div>';
  empty.style.display = folders.length ? 'none' : 'block';
  if (!folders.length) { list.innerHTML = ''; return; }

  const gamesByFolder = await Promise.all(
    folders.map(async f => ({ folder: f, games: await window.pork.backporksGames(f.name) }))
  );

  list.innerHTML = '';

  for (const { folder: f, games } of gamesByFolder) {

    const card = document.createElement('div');
    card.className = 'backpork-card';

    const gamesHtml = games.length ? games.map(g => {
      const title   = g.prospero_name || g.title || g.game_id;
      const porked  = g.porked_firmware === f.name;
      const _bhs    = _backporkHashSummary.get(g.game_id + '|' + f.name) || _gameHashSummary.get(g.game_id);
      const hashPill = _bhs
        ? _bhs.community_mismatch
          ? `<span class="backpork-porked-pill hash-pill-fail" title="⚠ Community hash check FAILED — may contain modified or malicious files">⚠ Hash Fail</span>`
          : _bhs.community_matches > 0
            ? `<span class="backpork-porked-pill hash-pill-ok" title="Community verified: ${_bhs.community_matches}/${_bhs.hash_count} files">✓ Verified</span>`
            : `<span class="backpork-porked-pill hash-pill-local" title="${_bhs.hash_count} file(s) hashed">⧭ Hashed</span>`
        : '';
      return `
        <div class="backpork-game-row">
          ${g.prospero_icon_url
            ? `<img class="backpork-game-icon" src="${escHtml(g.prospero_icon_url)}" alt="" onerror="this.style.display='none'"/>`
            : '<div class="backpork-game-icon"></div>'}
          <div class="backpork-game-info">
            <div class="backpork-game-title" title="${escHtml(title)}">${escHtml(title)}</div>
            <div class="backpork-game-id">${escHtml(g.game_id)}</div>
          </div>
          ${porked ? `<span class="backpork-porked-pill">✓ Porked</span>` : ''}
          ${hashPill}
          <div class="backpork-game-actions">
            <button class="btn btn-sm" data-bp-view="${escHtml(g.game_id)}">View</button>
            <button class="btn btn-sm btn-teal"
                    data-bp-pork="${escHtml(g.game_id)}"
                    data-bp-fw="${escHtml(f.name)}"
                    data-bp-path="${escHtml(f.path)}"
                    ${!state.connected ? 'disabled title="Connect to PS5 first"' : ''}>
              Pork ▶
            </button>
          </div>
        </div>`;
    }).join('') : '<div class="backpork-game-row" style="color:var(--text-dim);font-size:12px">No games detected — click Rescan</div>';

    card.innerHTML = `
      <div class="backpork-card-header">
        <div class="backpork-badge">${escHtml(f.name)}</div>
        <div class="backpork-info">
          <div class="backpork-path" title="${escHtml(f.path)}">${escHtml(f.path)}</div>
          <div class="backpork-count"><strong>${games.length}</strong> game(s) detected</div>
        </div>
        <div class="backpork-actions">
          <button class="btn btn-sm btn-teal" data-action="scan" data-id="${f.id}">&#8635; Rescan</button>
          <button class="btn btn-sm btn-teal"
                  data-action="pork-all"
                  data-id="${f.id}"
                  data-fw="${escHtml(f.name)}"
                  data-path="${escHtml(f.path)}"
                  ${!state.connected ? 'disabled title="Connect to PS5 first"' : ''}
                  title="Queue all ${games.length} game(s) from ${escHtml(f.name)} for PS5 install">
            &#x1F527; Apply All (${games.length})
          </button>
          <button class="btn btn-sm btn-danger" data-action="remove" data-id="${f.id}">Remove</button>
        </div>
      </div>
      <div class="backpork-games">${gamesHtml}</div>`;

    list.appendChild(card);
  }

  list.onclick = async e => {
    // Rescan / Remove
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'scan') {
        btn.disabled = true; btn.textContent = 'Scanning…';
        try {
          const { count } = await window.pork.backporksScan(id);
          setStatus(`Rescan complete — ${count} game(s) found`, 'ok');
          await loadBackporks();
          await refreshFirmwareFilters();
        } catch (err) { setStatus(err.message, 'error'); }
      }
      if (btn.dataset.action === 'remove') {
        const fwName = btn.closest('.backpork-card')?.querySelector('.backpork-badge')?.textContent || String(id);
        if (!confirm(`Remove firmware folder "${fwName}" from Porkfolio?`)) return;
        await window.pork.backporksRemove(id);
        setStatus('Folder removed', 'ok');
        await loadBackporks();
        await refreshFirmwareFilters();
      }

      if (btn.dataset.action === 'pork-all') {
        const folderName = btn.dataset.fw;
        const folderPath = btn.dataset.path;
        const folderEntry = gamesByFolder.find(({ folder }) => folder.name === folderName);
        const folderGames = folderEntry?.games || [];

        if (!folderGames.length) { setStatus('No games in this firmware folder', 'warn'); return; }
        if (!await showConfirm(`Queue all ${folderGames.length} game(s) from ${folderName} for PS5 install?\n\nProgress will be shown below in real-time.`)) return;

        // ── Progress panel helpers ────────────────────────────────────────────
        const panel     = $('pork-all-progress-panel');
        const queueFill = $('pork-all-queue-fill');
        const queueLbl  = $('pork-all-queue-label');
        const queueCnt  = $('pork-all-queue-count');
        const gameLbl   = $('pork-all-current-game');
        const fileFill  = $('pork-all-file-fill');
        const fileLbl   = $('pork-all-file-label');
        const logEl     = $('pork-all-log');

        panel.style.display = '';
        logEl.textContent = '';
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        const ts = () => new Date().toLocaleTimeString();
        function appendLog(line, color) {
          const span = document.createElement('span');
          if (color) span.style.color = color;
          span.textContent = `[${ts()}] ${line}\n`;
          logEl.appendChild(span);
          logEl.scrollTop = logEl.scrollHeight;
        }

        function fmtBytes(b) {
          if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
          if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
          if (b >= 1024)       return (b / 1024).toFixed(0) + ' KB';
          return b + ' B';
        }
        function fmtSpeed(bps) {
          return fmtBytes(bps) + '/s';
        }

        // ── Phase 1: Resolve FTP paths (before registering listener) ────────────
        btn.disabled = true;
        btn.textContent = 'Resolving paths…';
        appendLog(`Starting bulk apply — ${folderGames.length} game(s) from ${folderName}`);
        queueLbl.textContent = `Resolving FTP paths… (0 / ${folderGames.length})`;

        const readyGames = []; // { game, ftpDest }
        let skipped = 0, failed = 0;
        let pathsDone = 0;

        for (const game of folderGames) {
          try {
            const ftpDest = await ensureGameFtpPath(game.game_id);
            pathsDone++;
            if (!ftpDest) {
              skipped++;
              appendLog(`  SKIP  ${game.game_id} — no FTP path (cancelled)`, '#f59e0b');
            } else {
              appendLog(`  PATH  ${game.game_id} → ${ftpDest}`);
              readyGames.push({ game, ftpDest });
            }
            queueLbl.textContent = `Resolving FTP paths… (${pathsDone} / ${folderGames.length})`;
          } catch (err) {
            pathsDone++;
            failed++;
            appendLog(`  ERROR  ${game.game_id}: ${err.message}`, '#f87171');
            console.error('[pork-all]', game.game_id, err.message);
          }
        }

        if (!readyGames.length) {
          const parts = [`Nothing queued from ${folderName}`];
          if (skipped) parts.push(`${skipped} skipped`);
          if (failed)  parts.push(`${failed} failed`);
          appendLog(`\n${parts.join(' — ')}`, '#f59e0b');
          setStatus(parts.join(' — '), 'warn');
          panel.style.display = 'none';
          btn.disabled = false;
          btn.textContent = `\u{1F527} Apply All (${folderGames.length})`;
          return;
        }

        // ── Phase 2: Register listener BEFORE queuing so we catch all events ──
        const batchIds  = new Set();
        const gameById  = {};
        const lastState = {};
        let doneCount   = 0;
        let lastLoggedFile = {};
        let batchDone = false;

        const updateProgress = (transferState) => {
          if (batchDone) return;
          const batchJobs2 = (transferState.jobs || []).filter(j => batchIds.has(j.id));

          // Count completed
          let nowDone = 0;
          let activeJob = null;

          for (const j of batchJobs2) {
            const game = gameById[j.id];
            const prev = lastState[j.id];

            if (j.status === 'active') activeJob = j;

            if (j.status !== prev) {
              lastState[j.id] = j.status;
              if (j.status === 'active') {
                appendLog(`\n▶ START  #${j.id}  ${game?.game_id || j.gameId}  (${j.label})`);
              } else if (j.status === 'done') {
                nowDone++;
                appendLog(`✓ DONE   #${j.id}  ${game?.game_id || j.gameId}`, '#4ade80');
              } else if (j.status === 'error') {
                nowDone++;
                appendLog(`✗ ERROR  #${j.id}  ${game?.game_id || j.gameId}: ${j.error || 'unknown error'}`, '#f87171');
              } else if (j.status === 'cancelled') {
                nowDone++;
                appendLog(`⊘ CANCEL #${j.id}  ${game?.game_id || j.gameId}`, '#f59e0b');
              }
            } else if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
              nowDone++;
            }

            // Log file changes for active jobs
            if (j.status === 'active' && j.progress?.file && j.progress.file !== lastLoggedFile[j.id]) {
              lastLoggedFile[j.id] = j.progress.file;
              const fileShort = j.progress.file.replace(/\\/g, '/').split('/').pop();
              const fileInfo  = j.progress.filesTotal
                ? `  FILE  [${j.progress.filesDone + 1}/${j.progress.filesTotal}] ${fileShort}`
                : `  FILE  ${fileShort}`;
              appendLog(fileInfo);
            }
          }

          doneCount = nowDone;

          // Overall queue bar — use batchIds.size (grows as jobs are queued)
          const batchTotal = batchIds.size;
          const qPct = batchTotal > 0 ? Math.round((doneCount / batchTotal) * 100) : 0;
          if (!batchDone) {
            // Only update bar/label while we're still monitoring
            queueFill.style.width = qPct + '%';
            queueLbl.textContent  = `Applying backporks to PS5 — ${doneCount} / ${batchTotal} complete`;
            queueCnt.textContent  = `${qPct}%`;
            btn.textContent       = `Applying… (${doneCount}/${batchTotal})`;
          }

          // Per-file progress from active job
          if (activeJob) {
            const g   = gameById[activeJob.id];
            const p   = activeJob.progress || {};
            const pct = p.percent || 0;
            fileFill.style.width = pct + '%';

            const fileShort = (p.file || '').replace(/\\/g, '/').split('/').pop();
            const speedStr  = p.speedBps ? ` @ ${fmtSpeed(p.speedBps)}` : '';
            const sizeStr   = p.total    ? ` — ${fmtBytes(p.transferred)} / ${fmtBytes(p.total)}` : '';
            const filesStr  = p.filesTotal ? ` [file ${p.filesDone + 1}/${p.filesTotal}]` : '';

            gameLbl.textContent = `${g?.game_id || activeJob.gameId}${filesStr}: ${fileShort || 'preparing…'}`;
            fileLbl.textContent = `${pct.toFixed(1)}%${sizeStr}${speedStr}`;
          } else if (doneCount < batchTotal) {
            gameLbl.textContent = 'Waiting for next job to start…';
            fileLbl.textContent = '';
            fileFill.style.width = '0%';
          }

          // All batch jobs finished (or no more in queue)
          if (batchIds.size > 0 && doneCount >= batchIds.size) {
            batchDone = true;
            const errCount = batchJobs2.filter(j => j.status === 'error').length;
            const cancelCount = batchJobs2.filter(j => j.status === 'cancelled').length;
            const parts = [`Applied ${batchIds.size - errCount - cancelCount} of ${batchIds.size}`];
            if (skipped) parts.push(`${skipped} skipped`);
            if (failed)  parts.push(`${failed} path errors`);
            if (errCount) parts.push(`${errCount} transfer errors`);
            appendLog(`\n━━━ All done — ${parts.join(', ')} ━━━`, '#4ade80');
            queueFill.style.width = '100%';
            queueLbl.textContent  = `Bulk apply complete — ${parts.join(', ')}`;
            queueCnt.textContent  = '100%';
            gameLbl.textContent   = '';
            fileLbl.textContent   = '';
            fileFill.style.width  = '0%';
            btn.disabled = false;
            btn.textContent = `\u{1F527} Apply All (${folderGames.length})`;
            setStatus(parts.join(' — '), errCount || failed ? 'warn' : 'ok');
            loadBackporks().catch(() => {});
            _bpApplyUpdater = null; // stop forwarding transfer:update to this run
          }
        };

        _bpApplyUpdater = updateProgress;

        // ── Phase 3: Queue jobs now that listener is active ───────────────────
        appendLog(`\nQueuing ${readyGames.length} job(s)…`);
        queueLbl.textContent = `Queuing ${readyGames.length} job(s)…`;
        btn.textContent = `Queuing… (0/${readyGames.length})`;
        let queuedCount = 0;

        for (const { game } of readyGames) {
          try {
            const result = await window.pork.backporksPork(game.game_id, folderName, folderPath);
            batchIds.add(result.jobId);
            gameById[result.jobId] = game;
            queuedCount++;
            appendLog(`  QUEUE #${result.jobId}  ${game.game_id}`);
            btn.textContent = `Queuing… (${queuedCount}/${readyGames.length})`;
          } catch (err) {
            failed++;
            appendLog(`  QUEUE-ERR  ${game.game_id}: ${err.message}`, '#f87171');
            console.error('[pork-all queue]', game.game_id, err.message);
          }
        }

        if (!batchIds.size) {
          batchDone = true;
          _bpApplyUpdater = null; // nothing queued — stop forwarding
          appendLog('\nNothing was queued — all queue attempts failed', '#f59e0b');
          setStatus('Queue failed — check Transfers tab', 'error');
          panel.style.display = 'none';
          btn.disabled = false;
          btn.textContent = `\u{1F527} Apply All (${folderGames.length})`;
          return;
        }

        appendLog(`\nAll ${batchIds.size} job(s) queued — monitoring transfers…\n`);
        queueLbl.textContent = `Applying backporks to PS5 — 0 / ${batchIds.size} complete`;
        queueFill.style.width = '0%';
        btn.textContent = `Applying… (0/${batchIds.size})`;
        return;
      }

      return;
    }

    // View game
    const viewBtn = e.target.closest('[data-bp-view]');
    if (viewBtn) { openModal(viewBtn.dataset.bpView); return; }

    // Pork from backporks page
    const porkBtn = e.target.closest('[data-bp-pork]');
    if (porkBtn && !porkBtn.disabled) {
      const gameId     = porkBtn.dataset.bpPork;
      const folderName = porkBtn.dataset.bpFw;
      const folderPath = porkBtn.dataset.bpPath;

      // Ensure a destination is remembered before porking
      const ftpDest = await ensureGameFtpPath(gameId);
      if (!ftpDest) return; // user cancelled picker

      porkBtn.disabled = true;
      porkBtn.textContent = 'Queuing…';
      setStatus(`Queuing ${gameId} (${folderName}) for install…`);
      try {
        await window.pork.backporksPork(gameId, folderName, folderPath);
        setStatus(`${gameId} queued — see Transfers tab for progress`, 'ok');
        await loadBackporks();
      } catch (err) {
        setStatus(`Pork failed: ${err.message}`, 'error');
        porkBtn.disabled = false;
        porkBtn.textContent = 'Pork ▶';
      }
    }
  };
}

// Refresh backporks page when auto-scan completes on launch
window.pork.on('backporks:scan:complete', async ({ folders, count, uniqueGames }) => {
  if (count > 0) {
    const folderLabel = `${folders} firmware folder${folders !== 1 ? 's' : ''}`;
    const buildLabel = `${count} build${count !== 1 ? 's' : ''}`;
    const uniqueLabel = Number.isFinite(uniqueGames) && uniqueGames > 0
      ? ` across ${uniqueGames} unique game${uniqueGames !== 1 ? 's' : ''}`
      : '';
    showToast(`Backporks: ${buildLabel} in ${folderLabel}${uniqueLabel}`, 'info');
  }
  if (document.querySelector('.page.active')?.id === 'page-backporks') await loadBackporks();
  await refreshFirmwareFilters();
});

$('btn-create-fw-folder').addEventListener('click', () => {
  $('new-fw-form').hidden = !$('new-fw-form').hidden;
  if (!$('new-fw-form').hidden) $('new-fw-name').focus();
});
$('btn-new-fw-cancel').addEventListener('click', () => {
  $('new-fw-form').hidden = true;
  $('new-fw-name').value = '';
  $('new-fw-parent').value = '';
});
$('btn-new-fw-browse').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (folder) $('new-fw-parent').value = folder;
});
$('btn-new-fw-create').addEventListener('click', async () => {
  const name       = $('new-fw-name').value.trim();
  const parentPath = $('new-fw-parent').value.trim();
  if (!name)       { setStatus('Enter a firmware version (e.g. 11.50.0)', 'error'); return; }
  if (!parentPath) { setStatus('Select a parent folder', 'error'); return; }
  if (!/^\d+\.\d+\.\d+$/.test(name)) { setStatus('Version must follow x.x.x format (e.g. 11.50.0)', 'error'); return; }
  try {
    $('btn-new-fw-create').disabled = true;
    const { path: created } = await window.pork.backporksCreateFolder(name, parentPath);
    showToast(`Created firmware folder ${name}`, 'ok');
    $('new-fw-form').hidden = true;
    $('new-fw-name').value = '';
    $('new-fw-parent').value = '';
    await loadBackporks();
    await refreshFirmwareFilters();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('btn-new-fw-create').disabled = false;
  }
});

$('btn-add-backpork').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;

  $('btn-add-backpork').disabled = true;
  setStatus('Scanning firmware folders…');
  try {
    const { folders, count } = await window.pork.backporksAddRoot(folder);
    setStatus(`Found ${folders} firmware folder(s) — ${count} game(s) detected`, 'ok');
    showToast(`Registered ${folders} firmware folder(s)`, 'ok');
    await loadBackporks();
    await refreshFirmwareFilters();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('btn-add-backpork').disabled = false;
  }
});

// Auto-Backporks card browse actions are wired here as a fallback because this
// page module is known-good: the main "Select Backpork Folder" button on the
// same page already uses the same picker bridge successfully.
function applyBpgenAutoConfigFromPairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return;
  const ready = pairs.filter(p => p.hasLibs).sort((a, b) => a.pair - b.pair);
  if (!ready.length) return;

  const pair = ready[0].pair;
  const sdkSelect = $('bpgen-sdk-pair');
  const fwInput = $('bpgen-fw-label');
  const fakelibInput = $('bpgen-fakelib-dir');

  if (sdkSelect && [...sdkSelect.options].some(o => Number(o.value) === pair)) {
    sdkSelect.value = String(pair);
  }
  if (fwInput) fwInput.value = `${pair}.xx`;
  if (fakelibInput && !fakelibInput.value.trim()) {
    fakelibInput.value = ready[0].dir || '';
  }
  window.pork.setSettings({
    bpgenSdkPair: String(pair),
    bpgenFirmwareLabel: `${pair}.xx`,
    bpgenFakelibDir: fakelibInput?.value.trim() || '',
  }).catch(() => {});
}

if (!_bpgenPageInitStarted) {
  _bpgenPageInitStarted = true;

  $('bpgen-sdk-pair')?.addEventListener('change', async () => {
    const pair = $('bpgen-sdk-pair').value;
    const baseDir = $('bpgen-fl-basedir').value.trim().replace(/[\\\/]+$/, '');
    if (pair === 'all') {
      $('bpgen-fw-label').value = 'All';
      if (baseDir) $('bpgen-fakelib-dir').value = '';
    } else {
      $('bpgen-fw-label').value = pair ? `${pair}.xx` : '';
      if (baseDir && pair) $('bpgen-fakelib-dir').value = `${baseDir}\\${pair}`;
    }
    await window.pork.setSettings({
      bpgenSdkPair: pair,
      bpgenFirmwareLabel: $('bpgen-fw-label').value.trim(),
      bpgenFakelibDir: $('bpgen-fakelib-dir').value.trim(),
    }).catch(() => {});
  });
}

if (!$('bpgen-btn-output')?.dataset.boundInBackporks) {
  $('bpgen-btn-output').dataset.boundInBackporks = '1';
  $('bpgen-btn-output').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const folder = await window.pork.selectFolder();
      if (folder) {
        $('bpgen-output-dir').value = folder;
        await window.pork.setSettings({ bpgenOutputDir: folder });
      }
    } catch (err) {
      setStatus(`Output folder browse failed: ${err.message}`, 'error');
    }
  });
}

if (!$('bpgen-btn-fakelib')?.dataset.boundInBackporks) {
  $('bpgen-btn-fakelib').dataset.boundInBackporks = '1';
  $('bpgen-btn-fakelib').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const folder = await window.pork.selectFolder();
      if (folder) {
        $('bpgen-fakelib-dir').value = folder;
        const save = { bpgenFakelibDir: folder };
        const pairMatch = String(folder).match(/[\\\/](\d+)\s*$/);
        if (pairMatch) {
          const pair = Number(pairMatch[1]);
          if (Number.isFinite(pair)) {
            if ([...$('bpgen-sdk-pair').options].some(o => Number(o.value) === pair)) {
              $('bpgen-sdk-pair').value = String(pair);
            }
            $('bpgen-fw-label').value = `${pair}.xx`;
            save.bpgenSdkPair = String(pair);
            save.bpgenFirmwareLabel = `${pair}.xx`;
          }
        }
        await window.pork.setSettings(save);
      }
    } catch (err) {
      setStatus(`Fakelib folder browse failed: ${err.message}`, 'error');
    }
  });
}

if (!$('bpgen-fl-btn-base')?.dataset.boundInBackporks) {
  $('bpgen-fl-btn-base').dataset.boundInBackporks = '1';
  $('bpgen-fl-btn-base').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const folder = await window.pork.selectFolder();
      if (!folder) return;
      $('bpgen-fl-basedir').value = folder;
      await window.pork.setSettings({ bpgenFakelibBaseDir: folder });
      if (window.pork.bpgenFakelibSetBasedir) {
        const result = await window.pork.bpgenFakelibSetBasedir(folder);
        applyBpgenAutoConfigFromPairs(result?.pairs || []);
      }
    } catch (err) {
      setStatus(`Fakelib base dir browse failed: ${err.message}`, 'error');
    }
  });
}
