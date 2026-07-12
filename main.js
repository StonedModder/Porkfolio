'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, net: eNet, protocol } = require('electron');
const { getConversionCapabilities } = require('./src/platform-capabilities');

// The SteamOS/Wayland validation host repeatedly rejected Electron's GPU child
// process (error 1002), which makes Chromium terminate after its retry limit.
// Software compositing is the portable fallback; Windows keeps its normal GPU path.
if (getConversionCapabilities().disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// Register pork-cache as a privileged scheme before app is ready so that
// <video src="pork-cache://..."> is treated as a secure, standard origin and
// is allowed through CSP.  Must happen before app.whenReady().
protocol.registerSchemesAsPrivileged([
  { scheme: 'pork-cache', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
]);
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const net   = require('net');
const https    = require('https');
const NodeFormData = require('form-data');
const nodeFetch = require('node-fetch');
const http  = require('http');
const log   = require('electron-log');
const Store = require('electron-store');

// Last-resort safety net: a rejected promise or thrown error in any fire-and-forget
// path (auto-scans, ps5Notify, streamed IPC) would otherwise crash or silently kill
// the main process. Log it instead of taking the whole app down.
process.on('unhandledRejection', (reason) => {
  log.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  log.error('[uncaughtException]', err);
});

const { PS5Notifier } = require('./PSNotifyModule');
const xavatar     = require('./src/xavatarElectronModule');
const ffmpegPath  = require('ffmpeg-static');
const { spawn }   = require('child_process');

const db       = require('./src/database');
const ftp      = require('./src/ftp');
const prospero = require('./src/prospero');
const cheats   = require('./src/cheats');
const { hashFile } = require('./src/hashing');
const github   = require('./src/github');

// ── Deferred IPC modules (registered after win is created) ──────────────────────
const _registerMedia      = require('./src/ipc/media');
const _registerConversion = require('./src/ipc/conversion');
const _registerGarlic     = require('./src/ipc/garlic-saves');
const _registerBpgen      = require('./src/ipc/backpork-gen');
const _registerElfArsenal = require('./src/ipc/elf-arsenal');
const _registerPfsRipper  = require('./src/ipc/pfs-ripper');
const _registerY2jbGen     = require('./src/ipc/y2jb-generator');
const _registerSystemState = require('./src/ipc/system-state');
const _registerBdjbGen     = require('./src/ipc/bdjb-generator');

// ── Web UI server ─────────────────────────────────────────────────────────────
const WebUIServer = require('./src/web-server');

// ── Settings store (credentials persisted via electron-store) ─────────────────
const store = new Store({ name: 'porkfolio-settings' });

// ── Web UI handler registry — intercept ipcMain.handle before any registrations
// Every handler registered with ipcMain.handle is also stored in webHandlers so
// the HTTP web server can call them directly without going through Electron IPC.
const webHandlers = new Map();
const WEB_BLOCKED_CHANNELS = new Set([
  'dialog:select-folder',
  'shell:open',
  'db:export:sql',
  'db:export:csv',
  'system-view:pick-save',
  'system-view:write-file',
  'system-view:append-file',
  'system-view:delete-file',
]);
const _origIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  if (!WEB_BLOCKED_CHANNELS.has(channel)) webHandlers.set(channel, handler);
  return _origIpcHandle(channel, handler);
};

let webServer = null; // WebUIServer instance

// ── Community hash database (bundled with app, updated via app updates) ────────
const communityHashPath = path.join(__dirname, 'data', 'game_hashes.json');
const LANG_DIR          = path.join(__dirname, 'build', 'lang');
const communityHashMap  = new Map(); // file_hash → community entry
const communityGameIndex = new Map(); // game_id  → Set<file_hash>
let _communityHashMeta  = null;      // { version, updated, source } — set when hashes are loaded

// Populate (or replace) both community lookup maps from an array of hash entries.
// Each entry is expected to have at least { file_hash, game_id } fields.
function loadCommunityHashes(hashes) {
  communityHashMap.clear();
  communityGameIndex.clear();
  for (const h of hashes || []) {
    communityHashMap.set(h.file_hash, h);
    if (h.game_id) {
      if (!communityGameIndex.has(h.game_id)) communityGameIndex.set(h.game_id, new Set());
      communityGameIndex.get(h.game_id).add(h.file_hash);
    }
  }
}

try {
  if (fs.existsSync(communityHashPath)) {
    const raw = JSON.parse(fs.readFileSync(communityHashPath, 'utf8'));
    loadCommunityHashes(raw.hashes || []);
    _communityHashMeta = { version: raw.version || 1, updated: raw.updated || null, source: 'bundled' };
    log.info(`[Hashes] Loaded ${communityHashMap.size} community hash(es)`);
  }
} catch (e) {
  log.warn('[Hashes] Failed to load community hashes:', e.message);
}

// ── PS5 Notifier ──────────────────────────────────────────────────────────────
const ps5 = new PS5Notifier('127.0.0.1'); // host updated from store at send time

/** Strip C0/C1 control characters and null bytes from a string, but preserve
 *  all printable Unicode — including emoji.  The PS5's customPSNotify daemon
 *  reads the payload as UTF-8, so emoji arrive correctly as long as we send
 *  the packet as explicit UTF-8 bytes (handled in PSNotifyModule). */
function sanitizePs5Str(s) {
  // Remove null bytes and control characters (0x00-0x1F, 0x7F, 0x80-0x9F)
  // but keep all printable ASCII and all Unicode above U+009F (emoji etc.).
  return String(s ?? '').replace(/[\x00-\x1F\x7F-\x9F]/g, '');
}

/** Fire-and-forget PS5 toast. Silently does nothing if disabled or unconfigured. */
async function ps5Notify(message, subMessage = '') {
  const host = store.get('ftp.host', '');
  if (!host || !store.get('psnotify.enabled', true)) return;
  ps5.setHost(host);
  ps5.port    = store.get('psnotify.port',    6969);
  ps5.timeout = store.get('psnotify.timeout', 5000);
  try { await ps5.send(sanitizePs5Str(message), { subMessage: sanitizePs5Str(subMessage) }); } catch (_) {}
}

// ── Prospero background fetch queue ──────────────────────────────────────────
const PROSPERO_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const prosperoQueue = new Set();
let   prosperoRunning = false;

async function processProsperoQueue() {
  if (prosperoRunning || prosperoQueue.size === 0) return;
  prosperoRunning = true;
  let fetched = 0, failed = 0;
  log.info(`[Prospero] Queue started — ${prosperoQueue.size} game(s)`);
  while (prosperoQueue.size > 0) {
    const [game_id] = prosperoQueue;
    prosperoQueue.delete(game_id);
    try {
      const data = await prospero.fetchGameMetadata(game_id);
      db.updateProsperoData(game_id, data);
      win?.webContents.send('prospero:updated', { game_id, data });
      log.info(`[Prospero] Cached metadata for ${game_id}`);
      fetched++;
    } catch (e) {
      log.warn(`[Prospero] Fetch failed for ${game_id}: ${e.message}`);
      failed++;
    }
    if (prosperoQueue.size > 0) await new Promise(r => setTimeout(r, 600));
  }
  prosperoRunning = false;
  log.info('[Prospero] Queue finished');
  win?.webContents.send('prospero:queue:done', { fetched, failed });
  if (fetched > 0) ps5Notify('ProsperoPatches Updated', `${fetched} game${fetched !== 1 ? 's' : ''} updated`);
}

function queueProsperoFetch(gameIds) {
  for (const game_id of gameIds) {
    if (db.getProsperoAge(game_id) < PROSPERO_TTL) continue; // still fresh
    prosperoQueue.add(game_id);
  }
  if (prosperoQueue.size > 0) {
    processProsperoQueue().catch(e => log.error('[Prospero] Queue error:', e));
  }
}

// ── Window ────────────────────────────────────────────────────────────────────
let win;
let systemViewPopup = null;
let splashWin = null;
let donationWin = null;
let _quitting = false; // set to true once we are committed to quitting — lets win.on('close') pass through

let _splashLoaded        = false;
let _pendingSplashStatus = null;

function createSplash() {
  return new Promise(resolve => {
    _splashLoaded        = false;
    _pendingSplashStatus = null;

    splashWin = new BrowserWindow({
      width:           360,
      height:          260,
      center:          true,
      frame:           false,
      resizable:       false,
      alwaysOnTop:     true,
      show:            false,
      backgroundColor: '#121212',
      icon:            path.join(__dirname, 'build', 'icon.png'),
      webPreferences:  { contextIsolation: true, nodeIntegration: false },
    });

    splashWin.webContents.once('did-finish-load', () => {
      _splashLoaded = true;
      // Flush any status message that arrived before the page was ready
      if (_pendingSplashStatus) {
        _execSplashStatus(_pendingSplashStatus);
        _pendingSplashStatus = null;
      }
      // Small delay lets the GPU composite the first paint before revealing the window
      setTimeout(() => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.show();
        resolve();
      }, 80);
    });

    splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  });
}

function closeSplash() {
  _splashLoaded        = false;
  _pendingSplashStatus = null;
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.close();
    splashWin = null;
  }
}

function _execSplashStatus(msg) {
  splashWin?.webContents.executeJavaScript(
    `window.setSplashStatus && window.setSplashStatus(${JSON.stringify(msg)})`
  ).catch(() => {});
}

function setSplashStatus(msg) {
  if (!splashWin || splashWin.isDestroyed()) return;
  if (_splashLoaded) {
    _execSplashStatus(msg);
  } else {
    _pendingSplashStatus = msg; // deliver once page is ready
  }
}

function createWindow() {
  win = new BrowserWindow({
    width:     1200,
    height:    800,
    minWidth:  900,
    minHeight: 600,
    show:      false,           // hidden until ready-to-show
    backgroundColor: '#121212',
    icon:      path.join(__dirname, 'build', 'icon.png'),
    frame:     false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      true,
    },
  });

  win.once('ready-to-show', () => {
    closeSplash();
    win.show();
  });

  // Forward all main-process events to web UI browser clients via WebSocket
  const _origWcSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => {
    _origWcSend(channel, ...args);
    if (webServer && webServer.isRunning()) webServer.broadcast(channel, ...args);
  };

  // Grant camera/microphone access for System View (capture card via getUserMedia)
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'microphone', 'camera', 'videoCapture', 'audioCapture'].includes(permission));
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Intercept close to show the donation popup (WinRAR-style).
  // _quitting is set before app.quit() so this handler lets it pass through.
  win.on('close', (e) => {
    if (_quitting) {
      // Real quit — clean up sub-windows then let electron proceed
      if (systemViewPopup && !systemViewPopup.isDestroyed()) {
        systemViewPopup.destroy();
        systemViewPopup = null;
      }
      return;
    }
    e.preventDefault();
    // If the popup is already open just focus it — don't open a second one
    if (donationWin && !donationWin.isDestroyed()) {
      donationWin.focus();
      return;
    }
    // Hide the main window so the user can't trigger another popup while this one is open
    win.hide();
    openDonationWindow(true);
  });

  // Auto-scan local backups and all known backpork folders once the renderer is ready.
  // Deferred via setImmediate so the renderer's init() IPC calls (settings, stats, FTP status)
  // get responses immediately — the scan runs after those complete.
  win.webContents.once('did-finish-load', () => {
    setImmediate(async () => {
    // ── Local backup scan (all configured source folders) ────────────────────
    const _startupBps = store.get('backupPaths', null) || (store.get('backupPath', '') ? [store.get('backupPath', '')] : []);
    for (const bp of _startupBps) {
      if (!bp) continue;
      try {
        const { found, newIds } = await scanLocalBackups(bp);
        queueProsperoFetch(found);
        win.webContents.send('local:scan:complete', { total: found.length, added: newIds.length });
        log.info(`[AutoScan] Local (${bp}): ${found.length} game(s), ${newIds.length} new`);
      } catch (e) {
        log.warn('[AutoScan Local]', e.message);
      }
    }

    // ── Re-queue games with missing icon URLs (e.g. after prospero regex fix) ──
    try {
      const missing = db.getGamesMissingIconUrl();
      if (missing.length > 0) {
        queueProsperoFetch(missing);
        log.info(`[AutoScan] Queued ${missing.length} game(s) for icon re-fetch`);
      }
    } catch (e) {
      log.warn('[AutoScan Icons]', e.message);
    }

    // ── Backpork folder auto-scan ──────────────────────────────────────────────
    try {
      const bpFolders = db.listBackporkFolders();
      let bpTotal = 0;
      const allBpFound = [];
      for (const folder of bpFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const found = await scanBackporkFolder(folder.path, folder.name);
        bpTotal += found.length;
        allBpFound.push(...found);
        queueProsperoFetch(found);
      }
      if (bpFolders.length > 0) {
        const bpUniqueGames = new Set(allBpFound).size;
        win.webContents.send('backporks:scan:complete', { folders: bpFolders.length, count: bpTotal, uniqueGames: bpUniqueGames });
        log.info(`[AutoScan] Backporks: ${bpFolders.length} firmware folder(s), ${bpTotal} build(s) across ${bpUniqueGames} unique game(s)`);
      }
    } catch (e) {
      log.warn('[AutoScan Backporks]', e.message);
    }
    }); // end setImmediate
  });
}

// ── Donation window ───────────────────────────────────────────────────────────
// exitMode = true  → "Close Porkfolio" button actually quits the app
//           false → "Close" button just dismisses the popup (opened from sidebar)
function openDonationWindow(exitMode = false) {
  if (donationWin && !donationWin.isDestroyed()) {
    donationWin.focus();
    return;
  }

  const query = exitMode ? '?mode=exit' : '';
  donationWin = new BrowserWindow({
    width:           400,
    height:          560,
    center:          true,
    frame:           false,
    resizable:       false,
    alwaysOnTop:     true,
    show:            false,
    backgroundColor: '#121212',
    icon:            path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'donation-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  donationWin.once('ready-to-show', () => {
    if (donationWin && !donationWin.isDestroyed()) donationWin.show();
  });

  // When the popup is closed by ANY means (button click or its own X)
  // and we were in exit-mode, commit to quitting.
  donationWin.on('closed', () => {
    donationWin = null;
    if (exitMode && !_quitting) {
      _quitting = true;
      app.quit();
    }
  });
  donationWin.loadFile(path.join(__dirname, 'renderer', 'donation.html'), { search: query });
}

// ── Donation IPC ──────────────────────────────────────────────────────────────
// Renderer-side donate widget opens the popup in manual mode
ipcMain.on('donation:show',    () => openDonationWindow(false));
// "Close Porkfolio" button inside exit-mode popup
ipcMain.on('donation:exit-app', () => {
  _quitting = true;
  app.quit(); // donationWin 'closed' handler will fire but _quitting is already true
});
// Dismiss — manual mode only (sidebar button): just close the popup, main window stays
ipcMain.on('donation:dismiss', () => {
  if (donationWin && !donationWin.isDestroyed()) donationWin.close();
});
// Open external links from the donation popup
ipcMain.on('donation:open-x',      () => shell.openExternal('https://x.com/StonedModder'));
ipcMain.on('donation:open-revolut', () => shell.openExternal('https://revolut.me/zenithprints'));
// Generate QR as SVG in main process — works without native canvas
ipcMain.handle('donation:gen-qr', async () => {
  try {
    const QRCode = require('qrcode');
    const btcAddr = '3Kt8L3FRS12XW6HJt9QqFGd8irxBc8xTD4';
    const svg = await QRCode.toString(`bitcoin:${btcAddr}`, {
      type:         'svg',
      margin:       1,
      color:        { dark: '#BB86FC', light: '#1e1e1e' },
    });
    return { ok: true, svg };
  } catch (e) {
    log.warn('[Donation] QR gen failed:', e.message);
    return { ok: false };
  }
});

