// ── Modal tab switching ────────────────────────────────────────────────────────
document.querySelectorAll('.modal-tab').forEach(tab =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.modal-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`mpanel-${tab.dataset.mtab}`).classList.add('active');
  })
);

function resetModalTabs() {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.modal-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.modal-tab[data-mtab="info"]').classList.add('active');
  $('mpanel-info').classList.add('active');
}

// ── Prospero render helpers ───────────────────────────────────────────────────
function renderProsperoData(g) {
  const hasProspero = !!g.prospero_fetched_at;

  // ── Banner (cover art background) ───────────────────────────────────────────
  const banner = $('modal-banner');
  if (hasProspero && g.prospero_banner_url) {
    const img = new Image();
    img.onload  = () => { banner.style.backgroundImage = `url('${g.prospero_banner_url}')`; };
    img.onerror = () => { banner.style.backgroundImage = ''; };
    img.src = g.prospero_banner_url;
  } else {
    banner.style.backgroundImage = '';
  }

  // ── Icon ────────────────────────────────────────────────────────────────────
  const icon = $('modal-icon');
  icon.onerror = () => { icon.hidden = true; };
  if (hasProspero && g.prospero_icon_url) {
    icon.src    = g.prospero_icon_url;
    icon.hidden = false;
  } else {
    icon.hidden = true;
    icon.src    = '';
  }

  // ── Tab badges ──────────────────────────────────────────────────────────────
  const patchCount   = hasProspero ? (g.prospero_patch_count || 0) : 0;
  const dlcArr       = hasProspero ? tryParseJson(g.prospero_dlc, []) : [];
  const regionArr    = hasProspero ? tryParseJson(g.prospero_other_regions, []) : [];
  $('mtab-patch-count').textContent   = patchCount  || '';
  $('mtab-dlc-count').textContent     = dlcArr.length   || '';
  $('mtab-regions-count').textContent = regionArr.length || '';

  if (!hasProspero) {
    $('modal-patches-content').innerHTML = '<div class="prospero-placeholder">Fetching patch data…</div>';
    $('modal-dlc-content').innerHTML     = '<div class="prospero-placeholder">Fetching DLC data…</div>';
    $('modal-regions-content').innerHTML = '<div class="prospero-placeholder">Fetching region data…</div>';
    return;
  }

  // Description is always the generic ProsperoPatches template — never useful, keep hidden.
  $('modal-description').hidden = true;

  // ── Patches ─────────────────────────────────────────────────────────────────
  const patches = tryParseJson(g.prospero_patches, []);
  if (patches.length) {
    $('modal-patches-content').innerHTML = `
      <ul class="patch-list">
        ${patches.map(p => `
          <li class="patch-item${p.isLatest ? ' patch-item-latest' : ''}">
            <div class="patch-header">
              <span class="patch-ver">v${escHtml(p.contentVer || '?')}</span>
              ${p.isLatest ? '<span class="patch-latest">LATEST</span>' : ''}
              <span class="patch-meta">
                <span title="File size">${escHtml(p.filesize || '—')}</span>
                <span title="Required firmware">FW ${escHtml(p.requiredFirmware || '?')}</span>
                <span title="Import date">${escHtml(p.importDate || '')}</span>
              </span>
            </div>
            ${p.changelogPreview ? `<div class="patch-changelog">${escHtml(p.changelogPreview)}</div>` : ''}
          </li>`).join('')}
      </ul>`;
  } else {
    $('modal-patches-content').innerHTML = '<div class="prospero-placeholder">No patch updates found</div>';
  }

  // ── DLC ──────────────────────────────────────────────────────────────────────
  const dlc = dlcArr;
  if (dlc.length) {
    $('modal-dlc-content').innerHTML = `
      <ul class="dlc-list">
        ${dlc.map(d => `
          <li class="dlc-item">
            ${d.iconUrl ? `<img class="dlc-icon" src="${escHtml(d.iconUrl)}" alt="" onerror="this.style.display='none'"/>` : '<div class="dlc-icon"></div>'}
            <div>
              <div class="dlc-name">${escHtml(d.name || d.contentid || '—')}</div>
              <div class="dlc-meta">
                ${d.contentVer ? `v${escHtml(d.contentVer)}` : ''}
                ${d.filesize   ? ` · ${escHtml(d.filesize)}` : ''}
                ${d.requiredFirmware ? ` · FW ${escHtml(d.requiredFirmware)}` : ''}
              </div>
            </div>
          </li>`).join('')}
      </ul>`;
  } else {
    $('modal-dlc-content').innerHTML = '<div class="prospero-placeholder">No additional content</div>';
  }

  // ── Regions (mark ones we own) ───────────────────────────────────────────────
  const regions = regionArr;
  if (regions.length) {
    $('modal-regions-content').innerHTML = `
      <div class="region-pills">
        ${regions.map(r => {
          const isOwned = r.titleid === g.game_id;
          return `
            <button class="region-pill${isOwned ? ' owned' : ''}" data-tid="${escHtml(r.titleid)}">
              <code>${escHtml(r.titleid)}</code>
              <span>${escHtml(r.region || '')}</span>
            </button>`;
        }).join('')}
      </div>`;
    $('modal-regions-content').querySelector('.region-pills')?.addEventListener('click', e => {
      const pill = e.target.closest('[data-tid]');
      if (pill) openModal(pill.dataset.tid);
    });
  } else {
    $('modal-regions-content').innerHTML = '<div class="prospero-placeholder">No other regions found</div>';
  }
}

