// ── Auto-Backpork Generator — Renderer Module ─────────────────────────────────
// Note: $ is declared in state.js and shared across all non-module scripts.

let _sdkPairs      = [];
let _gameList      = [];    // current candidate list shown in picker
let _selectedGames = new Set(); // game_ids explicitly selected
let _running       = false;
let _bpgenProgressState = { startedAt: 0, currentGameIndex: 0, totalGames: 0 };
let _knownFirmwareLabels = [];
let _bpgenSettingsHydrated = false;

// ── Fakelib Manager state ─────────────────────────────────────────────────────
let _flBaseDir     = '';
let _flPairs       = [];         // Array<{ pair, dir, libCount, hasLibs }>
let _flSelectedPair = null;      // which pair the user wants to import for
let _flExtracting  = false;

function getSdkPairValue() {
  const raw = $('bpgen-sdk-pair')?.value;
  if (!raw) return null;
  if (raw === 'all') return 'all';
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function getActiveFakelibDir() {
  const sdkPair = getSdkPairValue();
  if (!sdkPair || sdkPair === 'all') return '';
  const pair = _flPairs.find(p => p.pair === sdkPair);
  return pair?.hasLibs ? pair.dir : '';
}

function getPairStatus(pairNumber) {
  return _flPairs.find(p => p.pair === pairNumber) || null;
}

function getPreferredFirmwareLabel(pairNumber) {
  return `${pairNumber}.xx`;
}

async function saveBpgenSettings(patch = {}) {
  const payload = {
    bpgenOutputDir: $('bpgen-output-dir')?.value.trim() || '',
    bpgenFakelibBaseDir: $('bpgen-fl-basedir')?.value.trim() || '',
    bpgenFakelibDir: $('bpgen-fakelib-dir')?.value.trim() || '',
    bpgenSdkPair: $('bpgen-sdk-pair')?.value || '',
    bpgenFirmwareLabel: $('bpgen-fw-label')?.value.trim() || '',
    ...patch,
  };
  try {
    await window.pork.setSettings(payload);
  } catch (e) {
    console.error('[bpgen] save settings error', e);
  }
}

function restoreBpgenSettings(settings = {}) {
  if (!settings || typeof settings !== 'object') return;

  if (settings.bpgenOutputDir) $('bpgen-output-dir').value = settings.bpgenOutputDir;

  if (settings.bpgenFakelibBaseDir) {
    _flBaseDir = settings.bpgenFakelibBaseDir;
    $('bpgen-fl-basedir').value = settings.bpgenFakelibBaseDir;
  }

  if (settings.bpgenFakelibDir) {
    const input = $('bpgen-fakelib-dir');
    input.value = settings.bpgenFakelibDir;
    input.dataset.autoDir = '';
  }

  if (settings.bpgenSdkPair && [...$('bpgen-sdk-pair').options].some(o => o.value === String(settings.bpgenSdkPair))) {
    $('bpgen-sdk-pair').value = String(settings.bpgenSdkPair);
  }

  if (settings.bpgenFirmwareLabel) {
    const input = $('bpgen-fw-label');
    input.value = settings.bpgenFirmwareLabel;
    input.dataset.autoValue = settings.bpgenFirmwareLabel;
  }
}

function syncFirmwareLabel(force = false) {
  const input = $('bpgen-fw-label');
  const sdkPair = getSdkPairValue();
  if (!input || !sdkPair) return;
  if (sdkPair === 'all') {
    input.dataset.autoValue = 'All';
    if (force || !input.value.trim() || input.value === input.dataset.autoValue) input.value = 'All';
    return;
  }
  const autoLabel = getPreferredFirmwareLabel(sdkPair);
  const current = input.value.trim();
  const shouldReplace = force || !current || current === input.dataset.autoValue;

  input.dataset.autoValue = autoLabel;
  if (shouldReplace) {
    input.value = autoLabel;
    if (_bpgenSettingsHydrated) saveBpgenSettings({ bpgenFirmwareLabel: autoLabel });
  }
}

function autoSelectSdkPairFromFakelibs(force = false) {
  const available = _flPairs.filter(p => p.hasLibs).sort((a, b) => a.pair - b.pair);
  if (!available.length) return;

  const currentPair = getSdkPairValue();
  if (currentPair === 'all') return;
  const currentReady = available.some(p => p.pair === currentPair);
  if (!force && currentReady) return;

  $('bpgen-sdk-pair').value = String(available[0].pair);
  if (_bpgenSettingsHydrated) saveBpgenSettings({ bpgenSdkPair: String(available[0].pair) });
  syncFakelibInput(true);
  syncFirmwareLabel(true);
}

function syncFakelibInput(force = false) {
  const input = $('bpgen-fakelib-dir');
  if (!input) return;
  const current = input.value.trim();
  const autoDir = getActiveFakelibDir();
  const shouldReplace = force || !current || current === input.dataset.autoDir;

  input.dataset.autoDir = autoDir || '';
  if (shouldReplace) {
    input.value = autoDir || '';
    if (_bpgenSettingsHydrated) saveBpgenSettings({ bpgenFakelibDir: autoDir || '' });
  }
}

function resetBpgenActionButtons() {
  [
    'bpgen-btn-output',
    'bpgen-btn-fakelib',
    'bpgen-btn-run',
    'bpgen-btn-cancel',
    'bpgen-select-all',
    'bpgen-select-none',
    'bpgen-fl-btn-base',
    'bpgen-fl-btn-pick-pup',
    'bpgen-fl-btn-extract',
  ].forEach(id => {
    const el = $(id);
    if (!el || !el.parentNode) return;
    const clean = el.cloneNode(true);
    clean.removeAttribute('onclick');
    clean.dataset.boundInBackporks = '';
    el.parentNode.replaceChild(clean, el);
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function initBackporkGen() {
  try {
    const [sdkPairs, knownFirmwareLabels, savedSettings] = await Promise.all([
      window.pork.bpgenSdkPairs(),
      window.pork.firmwareLabels().catch(() => []),
      window.pork.getSettings().catch(() => ({})),
    ]);
    _sdkPairs = sdkPairs;
    _knownFirmwareLabels = knownFirmwareLabels;
    renderSdkPairDropdown();
    restoreBpgenSettings(savedSettings);
    _bpgenSettingsHydrated = true;
    syncFakelibInput(true);
    syncFirmwareLabel(true);
  } catch (e) {
    console.error('[bpgen] init error', e);
  }

  // Selection mode toggle
  $('bpgen-mode').addEventListener('change', () => updateGamePickerVisibility());
  $('bpgen-sdk-pair').addEventListener('change', () => {
    saveBpgenSettings({ bpgenSdkPair: $('bpgen-sdk-pair').value });
    syncFakelibInput();
    syncFirmwareLabel();
  });
  $('bpgen-output-dir').addEventListener('change', () => saveBpgenSettings());
  $('bpgen-fakelib-dir').addEventListener('change', () => saveBpgenSettings());
  $('bpgen-fl-basedir').addEventListener('change', () => saveBpgenSettings());

  // Firmware filter change → refresh game list
  $('bpgen-fw-filter').addEventListener('change', () => refreshGameList());

  // Buttons
  $('bpgen-btn-output').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const p = await window.pork.selectFolder();
      if (p) {
        $('bpgen-output-dir').value = p;
        saveBpgenSettings({ bpgenOutputDir: p });
      }
    } catch (err) {
      bpgenSetStatus(`Output folder browse failed: ${err.message}`, 'error');
    }
  });
  $('bpgen-btn-fakelib').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const p = await window.pork.selectFolder();
      if (p) {
        const input = $('bpgen-fakelib-dir');
        input.value = p;
        input.dataset.autoDir = '';
        saveBpgenSettings({ bpgenFakelibDir: p });
      }
    } catch (err) {
      bpgenSetStatus(`Fakelib folder browse failed: ${err.message}`, 'error');
    }
  });
  $('bpgen-btn-run').addEventListener('click', () => runBackporkGen());
  $('bpgen-btn-cancel').addEventListener('click', () => {
    window.pork.bpgenCancel();
    appendLog('Cancelling…');
  });

  // Select all / none in game picker
  $('bpgen-select-all').addEventListener('click',  () => toggleAllGames(true));
  $('bpgen-select-none').addEventListener('click', () => toggleAllGames(false));

  // Listen for progress events
  window.pork.on('bpgen:progress', handleProgress);

  // ── Fakelib Manager ────────────────────────────────────────────────────────
  initFakelibManager();
  resetBpgenActionButtons();
}

