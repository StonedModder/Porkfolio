/**
 * examples/electron-integration/main.js
 * ========================================
 * Minimal Electron app that wires up xavatar-electron-module in ~20 lines.
 *
 * To run:
 *   cd examples/electron-integration
 *   npm install
 *   npm start
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path    = require('path');
const fs      = require('fs');
const xavatar = require('../../index');   // 'xavatar-electron-module' when installed via npm

let mainWindow;
let cleanup;

app.whenReady().then(() => {
  // 1️⃣  Register all IPC handlers — one line
  cleanup = xavatar.registerIpcHandlers(ipcMain);

  // 2️⃣  Add an optional "save to disk" handler so the renderer can ask the
  //     main process to write the file after conversion
  ipcMain.handle('xavatar:save-dialog', async (_event, { buffer, filename }) => {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename,
      filters: [{ name: 'xavatar files', extensions: ['xavatar'] }],
    });
    if (canceled || !filePath) return { ok: false, error: 'Cancelled' };
    try {
      await fs.promises.writeFile(filePath, Buffer.from(buffer));
      return { ok: true, savedTo: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 3️⃣  Create the window — inject the preload
  mainWindow = new BrowserWindow({
    width:  900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: require.resolve('xavatar-electron-module/preload'),
      //      ↑ adds window.xavatarAPI to every renderer automatically
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // mainWindow.webContents.openDevTools();
});

app.on('will-quit', () => cleanup && cleanup());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
