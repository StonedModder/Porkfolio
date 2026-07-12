'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareBdjbWorkspace } = require('../src/bdjb-generator');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porkfolio-bdjb-test-'));
  const templateDir = path.join(root, 'template');
  fs.mkdirSync(path.join(templateDir, 'ps5_autoloader'), { recursive: true });
  fs.mkdirSync(path.join(templateDir, 'BDMV', 'META', 'DL'), { recursive: true });
  fs.mkdirSync(path.join(templateDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(templateDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(templateDir, 'bin', 'elfldr.elf'), 'loader');
  fs.writeFileSync(path.join(templateDir, 'src', 'Main.java'), 'class Main {}');
  fs.writeFileSync(path.join(templateDir, 'payload.jar'), 'jar');
  fs.writeFileSync(path.join(templateDir, 'Makefile'), 'all:');
  fs.writeFileSync(path.join(templateDir, 'ps5_autoloader', 'autoload.txt'), '!5000\nold.elf\n');
  fs.writeFileSync(path.join(templateDir, 'BDMV', 'META', 'DL', 'bdmt_eng.xml'), '<di:name>Sonic Loader</di:name>');
  const sourcePayload = path.join(root, 'loader.elf');
  fs.writeFileSync(sourcePayload, 'payload bytes');

  const result = await prepareBdjbWorkspace({
    templateDir,
    workspaceDir: path.join(root, 'workspace'),
    theme: 'cyberpunk',
    payloads: [{ name: 'loader.elf', path: sourcePayload }],
    entries: [{ type: 'delay', value: '1500' }, { type: 'payload', value: 'loader.elf' }],
    discTitle: 'Porkfolio BDJB',
    log: () => {},
  });
  assert.strictEqual(fs.readFileSync(path.join(result.workspaceDir, 'ps5_autoloader', 'autoload.txt'), 'utf8'), '!1500\nloader.elf\n');
  assert.deepStrictEqual(fs.readFileSync(path.join(result.workspaceDir, 'ps5_autoloader', 'loader.elf')), Buffer.from('payload bytes'));
  assert.match(fs.readFileSync(path.join(result.workspaceDir, 'BDMV', 'META', 'DL', 'bdmt_eng.xml'), 'utf8'), /Porkfolio BDJB/);
  assert.strictEqual(result.payloadCount, 1);
  console.log('bdjb generator workspace test passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