app.whenReady().then(async () => {
  await createSplash();
  // Serve cached media files (thumbnails, clips) through pork-cache://<safeName>
  // so <video> and <img> elements can reference large files without base64 encoding.
  protocol.handle('pork-cache', req => {
    // The renderer sets src="pork-cache://<safeName>" where safeName contains
    // no slashes, so the entire filename is in the URL hostname component.
    const safeName = decodeURIComponent(new URL(req.url).hostname)
      .replace(/\.\./g, '').replace(/[/\\]/g, '');
    const filePath  = path.join(path.join(os.tmpdir(), 'porkfolio-media-thumb'), safeName);
    return eNet.fetch(`file:///${filePath.replace(/\\/g, '/')}`);
  });

  try {
    setSplashStatus('Loading database…');
    await db.initialize();
    // Overlay user-imported community hashes (persisted across launches)
    try {
      const userHashPath = path.join(app.getPath('userData'), 'community-hashes.json');
      if (fs.existsSync(userHashPath)) {
        const raw = JSON.parse(fs.readFileSync(userHashPath, 'utf8'));
        if (Array.isArray(raw.hashes)) {
          loadCommunityHashes(raw.hashes);
          _communityHashMeta = { version: raw.version || 1, updated: raw.updated || null, source: 'imported' };
          log.info(`[Hashes] Loaded ${communityHashMap.size} imported community hash(es)`);
        }
      }
    } catch (_ie) { log.warn('[Hashes] Failed to load imported hashes:', _ie.message); }
    const dbStats    = db.getStats();
    const cheatStats = db.getCheatStats();
    setSplashStatus(`${dbStats.totalGames} game${dbStats.totalGames !== 1 ? 's' : ''} found · ${cheatStats.files} cheats cached`);
    createWindow();
    // Auto-launch System View popout immediately using stored settings —
    // done here in the main process so it opens without waiting for the
    // renderer's init() sequence (which can take many seconds).
    if (store.get('sv.autoLoad', false)) {
      _openSystemViewPopout(
        store.get('sv.videoDevice', ''),
        store.get('sv.audioDevice', ''),
        store.get('sv.resolution',  '')
      );
    }
    // Register large IPC modules now that win is set
    _registerMedia(ipcMain,      { win, store, log, ftp, shell, dialog, path, fs, os, http, https, ffmpegPath, spawn, transferMgr, ps5Notify, eNet, app, BrowserWindow });
    _registerConversion(ipcMain, { win, store, log, path, fs, os, spawn, ps5Notify, transferMgr, dialog, ftp });
    _registerGarlic(ipcMain,     { win, store, ftp, path, fs, app, net, github, ps5Notify });
    _registerBpgen(ipcMain,      { win, db, log, path, fs, dialog, app, store });
    _registerElfArsenal(ipcMain, { win, store, log, path, fs, dialog, nodeFetch, ps5Notify });
    _registerPfsRipper(ipcMain,  { win, store, log, path, fs, dialog, shell, ftp, transferMgr });
    _registerY2jbGen(ipcMain,    { app, dialog, log });
    _registerSystemState(ipcMain,{ store, transferMgr, log });
    _registerBdjbGen(ipcMain,    { app, dialog, log, win });

    // ── Web UI server — start if enabled in settings ──────────────────────────
    webServer = new WebUIServer({
      appRoot: __dirname, store, log, webHandlers,
      onRelayRequest: (active) => {
        if (win && !win.isDestroyed()) win.webContents.send('sv:relay:request', { active });
      },
    });
    if (store.get('webui.enabled', false)) {
      const port = store.get('webui.port', 6967);
      webServer.start(port).catch(e => log.error('[WebUI] Failed to start:', e.message));
    }
  } catch (e) {
    closeSplash();
    log.error('[App] Startup error:', e);
    dialog.showErrorBox('Startup Error', e.message);
    app.quit();
  }
});

const _xavatarCleanup = xavatar.registerIpcHandlers(ipcMain);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { ftp.disconnect().catch(() => {}); db.close(); _xavatarCleanup(); });

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:maximize', () => win?.isMaximized() ? win.restore() : win.maximize());
ipcMain.on('window:close',    () => win?.close());

// ── Settings ──────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => ({
  ftpHost:          store.get('ftp.host',           ''),
  ftpPort:          store.get('ftp.port',           '21'),
  ftpPorts:         store.get('ftp.ports',          ['1337', '2121', '21']),
  ftpUser:          store.get('ftp.user',           ''),
  ftpPass:          store.get('ftp.pass',           ''),
  backupPath:       store.get('backupPath',          ''),
  backupPaths:      store.get('backupPaths',         null) || (store.get('backupPath', '') ? [store.get('backupPath', '')] : []),
  accentColor:      store.get('accentColor',         '#BB86FC'),
  payloadLocalPath: store.get('payload.localPath',   ''),
  payloadRemotePath:store.get('payload.remotePath',  '/data/payloads/'),
  svResolution:     store.get('sv.resolution',        ''),
  svVideoDevice:    store.get('sv.videoDevice',       ''),
  svAudioDevice:    store.get('sv.audioDevice',       ''),
  svGifFps:         store.get('sv.gifFps',            '10'),
  svVidQuality:     store.get('sv.vidQuality',        '8000000'),
  svHotkeys:        store.get('sv.hotkeys',           { mute: 'm', gif: 'g', video: 'v', fullscreen: 'f', popout: 'p' }),
  svAutoLoad:       store.get('sv.autoLoad',           false),
  savemgrPort:      store.get('savemgr.port',         store.get('savemgrPort', 8082)),
  remoteGamePaths:  store.get('remoteGamePaths',     []),
  mediaLocalPath:      store.get('mediaLocalPath',          ''),
  discordWebhookUrl:       store.get('discord.webhookUrl',      ''),
  mediaPsNotifyEnabled:    store.get('media.psNotify.enabled',  true),
  mediaPsNotifyDiscordDownload: store.get('media.psNotify.discordDownload', true),
  mediaPsNotifyDiscordConvert:  store.get('media.psNotify.discordConvert',  true),
  mediaPsNotifyDiscordUpload:   store.get('media.psNotify.discordUpload',   true),
  mediaPsNotifyDiscordDone:     store.get('media.psNotify.discordDone',     true),
  mediaPsNotifyDiscordError:    store.get('media.psNotify.discordError',    true),
  y2jbZipUrl:       store.get('y2jb.zipUrl',          ''),
  y2jbFtpPath:      store.get('y2jb.ftpPath',         '/data/'),
  psnotifyEnabled:  store.get('psnotify.enabled',     true),
  psnotifyPort:     store.get('psnotify.port',        6969),
  pinnedCards:      store.get('pinnedCards',          []),
  autoConnect:      store.get('autoConnect',           false),
  // ── Game Conversion (FFPKG / ExFAT) ────────────────────────────────────────
  gameConversionMode: store.get('conv.mode',           'pfs'),   // 'pfs' | 'ffpkg' | 'exfat'
  ufs2ToolPath:       store.get('conv.ufs2ToolPath',   ''),
  exfatToolPath:      store.get('conv.exfatToolPath',  ''),
  osfmountPath:       store.get('conv.osfmountPath',   ''),
  ufs2Method:         store.get('conv.ufs2Method',     'makefs'), // 'makefs' | 'newfs'
  convOutputDir:      store.get('conv.outputDir',      ''),
  convTempDir:        store.get('conv.tempDir',        ''),
  convFtpUpload:      store.get('conv.ftpUpload',      false),
  convDeleteAfter:    store.get('conv.deleteAfter',    false),
  convPsNotifyEnabled:       store.get('conv.psNotify.enabled',       true),
  convPsNotifyOnGameQueued:  store.get('conv.psNotify.onGameQueued',  true),
  convPsNotifyOnBatchQueued: store.get('conv.psNotify.onBatchQueued', true),
  convPsNotifyOnCopyStart:   store.get('conv.psNotify.onCopyStart',   true),
  convPsNotifyOnConvertStart:store.get('conv.psNotify.onConvertStart',true),
  convPsNotifyOnJobDone:     store.get('conv.psNotify.onJobDone',     true),
  bpgenOutputDir:            store.get('bpgen.outputDir',             store.get('bpgenOutputDir', '')),
  bpgenFakelibBaseDir:       store.get('bpgen.fakelibBaseDir',        store.get('bpgenFakelibBaseDir', '')),
  bpgenFakelibDir:           store.get('bpgen.fakelibDir',            store.get('bpgenFakelibDir', '')),
  bpgenSdkPair:              store.get('bpgen.sdkPair',               store.get('bpgenSdkPair', '')),
  bpgenFirmwareLabel:        store.get('bpgen.firmwareLabel',         store.get('bpgenFirmwareLabel', '')),
  voidshellPort:            store.get('voidshell.port',              7007),
  elfArsenalPort:           store.get('elfArsenal.port',             6969),
  language:                 store.get('language',                    'en'),
  webUiEnabled:             store.get('webui.enabled',               false),
  webUiPort:                store.get('webui.port',                  6967),
  hashConcurrency:          store.get('hash.concurrency',            8),
}));

ipcMain.handle('settings:set', (_e, s) => {
  if (s.ftpHost           != null) store.set('ftp.host',          s.ftpHost);
  if (s.ftpPort           != null) store.set('ftp.port',          s.ftpPort);
  if (s.ftpPorts          != null) store.set('ftp.ports',         s.ftpPorts);
  if (s.ftpUser           != null) store.set('ftp.user',          s.ftpUser);
  if (s.ftpPass           != null) store.set('ftp.pass',          s.ftpPass);
  if (s.backupPath        != null) store.set('backupPath',         s.backupPath);
  if (s.backupPaths       != null) { store.set('backupPaths', s.backupPaths); if (s.backupPaths.length) store.set('backupPath', s.backupPaths[0]); }
  if (s.accentColor       != null) store.set('accentColor',        s.accentColor);
  if (s.payloadLocalPath  != null) store.set('payload.localPath',  s.payloadLocalPath);
  if (s.payloadRemotePath != null) store.set('payload.remotePath', s.payloadRemotePath);
  if (s.svResolution      != null) store.set('sv.resolution',      s.svResolution);
  if (s.svVideoDevice     != null) store.set('sv.videoDevice',     s.svVideoDevice);
  if (s.svAudioDevice     != null) store.set('sv.audioDevice',     s.svAudioDevice);
  if (s.svGifFps          != null) store.set('sv.gifFps',          s.svGifFps);
  if (s.svVidQuality      != null) store.set('sv.vidQuality',      s.svVidQuality);
  if (s.svHotkeys         != null) store.set('sv.hotkeys',         s.svHotkeys);
  if (s.svAutoLoad        != null) store.set('sv.autoLoad',        s.svAutoLoad);
  if (s.savemgrPort       != null) { store.set('savemgr.port', Number(s.savemgrPort)); store.set('savemgrPort', Number(s.savemgrPort)); }
  if (s.remoteGamePaths   != null) store.set('remoteGamePaths',    s.remoteGamePaths);
  if (s.mediaLocalPath    != null) store.set('mediaLocalPath',     s.mediaLocalPath);
  if (s.discordWebhookUrl    != null) store.set('discord.webhookUrl',    s.discordWebhookUrl);
  if (s.mediaPsNotifyEnabled != null) store.set('media.psNotify.enabled', s.mediaPsNotifyEnabled);
  if (s.mediaPsNotifyDiscordDownload != null) store.set('media.psNotify.discordDownload', s.mediaPsNotifyDiscordDownload);
  if (s.mediaPsNotifyDiscordConvert  != null) store.set('media.psNotify.discordConvert',  s.mediaPsNotifyDiscordConvert);
  if (s.mediaPsNotifyDiscordUpload   != null) store.set('media.psNotify.discordUpload',   s.mediaPsNotifyDiscordUpload);
  if (s.mediaPsNotifyDiscordDone     != null) store.set('media.psNotify.discordDone',     s.mediaPsNotifyDiscordDone);
  if (s.mediaPsNotifyDiscordError    != null) store.set('media.psNotify.discordError',    s.mediaPsNotifyDiscordError);
  if (s.y2jbZipUrl           != null) store.set('y2jb.zipUrl',            s.y2jbZipUrl);
  if (s.y2jbFtpPath       != null) store.set('y2jb.ftpPath',       s.y2jbFtpPath);
  if (s.psnotifyEnabled   != null) store.set('psnotify.enabled',   s.psnotifyEnabled);
  if (s.psnotifyPort      != null) store.set('psnotify.port',      s.psnotifyPort);
  if (s.pinnedCards       != null) store.set('pinnedCards',        s.pinnedCards);
  if (s.autoConnect       != null) store.set('autoConnect',        s.autoConnect);
  // ── Game Conversion ────────────────────────────────────────────────────────
  if (s.gameConversionMode != null) store.set('conv.mode',           s.gameConversionMode);
  if (s.ufs2ToolPath       != null) store.set('conv.ufs2ToolPath',   s.ufs2ToolPath);
  if (s.exfatToolPath      != null) store.set('conv.exfatToolPath',  s.exfatToolPath);
  if (s.osfmountPath       != null) store.set('conv.osfmountPath',   s.osfmountPath);
  if (s.ufs2Method         != null) store.set('conv.ufs2Method',     s.ufs2Method);
  if (s.convOutputDir      != null) store.set('conv.outputDir',      s.convOutputDir);
  if (s.convTempDir        != null) store.set('conv.tempDir',        s.convTempDir);
  if (s.convFtpUpload      != null) store.set('conv.ftpUpload',      s.convFtpUpload);
  if (s.convDeleteAfter    != null) store.set('conv.deleteAfter',    s.convDeleteAfter);
  if (s.convPsNotifyEnabled        != null) store.set('conv.psNotify.enabled',       s.convPsNotifyEnabled);
  if (s.convPsNotifyOnGameQueued   != null) store.set('conv.psNotify.onGameQueued',  s.convPsNotifyOnGameQueued);
  if (s.convPsNotifyOnBatchQueued  != null) store.set('conv.psNotify.onBatchQueued', s.convPsNotifyOnBatchQueued);
  if (s.convPsNotifyOnCopyStart    != null) store.set('conv.psNotify.onCopyStart',   s.convPsNotifyOnCopyStart);
  if (s.convPsNotifyOnConvertStart != null) store.set('conv.psNotify.onConvertStart',s.convPsNotifyOnConvertStart);
  if (s.convPsNotifyOnJobDone      != null) store.set('conv.psNotify.onJobDone',     s.convPsNotifyOnJobDone);
  if (s.bpgenOutputDir       != null) { store.set('bpgen.outputDir', s.bpgenOutputDir); store.set('bpgenOutputDir', s.bpgenOutputDir); }
  if (s.bpgenFakelibBaseDir  != null) { store.set('bpgen.fakelibBaseDir', s.bpgenFakelibBaseDir); store.set('bpgenFakelibBaseDir', s.bpgenFakelibBaseDir); }
  if (s.bpgenFakelibDir      != null) { store.set('bpgen.fakelibDir', s.bpgenFakelibDir); store.set('bpgenFakelibDir', s.bpgenFakelibDir); }
  if (s.bpgenSdkPair         != null) { store.set('bpgen.sdkPair', s.bpgenSdkPair); store.set('bpgenSdkPair', s.bpgenSdkPair); }
  if (s.bpgenFirmwareLabel   != null) { store.set('bpgen.firmwareLabel', s.bpgenFirmwareLabel); store.set('bpgenFirmwareLabel', s.bpgenFirmwareLabel); }
  if (s.voidshellPort             != null) store.set('voidshell.port',              s.voidshellPort);
  if (s.elfArsenalPort            != null) store.set('elfArsenal.port',             s.elfArsenalPort);
  if (s.language                  != null) store.set('language',                    s.language);
  // Web UI settings — apply changes immediately if webServer is ready
  if (s.webUiEnabled      != null) store.set('webui.enabled',     s.webUiEnabled);
  if (s.webUiPort         != null) store.set('webui.port',        Number(s.webUiPort));
  if (s.hashConcurrency   != null) store.set('hash.concurrency',  Math.max(1, Math.min(32, Number(s.hashConcurrency) || 8)));
  if (webServer && (s.webUiEnabled != null || s.webUiPort != null)) {
    const enabled = store.get('webui.enabled', false);
    const port    = store.get('webui.port',    6967);
    if (enabled) {
      webServer.stop().then(() => webServer.start(port)).catch(e => log.error('[WebUI] Restart failed:', e.message));
    } else {
      webServer.stop().catch(e => log.error('[WebUI] Stop failed:', e.message));
    }
  }
  return true;
});

// ── Web UI control IPC handlers ───────────────────────────────────────────────
ipcMain.handle('webui:status', () => {
  const running = webServer ? webServer.isRunning() : false;
  const port    = running ? webServer.port : store.get('webui.port', 6967);
  return { running, port, hosts: ['localhost', '127.0.0.1'], localOnly: true };
});