// ── SDK Pair Dropdown ─────────────────────────────────────────────────────────
function renderSdkPairDropdown() {
  const sel = $('bpgen-sdk-pair');
  const current = sel.value;
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All SDK Targets';
  sel.appendChild(allOpt);
  for (const p of _sdkPairs) {
    const opt = document.createElement('option');
    opt.value = p.pair;
    const pairStatus = getPairStatus(p.pair);
    const suffix = pairStatus?.hasLibs ? `  [libs ready: ${pairStatus.libCount}]` : '';
    opt.textContent = `SDK Pair ${p.pair}  —  PS5: ${p.ps5Ver}  /  PS4: ${p.ps4Ver}${suffix}`;
    sel.appendChild(opt);
  }
  if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
}

// ── Game Picker ───────────────────────────────────────────────────────────────
function updateGamePickerVisibility() {
  const mode = $('bpgen-mode').value;
  $('bpgen-game-picker').hidden = (mode !== 'specific');
  $('bpgen-fw-filter-row').hidden = (mode !== 'fw-missing');
  if (mode === 'specific') refreshGameList();
}

async function refreshGameList() {
  const mode = $('bpgen-mode').value;
  const fw   = $('bpgen-fw-filter').value.trim();

  try {
    if (mode === 'specific' || mode === 'fw-missing') {
      $('bpgen-game-list').innerHTML = '<div class="bpgen-loading">Loading…</div>';
      const games = mode === 'specific'
        ? await window.pork.bpgenListAll()
        : await window.pork.bpgenListMissing(fw);
      _gameList = games;
      renderGamePicker(games);
    }
  } catch (e) {
    console.error('[bpgen] list error', e);
  }
}

