// ── Payload Manager Settings modal ────────────────────────────────────────────

$('btn-payload-settings').addEventListener('click', async () => {
  const s = await window.pork.getSettings();
  $('pm-local-path').value  = s.payloadLocalPath  || '';
  $('pm-remote-path').value = s.payloadRemotePath || '';
  $('payload-settings-overlay').hidden = false;
});

$('btn-pm-browse-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (folder) $('pm-local-path').value = folder;
});

$('btn-pm-settings-save').addEventListener('click', async () => {
  await window.pork.setSettings({
    payloadLocalPath:  $('pm-local-path').value.trim(),
    payloadRemotePath: $('pm-remote-path').value.trim(),
  });
  $('payload-settings-overlay').hidden = true;
});

['payload-settings-close', 'btn-pm-settings-cancel'].forEach(id =>
  $(id).addEventListener('click', () => { $('payload-settings-overlay').hidden = true; })
);

// ── Transfer Manager ──────────────────────────────────────────────────────────

function fmtSpeed(bps) {
  if (!bps || bps < 0) return '—';
  if (bps < 1024)        return `${Math.round(bps)} B/s`;
  if (bps < 1048576)     return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

let _transferState = { jobs: [], paused: false, maxConcurrent: 1, activeCount: 0, queuedCount: 0 };

function renderTransferPage(st) {
  _transferState = st;

  // Stats bar
  $('tstat-active').textContent    = st.activeCount;
  $('tstat-queued').textContent    = st.queuedCount;
  $('tstat-concurrent').textContent = st.maxConcurrent;

  const slider = $('transfer-concurrent-slider');
  if (slider && parseInt(slider.value) !== st.maxConcurrent) slider.value = st.maxConcurrent;

  // Total speed from all active jobs
  const totalSpeed = st.jobs
    .filter(j => j.status === 'active')
    .reduce((sum, j) => sum + (j.progress?.speedBps || 0), 0);
  $('tstat-speed').textContent = fmtSpeed(totalSpeed);

  // Pause/resume button
  const pauseBtn = $('btn-transfer-pause');
  if (pauseBtn) {
    pauseBtn.textContent = st.paused ? '▶ Resume All' : '⏸ Pause All';
  }

  // Job list
  const list = $('transfers-list');
  const empty = $('transfers-empty');
  const visibleJobs = st.jobs.filter(j => j.status !== 'cancelled');

  if (!visibleJobs.length) {
    list.innerHTML = '';
    empty.hidden   = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = visibleJobs.map(job => {
    const statusText = {
      queued:    'Queued',
      active:    'Transferring…',
      done:      'Done',
      error:     'Error',
      cancelled: 'Cancelled',
    }[job.status] || job.status;

    const typeLabel = { upload: 'UPLOAD', download: 'DOWNLOAD', pork: 'PORK' }[job.type] || (job.type || '').toUpperCase();
    const typeClass = { upload: 'type-upload', download: 'type-download', pork: 'type-pork' }[job.type] || '';

    const pct  = job.progress?.percent || 0;
    const speed = job.status === 'active' ? fmtSpeed(job.progress?.speedBps) : '';
    const file  = job.progress?.file || '';
    const filesDone  = job.progress?.filesDone  || 0;
    const filesTotal = job.progress?.filesTotal || 0;
    const transferred = job.progress?.transferred || 0;
    const total       = job.progress?.total || 0;

    const showCancel  = job.status === 'queued' || job.status === 'active';
    const showBar     = job.status === 'active' || job.status === 'done';

    const currentBytes    = job.progress?.currentBytes    || 0;
    const currentFileSize = job.progress?.currentFileSize || 0;

    // File counter or single-file byte progress
    const sizeStr = filesTotal > 1
      ? `File ${filesDone}/${filesTotal}`
      : (total > 0 ? `${fmt(transferred)} / ${fmt(total)}` : '');

    // Current-file byte progress for directory uploads (shows activity on large files)
    const fileByteStr = (filesTotal > 1 && currentFileSize > 0 && job.status === 'active')
      ? `${fmt(currentBytes)} / ${fmt(currentFileSize)}`
      : '';

    const pctLabel = (showBar && job.status === 'active') ? `${pct}%` : (job.status === 'done' ? '100%' : '');

    return `
      <div class="transfer-item transfer-item-${job.status}">
        <div class="transfer-item-header">
          <span class="transfer-label" title="${escHtml(job.localPath || job.remotePath || '')}">${escHtml(job.label)}</span>
          <span class="transfer-type-badge ${typeClass}">${typeLabel}</span>
          <span class="transfer-status-text">${statusText}</span>
          ${showCancel ? `<button class="btn-cancel-transfer" data-job-id="${job.id}" title="Cancel">×</button>` : ''}
        </div>
        ${showBar ? `
        <div class="transfer-progress-wrap">
          <div class="transfer-progress-bar">
            <div class="transfer-progress-fill" style="width:${pct}%"></div>
          </div>
          ${pctLabel ? `<span class="transfer-pct-label">${pctLabel}</span>` : ''}
        </div>` : ''}
        <div class="transfer-meta">
          ${speed    ? `<span class="transfer-speed">${speed}</span>` : ''}
          ${file     ? `<span class="transfer-file">${escHtml(file)}</span>` : ''}
          ${fileByteStr ? `<span class="transfer-sizes">${fileByteStr}</span>` : sizeStr ? `<span class="transfer-sizes">${sizeStr}</span>` : ''}
          ${job.error ? `<span class="transfer-error">${escHtml(job.error)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function updateNavTransferBadge(st) {
  const badge = $('nav-transfer-badge');
  if (!badge) return;
  const n = (st.activeCount || 0) + (st.queuedCount || 0);
  badge.hidden      = n === 0;
  badge.textContent = n;
}