function tryParseJson(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch (_) { return fallback; }
}

// ── Conversion Queue Panel ────────────────────────────────────────────────────

// ── Conv job live-patch cache ───────────────────────────────────────────────────────
const convJobsCache = new Map();

// Update a single conv-job-row in-place without an IPC roundtrip or full re-render.
// Called directly from the conv:job-update event (which already carries the full job).
function patchConvJobCard(job) {
  convJobsCache.set(job.id, job);
  const card = document.querySelector(`.conv-job-row[data-conv-id="${job.id}"]`);
  // New card or status change → do a full panel refresh (handles transitions + new jobs)
  if (!card || card.dataset.convStatus !== job.status) {
    refreshConvQueuePanel().catch(() => {});
    return;
  }
  // Incremental patch: progress bar, phase text, log box
  const pct = job.progress?.percent ?? 0;
  const bar = card.querySelector('.conv-job-bar');
  if (bar) bar.style.width = `${pct}%`;

  const phaseEl = card.querySelector('.conv-job-phase');
  if (phaseEl) phaseEl.textContent = job.progress?.phase || job.status;

  const log     = (job.progress?.log ?? []).join('\n');
  const showLog = (job.status === 'running' || job.status === 'error') && log;
  let lb = card.querySelector('.conv-log-box');
  if (showLog) {
    if (!lb) {
      lb = document.createElement('pre');
      lb.className      = 'conv-log-box';
      lb.dataset.logLen = '0';
      card.appendChild(lb);
    }
    if (lb.dataset.logLen !== String(job.progress?.log?.length)) {
      lb.textContent    = log;
      lb.scrollTop      = lb.scrollHeight;
      lb.dataset.logLen = String(job.progress?.log?.length ?? 0);
    }
  }
}

async function refreshConvQueuePanel() {
  try {
    const jobs   = await window.pork.convQueueList();
    const paused = await window.pork.convQueueIsPaused();
    const s      = await window.pork.getSettings();
    const panel  = $('conv-queue-panel');
    if (!panel) return;
    panel.hidden = false;

    const mode = s.gameConversionMode || 'pfs';

    // ── Mode switcher button states ──────────────────────────────────────────
    document.querySelectorAll('.conv-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.convMode === mode);
    });

    // ── Not-configured warning ───────────────────────────────────────────────
    const warnEl  = $('conv-mode-warn');
    const warnTxt = $('conv-mode-warn-text');
    let warnMsg = '';
    if (mode === 'ffpkg') {
      const info = await window.pork.convToolInfo().catch(() => null);
      warnMsg = info && !info.supported
        ? info.reason
        : (!s.ufs2ToolPath ? 'FFPKG mode requires UFS2Tool.exe — set the path in Game Conversion settings.' : '');
    }
    if (warnEl) {
      warnEl.hidden = !warnMsg;
      if (warnTxt) warnTxt.textContent = warnMsg;
    }
    // ExFAT is built natively (no make_image.bat); only warn if OSFMount is missing.
    if (mode === 'exfat') {
            window.pork.convExfatToolInfo().then(info => {
              if (!warnEl) return;
              if (info && !info.supported) {
                warnEl.hidden = false;
                if (warnTxt) warnTxt.textContent = info.reason;
                return;
              }
              if (info && info.toolAvailable) { warnEl.hidden = true; return; }
              warnEl.hidden = false;
              if (warnTxt) warnTxt.textContent = 'ExFAT mode needs OSFMount — install it or set osfmount.com in Game Conversion settings.';
            }).catch(() => {});
          }

    // ── Not-admin warning (inline, always visible when applicable) ───────────
    const adminWarnEl = $('conv-admin-warn');
    if (adminWarnEl) {
      if (mode === 'ffpkg' || mode === 'exfat') {
        let isElevated = false;
        try { isElevated = await window.pork.isAdmin(); } catch (_) {}
        adminWarnEl.hidden = isElevated;
      } else {
        adminWarnEl.hidden = true;
      }
    }

    const listEl  = $('conv-queue-list');
    const emptyEl = $('conv-queue-empty');
    if (listEl) {
      listEl.innerHTML = jobs.map(j => renderConvJobRowHtml(j)).join('');
      // Seed live-patch cache and scroll all log boxes to bottom so errors are visible
      jobs.forEach(j => convJobsCache.set(j.id, j));
      listEl.querySelectorAll('.conv-log-box').forEach(lb => { lb.scrollTop = lb.scrollHeight; });
    }
    if (emptyEl) emptyEl.hidden   = jobs.length > 0;

    const startBtn = $('btn-conv-start');
    if (startBtn) {
      const hasQueued = jobs.some(j => j.status === 'queued');
      startBtn.disabled    = !paused || !hasQueued;
      startBtn.textContent = paused ? '▶ Start Queue' : '⏸ Running…';
    }
  } catch (_) {}
}