ipcMain.handle('webui:start', async () => {
  if (!webServer) return { ok: false, error: 'Server not initialized' };
  if (webServer.isRunning()) return { ok: true, port: webServer.port };
  const port = store.get('webui.port', 6967);
  try {
    await webServer.start(port);
    store.set('webui.enabled', true);
    return { ok: true, port };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('webui:stop', async () => {
  if (!webServer || !webServer.isRunning()) return { ok: true };
  try {
    await webServer.stop();
    store.set('webui.enabled', false);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Language / i18n ─────────────────────────────────────────────────────────
//
// Two-tier language resolution:
//   1. Bundled: build/lang/*.json  (shipped with the app, read-only)
//   2. Imported: userData/lang/*.json  (user-added, persists across updates)
// Imported files override bundled ones when the same language code exists.

// Lazy getter — app.getPath() requires app to be ready
function getExtLangDir() {
  return path.join(app.getPath('userData'), 'lang');
}

// Returns a Map of filename → { filePath, source: 'bundled'|'imported' }
// Imported entries shadow bundled entries with the same filename.
async function listLangFiles() {
  const files = new Map();
  for (const f of await fs.promises.readdir(LANG_DIR).catch(() => [])) {
    if (f.endsWith('.json')) files.set(f, { filePath: path.join(LANG_DIR, f), source: 'bundled' });
  }
  const extDir = getExtLangDir();
  for (const f of await fs.promises.readdir(extDir).catch(() => [])) {
    if (f.endsWith('.json')) files.set(f, { filePath: path.join(extDir, f), source: 'imported' });
  }
  return files;
}

ipcMain.handle('lang:list', async () => {
  try {
    const files = await listLangFiles();
    const langs = [];
    for (const [, { filePath, source }] of files) {
      try {
        const raw  = await fs.promises.readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.meta && data.meta.code && data.meta.name)
          langs.push({ code: data.meta.code, name: data.meta.name, source });
      } catch (_) {}
    }
    langs.sort((a, b) => a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.name.localeCompare(b.name));
    if (!langs.length) langs.push({ code: 'en', name: 'English', source: 'bundled' });
    return langs;
  } catch (_) {
    return [{ code: 'en', name: 'English', source: 'bundled' }];
  }
});

ipcMain.handle('lang:load', async (_e, code) => {
  if (typeof code !== 'string' || !/^[a-z]{2,8}(-[A-Za-z]{2,4})?$/.test(code))
    throw new Error('Invalid language code.');
  const files   = await listLangFiles();
  const entry   = files.get(`${code}.json`);
  if (!entry) throw new Error(`Language not found: ${code}`);
  const raw  = await fs.promises.readFile(entry.filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data.meta || typeof data.strings !== 'object') throw new Error('Invalid language file format.');
  return data;
});

ipcMain.handle('lang:export-base', async () => {
  const { filePath: dest, canceled } = await dialog.showSaveDialog(win, {
    title:       'Export English Base Language File',
    defaultPath: 'en.json',
    filters:     [{ name: 'JSON Language File', extensions: ['json'] }],
  });
  if (canceled || !dest) return { canceled: true };
  const src = path.join(LANG_DIR, 'en.json');
  await fs.promises.copyFile(src, dest);
  return { ok: true, dest };
});

ipcMain.handle('lang:import', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title:       'Import Language File',
      filters:     [{ name: 'JSON Language File', extensions: ['json'] }],
      properties:  ['openFile'],
    });
    const { canceled, filePaths } = result;
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };

    const raw  = await fs.promises.readFile(filePaths[0], 'utf8');
    const data = JSON.parse(raw);

    if (!data.meta || !data.meta.code || !data.meta.name || typeof data.strings !== 'object')
      throw new Error('Invalid language file. Must have meta.code, meta.name, and a strings object.');
    if (!/^[a-z]{2,8}(-[A-Za-z]{2,4})?$/.test(data.meta.code))
      throw new Error(`Invalid language code "${data.meta.code}" in file.`);

    const extDir = getExtLangDir();
    await fs.promises.mkdir(extDir, { recursive: true });
    const dest = path.join(extDir, `${data.meta.code}.json`);
    await fs.promises.writeFile(dest, raw, 'utf8');
    return { ok: true, code: data.meta.code, name: data.meta.name };
  } catch (err) {
    log.error('[lang:import] Failed:', err.message);
    throw err;
  }
});

// ── Y2JB Updater ──────────────────────────────────────────────────────────────

ipcMain.handle('y2jb:check', async () => {
  const url = store.get('y2jb.zipUrl', '');
  if (!url) throw new Error('No ZIP URL configured. Open Y2JB Settings to set one.');
  const lastModified = await new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD' },
      res => resolve(res.headers['last-modified'] || res.headers['date'] || '')
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
  return { lastModified, lastApplied: store.get('y2jb.lastApplied', '') };
});