function renderGamePicker(games) {
  const el = $('bpgen-game-list');
  if (!games.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:6px">No games found</div>';
    return;
  }
  el.innerHTML = games.map(g => {
    const title = escHtml(g.prospero_name || g.title || g.game_id);
    const checked = _selectedGames.has(g.game_id) ? 'checked' : '';
    return `<label class="bpgen-game-row">
      <input type="checkbox" data-game-id="${escHtml(g.game_id)}" ${checked}/>
      <span class="bpgen-game-title">${title}</span>
      <span class="bpgen-game-id">${escHtml(g.game_id)}</span>
    </label>`;
  }).join('');

  el.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = e.target.dataset.gameId;
      if (e.target.checked) _selectedGames.add(id);
      else _selectedGames.delete(id);
    });
  });
}

function toggleAllGames(select) {
  _selectedGames = select ? new Set(_gameList.map(g => g.game_id)) : new Set();
  $('bpgen-game-list').querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.checked = select;
  });
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function runBackporkGen() {
  const mode          = $('bpgen-mode').value;
  const sdkPair       = getSdkPairValue();
  const outputDir     = $('bpgen-output-dir').value.trim();
  const firmwareLabel = $('bpgen-fw-label').value.trim();
  const fakelibDir    = $('bpgen-fakelib-dir').value.trim() || null;
  const overwrite     = $('bpgen-overwrite').checked;

  if (!outputDir)     { bpgenSetStatus('Select an output folder first.', 'error'); return; }
  if (sdkPair !== 'all' && !firmwareLabel) { bpgenSetStatus('Enter a firmware label (e.g. 4.xx).', 'error'); return; }
  if (mode === 'fw-missing' && !$('bpgen-fw-filter').value.trim()) {
    bpgenSetStatus('Enter the firmware label to check for missing backporks.', 'error');
    return;
  }

  let gameIds  = [];
  let filterFw = '';

  if (mode === 'specific') {
    gameIds = [..._selectedGames];
    if (!gameIds.length) { bpgenSetStatus('Select at least one game.', 'error'); return; }
  } else if (mode === 'fw-missing') {
    filterFw = $('bpgen-fw-filter').value.trim();
  }
  // mode === 'all-missing' → gameIds empty, filterFw empty → default all-missing logic

  _running = true;
  $('bpgen-btn-run').disabled    = true;
  $('bpgen-btn-cancel').disabled = false;
  $('bpgen-log').innerHTML       = '';
  $('bpgen-progress-wrap').hidden = false;
  _bpgenProgressState = { startedAt: Date.now(), currentGameIndex: 0, totalGames: 0 };
  setProgress(0, 'Starting…');

  try {
    const result = await window.pork.bpgenRun({
      gameIds, sdkPair, outputDir, firmwareLabel, fakelibDir, filterFw, overwrite,
    });
    bpgenSetStatus(`Done — ${result.ok} file(s) processed, ${result.failed} failed`, result.failed ? 'warn' : 'ok');
  } catch (e) {
    bpgenSetStatus(`Error: ${e.message}`, 'error');
  } finally {
    _running = false;
    $('bpgen-btn-run').disabled    = false;
    $('bpgen-btn-cancel').disabled = true;
  }
}

