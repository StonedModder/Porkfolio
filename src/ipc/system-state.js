'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const { normalizeSystemStateCommand, parseSystemStateResponse } = require('../system-state-client');

function requestSystemState({ host, port, command, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SystemStateManager did not respond on port ${port}.`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('data', (chunk) => { received += chunk; if (received.includes('\n')) socket.end(); });
    socket.once('close', () => { clearTimeout(timer); resolve(parseSystemStateResponse(received)); });
    socket.connect(port, host, () => socket.write(`${command}\n`));
  });
}

module.exports = function registerSystemState(ipcMain, { store, transferMgr, log }) {
  const bundledElf = path.join(__dirname, '..', '..', 'build', 'garlic', 'SystemStateManager.elf');

  ipcMain.handle('system-state:status', async () => {
    const host = store.get('ftp.host', '');
    if (!host) return { connected: false, error: 'No PS5 IP configured. Set it in FTP Settings.' };
    try {
      const result = await requestSystemState({ host, port: 9112, command: 'STATUS' });
      return { connected: result.ok, ...result };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  });

  ipcMain.handle('system-state:deploy', async () => {
    if (!fs.existsSync(bundledElf)) throw new Error('Bundled SystemStateManager.elf is missing.');
    const host = store.get('ftp.host', '');
    if (!host) throw new Error('No PS5 IP configured. Set it in FTP Settings.');
    const result = await new Promise((resolve, reject) => {
      const data = fs.readFileSync(bundledElf);
      const socket = new net.Socket();
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('ELF loader did not respond on port 9021.')); }, 10000);
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      socket.connect(9021, host, () => socket.end(data, () => { clearTimeout(timer); resolve({ bytes: data.length }); }));
    });
    log.info(`[SystemStateManager] Deployed ${result.bytes} bytes to ${host}:9021.`);
    return { ok: true, ...result, message: 'Payload bytes sent. Wait for the server to begin listening on port 9112 before testing controls.' };
  });

  ipcMain.handle('system-state:command', async (_event, { action, confirmation }) => {
    const command = normalizeSystemStateCommand(action);
    if (confirmation !== `CONFIRM ${command}`) throw new Error('Confirmation phrase does not match the requested system action.');
    const host = store.get('ftp.host', '');
    if (!host) throw new Error('No PS5 IP configured. Set it in FTP Settings.');
    const result = await requestSystemState({ host, port: 9112, command });
    log.info(`[SystemStateManager] ${command}: ${result.ok ? 'OK' : 'ERR'} ${result.response}`);
    if (!result.ok) throw new Error(result.response);
    return result;
  });
};