ipcMain.handle('y2jb:apply', async () => {
  const zipUrl  = store.get('y2jb.zipUrl',  '');
  const ftpPath = store.get('y2jb.ftpPath', '/data/');
  if (!zipUrl)  throw new Error('No ZIP URL configured. Open Y2JB Settings.');
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const filename    = new URL(zipUrl).pathname.split('/').pop() || 'y2jb-update.zip';
  const tmpFile     = path.join(os.tmpdir(), filename);
  const finalFtpPath = ftpPath.endsWith('/') ? ftpPath + filename : ftpPath + '/' + filename;

  // Download ZIP to temp file (follow one redirect)
  await new Promise((resolve, reject) => {
    let redirects = 0;
    const doGet = (targetUrl) => {
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.get(targetUrl, res => {
        // Redirect: drain the response to free the socket, then follow (capped).
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (!res.headers.location) { reject(new Error(`Redirect ${res.statusCode} without Location header`)); return; }
          if (++redirects > 5) { reject(new Error('Too many redirects downloading ZIP')); return; }
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ZIP`));
          return;
        }
        // Final response only — open the write stream here so redirects never race it.
        const file = fs.createWriteStream(tmpFile);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject).setTimeout(60000, function() { this.destroy(new Error('Download timeout')); });
    };
    doGet(zipUrl);
  });

  store.set('y2jb.lastApplied', new Date().toISOString());

  return transferMgr.enqueue('upload', {
    label:      `Y2JB Update \u2192 PS5`,
    localPath:  tmpFile,
    remotePath: finalFtpPath,
  });
});

// ── PSNotify IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('psnotify:send', async (_e, { message, subMessage = '' }) => {
  const host = store.get('ftp.host', '');
  if (!host) throw new Error('No PS5 IP configured. Set one in FTP Settings.');
  ps5.setHost(host);
  ps5.port    = store.get('psnotify.port',    6969);
  ps5.timeout = store.get('psnotify.timeout', 5000);
  await ps5.send(message, { subMessage });
  return { ok: true };
});

ipcMain.handle('psnotify:history', () => ps5.history(100));

ipcMain.handle('psnotify:pushPayload', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const localPath  = path.join(__dirname, 'build', 'garlic', 'customPSNotify.js');
  const remotePath = store.get('payload.remotePath', '/data/payloads/');
  const remoteFile = remotePath.endsWith('/') ? remotePath + 'customPSNotify.js' : remotePath + '/customPSNotify.js';
  transferMgr.enqueue('upload', {
    label:      'customPSNotify.js (UTF-8 patched) → PS5',
    localPath,
    remotePath: remoteFile,
  }).catch(e => log.warn('[PSNotify] Push payload failed: ' + e.message));
  return { ok: true, remotePath: remoteFile };
});

// Upload garlic-savemgr.elf to /data/ps5_autoloader and append it to autoload.txt.
ipcMain.handle('savemgr:push-payload', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const localPath = path.join(__dirname, 'build', 'garlic', 'garlic-savemgr.elf');
  if (!fs.existsSync(localPath)) throw new Error('garlic-savemgr.elf not found in the build folder.');
  // Upload the ELF
  const remoteElf = `${AUTOLOADER_DIR}/garlic-savemgr.elf`;
  await ftp.uploadFile(localPath, remoteElf);
  // Read autoload.txt, append filename if not already present
  let content = '';
  const tmpPath = path.join(os.tmpdir(), `pork-autoload-savemgr-${Date.now()}.txt`);
  try {
    await ftp.downloadFile(AUTOLOADER_FILE, tmpPath);
    content = await fs.promises.readFile(tmpPath, 'utf8');
  } catch (_) {}
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  let appended = false;
  if (!lines.includes('garlic-savemgr.elf')) {
    lines.push('garlic-savemgr.elf');
    const updated = lines.join('\n') + '\n';
    await fs.promises.writeFile(tmpPath, updated, 'utf8');
    await ftp.uploadFile(tmpPath, AUTOLOADER_FILE);
    appended = true;
  }
  await fs.promises.unlink(tmpPath).catch(() => {});
  // Send a PS5 notification if psnotify is configured
  try {
    const host = store.get('ftp.host', '');
    if (host && store.get('psnotify.enabled', true)) {
      ps5.setHost(host);
      ps5.port    = store.get('psnotify.port',    6969);
      ps5.timeout = store.get('psnotify.timeout', 5000);
      await ps5.send('Local Save Manager installed ✓', { subMessage: 'Reboot your console to apply.' });
    }
  } catch (_) {}
  return { ok: true, remoteElf, appended };
});

// ── GarlicMgr native API proxy ───────────────────────────────────────────────
function _smgrBase() {
  const ip   = store.get('ftp.host', '');
  const port = store.get('savemgr.port', store.get('savemgrPort', 8082));
  if (!ip) throw new Error('PS5 IP not set. Configure FTP Settings first.');
  return `http://${ip}:${port}`;
}

// Generic GET → JSON
ipcMain.handle('savemgr:request', async (_, { path: apiPath }) => {
  const r = await nodeFetch(_smgrBase() + apiPath);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

// POST binary data → JSON
ipcMain.handle('savemgr:upload', async (_, { path: apiPath, data }) => {
  const r = await nodeFetch(_smgrBase() + apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(data),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

// GET binary → show system save dialog → write file
ipcMain.handle('savemgr:download', async (_, { path: apiPath, filename }) => {
  const r = await nodeFetch(_smgrBase() + apiPath);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.buffer();
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, buf);
  shell.showItemInFolder(filePath);
  return { ok: true, size: buf.length };
});

// POST binary → receive binary ZIP → save dialog
ipcMain.handle('savemgr:decrypt', async (_, { data, filename }) => {
  const r = await nodeFetch(_smgrBase() + '/api/decrypt_upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(data),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  const buf = await r.buffer();
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, buf);
  shell.showItemInFolder(filePath);
  return { ok: true, size: buf.length };
});

// POST binary → resign → download resigned binary → save dialog
ipcMain.handle('savemgr:resign', async (_, { data, aid, filename }) => {
  const r = await nodeFetch(_smgrBase() + `/api/resign?aid=${encodeURIComponent(aid)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(data),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  const r2 = await nodeFetch(_smgrBase() + `/api/resign_download?name=${encodeURIComponent(filename)}`);
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  const buf = await r2.buffer();
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, buf);
  shell.showItemInFolder(filePath);
  return { ok: true, size: buf.length };
});

// GET game icon → base64 data URL
ipcMain.handle('savemgr:icon', async () => {
  try {
    const r = await nodeFetch(_smgrBase() + `/api/icon?t=${Date.now()}`);
    if (!r.ok) return null;
    const buf = await r.buffer();
    const ct = r.headers.get('content-type') || 'image/png';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (_) { return null; }
});

// GET /api/create_pfs → JSON
ipcMain.handle('savemgr:create-pfs', async (_, { size }) => {
  const r = await nodeFetch(_smgrBase() + `/api/create_pfs?size=${size}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

// GET /api/download_new → binary → save dialog
ipcMain.handle('savemgr:download-new', async (_, { name, aid }) => {
  let url = _smgrBase() + `/api/download_new?name=${encodeURIComponent(name)}`;
  if (aid) url += `&aid=${encodeURIComponent(aid)}`;
  const r = await nodeFetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.buffer();
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: name });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, buf);
  shell.showItemInFolder(filePath);
  return { ok: true, size: buf.length };
});

// GET /api/dump_usb streaming → emit progress events to renderer
ipcMain.handle('savemgr:dump-usb', async (_, { idx }) => {
  const r = await nodeFetch(_smgrBase() + `/api/dump_usb?idx=${idx}`);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  let buf = '';
  let last = null;
  const handleLine = (line) => {
    if (!line.trim()) return;
    let j;
    try { j = JSON.parse(line); }
    catch { return; } // skip a malformed NDJSON line instead of aborting the whole stream
    if (j.error) throw new Error(j.error);
    if (j.progress !== undefined) win?.webContents.send('savemgr:usb-progress', j);
    if (j.ok) last = j;
  };
  for await (const chunk of r.body) {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf); // flush trailing partial line
  return last || { ok: true };
});

// ── VoidShell ─────────────────────────────────────────────────────────────────
function _vsBase() {
  const ip   = store.get('ftp.host', '');
  const port = store.get('voidshell.port', store.get('voidshellPort', 7007));
  if (!ip) throw new Error('PS5 IP not set. Configure FTP Settings first.');
  return `http://${ip}:${port}`;
}

function _vsPkgBase() {
  const ip = store.get('ftp.host', '');
  if (!ip) throw new Error('PS5 IP not set.');
  return `http://${ip}:9200`;
}

function _vsParse(text) {
  try { return { data: JSON.parse(text), type: 'json' }; }
  catch { return { data: text, type: 'text' }; }
}

ipcMain.handle('vs:request', async (_, { path: apiPath }) => {
  const r = await nodeFetch(_vsBase() + apiPath);
  const text = await r.text();
  const ct   = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const p = _vsParse(text); return { ok: r.ok, ...p }; }
  return { ok: r.ok, data: text, type: 'text' };
});

ipcMain.handle('vs:post', async (_, { path: apiPath, body, bodyType }) => {
  const opts = { method: 'POST' };
  if (bodyType === 'text') {
    opts.headers = { 'Content-Type': 'text/plain' };
    opts.body = body;
  } else if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r    = await nodeFetch(_vsBase() + apiPath, opts);
  const text = await r.text();
  const ct   = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const p = _vsParse(text); return { ok: r.ok, ...p }; }
  return { ok: r.ok, data: text, type: 'text' };
});

ipcMain.handle('vs:download', async (_, { path: apiPath, filename }) => {
  const { filePath } = await dialog.showSaveDialog({ defaultPath: filename });
  if (!filePath) return { canceled: true };
  const r = await nodeFetch(_vsBase() + apiPath);
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  const buf = await r.buffer();
  await fs.promises.writeFile(filePath, buf);
  shell.showItemInFolder(filePath);
  return { ok: true, filePath };
});

ipcMain.handle('vs:upload', async (_, { path: apiPath, data, filename }) => {
  const FormData = require('form-data');
  const buf = Buffer.from(data);
  const form = new FormData();
  form.append('file', buf, { filename });
  const r = await nodeFetch(_vsBase() + apiPath, { method: 'POST', body: form, headers: form.getHeaders() });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) return { ok: r.ok, data: await r.json() };
  return { ok: r.ok, data: await r.text() };
});

ipcMain.handle('vs:image', async (_, { path: apiPath }) => {
  try {
    const r = await nodeFetch(_vsBase() + apiPath);
    if (!r.ok) return null;
    const buf = await r.buffer();
    const ct = r.headers.get('content-type') || 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
});

// PKG manager (port 9200)
ipcMain.handle('vs:pkg-request', async (_, { path: apiPath }) => {
  const r    = await nodeFetch(_vsPkgBase() + apiPath);
  const text = await r.text();
  const ct   = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const p = _vsParse(text); return { ok: r.ok, ...p }; }
  return { ok: r.ok, data: text, type: 'text' };
});

ipcMain.handle('vs:pkg-post', async (_, { path: apiPath, body, bodyType }) => {
  const opts = { method: 'POST' };
  if (bodyType === 'text') {
    opts.headers = { 'Content-Type': 'text/plain' };
    opts.body = body;
  } else if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r    = await nodeFetch(_vsPkgBase() + apiPath, opts);
  const text = await r.text();
  const ct   = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const p = _vsParse(text); return { ok: r.ok, ...p }; }
  return { ok: r.ok, data: text, type: 'text' };
});

ipcMain.handle('vs:pkg-upload', async (_, { filename, data }) => {
  const buf  = Buffer.from(data);
  const url  = `${_vsPkgBase()}/upload?name=${encodeURIComponent(filename)}`;
  const r    = await nodeFetch(url, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length } });
  const text = await r.text();
  const ct   = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const p = _vsParse(text); return { ok: r.ok, ...p }; }
  return { ok: r.ok, data: text, type: 'text' };
});

ipcMain.handle('psnotify:test', async () => {
  const host = store.get('ftp.host', '');
  if (!host) throw new Error('No PS5 IP configured. Set one in FTP Settings.');
  ps5.setHost(host);
  ps5.port    = store.get('psnotify.port',    6969);
  ps5.timeout = store.get('psnotify.timeout', 5000);
  await ps5.send('Porkfolio Test', { subMessage: 'PSNotify is working!' });
  return { ok: true };
});

// ── FTP ───────────────────────────────────────────────────────────────────────
ipcMain.handle('ftp:connect', async (_e, creds) => {
  // Support multiple ports: try each in order until one succeeds.
  const ports = (Array.isArray(creds.ports) && creds.ports.length)
    ? creds.ports
    : [creds.port || '21'];

  const failures = [];
  for (const port of ports) {
    try {
      await ftp.connect({ ...creds, port: String(port) });
      store.set('ftp.lastPort', String(port)); // remember for extra-client connections
      store.set('ftp.host',     creds.host);   // ensure host is stored so ps5Notify can reach it
      ps5Notify('🐷 Porkfolio Connected ✓', 'Created by StonedModder');
      return { success: true, port };
    } catch (e) {
      const reason = e.code === 'ECONNREFUSED' ? 'refused' : e.message.split('\n')[0];
      log.warn(`[FTP] Connect attempt on port ${port} failed: ${e.message}`);
      failures.push(`${port} (${reason})`);
    }
  }
  const summary = failures.length === 1
    ? `Connection failed: ${failures[0]}`
    : `All ports failed — ${failures.join(', ')}`;
  throw new Error(summary);
});

ipcMain.handle('ftp:disconnect', async () => {
  await ftp.disconnect();
  return { success: true };
});

ipcMain.handle('ftp:status', () => ({ connected: ftp.isConnected() }));

ipcMain.handle('ftp:scan', async () => {
  const customPaths = (store.get('remoteGamePaths', []) || []).map(p => p.path).filter(Boolean);
  const games = await ftp.scanGames(progress => {
    win?.webContents.send('ftp:progress', progress);
  }, customPaths);

  // Clear installed/ftp_path for games previously on the PS5 that were not
  // found in this scan — but only when the scan actually discovered at least
  // one game, so a failed or empty connection doesn't wipe every flag.
  if (games.length > 0) {
    const scannedIds = new Set(games.map(g => g.game_id));
    const allGames = db.listGames();
    for (const g of allGames) {
      if (g.installed && !scannedIds.has(g.game_id)) {
        db.updateGame(g.game_id, { installed: 0, ftp_path: '' });
      }
    }
  }

  // Upsert all scanned games into DB
  for (const g of games) db.upsertGame(g);

  // Cross-reference with local backups and queue their Prospero fetches too
  const _ftpScanBps = store.get('backupPaths', null) || (store.get('backupPath', '') ? [store.get('backupPath', '')] : []);
  for (const bp of _ftpScanBps) {
    if (bp) {
      const { found } = await scanLocalBackups(bp);
      queueProsperoFetch(found);
    }
  }

  // Queue prospero metadata fetch for all FTP-discovered games
  queueProsperoFetch(games.map(g => g.game_id));

  ps5Notify('PS5 Scan Complete', `${games.length} game${games.length !== 1 ? 's' : ''} found`);
  return { games, count: games.length };
});

ipcMain.handle('ftp:list-dir', async (_e, { path }) => {
  return ftp.listDir(path || '/');
});

ipcMain.handle('ftp:find-game', async (_e, { game_id }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) return null;
  log.info(`[FTP] find-game: searching for ${game_id}`);
  const customPaths = (store.get('remoteGamePaths', []) || []).map(p => p.path).filter(Boolean);
  const scanPaths = customPaths.length
    ? customPaths
    : ['/mnt/sandbox/pfsmnt/', '/user/app/', '/mnt/data/app/'];
  for (const basePath of scanPaths) {
    const base = basePath.endsWith('/') ? basePath : basePath + '/';
    try {
      const list = await ftp.listDir(base);
      const match = list.find(f => f.isDir && f.name.startsWith(game_id));
      if (match) {
        log.info(`[FTP] find-game: found ${game_id} at ${base + match.name}`);
        return base + match.name;
      }
    } catch (e) {
      log.info(`[FTP] find-game: skipping ${base} — ${e.message}`);
    }
  }
  log.info(`[FTP] find-game: ${game_id} not found in any configured path`);
  return null;
});

ipcMain.handle('ftp:delete-game', async (_e, { game_id }) => {
  const game = db.getGame(game_id);
  if (!game?.ftp_path) throw new Error('No PS5 path stored for this game — cannot delete.');
  await ftp.removeDir(game.ftp_path);
  db.updateGame(game_id, { installed: 0, ftp_path: '' });
  log.info(`[FTP] Deleted game ${game_id} from PS5 at ${game.ftp_path}`);
  return { success: true };
});

// ── Transfer Queue Manager ────────────────────────────────────────────────────

const transferMgr = {
  jobs:          [],
  maxConcurrent: 1,
  paused:        false,
  nextId:        1,

  // Enqueue a transfer job. Returns a Promise that resolves/rejects when the
  // job actually completes (so IPC callers can still await results).
  enqueue(type, opts) {
    const job = {
      id:          this.nextId++,
      type,
      label:       opts.label       || `${type} ${opts.gameId || ''}`.trim(),
      gameId:      opts.gameId      || null,
      localPath:   opts.localPath   || null,
      remotePath:  opts.remotePath  || null,
      // pork-specific
      folderName:  opts.folderName  || null,
      folderPath:  opts.folderPath  || null,
      status:      'queued',
      progress:    { percent: 0, speedBps: 0, transferred: 0, total: 0, file: '', filesDone: 0, filesTotal: 0 },
      error:       null,
      addedAt:     Date.now(),
      startedAt:   null,
      completedAt: null,
      _resolve:    null,
      _reject:     null,
      _cancelled:  false,
    };

    const promise = new Promise((resolve, reject) => {
      job._resolve = resolve;
      job._reject  = reject;
    });

    this.jobs.push(job);
    this._notify();
    this._tick();
    return promise;
  },

  pause()  { this.paused = true;  this._notify(); },
  resume() { this.paused = false; this._tick(); this._notify(); },

  cancel(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return;
    job._cancelled = true;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job._reject?.(new Error('Cancelled'));
      this._notify();
    }
    // Active jobs check _cancelled in their progress loop; they'll abort shortly.
  },

  clearDone() {
    this.jobs = this.jobs.filter(j => j.status !== 'done' && j.status !== 'error' && j.status !== 'cancelled');
    this._notify();
  },

  setConcurrent(n) {
    this.maxConcurrent = Math.max(1, Math.min(15, n));
    this._tick();
    this._notify();
  },

  getState() {
    return {
      jobs: this.jobs.map(({ _resolve, _reject, _cancelled, ...rest }) => rest),
      maxConcurrent: this.maxConcurrent,
      paused:        this.paused,
      activeCount:   this.jobs.filter(j => j.status === 'active').length,
      queuedCount:   this.jobs.filter(j => j.status === 'queued').length,
    };
  },

  _notify() {
    win?.webContents.send('transfer:update', this.getState());
  },

  _tick() {
    if (this.paused) return;
    const activeCount = this.jobs.filter(j => j.status === 'active').length;
    const slots = this.maxConcurrent - activeCount;
    if (slots <= 0) return;
    const queued = this.jobs.filter(j => j.status === 'queued');
    for (let i = 0; i < Math.min(slots, queued.length); i++) {
      this._runJob(queued[i]);
    }
  },

  async _runJob(job) {
    job.status    = 'active';
    job.startedAt = Date.now();
    this._notify();

    // Determine whether to use the primary singleton or a fresh extra client.
    // Slot 0 (i.e. when primary is free): use ftp singleton directly.
    // Extra slots: create a dedicated client using stored creds.
    const activeJobs = this.jobs.filter(j => j.status === 'active');
    const usePrimary = activeJobs.length <= 1; // this job just became active, so ≤ 1

    let extraClient = null;
    let ftpClient; // object with uploadFile / uploadDirectory / downloadFile

    try {
      if (!usePrimary) {
        const creds = {
          host:     store.get('ftp.host', ''),
          port:     store.get('ftp.lastPort', store.get('ftp.port', '21')),
          user:     store.get('ftp.user', ''),
          password: store.get('ftp.pass', ''),
        };
        extraClient = await ftp.createClient(creds);
        ftpClient   = extraClient;
      } else {
        // Wrap singleton methods so callers use the same interface
        ftpClient = {
          uploadFile:      ftp.uploadFile.bind(ftp),
          uploadDirectory: ftp.uploadDirectory.bind(ftp),
          downloadFile:    ftp.downloadFile.bind(ftp),
        };
      }

      // Speed tracking
      let lastBytes = 0;
      let lastTime  = Date.now();
      const _notifiedMilestones = new Set();

      const trackProgress = (info) => {
        if (job._cancelled) return;
        const now  = Date.now();
        const dt   = (now - lastTime) / 1000;
        const bytesDone = info.bytesOverall || info.bytes || 0;

        if (dt >= 0.2) {
          job.progress.speedBps = Math.max(0, Math.round((bytesDone - lastBytes) / dt));
          lastBytes = bytesDone;
          lastTime  = now;
        }

        // Directory upload shape: { file, filesDone, filesTotal, bytes, bytesOverall, currentFileSize }
        if (info.filesTotal != null) {
          const filesDone  = info.filesDone  || 0;
          const filesTotal = info.filesTotal || 1;
          // Smooth %: blend completed files with the byte-fraction of the current in-flight file.
          // filesDone is 1-indexed (current file), so completed = filesDone - 1.
          const currentFileSize = info.currentFileSize || 0;
          const currentBytes    = info.bytes || 0;
          const fileFraction = currentFileSize > 0 ? Math.min(currentBytes / currentFileSize, 1) : 0;
          const smoothDone   = Math.max(0, filesDone - 1) + fileFraction;
          job.progress.percent    = Math.min(99, Math.round((smoothDone / filesTotal) * 100));
          job.progress.file       = info.file      || '';
          job.progress.filesDone  = filesDone;
          job.progress.filesTotal = filesTotal;
          job.progress.transferred = bytesDone;
          job.progress.currentBytes    = currentBytes;
          job.progress.currentFileSize = currentFileSize;
          // 25 / 50 / 75 % milestone notifications
          for (const m of [25, 50, 75]) {
            if (job.progress.percent >= m && !_notifiedMilestones.has(m)) {
              _notifiedMilestones.add(m);
              ps5Notify(`${job.label} \u2014 ${m}%`, `${filesDone} / ${filesTotal} files`);
            }
          }
        } else {
          // Single file shape: { bytes, bytesOverall, name, type, size }
          // bytesOverall is the cumulative total across the session; bytes is the
          // window delta. size is injected by _uploadFileWith via fs.statSync.
          const total = info.size || 0;
          const done  = info.bytesOverall || info.bytes || 0;
          job.progress.percent     = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
          job.progress.transferred = done;
          job.progress.total       = total;
        }
        this._notify();
      };

      let result;

      // Factory for extra file-worker FTP connections used inside _uploadDirectoryWith.
      const _ftpWorkerCreds = {
        host:     store.get('ftp.host', ''),
        port:     store.get('ftp.lastPort', store.get('ftp.port', '21')),
        user:     store.get('ftp.user', ''),
        password: store.get('ftp.pass', ''),
      };
      const _createWorkerClient = () => ftp.createRawClient(_ftpWorkerCreds);

      if (job.type === 'upload') {
        const stat = fs.statSync(job.localPath);
        if (stat.isDirectory()) {
          const uploadHooks = {
            onStart:     ({ count, totalBytes }) => {
              job.progress.totalBytes = totalBytes;
              ps5Notify(job.label, `${count} file${count !== 1 ? 's' : ''} \u00b7 ${fmtBytes(totalBytes)}`);
            },
            onRetry:     ({ rel, attempt, maxAttempts }) =>
              ps5Notify(`Retrying \u2014 ${job.label}`, `"${rel.split('/').pop()}" attempt ${attempt + 1}/${maxAttempts}`),
            onFileFailed: ({ rel, attempts }) =>
              ps5Notify(`Install Failed \u2014 ${job.label}`, `"${rel.split('/').pop()}" failed after ${attempts} attempts`),
            fileConcurrency:    transferMgr.maxConcurrent,
            _createWorkerClient,
          };
          await ftpClient.uploadDirectory(job.localPath, job.remotePath, info => {
            win?.webContents.send('ftp:upload:progress', info);
            trackProgress(info);
            if (job._cancelled) throw new Error('Cancelled');
          }, uploadHooks);
        } else {
          await ftpClient.uploadFile(job.localPath, job.remotePath, info => {
            win?.webContents.send('ftp:upload:progress', info);
            trackProgress(info);
            if (job._cancelled) throw new Error('Cancelled');
          });
        }
        result = { success: true };

      } else if (job.type === 'download') {
        await ftpClient.downloadFile(job.remotePath, job.localPath, info => {
          win?.webContents.send('ftp:download:progress', info);
          trackProgress(info);
          if (job._cancelled) throw new Error('Cancelled');
        });
        // Only update the DB for game-save backups (media downloads have no gameId)
        if (job.gameId) {
          const stat = fs.statSync(job.localPath);
          db.upsertBackup({
            game_id:     job.gameId,
            backup_path: job.localPath,
            size:        stat.size,
            backup_type: path.extname(job.localPath).slice(1) || 'dump',
          });
          db.updateGame(job.gameId, { backed_up: 1 });
        }
        result = { localPath: job.localPath };

      } else if (job.type === 'download-folder') {
        // Mirror a full game folder from PS5 → local backup directory.
        await ftpClient.downloadDirectory(job.remotePath, job.localPath, info => {
          win?.webContents.send('ftp:download:progress', info);
          trackProgress(info);
          if (job._cancelled) throw new Error('Cancelled');
        });
        const size = await dirSize(job.localPath);
        db.upsertBackup({
          game_id:     job.gameId,
          backup_path: job.localPath,
          size,
          backup_type: 'folder',
        });
        db.updateGame(job.gameId, { backed_up: 1 });
        result = { localPath: job.localPath };

      } else if (job.type === 'pork') {
        const subfolder = findGameSubfolder(job.folderPath, job.gameId);
        if (!subfolder) throw new Error(`No folder for ${job.gameId} found in ${job.folderPath}`);
        const localGameDir = path.join(job.folderPath, subfolder);
        const gameRow      = db.getGame(job.gameId);
        const remotePath   = gameRow?.ftp_path || `/mnt/sandbox/pfsmnt/${job.gameId}-app0`;

        const porkHooks = {
          onStart:     ({ count, totalBytes }) => {
            job.progress.totalBytes = totalBytes;
            ps5Notify(job.label, `${count} file${count !== 1 ? 's' : ''} \u00b7 ${fmtBytes(totalBytes)}`);
          },
          onRetry:     ({ rel, attempt, maxAttempts }) =>
            ps5Notify(`Retrying \u2014 ${job.label}`, `"${rel.split('/').pop()}" attempt ${attempt + 1}/${maxAttempts}`),
          onFileFailed: ({ rel, attempts }) =>
            ps5Notify(`Install Failed \u2014 ${job.label}`, `"${rel.split('/').pop()}" failed after ${attempts} attempts`),
          fileConcurrency:    transferMgr.maxConcurrent,
          _createWorkerClient,
        };
        await ftpClient.uploadDirectory(localGameDir, remotePath, info => {
          trackProgress(info);
          if (job._cancelled) throw new Error('Cancelled');
        }, porkHooks);

        db.setGamePorked(job.gameId, job.folderName);
        db.updateGame(job.gameId, { installed: 1 });
        result = { success: true, remotePath };
      }

      job.progress.percent = 100;
      job.status           = 'done';
      job.completedAt      = Date.now();
      job._resolve?.(result);
      log.info(`[Transfer] Job #${job.id} (${job.type}) done`);
      // Media downloads respect the per-media psNotify toggle; all others use the main setting.
      const isMediaDl = job.type === 'download' && job.label?.startsWith('Media:');
      if (!isMediaDl || store.get('media.psNotify.enabled', true)) {
        ps5Notify(job.label, 'Transfer complete');
      }

    } catch (e) {
      if (job._cancelled) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error  = e.message;
        log.error(`[Transfer] Job #${job.id} (${job.type}) error:`, e.message);
      }
      job._reject?.(e);
    } finally {
      extraClient?.close();
      job._resolve = null;
      job._reject  = null;
      this._notify();
      this._tick(); // start next queued job
    }
  },
};

// ── FTP Transfer IPC (via queue) ──────────────────────────────────────────────

ipcMain.handle('ftp:download', async (_e, { remotePath, game_id }) => {
  const _dlBps = store.get('backupPaths', null) || (store.get('backupPath', '') ? [store.get('backupPath', '')] : []);
  const bp = _dlBps[0] || '';
  if (!bp) throw new Error('No game source folder configured. Add one in Settings → Game Source Folders.');
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const filename  = path.basename(remotePath);
  const localPath = path.join(bp, game_id, filename);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  transferMgr.enqueue('download', {
    label:      `Download ${game_id}/${filename}`,
    gameId:     game_id,
    localPath,
    remotePath,
  }).catch(e => log.warn(`[Transfer] Download ${game_id} failed: ${e.message}`));
  return { success: true };
});