// ── Progress handling ─────────────────────────────────────────────────────────
function handleProgress({ type, ...data }) {
  switch (type) {
    case 'start': {
      _bpgenProgressState.totalRuns  = data.total  || 0;
      _bpgenProgressState.totalGames = data.games  || 0;
      _bpgenProgressState.totalPairs = data.pairs  || 1;
      _bpgenProgressState.currentGameIndex = 0;
      const pairsLabel = data.pairs > 1 ? ` × ${data.pairs} SDK pairs = ${data.total} total operations` : '';
      setProgress(0, `Processing ${data.games} game(s)${pairsLabel}…`);
      appendLog(`Starting: ${data.games} game(s)${pairsLabel}`);
      if (data.noLocalFolder > 0) {
        appendLog(`  ⚠ ${data.noLocalFolder} game(s) skipped — no local folder recorded in DB`);
      }
      break;
    }
    case 'run-config':
      appendLog(`Target firmware: ${data.firmwareLabel}`);
      appendLog(`SDK pair: ${data.sdkPair}`);
      appendLog(`Output: ${data.outputDir}`);
      appendLog(`Fakelib: ${data.fakelibDir || 'none'}`);
      appendLog(`Overwrite existing output: ${data.overwrite ? 'yes' : 'no'}`);
      break;
    case 'pair-start': {
      const pct = Math.round(((data.pairIndex - 1) / (data.totalPairs || 1)) * 100);
      const pairLabel = `pair ${data.pairIndex}/${data.totalPairs}`;
      const gamesNote = data.gamesInPair === 0 ? ' — all games already done, skipping' : ` — ${data.gamesInPair} game(s) to process`;
      // Update progress bar with pair info so the counter always advances visibly
      _bpgenProgressState.currentGameLabel = `[${pairLabel}] SDK ${data.sdkPair} (FW ${data.firmwareLabel})`;
      setProgress(pct, `${_bpgenProgressState.currentGameLabel} · ${formatElapsed()}`);
      appendLog(`\u27A4 ${pairLabel}: SDK ${data.sdkPair}${gamesNote}`);
      break;
    }
    case 'game-start': {
      _bpgenProgressState.currentGameIndex = data.index || 0;
      // Use per-pair counters when available (all-pairs mode), else fall back to overall index
      const gi  = data.pairGameIndex || data.index;
      const gt  = data.pairTotal     || _bpgenProgressState.totalGames;
      const pct = Math.round(((data.index - 1) / (data.total || 1)) * 100);
      // Always show pair counter so single-pair runs show "pair 1/1" and all-pairs show "pair 3/10"
      const pairLabel = data.totalPairs >= 1 ? ` · pair ${data.pairIndex}/${data.totalPairs}` : '';
      // Store sticky label so file-progress never overwrites it with a file path
      _bpgenProgressState.currentGameLabel = `[${gi}/${gt}${pairLabel}] ${data.title || data.gameId}`;
      setProgress(pct, `${_bpgenProgressState.currentGameLabel} · ${formatElapsed()}`);
      appendLog(`\u25B6 [${gi}/${gt}${pairLabel}] ${data.gameId} — ${data.title || ''} (SDK ${data.sdkPair}, FW ${data.firmwareLabel})`);
      break;
    }
    case 'file-progress':
      handleFileProgress(data);
      break;
    case 'game-done':
      appendLog(`  \u2713 OK (${data.ok} files processed)`);
      break;
    case 'game-skip':
      appendLog(`  \u23ED Skipped: ${data.reason}`);
      break;
    case 'game-error':
      appendLog(`  \u2717 Error: ${data.msg}`, 'error');
      break;
    case 'done':
      setProgress(100, `Complete — ${data.ok} files OK, ${data.failed} failed`);
      appendLog('');
      appendLog(`Complete: total=${data.total} ok=${data.ok} failed=${data.failed} skipped=${data.skipped}`);
      appendLog(`Elapsed: ${formatElapsed()}`);
      // Trigger a backpork rescan so the UI updates
      window.pork.backporksScanAll().catch(() => {});
      break;
    case 'cancelled':
      setProgress(0, 'Cancelled');
      appendLog(`Cancelled after ${data.processed} game(s)`);
      break;
  }
}

