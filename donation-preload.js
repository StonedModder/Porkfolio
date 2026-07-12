'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Bitcoin address to encode in the QR code ────────────────────────────────
// Replace this with your actual Bitcoin address.
const BITCOIN_ADDRESS = '3Kt8L3FRS12XW6HJt9QqFGd8irxBc8xTD4';

contextBridge.exposeInMainWorld('donate', {
  openX:       () => ipcRenderer.send('donation:open-x'),
  openRevolut: () => ipcRenderer.send('donation:open-revolut'),
  dismiss:     () => ipcRenderer.send('donation:dismiss'),
  exitApp:     () => ipcRenderer.send('donation:exit-app'),
  btcAddress:  () => BITCOIN_ADDRESS,
  // QR is generated as SVG in the main process (no canvas required)
  genQR: () => ipcRenderer.invoke('donation:gen-qr'),
});
