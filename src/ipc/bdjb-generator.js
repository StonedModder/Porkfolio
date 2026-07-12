'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { prepareBdjbWorkspace } = require('../bdjb-generator');

function run(command, args, options, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let output = '';
    const consume = (chunk) => {
      const text = chunk.toString(); output += text;
      text.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with code ${code}.\n${output.slice(-1600)}`)));
  });
}

module.exports = function registerBdjbGenerator(ipcMain, { app, dialog, log, win }) {
  const templateDir = path.join(__dirname, '..', '..', 'build', 'bdjb-template');
  const emit = (event, payload) => win?.webContents.send(event, payload);

  ipcMain.handle('bdjbgen:select-payloads', async () => {
    const result = await dialog.showOpenDialog({ title: 'Select BDJB autoloader payloads', properties: ['openFile', 'multiSelections'], filters: [{ name: 'ELF or BIN payloads', extensions: ['elf', 'bin'] }] });
    return result.canceled ? [] : result.filePaths.map((filePath) => ({ name: path.basename(filePath), path: filePath }));
  });

  ipcMain.handle('bdjbgen:build', async (_event, { entries, payloads, discTitle }) => {
    const save = await dialog.showSaveDialog({ title: 'Save BDJB ISO', defaultPath: 'porkfolio-bdjb-autoloader.iso', filters: [{ name: 'ISO image', extensions: ['iso'] }] });
    if (save.canceled || !save.filePath) return { canceled: true };
    const outputIso = save.filePath.toLowerCase().endsWith('.iso') ? save.filePath : `${save.filePath}.iso`;
    const root = await fs.promises.mkdtemp(path.join(app.getPath('temp') || os.tmpdir(), 'porkfolio-bdjb-'));
    const workspaceDir = path.join(root, 'Cyberpunk');
    const progress = (stage, message, percent) => emit('bdjbgen:progress', { stage, message, percent });
    try {
      progress('prepare', 'Preparing the bundled Cyberpunk BDJB template.', 10);
      const prepared = await prepareBdjbWorkspace({ templateDir, workspaceDir, payloads, entries, discTitle, log: (message) => progress('prepare', message, 20) });
      progress('dependencies', 'Checking BDJ SDK and Java 8 build prerequisites.', 30);
      const sdk = process.env.BDJ_SDK || '/opt/bdj-sdk';
      if (!fs.existsSync(path.join(sdk, 'host', 'bin', 'makefs'))) throw new Error(`BDJ SDK is not configured at ${sdk}. Set BDJ_SDK to a complete john-tornblom/bdj-sdk install before building.`);
      const javaHome = process.env.JAVA8_HOME || path.join(sdk, 'host', 'jdk8');
      if (!fs.existsSync(path.join(javaHome, 'bin', 'javac'))) throw new Error(`Java 8 is not configured at ${javaHome}. Set JAVA8_HOME to a Java 8 JDK before building.`);
      progress('compile', 'Compiling the BD-J payload and producing the ISO.', 45);
      await run('make', ['clean'], { cwd: workspaceDir, env: { ...process.env, BDJSDK_HOME: sdk, JAVA8_HOME: javaHome } }, (line) => progress('compile', line, 65));
      await run('make', ['all'], { cwd: workspaceDir, env: { ...process.env, BDJSDK_HOME: sdk, JAVA8_HOME: javaHome } }, (line) => progress('compile', line, 80));
      const generated = path.join(workspaceDir, 'cyberbdjb-autoloader.iso');
      if (!fs.existsSync(generated) || (await fs.promises.stat(generated)).size < 1024) throw new Error('BDJB build did not produce a usable ISO.');
      progress('finalize', 'Copying and validating ISO output.', 90);
      await fs.promises.copyFile(generated, outputIso);
      const size = (await fs.promises.stat(outputIso)).size;
      log.info(`[BDJB Genny] Built ${outputIso} (${size} bytes), ${prepared.payloadCount} payload(s).`);
      progress('done', `ISO validated: ${path.basename(outputIso)} (${size} bytes).`, 100);
      return { ok: true, outputIso, bytes: size, payloadCount: prepared.payloadCount };
    } finally { await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {}); }
  });
};