function handleFileProgress(data) {
  if (typeof data.fileIndex === 'number' && typeof data.totalFiles === 'number' && _bpgenProgressState.totalRuns > 0) {
    const currentGameZeroBased = Math.max(0, (_bpgenProgressState.currentGameIndex || 1) - 1);
    const perGameFraction = data.totalFiles > 0 ? (data.fileIndex / data.totalFiles) : 0;
    const pct = Math.round(((currentGameZeroBased + perGameFraction) / _bpgenProgressState.totalRuns) * 100);
    // Always show game name + pair info — never the file path
    const label = _bpgenProgressState.currentGameLabel || `[${_bpgenProgressState.currentGameIndex}/${_bpgenProgressState.totalGames}]`;
    setProgress(Math.min(99, Math.max(0, pct)), `${label} · ${formatElapsed()}`);
  }

  switch (data.step) {
    case 'scan':
      appendLog(`  ⟳ ${data.msg}`);
      break;
    case 'inventory':
      appendLog(`  Found ${data.executableFiles} ELF/SELF file(s) to process`);
      break;
    case 'copy':
      appendLog(`  → Copy ${data.file}`);
      break;
    case 'process':
      appendLog(`  • ${data.file}`);
      break;
    case 'decrypt':
    case 'patch':
    case 'sign':
      appendLog(`    ${data.step}: ${data.file} — ${data.msg}`);
      break;
    case 'skip':
      appendLog(`  ↷ ${data.file}: ${data.msg}`);
      break;
    case 'warn':
      appendLog(`  ! ${data.file || 'step'}: ${data.msg}`);
      break;
    case 'error':
      appendLog(`  \u2717 ${data.file}: ${data.msg}`, 'error');
      break;
    case 'libc':
      appendLog(`  libc: ${data.msg}${typeof data.totalFiles === 'number' ? ` (${data.totalFiles} file(s))` : ''}`);
      break;
    case 'libc-progress':
      appendLog(`    libc [${data.fileIndex}/${data.totalFiles}]: ${data.file} — ${data.msg}`);
      break;
    case 'fakelib':
      appendLog(`  fakelib: ${data.msg}`);
      break;
    case 'fakelib-progress':
      appendLog(`    fakelib [${data.fileIndex}/${data.totalFiles}]: ${data.file}`);
      break;
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function bpgenSetStatus(msg, type = '') {
  const el = $('bpgen-status');
  el.textContent = msg;
  el.className   = 'hint bpgen-status ' + (type === 'error' ? 'status-error' : type === 'ok' ? 'status-ok' : type === 'warn' ? 'status-warn' : '');
}

function setProgress(pct, label) {
  $('bpgen-progress-bar').style.width = `${pct}%`;
  $('bpgen-progress-label').textContent = label;
}

function appendLog(line, type = '') {
  const el  = $('bpgen-log');
  const row = document.createElement('div');
  row.className = 'bpgen-log-row' + (type === 'error' ? ' bpgen-log-error' : '');
  row.textContent = line;
  el.appendChild(row);
  while (el.childNodes.length > 800) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Fakelib Manager ───────────────────────────────────────────────────────────

function initFakelibManager() {
  // Base dir picker
  $('bpgen-fl-btn-base').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const dir = await window.pork.selectFolder();
      if (!dir) return;
      const result = await window.pork.bpgenFakelibSetBasedir(dir);
      if (!result) return;
      _flBaseDir = result.baseDir;
      _flPairs   = result.pairs;
      $('bpgen-fl-basedir').value = _flBaseDir;
      saveBpgenSettings({ bpgenFakelibBaseDir: _flBaseDir });
      renderSdkPairDropdown();
      renderFlGrid();
      updateFlSummaryBadge();
      autoSelectSdkPairFromFakelibs(true);
      syncFirmwareLabel(true);
      syncFakelibInput(true);
    } catch (err) {
      flSetStatus(`Base directory browse failed: ${err.message}`, 'error');
    }
  });

  // Pick PUP file
  $('bpgen-fl-btn-pick-pup').addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const p = await window.pork.bpgenFakelibPickPup();
      if (p) $('bpgen-fl-pup-path').value = p;
    } catch (err) {
      flSetStatus(`PUP browse failed: ${err.message}`, 'error');
    }
  });

  // Extract button
  $('bpgen-fl-btn-extract').addEventListener('click', () => runFlExtract());

  // Progress events from main process
  window.pork.on('bpgen:fakelib-progress', handleFlProgress);

  // Load saved state
  window.pork.bpgenFakelibScan().then(({ baseDir, pairs }) => {
    if (!baseDir) return;
    _flBaseDir = baseDir;
    _flPairs   = pairs;
    $('bpgen-fl-basedir').value = _flBaseDir;
    renderSdkPairDropdown();
    renderFlGrid();
    updateFlSummaryBadge();
    autoSelectSdkPairFromFakelibs();
    syncFakelibInput(true);
    syncFirmwareLabel(true);
  }).catch(() => {});
}

