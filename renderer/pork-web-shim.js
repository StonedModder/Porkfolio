/**
 * pork-web-shim.js
 * Injected by the Porkfolio web server when the UI is accessed from a browser.
 * Provides window.pork using fetch() for IPC invoke calls and WebSocket for
 * main-process events — matching the API surface of the Electron preload.js.
 */
(function () {
  'use strict';

  if (window.pork) return; // already provided by Electron preload — bail out

  // ── WebSocket event bus ─────────────────────────────────────────────────────
  const _listeners = new Map(); // channel → Set<fn>
  let   _ws        = null;

  function _connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    _ws = new WebSocket(`${proto}//${location.host}/ws`);

    _ws.onmessage = (event) => {
      try {
        const { channel, args } = JSON.parse(event.data);
        const listeners = _listeners.get(channel);
        if (listeners) {
          for (const fn of listeners) fn(...(args || []));
        }
      } catch (_) {}
    };

    _ws.onclose = () => setTimeout(_connectWs, 2000);
    _ws.onerror = () => { try { _ws.close(); } catch (_) {} };
  }

  _connectWs();

  function _toBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function _fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function _encodeIpcValue(value) {
    if (value == null) return value;
    if (value instanceof ArrayBuffer) {
      return { __porkBinary: true, base64: _toBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        __porkBinary: true,
        base64: _toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      };
    }
    if (Array.isArray(value)) return value.map(v => _encodeIpcValue(v));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = _encodeIpcValue(v);
      return out;
    }
    return value;
  }

  function _decodeIpcValue(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.__porkBinary === true && typeof value.base64 === 'string') {
      return _fromBase64(value.base64);
    }
    if (Array.isArray(value)) return value.map(v => _decodeIpcValue(v));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _decodeIpcValue(v);
    return out;
  }

  // ── fetch-based IPC invoke ──────────────────────────────────────────────────
  async function invoke(channel, ...args) {
    const res  = await fetch('/api/invoke', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ channel, args: _encodeIpcValue(args) }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'IPC error');
    return _decodeIpcValue(data.result);
  }

  // ── Rewrite pork-cache:// → /pork-cache/ for browser media elements ─────────
  // The Electron renderer builds URLs like `pork-cache://<safename>` for video
  // and image src attributes.  Browsers don't understand this custom scheme, so
  // we intercept src assignments and rewrite them to the HTTP endpoint served by
  // the web server at /pork-cache/<safename>.
  function _rewrite(url) {
    if (typeof url === 'string' && url.startsWith('pork-cache://')) {
      return '/pork-cache/' + url.slice('pork-cache://'.length);
    }
    return url;
  }

  function _patchSrcProp(Proto) {
    const desc = Object.getOwnPropertyDescriptor(Proto, 'src');
    if (!desc || !desc.set) return;
    const origSet = desc.set;
    Object.defineProperty(Proto, 'src', {
      ...desc,
      set(val) { origSet.call(this, _rewrite(val)); },
    });
  }

  _patchSrcProp(HTMLVideoElement.prototype);
  _patchSrcProp(HTMLImageElement.prototype);

  // Also intercept setAttribute('src', ...) used on <source> elements
  const _origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === 'src') value = _rewrite(value);
    return _origSetAttr.call(this, name, value);
  };

  // ── window.pork API ─────────────────────────────────────────────────────────
  window.pork = {
    isWebMode: true, // feature flag the UI can check

    // Window controls — no-op; the browser controls its own tab
    minimize: () => {},
    maximize: () => {},
    close:    () => {},

    // Settings
    getSettings: ()  => invoke('settings:get'),
    setSettings: (s) => invoke('settings:set', s),
    isAdmin:     ()  => Promise.resolve(false),

    // FTP
    ftpConnect:        (c)       => invoke('ftp:connect', c),
    ftpDisconnect:     ()        => invoke('ftp:disconnect'),
    ftpStatus:         ()        => invoke('ftp:status'),
    ftpScan:           ()        => invoke('ftp:scan'),
    ftpDownload:       (o)       => invoke('ftp:download', o),
    ftpDownloadFolder: (game_id) => invoke('ftp:download-folder', { game_id }),
    ftpUpload:         (o)       => invoke('ftp:upload', o),
    ftpInstallPfs:     (o)       => invoke('ftp:install-pfs', o),
    ftpListDir:        (p)       => invoke('ftp:list-dir', { path: p }),
    ftpFindGame:       (game_id) => invoke('ftp:find-game', { game_id }),
    ftpDeleteGame:     (game_id) => invoke('ftp:delete-game', { game_id }),
    ftpDownloadFile:   (remotePath) => invoke('ftp:download-file', { remotePath }),
    ftpDeleteFile:     (remotePath) => invoke('ftp:delete-file',   { remotePath }),

    // Database
    listGames:        (f)   => invoke('db:games:list', f),
    updateGame:       (o)   => invoke('db:games:update', o),
    listBackups:      (id)  => invoke('db:backups:list', id),
    deleteBackup:     (id)  => invoke('db:backups:delete', { id }),
    addBackup:        (game_id, backup_path) => invoke('db:backups:upsert', { game_id, backup_path }),
    getStats:         ()    => invoke('db:stats'),
    dbQuery:          (sql) => invoke('db:query', { sql }),
    dbClear:          ()    => invoke('db:clear'),
    dbClearSelective: (opts) => invoke('db:clear-selective', opts),
    dbDeleteRows:     (table, ids) => invoke('db:delete-rows', { table, ids }),
    dbClearHashes:    ()    => invoke('db:clear-hashes'),
    exportSql:        ()    => invoke('db:export:sql'),
    exportCsv:        (t)   => invoke('db:export:csv', { table: t }),

    // Local — folder dialogs open on the server machine; return null in web mode
    scanBackups:  () => invoke('local:scan-backups'),
    selectFolder: () => Promise.resolve(null),
    openShell:    () => Promise.resolve(null),

    // Prospero metadata
    prosperoFetch:      (game_id) => invoke('prospero:fetch',       { game_id }),
    prosperoFetchIcon:  (game_id) => invoke('prospero:fetch-icon',  { game_id }),
    prosperoRefreshAll: ()        => invoke('prospero:refresh-all'),

    // Backpork folders
    backporksList:         ()                                         => invoke('backporks:list'),
    backporksAdd:          (name, path)                               => invoke('backporks:add',           { name, path }),
    backporksAddRoot:      (rootPath)                                 => invoke('backporks:add-root',      { rootPath }),
    backporksRemove:       (id)                                       => invoke('backporks:remove',        { id }),
    backporksScan:         (id)                                       => invoke('backporks:scan',          { id }),
    backporksScanAll:      ()                                         => invoke('backporks:scan-all'),
    backporksGames:        (folder)                                   => invoke('backporks:games',         { folder }),
    backporksEntries:      (game_id)                                  => invoke('backporks:entries',       { game_id }),
    backporksPork:         (game_id, folder_name, folder_path)        => invoke('backporks:pork',          { game_id, folder_name, folder_path }),
    backporksCreateFolder: (name, parentPath)                         => invoke('backporks:create-folder', { name, parentPath }),
    firmwareLabels:        ()                                         => invoke('db:firmware:labels'),

    // Hash verification
    hashStatus:          (game_id)              => invoke('hash:status',           { game_id }),
    hashCompute:         (backup_path, game_id) => invoke('hash:compute',          { backup_path, game_id }),
    hashAdd:             (o)                    => invoke('hash:add', o),
    hashExport:          ()                     => invoke('hash:export'),
    hashBulk:            (source)               => invoke('hash:bulk',             { source }),
    hashImportCommunity: ()                     => invoke('hash:import-community'),
    hashCommunityInfo:   ()                     => invoke('hash:community-info'),
    hashGameSummary:     ()                     => invoke('hash:game-summary'),

    // Local Save Manager
    savemgrPushPayload: ()                    => invoke('savemgr:push-payload'),
    savemgrRequest:     (path)                => invoke('savemgr:request',     { path }),
    savemgrUpload:      (path, data)          => invoke('savemgr:upload',      { path, data }),
    savemgrDownload:    (path, filename)      => invoke('savemgr:download',    { path, filename }),
    savemgrDecrypt:     (data, filename)      => invoke('savemgr:decrypt',     { data, filename }),
    savemgrResign:      (data, aid, filename) => invoke('savemgr:resign',      { data, aid, filename }),
    savemgrIcon:        ()                    => invoke('savemgr:icon'),
    savemgrDumpUsb:     (idx)                 => invoke('savemgr:dump-usb',    { idx }),
    savemgrCreatePfs:   (size)                => invoke('savemgr:create-pfs',  { size }),
    savemgrDownloadNew: (name, aid)           => invoke('savemgr:download-new',{ name, aid }),

    // VoidShell
    vsRequest:    (path)                 => invoke('vs:request',     { path }),
    vsPost:       (path, body, bodyType) => invoke('vs:post',        { path, body, bodyType }),
    vsDownload:   (path, filename)       => invoke('vs:download',    { path, filename }),
    vsUpload:     (path, data, filename) => invoke('vs:upload',      { path, data, filename }),
    vsImage:      (path)                 => invoke('vs:image',       { path }),
    vsPkgRequest: (path)                 => invoke('vs:pkg-request', { path }),
    vsPkgPost:    (path, body, bodyType) => invoke('vs:pkg-post',    { path, body, bodyType }),
    vsPkgUpload:  (filename, data)       => invoke('vs:pkg-upload',  { filename, data }),

    // PSNotify
    psnotifySend:        (message, subMessage) => invoke('psnotify:send',        { message, subMessage }),
    psnotifyHistory:     ()                    => invoke('psnotify:history'),
    psnotifyTest:        ()                    => invoke('psnotify:test'),
    psnotifyPushPayload: ()                    => invoke('psnotify:pushPayload'),

    // Y2JB Updater
    y2jbCheck: () => invoke('y2jb:check'),
    y2jbApply: () => invoke('y2jb:apply'),
    y2jbGenSelectPayloads: () => invoke('y2jbgen:select-payloads'),
    y2jbGenBuild: (o) => invoke('y2jbgen:build', o),

    // Transfer Manager
    transferState:         ()   => invoke('transfer:state'),
    transferPause:         ()   => invoke('transfer:pause'),
    transferResume:        ()   => invoke('transfer:resume'),
    transferCancel:        (id) => invoke('transfer:cancel',       { id }),
    transferClearDone:     ()   => invoke('transfer:clear-done'),
    transferSetConcurrent: (n)  => invoke('transfer:set-concurrent',{ n }),

    // Payload Manager
    payloadSourcesList:   ()          => invoke('payload:sources:list'),
    payloadSourcesAdd:    (name, url) => invoke('payload:sources:add',    { name, url }),
    payloadSourcesRemove: (id)        => invoke('payload:sources:remove', { id }),
    payloadSourcesToggle: (id)        => invoke('payload:sources:toggle', { id }),
    payloadCheckUpdates:  (id)        => invoke('payload:check-updates',  id != null ? { id } : {}),
    payloadDownload:      (o)         => invoke('payload:download', o),
    payloadListLocal:     ()          => invoke('payload:list-local'),
    payloadListRemote:    ()          => invoke('payload:list-remote'),
    payloadPush:          (o)         => invoke('payload:push', o),
    payloadDeleteRemote:  (filename)  => invoke('payload:delete-remote', { filename }),
    payloadDeleteLocal:   (o)         => invoke('payload:delete-local', o),

    // System View — capture card not accessible remotely
    openSystemViewPopout: () => Promise.resolve(null),

    // Cheats
    cheatsStats:       ()                     => invoke('cheats:stats'),
    cheatsForGame:     (cusa_id)              => invoke('cheats:for-game',   { cusa_id }),
    cheatsSearch:      (query)                => invoke('cheats:search',     { query }),
    cheatsAll:         ()                     => invoke('cheats:all'),
    cheatsFetchIndex:  ()                     => invoke('cheats:fetch-index'),
    cheatsDownloadAll: ()                     => invoke('cheats:download-all'),
    cheatsCancel:      ()                     => invoke('cheats:cancel'),
    cheatsUnmatched:   ()                     => invoke('cheats:unmatched'),
    cheatsAssign:      (filename, cusaId)     => invoke('cheats:assign',     { filename, cusaId }),
    cheatsFtpInstall:  (remotePath)           => invoke('cheats:ftp-install',{ remotePath }),

    // Media
    mediaScan:              ()           => invoke('media:scan'),
    mediaDownload:          (o)          => invoke('media:download', o),
    mediaFetchThumb:        (remotePath) => invoke('media:fetch-thumb',         { remotePath }),
    mediaGetCachePath:      (remotePath) => invoke('media:get-cache-path',      { remotePath }),
    mediaFetchVideoPreview: (remotePath) => invoke('media:fetch-video-preview', { remotePath }),
    mediaOpen:              (remotePath) => invoke('media:open',                { remotePath }),
    mediaDiscordSend:       (o)          => invoke('media:discord-send', o),
    mediaFetchClipThumbs:   (paths)      => invoke('media:batch-clip-thumbs', paths),
    mediaLoadClipThumbs:    ()           => invoke('media:clip-thumbs:load'),

    // PS5 Autoloader
    autoloaderList:      ()        => invoke('autoloader:list'),
    autoloaderRead:      ()        => invoke('autoloader:read'),
    autoloaderSave:      (content) => invoke('autoloader:save',       { content }),
    autoloaderSaveLocal: (o)       => invoke('autoloader:save-local', o),

    // Autoloader Snapshots
    snapshotTake:    (label) => invoke('snapshot:autoloader:take',    { label }),
    snapshotList:    ()      => invoke('snapshot:autoloader:list'),
    snapshotRestore: (id)    => invoke('snapshot:autoloader:restore', { id }),
    snapshotDelete:  (id)    => invoke('snapshot:autoloader:delete',  { id }),
    snapshotExport:  (id)    => invoke('snapshot:autoloader:export',  { id }),
    snapshotImport:  (opts)  => invoke('snapshot:autoloader:import',  opts || {}),

    // Language / i18n
    langList:       ()     => invoke('lang:list'),
    langLoad:       (code) => invoke('lang:load', code),
    langExportBase: ()     => invoke('lang:export-base'),
    langImport:     ()     => Promise.resolve({ canceled: true }), // file dialogs unavailable

    // Payload TCP sender
    payloadTcpSend: (o) => invoke('payload:tcp-send', o),

    // XAvatar
    xavatarUploadToPs5:   (buffer, filename)              => invoke('xavatar:upload-to-ps5', { buffer, filename }),
    xavatarSaveFile:      (buffer, filename)              => invoke('xavatar:save-file',     { buffer, filename }),
    xavatarConvertCanvas: (rgba, width, height, filename) => invoke('xavatar:convert-rgba',  { rgba, width, height, filename }),
    xavatarExtractPng:    (buffer)                        => invoke('xavatar:extract-png',   { buffer }),

    // Game Conversion — tool-picker dialogs open on server machine; return null
    convToolInfo:         ()   => invoke('conv:tool-info'),
    convExfatToolInfo:    ()   => invoke('conv:exfat-tool-info'),
    convToolPick:         ()   => Promise.resolve(null),
    convExfatToolPick:    ()   => Promise.resolve(null),
    convPickOutputDir:    ()   => Promise.resolve(null),
    convPickTempDir:      ()   => Promise.resolve(null),
    convQueueAdd:         (o)  => invoke('conv:queue:add', o),
    convQueueAddBatch:    (a)  => invoke('conv:queue:add-batch', a),
    convQueueList:        ()   => invoke('conv:queue:list'),
    convQueueIsPaused:    ()   => invoke('conv:queue:is-paused'),
    convQueueStart:       ()   => invoke('conv:queue:start'),
    convQueueCancel:      (id) => invoke('conv:queue:cancel',      { id }),
    convQueueClearDone:   ()   => invoke('conv:queue:clear-done'),
    convQueueRetry:       (id) => invoke('conv:queue:retry',       { id }),
    convQueueCleanupTemp: ()   => invoke('conv:queue:cleanup-temp'),

    // GarlicSaves
    garlicStart: () => invoke('garlic:start'),

    // ELF Arsenal (successor to VoidShell)
    eaVersion:   ()                      => invoke('ea:version'),
    eaList:      (path)                  => invoke('ea:list',   { path }),
    eaStat:      (path)                  => invoke('ea:stat',   { path }),
    eaUsb:       ()                      => invoke('ea:usb'),
    eaMkdir:     (path)                  => invoke('ea:mkdir',  { path }),
    eaRename:    (src, dst)              => invoke('ea:rename', { src, dst }),
    eaDelete:    (path, recursive)       => invoke('ea:delete', { path, recursive }),
    eaCopy:      (src, dst)              => invoke('ea:copy',   { src, dst }),
    eaMove:      (src, dst)              => invoke('ea:move',   { src, dst }),
    eaJobStatus: ()                      => invoke('ea:job-status'),
    eaJobCancel: ()                      => invoke('ea:job-cancel'),
    eaLaunch:    (path, args, daemon)    => invoke('ea:launch', { path, args, daemon }),
    eaDownload:  (path, filename)        => Promise.resolve(null), // save dialog is server-side; N/A in web mode
    eaUpload:    (localPath, remotePath) => invoke('ea:upload', { localPath, remotePath }),

    // PFS Ripper — folder pickers / dialogs are server-side, so those return null in web mode
    pfsFoldersList:   ()          => invoke('pfsripper:folders:list'),
    pfsFoldersAdd:    ()          => Promise.resolve(null),
    pfsFoldersRemove: (folder)    => invoke('pfsripper:folders:remove', { folder }),
    pfsScan:          ()          => invoke('pfsripper:scan'),
    pfsExportCopy:    ()          => Promise.resolve(null),
    pfsExportFtp:     (path, remoteDir) => invoke('pfsripper:export-ftp', { path, remoteDir }),
    pfsReveal:        (path)      => invoke('pfsripper:reveal', { path }),

    // Auto-Backpork Generator
    bpgenSdkPairs:          ()      => invoke('bpgen:sdk-pairs'),
    bpgenListMissing:       (fw)    => invoke('bpgen:list-missing',        { firmwareLabel: fw || '' }),
    bpgenListAll:           ()      => invoke('bpgen:list-all-with-local'),
    bpgenPickFolder:        ()      => Promise.resolve(null),
    bpgenRun:               (opts)  => invoke('bpgen:run', opts),
    bpgenCancel:            ()      => invoke('bpgen:cancel'),
    bpgenFakelibScan:       ()      => invoke('bpgen:fakelib-scan'),
    bpgenFakelibSetBasedir: (dir)   => invoke('bpgen:fakelib-set-basedir', { dir: dir || null }),
    bpgenFakelibPickPup:    ()      => Promise.resolve(null),
    bpgenFakelibExtract:    (opts)  => invoke('bpgen:fakelib-extract', opts),

    // Web UI control (settings page uses this)
    webuiStatus: () => invoke('webui:status'),
    webuiStart:  () => invoke('webui:start'),
    webuiStop:   () => invoke('webui:stop'),

    // Donation popup — no-op in web mode
    openDonate: () => {},

    // Events from main process — backed by WebSocket
    systemViewPickSave:   ()   => Promise.resolve({ canceled: true, filePath: '' }),
    systemViewWriteFile:  ()   => Promise.resolve({ ok: false }),
    systemViewAppendFile: ()   => Promise.resolve({ ok: false }),
    systemViewDeleteFile: ()   => Promise.resolve({ ok: true }),

    on:  (ch, fn) => {
      if (!_listeners.has(ch)) _listeners.set(ch, new Set());
      _listeners.get(ch).add(fn);
    },
    off: (ch)     => _listeners.delete(ch),
  };

  document.body?.classList.add('web-mode');
})();
