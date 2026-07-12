'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── Settings ───────────────────────────────────────────────────────────────
  getSettings:       ()      => ipcRenderer.invoke('settings:get'),
  setSettings:       patch   => ipcRenderer.invoke('settings:set', patch),
  pickFolder:        title   => ipcRenderer.invoke('settings:pick-folder', { title }),

  // ── Tool ─────────────────────────────────────────────────────────────────────
  toolInfo:          ()      => ipcRenderer.invoke('tool:info'),
  toolPick:          ()      => ipcRenderer.invoke('tool:pick'),
  // ── ExFAT Tool ────────────────────────────────────────────────────
  exfatToolInfo:     ()      => ipcRenderer.invoke('exfat:tool-info'),
  exfatToolPick:     ()      => ipcRenderer.invoke('exfat:tool-pick'),
  // ── Game sources ───────────────────────────────────────────────────────────
  scanGames:         ()      => ipcRenderer.invoke('games:scan'),
  addGameSource:     ()      => ipcRenderer.invoke('games:add-source'),
  removeGameSource:  src     => ipcRenderer.invoke('games:remove-source', { src }),

  // ── Backpork / Firmware ────────────────────────────────────────────────────
  listFirmware:      ()         => ipcRenderer.invoke('backporks:list'),
  addBackporkRoot:   ()         => ipcRenderer.invoke('backporks:add-root'),
  removeBackporkRoot: root      => ipcRenderer.invoke('backporks:remove-root', { root }),
  addBackporkFolder: ()         => ipcRenderer.invoke('backporks:add-folder'),
  removeBackporkFolder: p       => ipcRenderer.invoke('backporks:remove-folder', { folderPath: p }),
  scanFirmwareFolder: folderPath => ipcRenderer.invoke('backporks:scan-folder', { folderPath }),

  // ── Queue ──────────────────────────────────────────────────────────────────
  queueList:            ()     => ipcRenderer.invoke('queue:list'),
  queueAdd:             item   => ipcRenderer.invoke('queue:add', item),
  queueAddBatch:        items  => ipcRenderer.invoke('queue:add-batch', items),
  queueCancel:          id     => ipcRenderer.invoke('queue:cancel', { id }),
  queueClearDone:       ()     => ipcRenderer.invoke('queue:clear-done'),
  queueRetry:           id     => ipcRenderer.invoke('queue:retry', { id }),
  queueCleanupTemp:     ()     => ipcRenderer.invoke('queue:cleanup-temp'),
  queueStart:           ()     => ipcRenderer.invoke('queue:start'),
  queueIsPaused:        ()     => ipcRenderer.invoke('queue:is-paused'),
  onQueuePausedChange: handler => {
    const wrap = (_e, val) => handler(val);
    ipcRenderer.on('queue:paused-change', wrap);
    return () => ipcRenderer.removeListener('queue:paused-change', wrap);
  },
  // ── Notifications ──────────────────────────────────────────────────
  notifyTest: () => ipcRenderer.invoke('notify:test'),
  // ── Shell ──────────────────────────────────────────────────────────────────
  openPath: p   => ipcRenderer.invoke('shell:open-path', { p }),
  openUrl:  url => ipcRenderer.invoke('shell:open-url',  { url }),

  // ── Events from main ───────────────────────────────────────────────────────
  onJobUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('queue:job-update', handler);
    return () => ipcRenderer.removeListener('queue:job-update', handler);
  },
});