function renderFlGrid() {
  const grid = $('bpgen-fl-grid');
  if (!_flBaseDir || !_flPairs.length) {
    _flSelectedPair = null;
    grid.hidden = true;
    $('bpgen-fl-import-row').hidden = true;
    renderSdkPairDropdown();
    return;
  }
  grid.hidden = false;
  grid.innerHTML = _flPairs.map(p => {
    const cls    = p.hasLibs ? 'bpgen-fl-pair-ok' : 'bpgen-fl-pair-missing';
    const icon   = p.hasLibs ? '&#10003;' : '&#43;';
    const label  = p.hasLibs ? `${p.libCount} lib${p.libCount !== 1 ? 's' : ''}` : 'No libs';
    return `<button class="bpgen-fl-pair ${cls}" data-pair="${p.pair}" title="${escHtml(p.dir)}">
      <span class="bpgen-fl-pair-num">${p.pair}</span>
      <span class="bpgen-fl-pair-icon">${icon}</span>
      <span class="bpgen-fl-pair-label">${label}</span>
    </button>`;
  }).join('');

  grid.querySelectorAll('.bpgen-fl-pair').forEach(btn => {
    btn.addEventListener('click', () => {
      _flSelectedPair = Number(btn.dataset.pair);
      grid.querySelectorAll('.bpgen-fl-pair').forEach(b => b.classList.remove('bpgen-fl-pair-active'));
      btn.classList.add('bpgen-fl-pair-active');
      $('bpgen-fl-import-pair-label').textContent = _flSelectedPair;
      $('bpgen-fl-import-row').hidden = false;
      $('bpgen-sdk-pair').value = String(_flSelectedPair);
      syncFakelibInput(true);
      syncFirmwareLabel(true);
    });
  });
}

