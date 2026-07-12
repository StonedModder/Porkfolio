'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { buildY2jbUpdate } = require('../y2jb-generator');

module.exports = function registerY2jbGenerator(ipcMain, { app, dialog, log }) {
  const templateDir = path.join(__dirname, '..', '..', 'build', 'y2jb-template');

  ipcMain.handle('y2jbgen:select-payloads', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Y2JB payload files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Payload files', extensions: ['elf', 'bin', 'js', 'jar'] }],
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({ name: path.basename(filePath), path: filePath }));
  });

  ipcMain.handle('y2jbgen:build', async (_event, { entries, payloads }) => {
    const save = await dialog.showSaveDialog({
      title: 'Save Y2JB update ZIP',
      defaultPath: 'y2jb_update.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (save.canceled || !save.filePath) return { canceled: true };

    const outputZip = save.filePath.toLowerCase().endsWith('.zip') ? save.filePath : `${save.filePath}.zip`;
    const workspaceDir = await fs.promises.mkdtemp(path.join(app.getPath('temp') || os.tmpdir(), 'porkfolio-y2jb-'));
    try {
      const payloadFiles = [];
      for (const payload of payloads || []) {
        if (!payload?.name || !payload?.path) continue;
        payloadFiles.push({ name: payload.name, data: await fs.promises.readFile(payload.path) });
      }
      const result = await buildY2jbUpdate({ templateDir, workspaceDir, outputZip, entries, payloadFiles });
      log.info(`[Y2JB Generator] Built ${outputZip} with ${result.entryCount} ZIP entries.`);
      return { ok: true, outputZip, entryCount: result.entryCount, updateInfo: result.updateInfo };
    } finally {
      await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  });
};