// Mode switcher buttons in the queue panel
$('conv-queue-panel').addEventListener('click', async e => {
  const modeBtn = e.target.closest('.conv-mode-btn');
  if (modeBtn) {
    const mode = modeBtn.dataset.convMode;
    await window.pork.setSettings({ gameConversionMode: mode });
    // Sync the Settings page radio if it exists
    const radio = document.querySelector(`#conv-mode-${mode}`);
    if (radio) radio.checked = true;
    applyConvModeUI(mode);
    await refreshConvQueuePanel();
    return;
  }
  if (e.target.closest('#btn-conv-goto-settings')) {
    navigate('settings');
    // Scroll the conversion card into view after a brief paint delay
    setTimeout(() => {
      const card = $('settings-conversion-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }
});

function renderConvJobRowHtml(job) {
  const pct      = job.progress?.percent ?? 0;
  const phase    = escHtml(job.progress?.phase || job.status);
  const log      = (job.progress?.log ?? []).join('\n');
  const showLog  = (job.status === 'running' || job.status === 'error') && log;
  const barClass = job.status === 'done'    ? 'conv-bar-done'
                 : job.status === 'error'   ? 'conv-bar-error'
                 : job.status === 'running' ? 'conv-bar-running'
                 : '';
  const cancelBtn = (job.status === 'queued' || job.status === 'running')
    ? `<button class="btn btn-sm btn-danger" data-conv-cancel="${job.id}" style="padding:2px 6px;font-size:10px">✕</button>`
    : '';
  const retryBtn = (job.status === 'error' || job.status === 'cancelled')
    ? `<button class="btn btn-sm" data-conv-retry="${job.id}" style="padding:2px 6px;font-size:10px">↺</button>`
    : '';
  return `<div class="conv-job-row" data-conv-id="${job.id}" data-conv-status="${escHtml(job.status)}">
    <div class="conv-job-summary">
      <span class="conv-job-id">#${job.id}</span>
      <span class="conv-job-game" title="${escHtml(job.game_id)}">${escHtml(job.game_name || job.game_id)}</span>
      <span class="conv-job-mode">${escHtml((job.mode || '').toUpperCase())}</span>
      <span class="conv-job-phase">${phase}</span>
      <div class="conv-job-bar-wrap"><div class="conv-job-bar ${barClass}" style="width:${pct}%"></div></div>
      <span class="conv-job-status conv-status-${job.status}">${escHtml(job.status)}</span>
      <div class="conv-job-actions">${cancelBtn}${retryBtn}</div>
    </div>
    ${showLog ? `<pre class="conv-log-box" data-log-len="${(job.progress?.log?.length ?? 0)}">${escHtml(log)}</pre>` : ''}
    ${job.error ? `<div class="conv-job-error">✗ ${escHtml(job.error)}</div>` : ''}
  </div>`;
}

// ── Admin-warning modal helpers ─────────────────────────────────────────────
function showAdminWarning() {
  $('admin-warn-overlay').hidden = false;
}
$('admin-warn-close').addEventListener('click', () => {
  $('admin-warn-overlay').hidden = true;
});
$('admin-warn-overlay').addEventListener('click', (e) => {
  if (e.target === $('admin-warn-overlay')) $('admin-warn-overlay').hidden = true;
});

// Returns true if safe to proceed, false if user should be blocked (not-admin + needs elevation)
async function guardAdminForConv() {
  const s    = await window.pork.getSettings();
  const mode = s.gameConversionMode || 'pfs';
  // Raw Dumps (FTP upload) and FFPFSC (native in-process build) need no elevation.
  if (mode === 'pfs' || mode === 'ffpfsc') return true;
  let ok = false;
  try {
    ok = await window.pork.isAdmin();
  } catch (_) {
    // isAdmin call failed — treat as not-admin (fail-secure)
    ok = false;
  }
  if (!ok) { showAdminWarning(); return false; }
  return true;
}

$('btn-conv-start').addEventListener('click', async () => {
  if (!await guardAdminForConv()) return;
  await window.pork.convQueueStart();
  await refreshConvQueuePanel();
});

$('btn-conv-clear-done').addEventListener('click', async () => {
  await window.pork.convQueueClearDone();
  await refreshConvQueuePanel();
});

$('btn-conv-cleanup-temp').addEventListener('click', async () => {
  const btn = $('btn-conv-cleanup-temp');
  btn.disabled = true;
  btn.textContent = '\u{1F9F9} Cleaning\u2026';
  try {
    const res = await window.pork.convQueueCleanupTemp();
    const parts = [];
    if (res.deletedDirs)  parts.push(`${res.deletedDirs} temp folder${res.deletedDirs  > 1 ? 's' : ''}`);
    if (res.deletedFiles) parts.push(`${res.deletedFiles} partial file${res.deletedFiles > 1 ? 's' : ''}`);
    btn.textContent = parts.length ? `\u2713 Removed ${parts.join(' + ')}` : '\u2713 Nothing to clean';
    if (res.errors?.length) console.warn('[CleanTemp]', res.errors);
  } catch (e) {
    btn.textContent = '\u2717 Cleanup failed';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '\u{1F9F9} Clean Temp'; }, 3000);
});

$('btn-conv-queue-toggle').addEventListener('click', () => {
  const body = $('conv-queue-body');
  const collapsed = body.hidden;
  body.hidden = !collapsed;
  $('btn-conv-queue-toggle').textContent = collapsed ? '↑' : '↓';
});

$('conv-queue-list').addEventListener('click', async e => {
  const cancelBtn = e.target.closest('[data-conv-cancel]');
  if (cancelBtn) {
    await window.pork.convQueueCancel(Number(cancelBtn.dataset.convCancel));
    await refreshConvQueuePanel();
    return;
  }
  const retryBtn = e.target.closest('[data-conv-retry]');
  if (retryBtn) {
    await window.pork.convQueueRetry(Number(retryBtn.dataset.convRetry));
    await refreshConvQueuePanel();
  }
});

// ── Install-to-PS5 modal ───────────────────────────────────────────────────────

let _installBackporkEntries = [];

async function openInstallModal(game_id, startMode) {
  const games = await window.pork.listGames({});
  const g = games.find(x => x.game_id === game_id);
  if (!g) return;

  $('install-modal-game-label').textContent = g.prospero_name || g.title || game_id;
  $('install-overlay').dataset.gameId   = game_id;
  $('install-overlay').dataset.gameName = g.prospero_name || g.title || game_id;

  // Pick the local game backup (source='local'), not a backpork patch
  const backups     = await window.pork.listBackups(game_id);
  const localBackup = backups.find(b => b.source === 'local' && b.backup_type === 'folder')
                   ?? backups.find(b => b.source === 'local')
                   ?? backups[0];
  const latest = localBackup;
  $('install-overlay').dataset.backupPath = latest?.backup_path || '';

  // ── PFS section ─────────────────────────────────────────────────────────────
  const hintEl = $('install-backup-hint');
  if (hintEl) {
    if (latest) {
      hintEl.textContent = `Source: ${latest.backup_path}`;
      hintEl.title       = latest.backup_path;
    } else {
      hintEl.textContent = 'No local backup found — use Browse folder to select one';
      hintEl.title       = '';
    }
  }

  // Resolve FTP path
  let ftpPath = g.ftp_path || '';
  const noPathsConfigured = remoteGamePaths.length === 0;
  if (!ftpPath && !noPathsConfigured) {
    const base = remoteGamePaths[0].path.replace(/\/?$/, '/');
    ftpPath = base + game_id + '-app';
  }
  const ftpPathEl = $('install-ftp-path');
  if (ftpPathEl) ftpPathEl.value = ftpPath;
  const warn = $('install-no-path-warn');
  if (warn) warn.hidden = !!ftpPath;

  // Backpork selector — PFS section
  const entries = await window.pork.backporksEntries(game_id);
  _installBackporkEntries = entries;
  const bpSel = $('install-backpork-select');
  if (bpSel) {
    bpSel.innerHTML = '<option value="">None</option>' +
      entries.map((e, i) => `<option value="${i}">${escHtml(e.folder_name)}</option>`).join('');
  }

  // ── Conv section (FFPKG / ExFAT) ────────────────────────────────────────────
  const convHintEl = $('install-conv-backup-hint');
  if (convHintEl) {
    if (latest) {
      convHintEl.textContent = `Source: ${latest.backup_path}`;
      convHintEl.title       = latest.backup_path;
    } else {
      convHintEl.textContent = 'No local backup found — use Browse folder to select one';
      convHintEl.title       = '';
    }
  }

  // Backpork selector — Conv section
  // Only show firmware entries where game_path is known (i.e. the game has a patch in that folder).
  // The option value is the ORIGINAL index into _installBackporkEntries so the lookup in the
  // confirm handler still works regardless of how many entries are filtered out.
  const convBpSel = $('install-conv-backpork-select');
  if (convBpSel) {
    convBpSel.innerHTML = '<option value="">None</option>' +
      entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !!e.game_path)          // skip firmware folders with no patch for this game
        .map(({ e, i }) => `<option value="${i}">${escHtml(e.folder_name)}</option>`)
        .join('');
  }

  // Pre-fill conv FTP path: use the parent directory of the game FTP path so
  // the converted file (e.g. PPSA03644.exfat) lands next to the game folders.
  // main.js will append the output filename automatically.
  const convFtpPathEl = $('install-conv-ftp-path');
  if (convFtpPathEl) {
    let convDir = '';
    if (g.ftp_path) {
      // Parent of the existing game folder path, with trailing slash
      convDir = g.ftp_path.replace(/\/[^\/]+\/?$/, '') || '/';
      if (!convDir.endsWith('/')) convDir += '/';
    } else if (!noPathsConfigured) {
      convDir = remoteGamePaths[0].path.replace(/\/?$/, '/');
    }
    convFtpPathEl.value = convDir;
  }

  // Pre-fill conv FTP upload / delete-after from settings
  const s = await window.pork.getSettings();
  const convFtpUploadEl = $('install-conv-ftp-upload');
  if (convFtpUploadEl) {
    convFtpUploadEl.checked = !!s.convFtpUpload;
    const convFtpFields = $('install-conv-ftp-fields');
    if (convFtpFields) convFtpFields.style.display = convFtpUploadEl.checked ? 'block' : 'none';
  }
  const convDelEl = $('install-conv-delete-after');
  if (convDelEl) convDelEl.checked = !!s.convDeleteAfter;

  // Tool warning for conv section
  const convToolWarn = $('install-conv-tool-warn');
  if (convToolWarn) {
    const currentMode = s.gameConversionMode || 'pfs';
    if (currentMode === 'ffpkg') {
      const info = s.ufs2ToolPath ? await window.pork.convToolInfo().catch(() => null) : null;
      convToolWarn.hidden = !!info?.toolAvailable;
    } else if (currentMode === 'exfat') {
      const info = await window.pork.convExfatToolInfo().catch(() => null);
      convToolWarn.hidden = !!info?.toolAvailable;
    } else {
      convToolWarn.hidden = true;
    }
  }

  // ── Activate the correct mode tab ────────────────────────────────────────────
  const currentMode = s.gameConversionMode || 'pfs';
  _applyInstallModeTab(currentMode);

  updateInstallConfirmState(currentMode, latest, ftpPath);
  $('install-overlay').hidden = false;
}

function _applyInstallModeTab(mode) {
  document.querySelectorAll('.install-mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.installMode === mode)
  );
  const pfsSec  = $('install-pfs-section');
  const convSec = $('install-conv-section');
  if (pfsSec)  pfsSec.hidden  = mode !== 'pfs';
  if (convSec) convSec.hidden = mode === 'pfs';
}

function updateInstallConfirmState(mode, latest, ftpPath) {
  const confirmBtn = $('btn-install-confirm');
  if (!confirmBtn) return;
  if (mode === 'pfs') {
    const backupPath = $('install-overlay').dataset.backupPath;
    const fp         = ftpPath !== undefined ? ftpPath : ($('install-ftp-path')?.value?.trim() || '');
    confirmBtn.disabled = !backupPath || !state.connected || !fp;
  } else {
    // For FFPKG/ExFAT: just need a backup path (FTP upload is optional)
    const backupPath = $('install-overlay').dataset.backupPath;
    confirmBtn.disabled = !backupPath;
  }
}

// Mode tab click delegation on install overlay
$('install-overlay').addEventListener('click', e => {
  const tab = e.target.closest('.install-mode-tab');
  if (!tab) return;
  const mode = tab.dataset.installMode;
  _applyInstallModeTab(mode);
  updateInstallConfirmState(mode);
});

$('btn-install-browse-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('install-overlay').dataset.backupPath = folder;
  $('install-backup-hint').textContent = `Source: ${folder}`;
  $('install-backup-hint').title = folder;
  // Also sync conv backup hint
  const convHint = $('install-conv-backup-hint');
  if (convHint) { convHint.textContent = `Source: ${folder}`; convHint.title = folder; }
  const ftpPath = $('install-ftp-path').value.trim();
  $('btn-install-confirm').disabled = !ftpPath || !state.connected;
  // Persist the manually-chosen path so it survives modal close/reopen
  const gameId = $('install-overlay').dataset.gameId;
  if (gameId) window.pork.addBackup(gameId, folder).catch(() => {});
});

$('btn-install-browse-ftp').addEventListener('click', async () => {
  const current = $('install-ftp-path').value.replace('(searching PS5…)', '') || '/';
  const selected = await openFtpBrowser(current);
  if (selected) $('install-ftp-path').value = selected;
});

$('btn-install-confirm').addEventListener('click', async () => {
  const game_id    = $('install-overlay').dataset.gameId;
  const backupPath = $('install-overlay').dataset.backupPath;

  // Determine active mode from tab selection
  const activeTab = document.querySelector('.install-mode-tab.active');
  const mode = activeTab?.dataset.installMode || 'pfs';

  if (!backupPath) { setStatus('No local backup found for this game', 'error'); return; }

  $('btn-install-confirm').disabled = true;
  $('btn-install-confirm').textContent = 'Queueing…';

  try {
    if (mode === 'pfs') {
      // ── PFS mode: existing behavior ─────────────────────────────────────────
      const ftpPath = $('install-ftp-path').value.trim();
      if (!ftpPath)        { setStatus('No PS5 path — configure Remote Game Paths in Settings first', 'error'); return; }
      if (!state.connected){ setStatus('Connect to PS5 first', 'error'); return; }

      const bpIdx = $('install-backpork-select').value;
      let pork = null;
      if (bpIdx !== '') {
        const bp = _installBackporkEntries[Number(bpIdx)];
        if (bp) pork = { folder_name: bp.folder_name, folder_path: bp.folder_path };
      }

      await window.pork.ftpInstallPfs({ game_id, localPath: backupPath, remotePath: ftpPath, pork });
      await window.pork.updateGame({ game_id, fields: { ftp_path: ftpPath, installed: 1 } });

      setStatus('Install queued — see Transfers tab for progress', 'ok');

    } else {
      // ── FFPKG / ExFAT mode ──────────────────────────────────────────────────
      const ftpUploadCb = $('install-conv-ftp-upload');
      const ftpUpload   = ftpUploadCb?.checked ?? false;
      const ftpPath     = ftpUpload ? ($('install-conv-ftp-path')?.value?.trim() || '') : '';
      const deleteAfter = ftpUpload && ($('install-conv-delete-after')?.checked ?? false);

      const bpIdx = $('install-conv-backpork-select')?.value ?? '';
      let backpork_path = '';
      let firmware_label = '';
      if (bpIdx !== '') {
        const bp = _installBackporkEntries[Number(bpIdx)];
        // Use bp.game_path (the game-specific patch subfolder, e.g. G:\Backporks\11.50.0\PPSA21837-app0)
        // NOT bp.folder_path (the firmware folder G:\Backporks\11.50.0 which contains ALL games' patches).
        // Using folder_path would copy every game's patch into workerDir and produce a corrupt image.
        if (bp && bp.game_path) { backpork_path = bp.game_path; firmware_label = bp.folder_name; }
      }

      const game_name = $('install-overlay').dataset.gameName || game_id;
      await window.pork.convQueueAdd({
        game_id,
        game_name,
        game_path:      backupPath,
        backpork_path,
        firmware_label,
        mode,
        ftpUpload,
        ftpRemotePath:  ftpPath,
        deleteAfter,
      });

      await refreshConvQueuePanel();
      setStatus(`${mode.toUpperCase()} conversion queued — see Conversion Queue on Games page`, 'ok');
    }
  } catch (e) {
    setStatus('Queue failed: ' + e.message, 'error');
  } finally {
    $('install-overlay').hidden = true;
    $('btn-install-confirm').disabled = false;
    $('btn-install-confirm').textContent = '⬆ Queue Install';
  }
});

['install-close', 'btn-install-cancel'].forEach(id =>
  $(id).addEventListener('click', () => { $('install-overlay').hidden = true; })
);

$('install-conv-ftp-upload').addEventListener('change', function () {
  const fields = $('install-conv-ftp-fields');
  if (fields) fields.style.display = this.checked ? 'block' : 'none';
});

$('btn-install-conv-browse-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('install-overlay').dataset.backupPath = folder;
  // Sync both backup hints
  const hint     = $('install-backup-hint');
  const convHint = $('install-conv-backup-hint');
  if (hint)     { hint.textContent     = `Source: ${folder}`; hint.title     = folder; }
  if (convHint) { convHint.textContent = `Source: ${folder}`; convHint.title = folder; }
  updateInstallConfirmState(document.querySelector('.install-mode-tab.active')?.dataset.installMode || 'pfs');
  // Persist the manually-chosen path so it survives modal close/reopen
  const gameId = $('install-overlay').dataset.gameId;
  if (gameId) window.pork.addBackup(gameId, folder).catch(() => {});
});