ipcMain.handle('ftp:upload', async (_e, { localPath, remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const label = path.basename(localPath);
  transferMgr.enqueue('upload', {
    label:      `Upload ${label}`,
    localPath,
    remotePath,
  }).catch(e => log.warn(`[Transfer] Upload ${label} failed: ${e.message}`));
  return { success: true };
});

ipcMain.handle('ftp:download-folder', async (_e, { game_id }) => {
  const _dlFolderBps = store.get('backupPaths', null) || (store.get('backupPath', '') ? [store.get('backupPath', '')] : []);
  const bp = _dlFolderBps[0] || '';
  if (!bp) throw new Error('No game source folder configured. Add one in Settings → Game Source Folders.');
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const game = db.getGame(game_id);
  if (!game?.ftp_path) throw new Error('No PS5 path stored for this game. Run a scan first.');

  // Preserve the remote folder name (e.g. PPSA12345-app0) so the backup scanner picks it up.
  const folderName = game.ftp_path.split('/').filter(Boolean).pop();
  const localPath  = path.join(bp, folderName);

  transferMgr.enqueue('download-folder', {
    label:      `Backup ${game_id} \u2190 PS5`,
    gameId:     game_id,
    localPath,
    remotePath: game.ftp_path,
  }).catch(e => log.warn(`[Transfer] Download-folder ${game_id} failed: ${e.message}`));
  return { success: true };
});

// ── App privilege helpers ────────────────────────────────────────────────────
// Check whether the current process has an elevated (Administrator) token.
// Uses base64-encoded PS command to avoid cmd.exe quoting issues and runs
// asynchronously so it never blocks the IPC thread.
ipcMain.handle('app:is-admin', () => {
  if (process.platform !== 'win32') return true;
  return new Promise((resolve) => {
    // Encode the PS expression in UTF-16LE so cmd.exe never sees the brackets
    const encodedCmd = Buffer.from(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      'utf16le'
    ).toString('base64');
    require('child_process').exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encodedCmd}`,
      { timeout: 6000 },
      (err, stdout) => resolve(!err && stdout.trim() === 'True')
    );
  });
});

// ── Database ──────────────────────────────────────────────────────────────────
ipcMain.handle('db:games:list',     (_e, filter)             => db.listGames(filter));
ipcMain.handle('db:games:update',   (_e, { game_id, fields }) => db.updateGame(game_id, fields));
ipcMain.handle('db:backups:list',   (_e, game_id)            => db.listBackups(game_id));
ipcMain.handle('db:backups:delete', (_e, { id })             => { db.deleteBackup(id); return { success: true }; });
ipcMain.handle('db:backups:upsert', async (_e, { game_id, backup_path }) => {
  if (!game_id || !backup_path) throw new Error('game_id and backup_path are required');
  let stat;
  try { stat = await fs.promises.stat(backup_path); } catch (_) { throw new Error(`Path not found: ${backup_path}`); }
  const size = stat.isDirectory() ? await dirSize(backup_path) : stat.size;
  const backup_type = stat.isDirectory() ? 'folder' : (path.extname(backup_path).slice(1) || 'pkg');
  db.upsertGameMinimal(game_id);
  db.upsertBackup({ game_id, backup_path, size, backup_type, source: 'local' });
  db.updateGame(game_id, { backed_up: 1 });
  return { success: true };
});
ipcMain.handle('db:stats',          ()                       => db.getStats());
ipcMain.handle('db:query',          (_e, { sql })            => db.runQuery(sql));
ipcMain.handle('db:clear',          ()                       => { db.clearAll();   return { success: true }; });
ipcMain.handle('db:clear-selective', (_e, opts)               => { db.clearSelective(opts); return { success: true }; });
ipcMain.handle('db:delete-rows',    (_e, { table, ids })     => ({ deleted: db.deleteRows(table, ids) }));
ipcMain.handle('db:clear-hashes',   ()                       => { db.clearHashes(); return { success: true }; });

ipcMain.handle('db:export:sql', async () => {
  const { filePath } = await dialog.showSaveDialog(win, {
    title: 'Export DB as SQL',
    defaultPath: `porkfolio_${Date.now()}.sql`,
    filters: [{ name: 'SQL', extensions: ['sql'] }],
  });
  if (!filePath) return null;
  fs.writeFileSync(filePath, db.exportSql(), 'utf8');
  return filePath;
});

ipcMain.handle('db:export:csv', async (_e, { table }) => {
  const { filePath } = await dialog.showSaveDialog(win, {
    title: `Export ${table} as CSV`,
    defaultPath: `porkfolio_${table}_${Date.now()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return null;
  fs.writeFileSync(filePath, db.exportCsv(table), 'utf8');
  return filePath;
});

// ── Byte formatter (used by transfer notifications) ─────────────────────────
function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576)    return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024)       return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// ── Shared directory-size helper ──────────────────────────────────────────────
// Sequential async walk — non-blocking and avoids EMFILE from concurrent handles.
// Aborts after TIMEOUT_MS and returns whatever total was accumulated so far,
// so games with hundreds of thousands of files don't stall the scanner forever.
const DIR_SIZE_TIMEOUT_MS = 5000; // 5 s max per folder
async function dirSize(dir, _deadline) {
  const deadline = _deadline ?? (Date.now() + DIR_SIZE_TIMEOUT_MS);
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (Date.now() >= deadline) break; // time budget exhausted — return partial size
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += await dirSize(p, deadline);
      } else {
        try { total += (await fs.promises.stat(p)).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return total;
}

// ── Local backup scanner ──────────────────────────────────────────────────────
// Returns { found: string[], newIds: string[] } so callers can report and queue Prospero.
// Async so file-system I/O doesn't block the main thread / UI.
const ARCHIVE_EXTS = new Set(['.rar', '.zip', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.001', '.002', '.003']);
async function scanLocalBackups(backupPath) {
  if (!fs.existsSync(backupPath)) return { found: [], newIds: [] };

  db.beginBulkUpdate();
  try {
    db.purgeArchiveBackups();

    const beforeIds      = new Set(db.listGames().map(g => g.game_id));
    const foundIds       = new Set();
    const backupsAtStart = db.listBackups();
    const knownSizes     = new Map(backupsAtStart.map(b => [b.backup_path, b.size]));
    const yield_         = () => new Promise(r => setImmediate(r));

    try {
      const entries = await fs.promises.readdir(backupPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(backupPath, entry.name);
        try {
          if (entry.isDirectory()) {
            const m = entry.name.match(/([A-Z]{4}\d{5})/);
            if (m) {
              const game_id = m[1];
              const size = knownSizes.has(full) ? knownSizes.get(full) : await dirSize(full);
              db.upsertGameMinimal(game_id);
              db.upsertBackup({ game_id, backup_path: full, size, backup_type: 'folder' });
              db.updateGame(game_id, { backed_up: 1 });
              foundIds.add(game_id);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (ARCHIVE_EXTS.has(ext)) continue;
            const m = entry.name.match(/([A-Z]{4}\d{5})/);
            if (m) {
              const game_id = m[1];
              let size;
              if (knownSizes.has(full)) {
                size = knownSizes.get(full);
              } else {
                try { size = (await fs.promises.stat(full)).size; } catch (_) { continue; }
              }
              db.upsertGameMinimal(game_id);
              const extType = ext.slice(1) || 'pkg';
              db.upsertBackup({ game_id, backup_path: full, size, backup_type: extType });
              db.updateGame(game_id, { backed_up: 1 });
              foundIds.add(game_id);
            }
          }
        } catch (entryErr) {
          log.warn(`[LocalScan] Skipped entry "${entry.name}": ${entryErr.message}`);
        }
        await yield_(); // let event loop breathe between each game entry
      }
    } catch (e) {
      log.error('[LocalScan]', e.message);
    }

    // Prune stale local backup entries whose path falls under this source folder
    // but no longer exist on disk. Use existsSync (same as original) — fs.promises.access
    // can throw for network errors / permission issues and would falsely delete valid backups.
    const rootPrefix = backupPath.replace(/[\\/]+$/, '').toLowerCase() + path.sep;
    let removedCount = 0;
    for (const b of backupsAtStart) {
      if (b.source === 'backpork') continue;
      if (!b.backup_path.toLowerCase().startsWith(rootPrefix)) continue;
      if (!fs.existsSync(b.backup_path)) {
        db.deleteBackup(b.id);
        log.info(`[LocalScan] Removed stale backup: ${b.backup_path}`);
        removedCount++;
      }
      await yield_();
    }
    db.syncBackedUpFlags();
    db.pruneOrphanScanGames();

    const found  = [...foundIds];
    const newIds = found.filter(id => !beforeIds.has(id));
    log.info(`[LocalScan] ${found.length} game(s) found, ${newIds.length} new${removedCount ? `, ${removedCount} stale removed` : ''}`);
    return { found, newIds };
  } finally {
    db.endBulkUpdate();
  }
}

ipcMain.handle('local:scan-backups', async () => {
  const scanBps = store.get('backupPaths', null) || (store.get('backupPath', '') ? [store.get('backupPath', '')] : []);
  if (!scanBps.length) throw new Error('No game source folders configured. Add one in Settings \u2192 Game Source Folders.');
  let allFound = [], allNewIds = [];
  for (const bp of scanBps) {
    if (!bp) continue;
    const { found, newIds } = await scanLocalBackups(bp);
    allFound   = [...allFound,   ...found];
    allNewIds  = [...allNewIds,  ...newIds];
  }
  const uniqueFound  = [...new Set(allFound)];
  const uniqueNewIds = [...new Set(allNewIds)];
  queueProsperoFetch(uniqueFound);
  return { success: true, total: uniqueFound.length, added: uniqueNewIds.length };
});

// ── Prospero force-fetch (renderer can request a specific game) ───────────────
ipcMain.handle('prospero:fetch', async (_e, { game_id }) => {
  try {
    const data = await prospero.fetchGameMetadata(game_id);
    db.updateProsperoData(game_id, data);
    win?.webContents.send('prospero:updated', { game_id, data });
    return { success: true, data };
  } catch (e) {
    log.error(`[Prospero] Force-fetch failed for ${game_id}:`, e.message);
    throw e;
  }
});

// ── Lightweight icon-only fetch for cheats page (no DB write required) ───────
ipcMain.handle('prospero:fetch-icon', async (_e, { game_id }) => {
  try {
    // Return cached icon if already in DB
    const existing = db.getGame(game_id);
    if (existing?.prospero_icon_url) return { iconUrl: existing.prospero_icon_url };
    // Fetch just the game page (skips patches/DLC/regions)
    const page = await prospero.fetchPageMetadata(game_id);
    // Persist to DB if game exists there
    if (existing && page.iconUrl) db.updateProsperoData(game_id, {
      name: page.name || '', description: '', region: page.region || '',
      contentId: page.contentId || '', publisher: page.publisher || '',
      publisherId: page.publisherId || '', iconUrl: page.iconUrl,
      bannerUrl: page.bannerUrl || '', cdnHash: page.cdnHash || '',
      lastUpdated: '', patchCount: 0, patches: [], additionalContent: [],
      otherRegions: [], fetchedAt: Date.now(),
    });
    return { iconUrl: page.iconUrl || '' };
  } catch (_) {
    return { iconUrl: '' };
  }
});

// ── Prospero refresh-all (force re-fetch every game) ─────────────────────────
ipcMain.handle('prospero:refresh-all', async () => {
  const gameIds = db.resetAllProsperoFetchedAt();
  log.info(`[Prospero] Refresh-all queued — ${gameIds.length} game(s)`);
  queueProsperoFetch(gameIds);
  return { queued: gameIds.length };
});

// ── Backpork folder scanner ───────────────────────────────────────────────────
async function scanBackporkFolder(folderPath, folderName) {
  const found      = [];
  const yield_     = () => new Promise(r => setImmediate(r));
  const rootPrefix = folderPath.replace(/[\\/]+$/, '').toLowerCase() + path.sep;

  db.beginBulkUpdate();
  try {
    const backupsAtStart = db.listBackups().filter(
      b => b.source === 'backpork' && b.backup_path.toLowerCase().startsWith(rootPrefix)
    );

    try {
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const m = entry.name.match(/([A-Z]{4}\d{5})/i);
        if (!m) continue;
        const game_id = m[1].toUpperCase();
        const gameDir = path.join(folderPath, entry.name);
        try {
          db.upsertGameMinimal(game_id);
          db.setGameFirmwareLabel(game_id, folderName);
          db.upsertBackup({ game_id, backup_path: gameDir, size: await dirSize(gameDir), backup_type: 'folder', source: 'backpork' });
          db.updateGame(game_id, { backed_up: 1 });
          found.push(game_id);
        } catch (entryErr) {
          log.warn(`[Backporks] Skipped entry "${entry.name}": ${entryErr.message}`);
        }
        await yield_(); // yield between each game so UI stays responsive
      }
    } catch (e) {
      log.error('[Backporks] Scan error:', e.message);
    }

    let removedCount = 0;
    for (const b of backupsAtStart) {
      if (!fs.existsSync(b.backup_path)) {
        db.deleteBackup(b.id);
        log.info(`[Backporks] Removed stale backup: ${b.backup_path}`);
        removedCount++;
      }
      await yield_();
    }
    if (removedCount > 0) {
      db.syncBackedUpFlags();
      log.info(`[Backporks] Pruned ${removedCount} stale backup(s) from "${folderName}"`);
    }
    const foundSet = new Set(found);
    db.pruneGameFirmwareForFolder(folderName, foundSet);
    db.pruneOrphanScanGames();

    log.info(`[Backporks] "${folderName}" — found ${found.length} game(s)`);
    return found;
  } finally {
    db.endBulkUpdate();
  }
}

function isFirmwareFolderName(name) {
  return /^\d+(?:\.(?:\d+|xx)){1,2}$/i.test(String(name || '').trim());
}

ipcMain.handle('backporks:list', () => db.listBackporkFolders());

ipcMain.handle('backporks:add', async (_e, { name, path: folderPath }) => {
  db.addBackporkFolder(name, folderPath);
  const found = await scanBackporkFolder(folderPath, name);
  queueProsperoFetch(found);
  return { success: true, count: found.length };
});

ipcMain.handle('backporks:create-folder', (_e, { name, parentPath }) => {
  if (!/^\d+\.\d+\.\d+$/.test(name)) throw new Error('Firmware version must follow x.x.x format (e.g. 11.50.0)');
  const folderPath = path.join(parentPath, name);
  fs.mkdirSync(folderPath, { recursive: true });
  db.addBackporkFolder(name, folderPath);
  return { success: true, path: folderPath };
});

ipcMain.handle('backporks:remove', (_e, { id }) => {
  // Look up the folder path before removing so we can clean up its backup rows
  const folders = db.listBackporkFolders();
  const folder  = folders.find(f => f.id === id);
  db.removeBackporkFolder(id);
  if (folder) {
    // Delete all backpork backup entries whose path falls under this folder
    const rootPrefix = folder.path.replace(/[\\/]+$/, '').toLowerCase() + path.sep;
    const allBackups = db.listBackups();
    for (const b of allBackups) {
      if (b.source === 'backpork' && b.backup_path.toLowerCase().startsWith(rootPrefix)) {
        db.deleteBackup(b.id);
      }
    }
    db.syncBackedUpFlags();
    db.pruneOrphanScanGames();
  }
  return { success: true };
});

ipcMain.handle('backporks:scan', async (_e, { id }) => {
  const folders = db.listBackporkFolders();
  const folder  = folders.find(f => f.id === id);
  if (!folder) throw new Error('Backpork folder not found');
  const found = await scanBackporkFolder(folder.path, folder.name);
  queueProsperoFetch(found);
  return { success: true, count: found.length };
});

ipcMain.handle('backporks:add-root', async (_e, { rootPath }) => {
  if (!fs.existsSync(rootPath)) throw new Error('Selected folder does not exist.');

  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory() && isFirmwareFolderName(e.name));

  if (!subdirs.length) throw new Error('No firmware-style subfolders found. Expected folders like 4.xx, 7.xx, or 11.50.0.');

  let totalGames = 0;
  const allFound = [];

  for (const subdir of subdirs) {
    const name       = subdir.name;
    const folderPath = path.join(rootPath, name);
    db.addBackporkFolder(name, folderPath);
    const found = await scanBackporkFolder(folderPath, name);
    totalGames += found.length;
    allFound.push(...found);
  }

  queueProsperoFetch(allFound);
  log.info(`[Backporks] Root scan: ${subdirs.length} firmware folder(s), ${totalGames} game(s) total`);
  return { success: true, folders: subdirs.length, count: totalGames };
});

ipcMain.handle('backporks:scan-all', async () => {
  const folders = db.listBackporkFolders();
  let total = 0;
  const allFound = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder.path)) continue;
    const found = await scanBackporkFolder(folder.path, folder.name);
    total += found.length;
    allFound.push(...found);
  }
  queueProsperoFetch(allFound);
  const uniqueGames = new Set(allFound).size;
  log.info(`[Backporks] Scan-all: ${folders.length} firmware folder(s), ${total} build(s) across ${uniqueGames} unique game(s)`);
  return { success: true, folders: folders.length, count: total, uniqueGames };
});

