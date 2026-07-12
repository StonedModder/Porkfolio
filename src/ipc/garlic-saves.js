'use strict';
module.exports = function register(ipcMain, { win, store, ftp, path, fs, app, net, github, ps5Notify }) {
// ── GarlicSaves ────────────────────────────────────────────────────────────────
const GARLIC_ELF_NAME    = 'garlic-worker-ps5.elf';
const GARLIC_REMOTE_DIR  = '/data/garlic';
const GARLIC_REMOTE_CFG  = `${GARLIC_REMOTE_DIR}/config.ini`;
const GARLIC_GITHUB_REPO = 'https://github.com/earthonion/garlic-worker';

function _garlicElfCachePath() {
  return path.join(app.getPath('userData'), GARLIC_ELF_NAME);
}

// Bundled config.ini — works in both dev and packaged (asar) builds.
// __dirname is src/ipc; the file lives at project-root build/garlic (asarUnpack'd when packaged).
function _garlicConfigSrc() {
  return path.join(__dirname, '..', '..', 'build', 'garlic', 'config.ini');
}

// Start: download ELF (if needed), FTP config.ini, send ELF via TCP 9021
// No autoloader modification — worker runs until PS5 is restarted.
ipcMain.handle('garlic:start', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const host = store.get('ftp.host', '');
  if (!host) throw new Error('No PS5 IP configured. Set it in FTP Settings.');

  const emit = (step, msg, percent) =>
    win?.webContents.send('garlic:progress', { step, msg, percent: percent ?? null });

  // Step 1 — download ELF from GitHub if not already cached
  const elfPath = _garlicElfCachePath();
  if (!fs.existsSync(elfPath)) {
    emit('download', 'Fetching latest garlic-worker release from GitHub…', 0);
    const release  = await github.fetchLatestRelease(GARLIC_GITHUB_REPO);
    const elfAsset = (release.assets || []).find(a => a.name === GARLIC_ELF_NAME);
    if (!elfAsset) throw new Error(`Could not find ${GARLIC_ELF_NAME} in latest GitHub release.`);
    await github.downloadAsset(elfAsset.url, elfPath, info => {
      emit('download', `Downloading ELF… ${info.percent ?? 0}%`, info.percent);
    });
    emit('download', 'ELF downloaded.', 100);
  } else {
    emit('download', 'ELF already cached.', 100);
  }

  // Step 2 — FTP config.ini to /data/garlic/ (overwrite if exists)
  emit('config', 'Uploading config.ini to /data/garlic/…', null);
  const cfgSrc = _garlicConfigSrc();
  if (!fs.existsSync(cfgSrc)) throw new Error(`Bundled config.ini not found at ${cfgSrc}`);
  await ftp.uploadFile(cfgSrc, GARLIC_REMOTE_CFG);
  emit('config', 'config.ini uploaded.', null);

  // Step 3 — Send ELF via TCP port 9021
  emit('send', `Sending ${GARLIC_ELF_NAME} to PS5 via TCP 9021…`, null);
  const buf = await fs.promises.readFile(elfPath);
  await new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let resolved = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('TCP connection timed out on port 9021 — PS5 unreachable or elfldr not running')); }, 10000);
    sock.on('error', err => { clearTimeout(timer); if (!resolved) reject(err); });
    sock.connect(9021, host, () => {
      clearTimeout(timer);
      sock.write(buf, err => {
        if (err) { reject(err); return; }
        sock.end();
        resolved = true;
        resolve();
      });
    });
  });

  emit('done', 'Worker started! To stop, restart your PS5.', 100);
  ps5Notify('GarlicSaves Worker Started', `Contributing to the community — restart PS5 to stop`).catch(() => {});
  return { ok: true, bytes: buf.length };
});
};