function updateFlSummaryBadge() {
  const badge = $('bpgen-fl-summary-status');
  if (!_flPairs.length) { badge.textContent = ''; return; }
  const ok = _flPairs.filter(p => p.hasLibs).length;
  badge.textContent = `${ok}/10 pairs ready`;
  badge.className = 'bpgen-fl-badge ' + (ok > 0 ? 'bpgen-fl-badge-ok' : 'bpgen-fl-badge-warn');
}

async function runFlExtract() {
  if (_flExtracting) return;
  const pupPath = $('bpgen-fl-pup-path').value.trim();
  if (!pupPath)          { flSetStatus('Select a .PUP.dec file first.'); return; }
  if (!_flSelectedPair)  { flSetStatus('Select an SDK pair above first.'); return; }
  if (!_flBaseDir)       { flSetStatus('Set a Fakelib Base Directory first.'); return; }

  _flExtracting = true;
  $('bpgen-fl-btn-extract').disabled = true;
  $('bpgen-fl-progress-wrap').hidden  = false;
  flSetProgress(0, 'Starting…');

  try {
    const result = await window.pork.bpgenFakelibExtract({
      pupPath,
      sdkPair: _flSelectedPair,
    });
    flSetStatus(`Done — ${result.libCount} libraries extracted to pair ${_flSelectedPair}`, 'ok');
    // Refresh grid
    const scan = await window.pork.bpgenFakelibScan();
    _flPairs = scan.pairs;
    renderSdkPairDropdown();
    renderFlGrid();
    updateFlSummaryBadge();
    autoSelectSdkPairFromFakelibs(true);
    syncFakelibInput(true);
    syncFirmwareLabel(true);
    // Re-select same pair to keep import row visible
    const btn = $('bpgen-fl-grid')?.querySelector(`[data-pair="${_flSelectedPair}"]`);
    if (btn) { btn.classList.add('bpgen-fl-pair-active'); $('bpgen-fl-import-row').hidden = false; }
  } catch (e) {
    flSetProgress(0, '');
    flSetStatus(`Error: ${e.message}`, 'error');
  } finally {
    _flExtracting = false;
    $('bpgen-fl-btn-extract').disabled = false;
  }
}

function handleFlProgress({ type, ...data }) {
  switch (type) {
    case 'start':
      flSetProgress(0, `Preparing extraction for pair ${data.sdkPair}…`);
      break;
    case 'tool-progress':
      flSetProgress(data.pct, data.msg);
      break;
    case 'tool-manual':
      flSetStatus(`Manual download required — ${data.msg}`, 'error');
      break;
    case 'extract-progress':
      flSetProgress(data.pct, data.msg);
      break;
    case 'done':
      flSetProgress(100, `Complete — ${data.libCount} libraries in pair ${data.sdkPair}`);
      break;
    case 'error':
      flSetProgress(0, '');
      flSetStatus(`Error: ${data.msg}`, 'error');
      break;
  }
}

function flSetProgress(pct, label) {
  $('bpgen-fl-progress-bar').style.width  = `${pct}%`;
  $('bpgen-fl-progress-label').textContent = label;
}

function flSetStatus(msg, type = '') {
  // Reuse bpgen-status element for simplicity, prefixed with [FL]
  const el = $('bpgen-status');
  el.textContent = msg ? `[Fakelib] ${msg}` : '';
  el.className   = 'hint bpgen-status ' +
    (type === 'error' ? 'status-error' : type === 'ok' ? 'status-ok' : type === 'warn' ? 'status-warn' : '');
}