ipcMain.handle('db:firmware:labels',    ()               => db.listFirmwareLabels());
ipcMain.handle('backporks:games',       (_e, { folder }) => db.listGamesForFolder(folder));
ipcMain.handle('backporks:entries',     (_e, { game_id })=> db.getGameBackporkEntries(game_id));

// Find the game's subfolder within a firmware folder path
function findGameSubfolder(folderPath, game_id) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Match the game ID anywhere in the folder name so long descriptive names
      // like "PPSA04341 – EUR Avatar Backport 5XX By BADERLINK" are found.
      const m = entry.name.match(/([A-Z]{4}\d{5})/i);
      if (m && m[1].toUpperCase() === game_id.toUpperCase()) return entry.name;
    }
  } catch (_) {}
  return null;
}

ipcMain.handle('backporks:pork', async (_e, { game_id, folder_name, folder_path }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const p = transferMgr.enqueue('pork', {
    label:      `Pork ${game_id} (${folder_name})`,
    gameId:     game_id,
    folderName: folder_name,
    folderPath: folder_path,
  });
  // Job was just pushed — its id is available synchronously
  const jobId = transferMgr.jobs[transferMgr.jobs.length - 1].id;
  p.catch(e => log.warn(`[Transfer] Pork ${game_id} failed: ${e.message}`));
  return { success: true, jobId };
});

// PFS install: upload the game folder then — only after the upload completes —
// enqueue the pork (patch) step. Both steps go through the transfer queue so
// they appear in the Transfers tab with progress.
ipcMain.handle('ftp:install-pfs', async (_e, { game_id, localPath, remotePath, pork }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const label = path.basename(localPath);
  const uploadPromise = transferMgr.enqueue('upload', {
    label:      `Install ${label}`,
    localPath,
    remotePath,
  });

  if (pork) {
    // Chain the pork job: it only enters the queue once the upload job resolves.
    uploadPromise
      .then(() => {
        transferMgr.enqueue('pork', {
          label:      `Pork ${game_id} (${pork.folder_name})`,
          gameId:     game_id,
          folderName: pork.folder_name,
          folderPath: pork.folder_path,
        }).catch(e => log.warn(`[Transfer] Pork ${game_id} failed: ${e.message}`));
      })
      .catch(e => log.warn(`[Transfer] PFS install ${game_id} upload failed — skipping pork: ${e.message}`));
  } else {
    uploadPromise.catch(e => log.warn(`[Transfer] PFS install ${label} failed: ${e.message}`));
  }

  return { success: true };
});

// ── Transfer Manager IPC ──────────────────────────────────────────────────────

ipcMain.handle('transfer:state',       ()           => transferMgr.getState());
ipcMain.handle('transfer:pause',       ()           => { transferMgr.pause();          return { success: true }; });
ipcMain.handle('transfer:resume',      ()           => { transferMgr.resume();         return { success: true }; });
ipcMain.handle('transfer:cancel',      (_e, { id }) => { transferMgr.cancel(id);       return { success: true }; });
ipcMain.handle('transfer:clear-done',  ()           => { transferMgr.clearDone();      return { success: true }; });
ipcMain.handle('transfer:set-concurrent', (_e, { n }) => { transferMgr.setConcurrent(n); return { success: true }; });

// ── Dialog / shell ────────────────────────────────────────────────────────────
ipcMain.handle('dialog:select-folder', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select Folder',
    properties: ['openDirectory'],
  });
  return filePaths?.[0] || null;
});

// ── Helper: recursively collect all files in a directory ────────────────────
function collectFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectFiles(p));
    else out.push(p);
  }
  return out;
}

// ── Hash verification ─────────────────────────────────────────────────────────
ipcMain.handle('hash:status', (_e, { game_id }) => {
  const localHashes      = db.getGameHashes(game_id);
  const communityMatches = localHashes
    .filter(h => communityHashMap.has(h.file_hash))
    .map(h => ({ ...h, communityEntry: communityHashMap.get(h.file_hash) }));
  // Mismatch: community has verified hashes for this game but none of ours match
  const communityForGame  = communityGameIndex.get(game_id) || new Set();
  const communityMismatch = communityForGame.size > 0 && communityMatches.length === 0 && localHashes.length > 0;
  return { localHashes, communityMatches, communityMismatch };
});

ipcMain.handle('hash:compute', async (_e, { backup_path, game_id }) => {
  if (!fs.existsSync(backup_path)) throw new Error('Path not found: ' + backup_path);

  const stat = fs.statSync(backup_path);

  if (stat.isDirectory()) {
    const files      = collectFiles(backup_path);
    const fileSizes  = files.map(fp => { try { return fs.statSync(fp).size; } catch { return 0; } });
    const totalBytes = fileSizes.reduce((a, b) => a + b, 0);
    const hashes     = new Array(files.length);

    // Track bytes across all concurrent workers for overall progress.
    // Node.js is single-threaded so the delta-update is race-free.
    const fileProgress = new Array(files.length).fill(0);
    let   globalBytes  = 0;
    let   lastPctSent  = -1;
    function sendProgress(pct) {
      if (pct !== lastPctSent) { lastPctSent = pct; win?.webContents.send('hash:progress', { percent: pct }); }
    }

    let nextIdx = 0;
    async function hashWorker() {
      while (nextIdx < files.length) {
        const i  = nextIdx++;
        const fp = files[i];
        const file_hash = await hashFile(fp, ({ bytesRead }) => {
          globalBytes        += bytesRead - fileProgress[i];
          fileProgress[i]     = bytesRead;
          sendProgress(Math.min(Math.round(globalBytes / (totalBytes || 1) * 100), 99));
        });
        globalBytes    += fileSizes[i] - fileProgress[i];
        fileProgress[i] = fileSizes[i];
        hashes[i] = { backup_path: fp, file_hash, file_size: fileSizes[i] };
      }
    }

    const CONCURRENCY = Math.min(store.get('hash.concurrency', 8), files.length || 1);
    await Promise.all(Array.from({ length: CONCURRENCY }, hashWorker));
    sendProgress(100);
    log.info(`[Hashes] Hashed ${hashes.length} file(s) for ${game_id}`);
    return { hashes };
  }

  // Single file
  const file_hash = await hashFile(backup_path, progress => {
    win?.webContents.send('hash:progress', progress);
  });
  const file_size = stat.size;
  log.info(`[Hashes] Computed hash for ${game_id}: ${file_hash.slice(0, 12)}…`);
  return { hashes: [{ backup_path, file_hash, file_size }] };
});

ipcMain.handle('hash:add', (_e, { game_id, file_hash, file_size, backup_path, hash_type = 'game', verified }) => {
  const firmware_label = hash_type === 'backpork' ? (db.getBackporkFirmwareLabel(backup_path) ?? null) : null;
  db.addGameHash({ game_id, file_hash, file_size, backup_path, hash_type, firmware_label, verified });
  const communityMatch = communityHashMap.get(file_hash) || null;
  log.info(`[Hashes] Saved hash for ${game_id} (${hash_type})${firmware_label ? ' [' + firmware_label + ']' : ''}${communityMatch ? ' — community match!' : ''}`);
  return { success: true, communityMatch };
});