$('btn-install-conv-browse-ftp').addEventListener('click', async () => {
  const current = $('install-conv-ftp-path')?.value?.replace('(searching PS5…)', '') || '/';
  const selected = await openFtpBrowser(current);
  if (selected && $('install-conv-ftp-path')) $('install-conv-ftp-path').value = selected;
});

// ── Modal ─────────────────────────────────────────────────────────────────────
async function openModal(game_id) {
  try {
    const games = await window.pork.listGames({});
    const g = games.find(x => x.game_id === game_id);
    if (!g) return;
    state.currentGame = g;

    resetModalTabs();

    // Header
    const displayName = g.prospero_name || g.title || g.game_id;
    $('modal-title').textContent    = displayName;
    $('modal-subtitle').textContent = `${g.game_id}  ·  ${g.prospero_region || g.version ? (g.prospero_region || '') + (g.version ? '  v' + g.version : '') : 'version unknown'}`;

    // Info table — local + prospero metadata
    const patches      = tryParseJson(g.prospero_patches, []);
    const fwVersions   = [...new Set(patches.map(p => p.requiredFirmware).filter(Boolean))];
    const fwDisplay    = fwVersions.length ? fwVersions.join(', ') : '—';
    const dlc          = tryParseJson(g.prospero_dlc, []);
    const infoRows = [
      ['Game ID',              g.game_id],
      ['Content ID',           g.content_id || g.prospero_content_id || '—'],
      ['Version',              g.version || g.prospero_version || '—'],
      ['Size',                 g.backup_size ? fmt(g.backup_size) : (g.size ? fmt(g.size) : (g.prospero_size || '—'))],
      ['Installed',            g.installed  ? 'Yes' : 'No'],
      ['Backed Up',            g.backed_up  ? 'Yes' : 'No'],
      ['Porked To',            g.porked_firmware ? `${g.porked_firmware}${g.porked_at ? '  (' + new Date(g.porked_at).toLocaleDateString() + ')' : ''}` : '—'],
      ['Publisher',            g.prospero_publisher    || '—'],
      ['Publisher ID',         g.prospero_publisher_id || '—'],
      ['Region',               g.prospero_region       || '—'],
      ['Last Updated',         g.prospero_last_updated || '—'],
      ['Required Firmware',    fwDisplay],
      ['DLC Available',        dlc.length ? `${dlc.length} item(s)` : 'None'],
      ['FTP Path',             g.ftp_path   || '—'],
      ['Last Scanned',         g.last_scanned ? new Date(g.last_scanned).toLocaleString() : '—'],
      ['Metadata Age',         g.prospero_fetched_at ? fmtAge(Date.now() - g.prospero_fetched_at) : 'Never fetched'],
    ];
    $('modal-info').innerHTML = infoRows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('');

    // Backup list
    const backups      = await window.pork.listBackups(game_id);
    const localBackups = backups.filter(b => b.source !== 'backpork');
    $('modal-backup-list').innerHTML = localBackups.length
      ? localBackups.map(b => `<li><span>${escHtml(b.backup_path)}</span><span>${fmt(b.size)}</span></li>`).join('')
      : '<li style="justify-content:center">No backups recorded</li>';

    // Hash verification section (Info tab)
    await renderHashSection(game_id, backups);

    // Manage tab
    await renderManagePanel(g, backups);

    // Prospero tabs
    renderProsperoData(g);

    // Cheats tab
    renderCheatsPanel(g);

    $('btn-modal-backup').disabled  = true; // enabled async below if folder found on FTP
    $('btn-modal-install').disabled = !state.connected || !backups.length;
    $('modal-overlay').hidden = false;

    // Async: check FTP for the game folder and enable Backup button only if found
    if (state.connected) {
      window.pork.ftpFindGame(game_id).then(ftpPath => {
        if (ftpPath) {
          $('btn-modal-backup').disabled = false;
          // Update stored ftp_path if the scan found a different or new path
          if (ftpPath !== g.ftp_path) {
            window.pork.updateGame({ game_id, fields: { ftp_path: ftpPath, installed: 1 } });
            state.currentGame.ftp_path = ftpPath;
          }
        }
      }).catch(() => {});
    }
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function fmtAge(ms) {
  if (ms < 60000)       return 'Just now';
  if (ms < 3600000)     return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000)    return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

$('btn-modal-mark').addEventListener('click', async () => {
  if (!state.currentGame) return;
  await window.pork.updateGame({ game_id: state.currentGame.game_id, fields: { backed_up: 1 } });
  setStatus('Marked as backed up', 'ok');
  closeModal();
  if (document.querySelector('.page.active')?.id === 'page-games') loadGames();
});

$('btn-modal-backup').addEventListener('click', async () => {
  if (!state.currentGame || !state.connected) return;
  const { ftp_path, game_id } = state.currentGame;
  if (!ftp_path) { setStatus('No FTP path recorded for this game — run a scan first', 'error'); return; }
  try {
    await window.pork.ftpDownloadFolder(game_id);
    setStatus('Backup queued — see Transfers for progress', 'ok');
    closeModal();
  } catch (e) {
    setStatus(e.message, 'error');
  }
});

// "Install to PS5" — upload the most recent local backup to the game's FTP path
$('btn-modal-install').addEventListener('click', async () => {
  if (!state.currentGame || !state.connected) return;
  const g = state.currentGame;
  const ftpPath = await ensureGameFtpPath(g.game_id);
  if (!ftpPath) return; // user cancelled path selection

  // Pick the most recent backup for this game
  let backups;
  try { backups = await window.pork.listBackups(g.game_id); } catch { backups = []; }
  if (!backups.length) { setStatus('No local backups found — add one via the Manage tab', 'error'); return; }

  const latest = backups.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  try {
    await window.pork.ftpUpload({ localPath: latest.backup_path, remotePath: ftpPath });
    setStatus('Install queued — see Transfers for progress', 'ok');
    closeModal();
  } catch (e) {
    setStatus(`Install failed: ${e.message}`, 'error');
  }
});

$('btn-modal-refresh').addEventListener('click', async () => {
  if (!state.currentGame) return;
  const { game_id } = state.currentGame;
  $('btn-modal-refresh').disabled = true;
  setStatus('Refreshing metadata…');
  try {
    await window.pork.prosperoFetch(game_id);
    setStatus('Metadata refreshed', 'ok');
  } catch (e) {
    setStatus(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('btn-modal-refresh').disabled = false;
  }
});

function closeModal() {
  $('modal-overlay').hidden = true;
  state.currentGame = null;
  // Reset banner
  $('modal-banner').style.backgroundImage = '';
  // Reset icon
  const icon = $('modal-icon');
  icon.src = ''; icon.hidden = true;
  // Reset description
  $('modal-description').hidden = true;
  $('modal-description').textContent = '';
  // Reset hash section
  $('modal-hash-section').hidden = true;
  $('modal-hash-progress').hidden = true;
  $('hash-progress-fill').style.width = '0%';
  // Reset manage section
  uploadLocalPath = null;
  uploadInProgress = false;
  porkInProgress   = false;
  $('manage-remote-path').value    = '';
  $('manage-remote-path').readOnly = true;
  $('btn-manage-upload').disabled  = true;
  $('manage-upload-log').hidden    = true;
  $('mtab-manage-count').textContent = '';
  $('manage-backpork-section').hidden = true;
  $('manage-pork-progress').hidden    = true;
  $('pork-progress-fill').style.width = '0%';
}

$('modal-close').addEventListener('click', closeModal);
$('btn-modal-close2').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });
document.addEventListener('keydown', e => {
  // Only close the game modal on Escape when it's actually open, so this doesn't
  // hijack Escape from other overlays (FTP browser, prompt, fullscreen).
  if (e.key === 'Escape' && $('modal-overlay') && !$('modal-overlay').hidden) closeModal();
});