function formatElapsed() {
  if (!_bpgenProgressState.startedAt) return '0s';
  const totalSeconds = Math.max(0, Math.floor((Date.now() - _bpgenProgressState.startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function browseBpgenOutputFolder() {
  try {
    const p = await window.pork.selectFolder();
    if (p) {
      $('bpgen-output-dir').value = p;
      saveBpgenSettings({ bpgenOutputDir: p });
    }
  } catch (err) {
    bpgenSetStatus(`Output folder browse failed: ${err.message}`, 'error');
  }
}

async function browseBpgenFakelibFolder() {
  try {
    const p = await window.pork.selectFolder();
    if (p) {
      const input = $('bpgen-fakelib-dir');
      input.value = p;
      input.dataset.autoDir = '';
      saveBpgenSettings({ bpgenFakelibDir: p });
    }
  } catch (err) {
    bpgenSetStatus(`Fakelib folder browse failed: ${err.message}`, 'error');
  }
}

async function browseBpgenFakelibBaseDir() {
  try {
    const dir = await window.pork.selectFolder();
    if (!dir) return;
    const result = await window.pork.bpgenFakelibSetBasedir(dir);
    if (!result) return;
    _flBaseDir = result.baseDir;
    _flPairs   = result.pairs;
    $('bpgen-fl-basedir').value = _flBaseDir;
    saveBpgenSettings({ bpgenFakelibBaseDir: _flBaseDir });
    renderSdkPairDropdown();
    renderFlGrid();
    updateFlSummaryBadge();
    autoSelectSdkPairFromFakelibs(true);
    syncFakelibInput(true);
    syncFirmwareLabel(true);
  } catch (err) {
    flSetStatus(`Base directory browse failed: ${err.message}`, 'error');
  }
}

async function browseBpgenPupFile() {
  try {
    const p = await window.pork.bpgenFakelibPickPup();
    if (p) $('bpgen-fl-pup-path').value = p;
  } catch (err) {
    flSetStatus(`PUP browse failed: ${err.message}`, 'error');
  }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('#bpgen-btn-output, #bpgen-btn-fakelib, #bpgen-btn-run, #bpgen-btn-cancel, #bpgen-select-all, #bpgen-select-none, #bpgen-fl-btn-base, #bpgen-fl-btn-pick-pup, #bpgen-fl-btn-extract');
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  switch (btn.id) {
    case 'bpgen-btn-output':
      browseBpgenOutputFolder();
      break;
    case 'bpgen-btn-fakelib':
      browseBpgenFakelibFolder();
      break;
    case 'bpgen-btn-run':
      runBackporkGen();
      break;
    case 'bpgen-btn-cancel':
      window.pork.bpgenCancel();
      appendLog('Cancelling…');
      break;
    case 'bpgen-select-all':
      toggleAllGames(true);
      break;
    case 'bpgen-select-none':
      toggleAllGames(false);
      break;
    case 'bpgen-fl-btn-base':
      browseBpgenFakelibBaseDir();
      break;
    case 'bpgen-fl-btn-pick-pup':
      browseBpgenPupFile();
      break;
    case 'bpgen-fl-btn-extract':
      runFlExtract();
      break;
  }
}, true);

window._bpgenButtonClick = action => {
  switch (action) {
    case 'output':
      browseBpgenOutputFolder();
      break;
    case 'fakelib':
      browseBpgenFakelibFolder();
      break;
    case 'baseDir':
      browseBpgenFakelibBaseDir();
      break;
    case 'pup':
      browseBpgenPupFile();
      break;
    case 'extract':
      runFlExtract();
      break;
    case 'run':
      runBackporkGen();
      break;
    case 'cancel':
      window.pork.bpgenCancel();
      appendLog('Cancelling…');
      break;
  }
  return false;
};

// Export for use by main renderer
window._bpgenInit = initBackporkGen;