ipcMain.handle('hash:export', async () => {
  const { filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Hash Database',
    defaultPath: `porkfolio_hashes_${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return null;
  const hashes = db.exportAllHashes();
  const out    = { version: 1, updated: new Date().toISOString().split('T')[0], hashes };
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');
  log.info(`[Hashes] Exported ${hashes.length} hash(es) to ${filePath}`);
  return filePath;
});

// Batch-hash all backups of a given source type ('local' | 'backpork' | 'all').
ipcMain.handle('hash:bulk', async (_e, { source = 'all' } = {}) => {
  const yield_ = () => new Promise(r => setImmediate(r)); // lets event loop breathe so IPC events deliver
  const allBackups = db.listBackups();
  const targets    = source === 'all' ? allBackups : allBackups.filter(b => b.source === source);
  const total = targets.length;
  let done = 0;
  let totalFilesHashed = 0;
  let totalBytesHashed = 0;
  const results = [];

  const send = (payload) => win?.webContents.send('hash:bulk:progress', payload);

  for (const backup of targets) {
    const bp = backup.backup_path;
    try {
      if (!fs.existsSync(bp)) throw new Error('Path not found');
      const stat  = fs.statSync(bp);
      const files = stat.isDirectory() ? collectFiles(bp) : [bp];

      send({
        phase: 'backup-start',
        done, total, percent: Math.round(done / (total || 1) * 100),
        gameId: backup.game_id,
        fileCount: files.length, totalFilesHashed, totalBytesHashed,
      });
      await yield_();

      // Hash up to CONCURRENCY files in parallel within this backup.
      const HASH_CONCURRENCY = Math.min(store.get('hash.concurrency', 8), files.length || 1);
      const fileSizes  = files.map(fp => { try { return fs.statSync(fp).size; } catch { return 0; } });
      const fileHashes = new Array(files.length);
      let   bulkNextIdx = 0;

      async function bulkWorker() {
        while (bulkNextIdx < files.length) {
          const i  = bulkNextIdx++;
          const fp = files[i];
          fileHashes[i] = await hashFile(fp);
        }
      }
      await Promise.all(Array.from({ length: HASH_CONCURRENCY }, bulkWorker));

      // Commit results to DB and accumulate counters
      const hash_type = backup.source === 'backpork' ? 'backpork' : 'game';
      for (let i = 0; i < files.length; i++) {
        const fp             = files[i];
        const file_hash      = fileHashes[i];
        const file_size      = fileSizes[i];
        const firmware_label = hash_type === 'backpork' ? (db.getBackporkFirmwareLabel(fp) ?? null) : null;
        db.addGameHash({ game_id: backup.game_id, file_hash, file_size, backup_path: fp, hash_type, firmware_label, verified: 1 });
        totalFilesHashed++;
        totalBytesHashed += file_size;
      }

      send({
        phase: 'file-progress',
        done, total, percent: Math.round(done / (total || 1) * 100),
        gameId: backup.game_id, currentFile: null, filePct: 100,
        totalFilesHashed, totalBytesHashed,
      });
      await yield_();
      results.push({ game_id: backup.game_id, ok: true, count: files.length });
    } catch (e) {
      log.warn(`[Hash:bulk] ${backup.game_id} — ${e.message}`);
      results.push({ game_id: backup.game_id, ok: false, error: e.message });
    }

    done++;
    send({
      phase: 'backup-done',
      done, total, percent: Math.round(done / (total || 1) * 100),
      gameId: backup.game_id, currentFile: null, filePct: 100,
      totalFilesHashed, totalBytesHashed,
    });
    await yield_();
  }
  return { results, total, totalFilesHashed, totalBytesHashed };
});

// Import an external community hash list JSON; persists to userData and reloads into memory.
ipcMain.handle('hash:import-community', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Community Hash List',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (!filePaths?.length) return null;
  const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  if (!Array.isArray(raw.hashes)) throw new Error('Invalid format \u2014 expected { hashes: [...] }');
  loadCommunityHashes(raw.hashes);
  _communityHashMeta = { version: raw.version || 1, updated: raw.updated || null, source: 'imported' };
  const userHashPath = path.join(app.getPath('userData'), 'community-hashes.json');
  fs.writeFileSync(userHashPath, JSON.stringify(raw, null, 2), 'utf8');
  log.info(`[Hashes] Imported ${communityHashMap.size} community hash(es)`);
  return { count: communityHashMap.size, version: raw.version, updated: raw.updated };
});

// Return stats about the loaded community hash list and the user's local hashes.
ipcMain.handle('hash:community-info', () => ({
  ..._communityHashMeta,
  count:      communityHashMap.size,
  localCount: db.getHashCount(),
}));

// Return per-game hash summary (hash count + community verification status) for all hashed games.
// Results are grouped by (game_id, hash_type, firmware_label) so game and backpork hashes appear separately.
ipcMain.handle('hash:game-summary', () => {
  const allHashes = db.getAllGameHashes();
  const byKey     = new Map(); // composite key → { game_id, hash_type, firmware_label, hashes[] }
  for (const h of allHashes) {
    const ht  = h.hash_type      || 'game';
    const fw  = h.firmware_label || null;
    const key = `${h.game_id}|${ht}|${fw || ''}`;
    if (!byKey.has(key)) byKey.set(key, { game_id: h.game_id, hash_type: ht, firmware_label: fw, hashes: [] });
    byKey.get(key).hashes.push(h.file_hash);
  }
  const out = [];
  for (const [, entry] of byKey) {
    const { game_id, hash_type, firmware_label, hashes } = entry;
    const communityHits    = hashes.filter(h => communityHashMap.has(h));
    const communityMismatch = communityGameIndex.has(game_id) && communityHits.length === 0;
    out.push({
      game_id, hash_type, firmware_label,
      hash_count:         hashes.length,
      community_matches:  communityHits.length,
      community_mismatch: communityMismatch,
    });
  }
  return out;
});

ipcMain.handle('shell:open', (_e, { target }) => {
  if (/^https?:\/\//i.test(target)) shell.openExternal(target);
  else if (fs.existsSync(target)) shell.openPath(target);
});

// ── Payload Manager IPC ───────────────────────────────────────────────────────

ipcMain.handle('payload:sources:list', () => db.listPayloadSources());

ipcMain.handle('payload:sources:add', (_e, { name, url }) => {
  // Normalize: prepend https:// if bare domain entered
  const normalised = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  // For GitHub repo URLs, validate the owner/repo portion
  if (/github\.com\//.test(normalised)) github.parseGitHubUrl(normalised);
  else {
    try { new URL(normalised); } catch { throw new Error(`"${url}" is not a valid URL`); }
  }
  db.addPayloadSource({ name, github_url: normalised });
  return db.listPayloadSources();
});

ipcMain.handle('payload:sources:remove', (_e, { id }) => {
  db.removePayloadSource(id);
  return { success: true };
});

ipcMain.handle('payload:sources:toggle', (_e, { id }) => {
  db.togglePayloadSource(id);
  return { success: true };
});

ipcMain.handle('payload:check-updates', async (_e, { id } = {}) => {
  const sources = id
    ? db.listPayloadSources().filter(s => s.id === id && s.enabled)
    : db.listPayloadSources().filter(s => s.enabled);

  const results = [];
  const localDir = store.get('payload.localPath', '');

  for (const source of sources) {
    try {
      win?.webContents.send('payload:check:progress', { source_id: source.id, status: 'checking' });
      const release  = await github.fetchLatestRelease(source.github_url);
      const hashMap  = await github.fetchChecksums(release.assets);

      // Filter to valid payload extensions only; also exclude checksum files.
      const assets = release.assets.filter(a =>
        /\.(bin|elf|js)$/i.test(a.name) &&
        !/sha256|checksums|sha2|sums/i.test(a.name)
      );

      // 1. Upsert remote asset records (with remote_hash from checksum file if available)
      for (const asset of assets) {
        const remoteHash = hashMap.get(asset.name) || null;
        db.upsertPayloadFile({
          source_id:   source.id,
          asset_name:  asset.name,
          asset_url:   asset.url,
          remote_hash: remoteHash,
          version:     release.tag,
        });
        if (remoteHash) {
          log.info(`[Payload] Remote SHA256 for ${asset.name}: ${remoteHash}`);
        } else {
          log.info(`[Payload] Remote SHA256 for ${asset.name}: <no checksum file in release>`);
        }
      }

      // 2. Hash any local copies that are present on disk but have no local_hash in DB yet.
      //    This covers: files downloaded via app where hashing was skipped, AND manually placed files.
      if (localDir) {
        for (const asset of assets) {
          const localPath = path.join(localDir, asset.name);
          if (!fs.existsSync(localPath)) continue;
          const row = db.getPayloadFiles(source.id).find(f => f.asset_name === asset.name);
          if (row?.local_hash) continue; // already hashed
          try {
            log.info(`[Payload] Hashing local copy of ${asset.name}…`);
            const local_hash = await hashFile(localPath, () => {});
            const local_size = fs.statSync(localPath).size;
            db.updatePayloadFileLocal({
              source_id: source.id, asset_name: asset.name,
              local_path: localPath, local_hash, local_size,
              version: row?.version || release.tag,
            });
            log.info(`[Payload] Local SHA256 for ${asset.name}: ${local_hash}`);
          } catch (hashErr) {
            log.warn(`[Payload] Could not hash local ${asset.name}: ${hashErr.message}`);
          }
        }
      }

      // 3. Log hash comparison summary for every asset
      const updatedFiles = db.getPayloadFiles(source.id);
      for (const asset of assets) {
        const row = updatedFiles.find(f => f.asset_name === asset.name);
        const r = row?.remote_hash || null;
        const l = row?.local_hash  || null;
        if (r && l) {
          const status = r === l ? 'UP TO DATE' : 'UPDATE AVAILABLE';
          log.info(`[Payload] ${asset.name}: remote=${r.slice(0, 12)}… local=${l.slice(0, 12)}… → ${status}`);
        } else if (r && !l) {
          log.info(`[Payload] ${asset.name}: remote=${r.slice(0, 12)}… local=<not downloaded>`);
        } else if (!r && l) {
          log.info(`[Payload] ${asset.name}: remote=<no checksum> local=${l.slice(0, 12)}…`);
        } else {
          log.info(`[Payload] ${asset.name}: no hashes available yet`);
        }
      }

      db.updatePayloadSourceChecked(source.id, release.tag);
      const files = db.getPayloadFiles(source.id);
      results.push({ source: { ...source, latest_tag: release.tag }, files });
      win?.webContents.send('payload:check:progress', { source_id: source.id, status: 'done', tag: release.tag });
      log.info(`[Payload] Checked ${source.name} — tag: ${release.tag}, assets: ${assets.length}`);
    } catch (e) {
      log.warn(`[Payload] Check failed for ${source.name}: ${e.message}`);
      win?.webContents.send('payload:check:progress', { source_id: source.id, status: 'error', error: e.message });
      results.push({ source, files: db.getPayloadFiles(source.id), error: e.message });
    }
  }

  return results;
});

ipcMain.handle('payload:download', async (_e, { source_id, asset_name, asset_url, version }) => {
  const localDir = store.get('payload.localPath', '');
  if (!localDir) throw new Error('No payload local folder configured. Set one in Settings first.');

  const localPath = path.join(localDir, asset_name);
  log.info(`[Payload] Downloading ${asset_name} to ${localPath}`);

  await github.downloadAsset(asset_url, localPath, info => {
    win?.webContents.send('payload:download:progress', { asset_name, ...info });
  });

  const stat      = fs.statSync(localPath);
  const local_hash = await hashFile(localPath, prog => {
    win?.webContents.send('payload:hash:progress', { asset_name, ...prog });
  });

  db.updatePayloadFileLocal({ source_id, asset_name, local_path: localPath, local_hash, local_size: stat.size, version });
  log.info(`[Payload] Downloaded ${asset_name} — hash: ${local_hash.slice(0, 12)}…`);
  return { localPath, local_hash };
});

ipcMain.handle('payload:list-local', async () => {
  const localDir = store.get('payload.localPath', '');
  if (!localDir || !fs.existsSync(localDir)) return [];

  // Pull all DB payload file rows so we can join on name
  const allSources = db.listPayloadSources();
  const sourceMap  = new Map(allSources.map(s => [s.id, s]));
  const allFiles   = allSources.flatMap(s => db.getPayloadFiles(s.id));
  const dbByName   = new Map(allFiles.map(f => [f.asset_name, f]));

  const out = [];
  try {
    for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      // Only list valid payload extensions
      if (!/\.(bin|elf|js)$/i.test(entry.name)) continue;
      let stat;
      try { stat = fs.statSync(path.join(localDir, entry.name)); } catch { continue; }
      const dbRow = dbByName.get(entry.name) || null;
      out.push({
        name:        entry.name,
        local_path:  path.join(localDir, entry.name),
        size:        stat.size,
        local_hash:  dbRow?.local_hash  || null,
        remote_hash: dbRow?.remote_hash || null,
        version:     dbRow?.version     || null,
        source_id:   dbRow?.source_id   || null,
        source_name: dbRow?.source_id != null ? (sourceMap.get(dbRow.source_id)?.name || null) : null,
        db_id:       dbRow?.id          || null,
        downloaded_at: dbRow?.downloaded_at || null,
      });
    }
  } catch (e) {
    log.warn('[Payload] list-local error:', e.message);
  }

  // Auto-hash any local file that does not yet have a local_hash in the DB.
  // This ensures manually-placed files are always hashable for update comparison.
  for (const f of out) {
    if (f.local_hash) continue;
    try {
      log.info(`[Payload] Auto-hashing local file: ${f.name}`);
      const local_hash = await hashFile(f.local_path, () => {});
      f.local_hash = local_hash;
      // Persist to DB — if row exists update it, otherwise we can only log (no source association)
      const dbRow = dbByName.get(f.name);
      if (dbRow) {
        db.updatePayloadFileLocal({
          source_id:  dbRow.source_id,
          asset_name: f.name,
          local_path: f.local_path,
          local_hash,
          local_size: f.size,
          version:    dbRow.version || null,
        });
      }
      log.info(`[Payload] Auto-hashed ${f.name}: ${local_hash}`);
    } catch (hashErr) {
      log.warn(`[Payload] Auto-hash failed for ${f.name}: ${hashErr.message}`);
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('payload:list-remote', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const remotePath = store.get('payload.remotePath', '/data/payloads/');
  const list = await ftp.listRemote(remotePath);
  return list;
});

ipcMain.handle('payload:push', (_e, { local_path, filename }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const remotePath = store.get('payload.remotePath', '/data/payloads/');
  return transferMgr.enqueue('upload', {
    label:      `Payload → ${filename}`,
    localPath:  local_path,
    remotePath: remotePath.replace(/\/$/, '') + '/' + filename,
  });
});

ipcMain.handle('payload:delete-remote', async (_e, { filename }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const remotePath = store.get('payload.remotePath', '/data/payloads/');
  await ftp.deleteRemote(remotePath.replace(/\/$/, '') + '/' + filename);
  return { success: true };
});

ipcMain.handle('payload:delete-local', (_e, { id, local_path }) => {
  if (local_path && fs.existsSync(local_path)) fs.unlinkSync(local_path);
  if (id != null) {
    // Get the asset_name and source_id from the DB to call updatePayloadFileLocal
    // We do a raw delete since we don't need the row data
    db.deletePayloadFile(id);
  }
  return { success: true };
});

// ── System View ───────────────────────────────────────────────────────────────

function _openSystemViewPopout(videoId, audioId, resolution) {
  if (systemViewPopup && !systemViewPopup.isDestroyed()) {
    systemViewPopup.focus();
    return { success: true, focused: true };
  }
  systemViewPopup = new BrowserWindow({
    width:     1280,
    height:    720,
    minWidth:  640,
    minHeight: 360,
    backgroundColor: '#000',
    title: 'System View — Porkfolio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  systemViewPopup.loadFile(
    path.join(__dirname, 'renderer', 'system-view.html'),
    { query: { videoId: videoId || '', audioId: audioId || '', resolution: resolution || '' } }
  );
  systemViewPopup.on('closed', () => {
    systemViewPopup = null;
    win?.webContents.send('system-view:popout-closed');
  });
  return { success: true };
}

ipcMain.handle('system-view:open-popout', (_e, { videoId, audioId, resolution } = {}) =>
  _openSystemViewPopout(videoId, audioId, resolution)
);

ipcMain.handle('system-view:pick-save', async (_e, { defaultPath, filters = [] } = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath, filters });
  return { canceled: !!canceled, filePath: filePath || '' };
});

ipcMain.handle('system-view:write-file', async (_e, { filePath, buffer }) => {
  if (!filePath) throw new Error('filePath is required');
  await fs.promises.writeFile(filePath, Buffer.from(new Uint8Array(buffer)));
  return { ok: true };
});

ipcMain.handle('system-view:append-file', async (_e, { filePath, buffer }) => {
  if (!filePath) throw new Error('filePath is required');
  await fs.promises.appendFile(filePath, Buffer.from(new Uint8Array(buffer)));
  return { ok: true };
});

ipcMain.handle('system-view:delete-file', async (_e, { filePath }) => {
  if (!filePath) return { ok: true };
  await fs.promises.unlink(filePath).catch(() => {});
  return { ok: true };
});

// ── XAvatar PS5 management ────────────────────────────────────────────────────

const AVATARS_PATH = '/data/AVATARS';

/** Write buffer to temp, enqueue FTP upload to /data/AVATARS */
ipcMain.handle('xavatar:upload-to-ps5', async (_e, { buffer, filename }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const tmpPath = path.join(os.tmpdir(), `pork-xav-${Date.now()}-${filename}`);
  await fs.promises.writeFile(tmpPath, Buffer.from(new Uint8Array(buffer)));
  // Enqueue and return *immediately* (fire-and-forget from the renderer's POV).
  // Do NOT await the enqueue promise — that would hold the IPC open for the full
  // FTP transfer duration, leaving the renderer blocked and unable to reset the UI.
  const job = transferMgr.enqueue('upload', {
    label:      `XAvatar → PS5: ${filename}`,
    localPath:  tmpPath,
    remotePath: `${AVATARS_PATH}/${filename}`,
  });
  // Let the job run in the background; discard the completion promise.
  job.catch(err => log.warn('[xavatar:upload-to-ps5] Transfer error:', err.message));
  return { ok: true, queued: true };
});

/** Download a remote file and return its contents as a Buffer */
ipcMain.handle('ftp:download-file', async (_e, { remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const filename = path.basename(remotePath);
  const tmpPath  = path.join(os.tmpdir(), `pork-ftpdl-${Date.now()}-${filename}`);
  await ftp.downloadFile(remotePath, tmpPath);
  const buf = await fs.promises.readFile(tmpPath);
  await fs.promises.unlink(tmpPath).catch(() => {});
  return buf;
});

/** Delete a single remote file */
ipcMain.handle('ftp:delete-file', async (_e, { remotePath }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  await ftp.deleteRemote(remotePath);
  return { ok: true };
});

/** Extract avatar.png from a .xavatar ZIP buffer */
ipcMain.handle('xavatar:extract-png', async (_e, { buffer }) => {
  const JSZip = require('jszip');
  const zip   = await JSZip.loadAsync(Buffer.from(new Uint8Array(buffer)));
  const entry = zip.file('avatar.png');
  if (!entry) throw new Error('avatar.png not found in .xavatar archive');
  return entry.async('nodebuffer');
});

/** Show a save-file dialog and write buffer to the chosen path */
ipcMain.handle('xavatar:save-file', async (_e, { buffer, filename }) => {
  const ext = path.extname(filename).replace('.', '') || 'bin';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: filename,
    filters: [{ name: ext.toUpperCase() + ' Files', extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: true, saved: false };
  await fs.promises.writeFile(filePath, Buffer.from(new Uint8Array(buffer)));
  return { ok: true, saved: true };
});

// ── PS5 Autoloader ─────────────────────────────────────────────────────────────
const AUTOLOADER_DIR  = '/data/ps5_autoloader';
const AUTOLOADER_FILE = `${AUTOLOADER_DIR}/autoload.txt`;

ipcMain.handle('autoloader:list', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  return ftp.listDir(AUTOLOADER_DIR);
});

ipcMain.handle('autoloader:read', async () => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const tmpPath = path.join(os.tmpdir(), `pork-autoload-${Date.now()}.txt`);
  try {
    await ftp.downloadFile(AUTOLOADER_FILE, tmpPath);
    const content = await fs.promises.readFile(tmpPath, 'utf8');
    await fs.promises.unlink(tmpPath).catch(() => {});
    return content;
  } catch (_) {
    return null; // autoload.txt may not exist yet
  }
});

ipcMain.handle('autoloader:save', async (_e, { content }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const tmpPath = path.join(os.tmpdir(), `pork-autoload-save-${Date.now()}.txt`);
  await fs.promises.writeFile(tmpPath, content, 'utf8');
  try {
    await ftp.uploadFile(tmpPath, AUTOLOADER_FILE);
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
  return { ok: true };
});

// FTP-download a file from /data/ps5_autoloader and save it to the local payloads folder.
ipcMain.handle('autoloader:save-local', async (_e, { filename }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const localDir = store.get('payload.localPath', '');
  if (!localDir) throw new Error('No local payload folder configured. Set one in Settings → Payload Manager.');
  const remotePath = `${AUTOLOADER_DIR}/${filename}`;
  const localPath  = path.join(localDir, filename);
  await ftp.downloadFile(remotePath, localPath);
  return { ok: true };
});

// ── Autoloader Snapshots ──────────────────────────────────────────────────────
const SNAPSHOT_BASE = path.join(app.getPath('userData'), 'autoloader-snapshots');

// Take a snapshot: download all payload files + autoload.txt to a local folder.
ipcMain.handle('snapshot:autoloader:take', async (_e, { label }) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');
  const ts      = Date.now();
  const safeLbl = ((label || '').replace(/[^\w\s\-_.]/g, '').trim().slice(0, 40)) || 'Snapshot';
  const snapDir = path.join(SNAPSHOT_BASE, String(ts));
  await fs.promises.mkdir(snapDir, { recursive: true });

  let hasAutoload = false;
  // 1. Download autoload.txt
  const tmpTxt = path.join(os.tmpdir(), `pork-snap-al-${ts}.txt`);
  try {
    await ftp.downloadFile(AUTOLOADER_FILE, tmpTxt);
    // Validate: must be non-empty and must not be all null bytes (corrupt download guard)
    const txtStat = await fs.promises.stat(tmpTxt).catch(() => null);
    if (!txtStat || txtStat.size === 0) throw new Error('autoload.txt download returned empty file');
    const txt = await fs.promises.readFile(tmpTxt, 'utf8');
    if (!txt || txt.replace(/\0/g, '').trim() === '') throw new Error('autoload.txt download returned only null bytes');
    await fs.promises.writeFile(path.join(snapDir, 'autoload.txt'), txt, 'utf8');
    hasAutoload = true;
  } catch (e) {
    log.warn(`[Snapshot:take] autoload.txt skipped: ${e.message}`);
  }
  await fs.promises.unlink(tmpTxt).catch(() => {});

  // 2. Download each payload file sequentially (basic-ftp: no concurrent ops)
  const files    = await ftp.listDir(AUTOLOADER_DIR);
  const payloads = files.filter(f => !f.isDir && /\.(elf|bin|js)$/i.test(f.name));
  const downloaded = [];
  for (const f of payloads) {
    const localFilePath = path.join(snapDir, f.name);
    try {
      await ftp.downloadFile(`${AUTOLOADER_DIR}/${f.name}`, localFilePath);
      // Validate: non-empty and first byte must not be null (guards against silent zero-fill)
      const stat = await fs.promises.stat(localFilePath).catch(() => null);
      if (!stat || stat.size === 0) throw new Error('download returned empty file');
      // Read first 4 bytes — valid ELF/BIN/JS files never start with a null byte
      const header = Buffer.alloc(4);
      const fd = await fs.promises.open(localFilePath, 'r');
      try { await fd.read(header, 0, 4, 0); } finally { await fd.close(); }
      if (header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x00 && header[3] === 0x00) {
        throw new Error('download produced a zero-filled file (corrupt transfer)');
      }
      downloaded.push(f.name);
    } catch (e) {
      log.warn(`[Snapshot:take] ${f.name} skipped: ${e.message}`);
      await fs.promises.unlink(localFilePath).catch(() => {}); // remove the corrupt partial file
    }
  }

  // 3. Write metadata
  const meta = { ts, label: safeLbl, files: downloaded, hasAutoload, createdAt: new Date().toISOString() };
  await fs.promises.writeFile(path.join(snapDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, meta };
});

// List all saved snapshots (newest first).
ipcMain.handle('snapshot:autoloader:list', async () => {
  await fs.promises.mkdir(SNAPSHOT_BASE, { recursive: true });
  const entries = await fs.promises.readdir(SNAPSHOT_BASE).catch(() => []);
  const metas = [];
  for (const entry of entries) {
    try {
      const raw = await fs.promises.readFile(path.join(SNAPSHOT_BASE, entry, '_meta.json'), 'utf8');
      metas.push({ id: entry, ...JSON.parse(raw) });
    } catch (_) {}
  }
  return metas.sort((a, b) => b.ts - a.ts);
});

// Restore a snapshot: upload all its files back to /data/ps5_autoloader.
ipcMain.handle('snapshot:autoloader:restore', async (_e, { id }) => {
  if (!ftp.isConnected()) throw new Error('Not connected to PS5. Connect via FTP first.');
  if (!/^\d+$/.test(id)) throw new Error('Invalid snapshot id.');
  const snapDir  = path.join(SNAPSHOT_BASE, id);
  const meta     = JSON.parse(await fs.promises.readFile(path.join(snapDir, '_meta.json'), 'utf8'));
  let uploaded = 0;
  const errors  = [];

  // Helper: validate a local snapshot file is not empty or zero-filled before we
  // push it to the PS5 — prevents corrupt snapshots from overwriting good PS5 files.
  async function _validateLocalFile(filePath, isBinary) {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size === 0) throw new Error('snapshot file is missing or empty');
    if (isBinary) {
      const header = Buffer.alloc(4);
      const fd = await fs.promises.open(filePath, 'r');
      try { await fd.read(header, 0, 4, 0); } finally { await fd.close(); }
      if (header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x00 && header[3] === 0x00) {
        throw new Error('snapshot file starts with null bytes (corrupt — re-take snapshot)');
      }
    } else {
      const txt = await fs.promises.readFile(filePath, 'utf8');
      if (!txt || txt.replace(/\0/g, '').trim() === '') throw new Error('snapshot file contains only null bytes (corrupt — re-take snapshot)');
    }
  }

  // Upload payload files sequentially
  for (const filename of (meta.files || [])) {
    const localFilePath = path.join(snapDir, filename);
    try {
      const isBinary = /\.(elf|bin)$/i.test(filename);
      await _validateLocalFile(localFilePath, isBinary);
      await ftp.uploadFile(localFilePath, `${AUTOLOADER_DIR}/${filename}`);
      uploaded++;
    } catch (e) {
      errors.push(`${filename}: ${e.message}`);
      log.warn(`[Snapshot:restore] Failed to upload ${filename}: ${e.message}`);
    }
  }
  // Upload autoload.txt
  if (meta.hasAutoload) {
    const localTxt = path.join(snapDir, 'autoload.txt');
    try {
      await _validateLocalFile(localTxt, false);
      await ftp.uploadFile(localTxt, AUTOLOADER_FILE);
      uploaded++;
    } catch (e) {
      errors.push(`autoload.txt: ${e.message}`);
      log.warn(`[Snapshot:restore] Failed to upload autoload.txt: ${e.message}`);
    }
  }
  const totalExpected = (meta.files || []).length + (meta.hasAutoload ? 1 : 0);
  if (uploaded === 0 && totalExpected > 0) throw new Error(`Upload failed — could not upload any files. Check FTP connection.`);
  return { ok: true, fileCount: uploaded, errors };
});

// Delete a snapshot folder permanently.
ipcMain.handle('snapshot:autoloader:delete', async (_e, { id }) => {
  if (!/^\d+$/.test(id)) throw new Error('Invalid snapshot id.');
  const snapDir = path.join(SNAPSHOT_BASE, id);
  if (!snapDir.startsWith(SNAPSHOT_BASE + path.sep)) throw new Error('Invalid snapshot path.');
  await fs.promises.rm(snapDir, { recursive: true, force: true });
  return { ok: true };
});

// Export a snapshot: bundle meta + all files into a single .porksnap file.
ipcMain.handle('snapshot:autoloader:export', async (_e, { id }) => {
  if (!/^\d+$/.test(id)) throw new Error('Invalid snapshot id.');
  const snapDir = path.join(SNAPSHOT_BASE, id);
  const meta = JSON.parse(await fs.promises.readFile(path.join(snapDir, '_meta.json'), 'utf8'));
  const safeLabel = (meta.label || 'snapshot').replace(/[^\w\s\-_.]/g, '').trim().slice(0, 40);
  const dateStr   = new Date(meta.createdAt || Date.now()).toISOString().slice(0, 10);

  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title:       'Export Snapshot',
    defaultPath: `${safeLabel}-${dateStr}.porkchop`,
    filters:     [{ name: 'Porkfolio Snapshot', extensions: ['porkchop'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const bundle = { version: 1, meta, files: {} };

  if (meta.hasAutoload) {
    try {
      bundle.files['autoload.txt'] = {
        encoding: 'utf8',
        data: await fs.promises.readFile(path.join(snapDir, 'autoload.txt'), 'utf8'),
      };
    } catch (_) {}
  }

  for (const filename of (meta.files || [])) {
    try {
      const buf = await fs.promises.readFile(path.join(snapDir, filename));
      bundle.files[filename] = { encoding: 'base64', data: buf.toString('base64') };
    } catch (_) {}
  }

  await fs.promises.writeFile(filePath, JSON.stringify(bundle), 'utf8');
  return { ok: true, filePath };
});

// Import a snapshot from a .porkchop file or a ZIP containing a ps5_autoloader folder.
ipcMain.handle('snapshot:autoloader:import', async (_e, { label: providedLabel, filePath: providedFilePath } = {}) => {
  let chosenPath;
  if (providedFilePath) {
    // Second call for ZIP label — use the already-chosen file, skip dialog
    chosenPath = providedFilePath;
  } else {
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title:      'Import Snapshot',
      filters:    [
        { name: 'Snapshots & ZIPs', extensions: ['porkchop', 'zip'] },
        { name: 'Porkfolio Snapshot', extensions: ['porkchop'] },
        { name: 'ZIP Archive',       extensions: ['zip'] },
        { name: 'All Files',         extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    chosenPath = filePaths[0];
  }

  const ext = path.extname(chosenPath).toLowerCase();

  // ── ZIP import ──────────────────────────────────────────────────────────────
  if (ext === '.zip') {
    // Caller must supply a label. If not yet provided, signal the renderer to ask.
    if (!providedLabel) return { ok: false, needsLabel: true, filePath: chosenPath };

    const JSZip = require('jszip');
    let zip;
    try {
      zip = await JSZip.loadAsync(await fs.promises.readFile(chosenPath));
    } catch (_) {
      throw new Error('Could not read ZIP file — it may be corrupt.');
    }

    const ts      = Date.now();
    const snapDir = path.join(SNAPSHOT_BASE, String(ts));
    await fs.promises.mkdir(snapDir, { recursive: true });

    const AUTOLOADER_PREFIX = 'ps5_autoloader/';
    const downloaded = [];
    let hasAutoload   = false;

    for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;

      // Only process files inside the ps5_autoloader folder
      const lower = zipPath.replace(/\\/g, '/');
      if (!lower.startsWith(AUTOLOADER_PREFIX)) continue;

      const filename = lower.slice(AUTOLOADER_PREFIX.length);
      // Reject path traversal and nested folders
      if (!filename || filename.includes('/') || filename.includes('..')) continue;
      if (!/^[\w\-. ]+$/.test(filename)) continue;

      const dest = path.join(snapDir, filename);
      if (!dest.startsWith(snapDir + path.sep)) continue; // traversal guard

      const buf = await zipEntry.async('nodebuffer');
      await fs.promises.writeFile(dest, buf);

      if (filename.toLowerCase() === 'autoload.txt') {
        hasAutoload = true;
      } else if (/\.(elf|bin|js)$/i.test(filename)) {
        downloaded.push(filename);
      }
    }

    const safeLabel = (providedLabel || 'Imported ZIP').replace(/[^\w\s\-_.]/g, '').trim().slice(0, 40);
    const importedMeta = {
      ts,
      label:        safeLabel,
      files:        downloaded,
      hasAutoload,
      createdAt:    new Date().toISOString(),
      importedAt:   new Date().toISOString(),
      importedFrom: path.basename(chosenPath),
    };
    await fs.promises.writeFile(path.join(snapDir, '_meta.json'), JSON.stringify(importedMeta, null, 2), 'utf8');
    return { ok: true, meta: importedMeta };
  }

  // ── .porkchop import ────────────────────────────────────────────────────────
  let bundle;
  try {
    bundle = JSON.parse(await fs.promises.readFile(chosenPath, 'utf8'));
  } catch (_) {
    throw new Error('Could not read snapshot file — it may be corrupt or not a valid .porkchop file.');
  }
  if (!bundle || bundle.version !== 1 || !bundle.meta)
    throw new Error('Invalid snapshot file format (missing version or meta).');

  const ts      = Date.now();
  const snapDir = path.join(SNAPSHOT_BASE, String(ts));
  await fs.promises.mkdir(snapDir, { recursive: true });

  for (const [filename, fileData] of Object.entries(bundle.files || {})) {
    if (!/^[\w\-. ]+$/.test(filename) || filename.includes('..')) continue;
    const dest = path.join(snapDir, filename);
    if (!dest.startsWith(snapDir + path.sep)) continue; // traversal guard
    if (fileData.encoding === 'base64') {
      await fs.promises.writeFile(dest, Buffer.from(fileData.data, 'base64'));
    } else {
      await fs.promises.writeFile(dest, fileData.data, 'utf8');
    }
  }

  const importedMeta = {
    ...bundle.meta,
    ts,
    label:      (bundle.meta.label || 'Imported Snapshot').slice(0, 40),
    importedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(path.join(snapDir, '_meta.json'), JSON.stringify(importedMeta, null, 2), 'utf8');
  return { ok: true, meta: importedMeta };
});

// Send a local payload file to the PS5 over a raw TCP connection (e.g. bin-loader on port 9021).
//
// Protocol: identical to `socat -t 99999999 - TCP:{ip}:{port}` (stdin = file bytes).
//   1. Open TCP connection (10s timeout to establish).
//   2. Write all bytes then send FIN (sock.end) — PS5 has everything it needs at this point.
//   3. Resolve the IPC call immediately — UI clears "Sending…" right away.
//   4. Fire a PS5 notify so the user gets on-screen confirmation the payload was received.
//   5. Keep socket alive in the background (mirroring socat's enormous -t value) so the
//      PS5 can close its end whenever it wants without us interrupting the connection.
ipcMain.handle('payload:tcp-send', async (_e, { localPath, port, filename }) => {
  const host = store.get('ftp.host', '');
  if (!host) throw new Error('No PS5 IP configured. Set it in FTP Settings.');
  const tcpPort = port || 9021;
  const label   = filename || path.basename(localPath);

  // Payloads are typically small ELFs (KB–low MB) — buffering is fine.
  const buf = await fs.promises.readFile(localPath);

  return new Promise((resolve, reject) => {
    let resolved = false;

    const sock = new net.Socket();

    // Phase 1: 10s connection-establishment timeout (cleared on connect).
    // We intentionally do NOT use sock.setTimeout() — that fires on *idle* and would
    // incorrectly kill the socket while the PS5 is silently loading the ELF.
    const connectTimer = setTimeout(() => {
      sock.destroy();
      reject(new Error('TCP connection timed out — PS5 not reachable on port ' + tcpPort));
    }, 10000);

    sock.on('error', err => {
      clearTimeout(connectTimer);
      if (!resolved) reject(err);
      // If already resolved, the background socket errored after we already told the UI
      // everything was fine — log but don't surface to the renderer.
      else log.warn(`[Payload TCP] background socket error for ${label}:`, err.message);
    });

    sock.connect(tcpPort, host, () => {
      clearTimeout(connectTimer);

      // Phase 2: write all bytes then send FIN.
      sock.write(buf, writeErr => {
        if (writeErr) { reject(writeErr); return; }

        sock.end(); // half-close: EOF → PS5 exploit host starts loading the ELF

        // Phase 3: IPC resolves NOW — bytes are on the wire, FIN is sent.
        // The renderer can immediately show "Sent ✓" without waiting for PS5 to respond.
        resolved = true;
        resolve({ ok: true, bytes: buf.length });

        // Fire PS5 notify in background — gives on-screen confirmation on the PS5.
        ps5Notify(`Payload Sent — ${label}`, `${(buf.length / 1024).toFixed(1)} KB on port ${tcpPort}`).catch(() => {});

        // Phase 4: keep socket open in background (socat -t 99999999 behaviour).
        // PS5 closes when it's done; we just let it happen without blocking anything.
        sock.once('close', () => log.info(`[Payload TCP] ${label} — PS5 closed connection`));
      });
    });
  });
});

// ── Cheats ────────────────────────────────────────────────────────────────────
let cheatAbort = false;

ipcMain.handle('cheats:stats',       ()                => db.getCheatStats());
ipcMain.handle('cheats:for-game',    (_e, { cusa_id }) => db.getCheatFiles(cusa_id));
ipcMain.handle('cheats:search',      (_e, { query })   => db.searchCheats(query));
ipcMain.handle('cheats:all',         ()                => db.listAllCheatsGrouped());
ipcMain.handle('cheats:cancel',      ()                => { cheatAbort = true; return { ok: true }; });
ipcMain.handle('cheats:fetch-index', ()                => cheats.fetchIndex());
ipcMain.handle('cheats:unmatched',   ()                => db.getUnmatchedCheats());
ipcMain.handle('cheats:assign',      (_e, { filename, cusaId }) => db.assignCheatCusaId(filename, cusaId));

ipcMain.handle('cheats:download-all', async () => {
  cheatAbort = false;
  const entries   = await cheats.fetchIndex();
  const cachedSet = new Set(db.listCachedFilenames());
  const todo      = entries.filter(e => !cachedSet.has(e.filename));
  const total     = entries.length;
  let done        = cachedSet.size;
  let saved       = 0;
  let failed      = 0;
  const startTime = Date.now();

  win?.webContents.send('cheats:dl:start', { total, alreadyCached: cachedSet.size });

  for (const entry of todo) {
    if (cheatAbort) break;
    try {
      const data = await cheats.fetchCheatFile(entry.filename);
      db.upsertCheatFile(entry.filename, entry.cusaId, entry.version, entry.title, JSON.stringify(data));
      saved++;
    } catch (e) {
      failed++;
      log.warn('[Cheats] Failed ' + entry.filename + ': ' + e.message);
    }
    done++;
    const elapsedSec = (Date.now() - startTime) / 1000;
    const rate       = saved / Math.max(elapsedSec, 0.1);
    const etaSec     = rate > 0 ? Math.round((todo.length - saved - failed) / rate) : null;
    win?.webContents.send('cheats:dl:progress', {
      done, total, saved, failed, etaSec,
      current: entry.title,
      pct: Math.round((done / total) * 100),
    });
    await new Promise(r => setTimeout(r, 100));
  }

  const cancelled = cheatAbort;
  cheatAbort = false;
  win?.webContents.send('cheats:dl:done', { saved, failed, total, cancelled });
  return { saved, failed, total, cancelled };
});

// ── Cheats FTP Install ─────────────────────────────────────────────────────────
ipcMain.handle('cheats:ftp-install', async (_e, { remotePath } = {}) => {
  if (!ftp.isConnected() && !ftp.hasCredentials()) throw new Error('Not connected to FTP. Connect to your PS5 first.');

  const files  = db.getAllCheatFilesWithData();
  const total  = files.length;
  if (total === 0) throw new Error('No cheats cached. Download the cheat database first.');

  const tmpDir    = path.join(os.tmpdir(), 'porkfolio-cheats-install');
  const remoteDst = (remotePath || store.get('cheats.remotePath', '/data/etaHEN/cheats')).replace(/\/+$/, '');

  // Write cheat JSONs to temp directory
  win?.webContents.send('cheats:ftp:start', { total, phase: 'write' });
  fs.mkdirSync(tmpDir, { recursive: true });
  for (let i = 0; i < files.length; i++) {
    fs.writeFileSync(path.join(tmpDir, files[i].filename), files[i].data, 'utf8');
    if (i % 100 === 0 || i === files.length - 1) {
      win?.webContents.send('cheats:ftp:progress', {
        phase: 'write', done: i + 1, total,
        pct: Math.round(((i + 1) / total) * 50), // first half of progress
        current: files[i].filename,
      });
    }
  }

  // Upload temp directory to PS5
  win?.webContents.send('cheats:ftp:progress', { phase: 'upload', done: 0, total, pct: 50, current: '' });
  try {
    await ftp.uploadDirectory(tmpDir, remoteDst, info => {
      const uploadPct = info.filesTotal > 0 ? Math.round((info.filesDone / info.filesTotal) * 50) : 0;
      win?.webContents.send('cheats:ftp:progress', {
        phase:   'upload',
        done:    info.filesDone,
        total:   info.filesTotal,
        pct:     50 + uploadPct,
        current: info.name || '',
      });
    });
    win?.webContents.send('cheats:ftp:done', { success: true, count: total });
    return { success: true, count: total };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

