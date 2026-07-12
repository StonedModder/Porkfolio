'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pork', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  // Settings
  getSettings: ()  => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  isAdmin:     ()  => ipcRenderer.invoke('app:is-admin'),

  // FTP
  ftpConnect:    (c) => ipcRenderer.invoke('ftp:connect', c),
  ftpDisconnect: ()  => ipcRenderer.invoke('ftp:disconnect'),
  ftpStatus:     ()  => ipcRenderer.invoke('ftp:status'),
  ftpScan:       ()  => ipcRenderer.invoke('ftp:scan'),
  ftpDownload:       (o)       => ipcRenderer.invoke('ftp:download', o),
  ftpDownloadFolder: (game_id) => ipcRenderer.invoke('ftp:download-folder', { game_id }),
  ftpUpload:         (o)       => ipcRenderer.invoke('ftp:upload', o),
  ftpInstallPfs:     (o)       => ipcRenderer.invoke('ftp:install-pfs', o),
  ftpListDir:    (p) => ipcRenderer.invoke('ftp:list-dir', { path: p }),
  ftpFindGame:   (game_id) => ipcRenderer.invoke('ftp:find-game', { game_id }),
  ftpDeleteGame: (game_id) => ipcRenderer.invoke('ftp:delete-game', { game_id }),

  // Database
  listGames:    (f)   => ipcRenderer.invoke('db:games:list', f),
  updateGame:   (o)   => ipcRenderer.invoke('db:games:update', o),
  listBackups:  (id)  => ipcRenderer.invoke('db:backups:list', id),
  deleteBackup: (id)  => ipcRenderer.invoke('db:backups:delete', { id }),
  addBackup:    (game_id, backup_path) => ipcRenderer.invoke('db:backups:upsert', { game_id, backup_path }),
  getStats:     ()    => ipcRenderer.invoke('db:stats'),
  dbQuery:      (sql) => ipcRenderer.invoke('db:query', { sql }),
  dbClear:        ()    => ipcRenderer.invoke('db:clear'),
  dbClearSelective: (opts) => ipcRenderer.invoke('db:clear-selective', opts),
  dbDeleteRows: (table, ids) => ipcRenderer.invoke('db:delete-rows', { table, ids }),
  dbClearHashes:  ()    => ipcRenderer.invoke('db:clear-hashes'),
  exportSql:    ()    => ipcRenderer.invoke('db:export:sql'),
  exportCsv:    (t)   => ipcRenderer.invoke('db:export:csv', { table: t }),

  // Local
  scanBackups:   () => ipcRenderer.invoke('local:scan-backups'),
  selectFolder:  () => ipcRenderer.invoke('dialog:select-folder'),
  openShell:     (t) => ipcRenderer.invoke('shell:open', { target: t }),

  // Prospero metadata
  prosperoFetch:      (game_id) => ipcRenderer.invoke('prospero:fetch', { game_id }),
  prosperoFetchIcon:  (game_id) => ipcRenderer.invoke('prospero:fetch-icon', { game_id }),
  prosperoRefreshAll: ()        => ipcRenderer.invoke('prospero:refresh-all'),

  // Backpork folders
  backporksList:    ()                              => ipcRenderer.invoke('backporks:list'),
  backporksAdd:     (name, path)                    => ipcRenderer.invoke('backporks:add', { name, path }),
  backporksAddRoot: (rootPath)                      => ipcRenderer.invoke('backporks:add-root', { rootPath }),
  backporksRemove:  (id)                            => ipcRenderer.invoke('backporks:remove', { id }),
  backporksScan:    (id)                            => ipcRenderer.invoke('backporks:scan', { id }),
  backporksScanAll: ()                              => ipcRenderer.invoke('backporks:scan-all'),
  backporksGames:   (folder)                        => ipcRenderer.invoke('backporks:games', { folder }),
  backporksEntries: (game_id)                       => ipcRenderer.invoke('backporks:entries', { game_id }),
  backporksPork:          (game_id, folder_name, folder_path) => ipcRenderer.invoke('backporks:pork', { game_id, folder_name, folder_path }),
  backporksCreateFolder:  (name, parentPath)                  => ipcRenderer.invoke('backporks:create-folder', { name, parentPath }),
  firmwareLabels:   ()                              => ipcRenderer.invoke('db:firmware:labels'),

  // Hash verification
  hashStatus:  (game_id)              => ipcRenderer.invoke('hash:status', { game_id }),
  hashCompute: (backup_path, game_id) => ipcRenderer.invoke('hash:compute', { backup_path, game_id }),
  hashAdd:     (o)                    => ipcRenderer.invoke('hash:add', o),
  hashExport:  ()                     => ipcRenderer.invoke('hash:export'),
  hashBulk:            (source)  => ipcRenderer.invoke('hash:bulk',             { source }),
  hashImportCommunity: ()        => ipcRenderer.invoke('hash:import-community'),
  hashCommunityInfo:   ()        => ipcRenderer.invoke('hash:community-info'),
  hashGameSummary:     ()        => ipcRenderer.invoke('hash:game-summary'),

  // Local Save Manager (garlic-savemgr)
  savemgrPushPayload:  ()                    => ipcRenderer.invoke('savemgr:push-payload'),
  savemgrRequest:      (path)                => ipcRenderer.invoke('savemgr:request',      { path }),
  savemgrUpload:       (path, data)          => ipcRenderer.invoke('savemgr:upload',        { path, data }),
  savemgrDownload:     (path, filename)      => ipcRenderer.invoke('savemgr:download',      { path, filename }),
  savemgrDecrypt:      (data, filename)      => ipcRenderer.invoke('savemgr:decrypt',       { data, filename }),
  savemgrResign:       (data, aid, filename) => ipcRenderer.invoke('savemgr:resign',        { data, aid, filename }),
  savemgrIcon:         ()                    => ipcRenderer.invoke('savemgr:icon'),
  savemgrDumpUsb:      (idx)                 => ipcRenderer.invoke('savemgr:dump-usb',      { idx }),
  savemgrCreatePfs:    (size)                => ipcRenderer.invoke('savemgr:create-pfs',    { size }),
  savemgrDownloadNew:  (name, aid)           => ipcRenderer.invoke('savemgr:download-new',  { name, aid }),

  // VoidShell
  vsRequest: (path)                 => ipcRenderer.invoke('vs:request', { path }),
  vsPost:    (path, body, bodyType) => ipcRenderer.invoke('vs:post',    { path, body, bodyType }),
  vsDownload:(path, filename)       => ipcRenderer.invoke('vs:download', { path, filename }),
  vsUpload:  (path, data, filename) => ipcRenderer.invoke('vs:upload',   { path, data, filename }),
  vsImage:   (path)                 => ipcRenderer.invoke('vs:image',    { path }),
  // VoidShell — PKG manager (port 9200)
  vsPkgRequest: (path)                 => ipcRenderer.invoke('vs:pkg-request', { path }),
  vsPkgPost:    (path, body, bodyType) => ipcRenderer.invoke('vs:pkg-post',    { path, body, bodyType }),
  vsPkgUpload:  (filename, data)       => ipcRenderer.invoke('vs:pkg-upload',  { filename, data }),

  // PSNotify
  psnotifySend:        (message, subMessage) => ipcRenderer.invoke('psnotify:send', { message, subMessage }),
  psnotifyHistory:     ()                    => ipcRenderer.invoke('psnotify:history'),
  psnotifyTest:        ()                    => ipcRenderer.invoke('psnotify:test'),
  psnotifyPushPayload: ()                    => ipcRenderer.invoke('psnotify:pushPayload'),

  // Y2JB Updater
  y2jbCheck: () => ipcRenderer.invoke('y2jb:check'),
  y2jbApply: () => ipcRenderer.invoke('y2jb:apply'),
  y2jbGenSelectPayloads: () => ipcRenderer.invoke('y2jbgen:select-payloads'),
  y2jbGenBuild: (o) => ipcRenderer.invoke('y2jbgen:build', o),

  // Transfer Manager
  transferState:        ()   => ipcRenderer.invoke('transfer:state'),
  transferPause:        ()   => ipcRenderer.invoke('transfer:pause'),
  transferResume:       ()   => ipcRenderer.invoke('transfer:resume'),
  transferCancel:       (id) => ipcRenderer.invoke('transfer:cancel', { id }),
  transferClearDone:    ()   => ipcRenderer.invoke('transfer:clear-done'),
  transferSetConcurrent:(n)  => ipcRenderer.invoke('transfer:set-concurrent', { n }),

  // Payload Manager
  payloadSourcesList:   ()               => ipcRenderer.invoke('payload:sources:list'),
  payloadSourcesAdd:    (name, url)      => ipcRenderer.invoke('payload:sources:add', { name, url }),
  payloadSourcesRemove: (id)             => ipcRenderer.invoke('payload:sources:remove', { id }),
  payloadSourcesToggle: (id)             => ipcRenderer.invoke('payload:sources:toggle', { id }),
  payloadCheckUpdates:  (id)             => ipcRenderer.invoke('payload:check-updates', id != null ? { id } : {}),
  payloadDownload:      (o)              => ipcRenderer.invoke('payload:download', o),
  payloadListLocal:     ()               => ipcRenderer.invoke('payload:list-local'),
  payloadListRemote:    ()               => ipcRenderer.invoke('payload:list-remote'),
  payloadPush:          (o)              => ipcRenderer.invoke('payload:push', o),
  payloadDeleteRemote:  (filename)       => ipcRenderer.invoke('payload:delete-remote', { filename }),
  payloadDeleteLocal:   (o)              => ipcRenderer.invoke('payload:delete-local', o),

  // System View
  openSystemViewPopout: (videoId, audioId, resolution) => ipcRenderer.invoke('system-view:open-popout', { videoId, audioId, resolution }),
  systemViewPickSave:    (opts) => ipcRenderer.invoke('system-view:pick-save', opts || {}),
  systemViewWriteFile:   (o)    => ipcRenderer.invoke('system-view:write-file', o),
  systemViewAppendFile:  (o)    => ipcRenderer.invoke('system-view:append-file', o),
  systemViewDeleteFile:  (o)    => ipcRenderer.invoke('system-view:delete-file', o),

  // Cheats
  cheatsStats:       ()             => ipcRenderer.invoke('cheats:stats'),
  cheatsForGame:     (cusa_id)      => ipcRenderer.invoke('cheats:for-game', { cusa_id }),
  cheatsSearch:      (query)        => ipcRenderer.invoke('cheats:search', { query }),
  cheatsAll:         ()             => ipcRenderer.invoke('cheats:all'),
  cheatsFetchIndex:  ()             => ipcRenderer.invoke('cheats:fetch-index'),
  cheatsDownloadAll: ()             => ipcRenderer.invoke('cheats:download-all'),
  cheatsCancel:      ()             => ipcRenderer.invoke('cheats:cancel'),
  cheatsUnmatched:   ()             => ipcRenderer.invoke('cheats:unmatched'),
  cheatsAssign:      (filename, cusaId) => ipcRenderer.invoke('cheats:assign', { filename, cusaId }),
  cheatsFtpInstall:  (remotePath)   => ipcRenderer.invoke('cheats:ftp-install', { remotePath }),

  // Media
  mediaScan:        ()  => ipcRenderer.invoke('media:scan'),
  mediaDownload:    (o) => ipcRenderer.invoke('media:download', o),
  mediaFetchThumb:        (remotePath) => ipcRenderer.invoke('media:fetch-thumb',         { remotePath }),
  mediaGetCachePath:      (remotePath) => ipcRenderer.invoke('media:get-cache-path',      { remotePath }),
  mediaFetchVideoPreview: (remotePath) => ipcRenderer.invoke('media:fetch-video-preview', { remotePath }),
  mediaOpen:              (remotePath) => ipcRenderer.invoke('media:open',           { remotePath }),
  mediaDiscordSend:       (o)          => ipcRenderer.invoke('media:discord-send', o),
  mediaFetchClipThumbs:   (paths)      => ipcRenderer.invoke('media:batch-clip-thumbs', paths),
  mediaLoadClipThumbs:    ()           => ipcRenderer.invoke('media:clip-thumbs:load'),

  // PS5 Autoloader
  autoloaderList:      ()        => ipcRenderer.invoke('autoloader:list'),
  autoloaderRead:      ()        => ipcRenderer.invoke('autoloader:read'),
  autoloaderSave:      (content) => ipcRenderer.invoke('autoloader:save', { content }),
  autoloaderSaveLocal: (o)       => ipcRenderer.invoke('autoloader:save-local', o),

  // Autoloader Snapshots
  snapshotTake:    (label) => ipcRenderer.invoke('snapshot:autoloader:take',    { label }),
  snapshotList:    ()      => ipcRenderer.invoke('snapshot:autoloader:list'),
  snapshotRestore: (id)    => ipcRenderer.invoke('snapshot:autoloader:restore', { id }),
  snapshotDelete:  (id)    => ipcRenderer.invoke('snapshot:autoloader:delete',  { id }),
  snapshotExport:  (id)    => ipcRenderer.invoke('snapshot:autoloader:export',  { id }),
  snapshotImport:  (opts)   => ipcRenderer.invoke('snapshot:autoloader:import', opts || {}),

  // Language / i18n
  langList:        ()       => ipcRenderer.invoke('lang:list'),
  langLoad:        (code)   => ipcRenderer.invoke('lang:load', code),
  langExportBase:  ()       => ipcRenderer.invoke('lang:export-base'),
  langImport:      ()       => ipcRenderer.invoke('lang:import'),

  // Payload TCP sender (sends local payload to PS5 via raw TCP, e.g. bin-loader port 9021)
  payloadTcpSend: (o) => ipcRenderer.invoke('payload:tcp-send', o),

  // XAvatar PS5 management
  xavatarUploadToPs5:    (buffer, filename) => ipcRenderer.invoke('xavatar:upload-to-ps5', { buffer, filename }),
  xavatarSaveFile:       (buffer, filename) => ipcRenderer.invoke('xavatar:save-file',     { buffer, filename }),
  // Fallback conversion channel (used when window.xavatarAPI is unavailable)
  xavatarConvertCanvas:  (rgba, width, height, filename) => ipcRenderer.invoke('xavatar:convert-rgba', { rgba, width, height, filename }),
  ftpDownloadFile:    (remotePath)       => ipcRenderer.invoke('ftp:download-file',      { remotePath }),
  ftpDeleteFile:      (remotePath)       => ipcRenderer.invoke('ftp:delete-file',         { remotePath }),
  xavatarExtractPng:  (buffer)           => ipcRenderer.invoke('xavatar:extract-png',    { buffer }),

  // ── Game Conversion (FFPKG / ExFAT) — Windows only ───────────────────────
  convToolInfo:        ()   => ipcRenderer.invoke('conv:tool-info'),
  convExfatToolInfo:   ()   => ipcRenderer.invoke('conv:exfat-tool-info'),
  convToolPick:        ()   => ipcRenderer.invoke('conv:tool-pick'),
  convExfatToolPick:   ()   => ipcRenderer.invoke('conv:exfat-tool-pick'),
  convPickOutputDir:   ()   => ipcRenderer.invoke('conv:pick-output-dir'),
  convPickTempDir:     ()   => ipcRenderer.invoke('conv:pick-temp-dir'),
  convQueueAdd:        (o)  => ipcRenderer.invoke('conv:queue:add', o),
  convQueueAddBatch:   (a)  => ipcRenderer.invoke('conv:queue:add-batch', a),
  convQueueList:       ()   => ipcRenderer.invoke('conv:queue:list'),
  convQueueIsPaused:   ()   => ipcRenderer.invoke('conv:queue:is-paused'),
  convQueueStart:      ()   => ipcRenderer.invoke('conv:queue:start'),
  convQueueCancel:     (id) => ipcRenderer.invoke('conv:queue:cancel',    { id }),
  convQueueClearDone:  ()   => ipcRenderer.invoke('conv:queue:clear-done'),
  convQueueRetry:      (id) => ipcRenderer.invoke('conv:queue:retry',     { id }),
  convQueueCleanupTemp: ()   => ipcRenderer.invoke('conv:queue:cleanup-temp'),

  // GarlicSaves
  garlicStart: () => ipcRenderer.invoke('garlic:start'),

  // ELF Arsenal (PS5 web API on :6969 — successor to VoidShell)
  eaVersion:   ()                      => ipcRenderer.invoke('ea:version'),
  eaList:      (path)                  => ipcRenderer.invoke('ea:list',   { path }),
  eaStat:      (path)                  => ipcRenderer.invoke('ea:stat',   { path }),
  eaUsb:       ()                      => ipcRenderer.invoke('ea:usb'),
  eaMkdir:     (path)                  => ipcRenderer.invoke('ea:mkdir',  { path }),
  eaRename:    (src, dst)              => ipcRenderer.invoke('ea:rename', { src, dst }),
  eaDelete:    (path, recursive)       => ipcRenderer.invoke('ea:delete', { path, recursive }),
  eaCopy:      (src, dst)              => ipcRenderer.invoke('ea:copy',   { src, dst }),
  eaMove:      (src, dst)              => ipcRenderer.invoke('ea:move',   { src, dst }),
  eaJobStatus: ()                      => ipcRenderer.invoke('ea:job-status'),
  eaJobCancel: ()                      => ipcRenderer.invoke('ea:job-cancel'),
  eaLaunch:    (path, args, daemon)    => ipcRenderer.invoke('ea:launch', { path, args, daemon }),
  eaDownload:  (path, filename)        => ipcRenderer.invoke('ea:download', { path, filename }),
  eaUpload:    (localPath, remotePath) => ipcRenderer.invoke('ea:upload', { localPath, remotePath }),

  // PFS Ripper (PFS/image library browser)
  pfsFoldersList:   ()          => ipcRenderer.invoke('pfsripper:folders:list'),
  pfsFoldersAdd:    ()          => ipcRenderer.invoke('pfsripper:folders:add'),
  pfsFoldersRemove: (folder)    => ipcRenderer.invoke('pfsripper:folders:remove', { folder }),
  pfsScan:          ()          => ipcRenderer.invoke('pfsripper:scan'),
  pfsExportCopy:    (path)      => ipcRenderer.invoke('pfsripper:export-copy', { path }),
  pfsExportFtp:     (path, remoteDir) => ipcRenderer.invoke('pfsripper:export-ftp', { path, remoteDir }),
  pfsReveal:        (path)      => ipcRenderer.invoke('pfsripper:reveal', { path }),

  // Auto-Backpork Generator
  bpgenSdkPairs:         ()        => ipcRenderer.invoke('bpgen:sdk-pairs'),
  bpgenCustomPairsGet:   ()        => ipcRenderer.invoke('bpgen:custom-sdk-pairs-get'),
  bpgenCustomPairsSet:   (pairs)   => ipcRenderer.invoke('bpgen:custom-sdk-pairs-set', pairs),
  bpgenListMissing: (fw)    => ipcRenderer.invoke('bpgen:list-missing', { firmwareLabel: fw || '' }),
  bpgenListAll:     ()      => ipcRenderer.invoke('bpgen:list-all-with-local'),
  bpgenPickFolder:  ()      => ipcRenderer.invoke('bpgen:pick-folder'),
  bpgenRun:         (opts)  => ipcRenderer.invoke('bpgen:run', opts),
  bpgenCancel:      ()      => ipcRenderer.invoke('bpgen:cancel'),
  // Auto-Backpork Generator — Fakelib Manager
  bpgenFakelibScan:        ()            => ipcRenderer.invoke('bpgen:fakelib-scan'),
  bpgenFakelibSetBasedir:  (dir)         => ipcRenderer.invoke('bpgen:fakelib-set-basedir', { dir: dir || null }),
  bpgenFakelibPickPup:     ()            => ipcRenderer.invoke('bpgen:fakelib-pick-pup'),
  bpgenFakelibExtract:     (opts)        => ipcRenderer.invoke('bpgen:fakelib-extract', opts),

  // Web UI server control
  webuiStatus: () => ipcRenderer.invoke('webui:status'),
  webuiStart:  () => ipcRenderer.invoke('webui:start'),
  webuiStop:   () => ipcRenderer.invoke('webui:stop'),

  // Donation popup
  openDonate: () => ipcRenderer.send('donation:show'),

  // Events from main process
  on:  (ch, fn) => ipcRenderer.on(ch, (_e, ...args) => fn(...args)),
  off: (ch)     => ipcRenderer.removeAllListeners(ch),
});

// xAvatar dedicated bridge. The reusable module's standalone preload is kept in
// src/xavatarElectronModule for consumers, but the root app exposes the small
// surface it actually needs directly so startup does not depend on chaining a
// second preload script.
contextBridge.exposeInMainWorld('xavatarAPI', {
  version: () => ipcRenderer.invoke('xavatar:version'),

  async convertFromCanvas(canvas, opts = {}) {
    const ctx     = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba    = new Uint8Array(imgData.data.buffer);
    const result  = await ipcRenderer.invoke('xavatar:convert-rgba', {
      rgba,
      width:    canvas.width,
      height:   canvas.height,
      filename: opts.filename,
    });
    if (!result || !result.ok) throw new Error(result?.error || 'xAvatar conversion failed');
    return { buffer: result.buffer?.buffer || result.buffer, filename: result.filename };
  },

  download(buffer, filename) {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
});
