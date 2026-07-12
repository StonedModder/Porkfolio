// ── External links — open in default browser via shell ────────────────────────
document.addEventListener('click', e => {
  const link = e.target.closest('a.external-link[data-url]');
  if (link) { e.preventDefault(); window.pork.openShell(link.dataset.url); }
});

// ── Pin button — toggle card pinned to dashboard ──────────────────────────────
document.addEventListener('click', async e => {
  const btn = e.target.closest('.btn-pin');
  if (!btn) return;
  e.stopPropagation(); // prevent tile nav from firing if btn is inside a tile
  const pinId = btn.dataset.pinId;
  if (!pinId) return;
  const s      = await window.pork.getSettings();
  const pinned = new Set(s.pinnedCards || []);
  if (pinned.has(pinId)) pinned.delete(pinId);
  else                   pinned.add(pinId);
  await window.pork.setSettings({ pinnedCards: [...pinned] });
  // Update pin button visuals everywhere
  document.querySelectorAll(`.btn-pin[data-pin-id="${pinId}"]`).forEach(b =>
    b.classList.toggle('pinned', pinned.has(pinId))
  );
  // If on dashboard, refresh pinned grid immediately
  if (document.querySelector('#page-dashboard.active')) renderPinnedTiles();
});

// ── Dashboard pinned tile — navigate on click ─────────────────────────────────
document.addEventListener('click', e => {
  const tile = e.target.closest('.dash-pinned-tile[data-nav-page]');
  if (tile) navigate(tile.dataset.navPage);
});

// ── Title bar ─────────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click', () => window.pork.minimize());
$('btn-max').addEventListener('click', () => window.pork.maximize());
$('btn-cls').addEventListener('click', () => window.pork.close());
$('sidebar-donate').addEventListener('click', () => window.pork.openDonate());
$('titlebar-x-link').addEventListener('click', e => {
  e.preventDefault();
  window.pork.openShell('https://x.com/StonedModder');
});

// ── Conversion job updates ────────────────────────────────────────────────────
window.pork.on('conv:job-update', (job) => {
  if (document.querySelector('#page-games.active')) {
    patchConvJobCard(job);
  }
});
window.pork.on('conv:queue:paused-change', () => {
  if (document.querySelector('#page-games.active')) {
    refreshConvQueuePanel().catch(() => {});
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // Load just the startup essentials. Heavy page-specific setup is deferred
  // until the user actually opens those pages.
  const [s] = await Promise.all([
    window.pork.getSettings(),
    loadDashboard(),
  ]);

  // Restore FTP connection state immediately so the UI isn't blank while devices enumerate.
  let connected = false;
  try {
    ({ connected } = await window.pork.ftpStatus());
    setConnected(connected);
  } catch (_) {}

  if (!connected && s.autoConnect && s.ftpHost) {
    setStatus('Auto-connecting…');
    try {
      const autoPorts = (s.ftpPorts && s.ftpPorts.length) ? s.ftpPorts : ['1337', '2121', '21'];
      await window.pork.ftpConnect({
        host:     s.ftpHost,
        ports:    autoPorts,
        user:     s.ftpUser || '',
        password: s.ftpPass || '',
      });
      setConnected(true);
      setStatus('Connected', 'ok');
      $('sb-sync').textContent = `Connected at ${new Date().toLocaleTimeString()}`;
    } catch (_) {
      setConnected(false);
      setStatus('Auto-connect failed — enter credentials and connect manually', 'error');
    }
  }

  scheduleBackgroundWarm(1200);
})();
