'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildY2jbUpdate } = require('../src/y2jb-generator');

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'porkfolio-y2jb-test-'));
  const templateDir = path.join(tempRoot, 'template');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const outputZip = path.join(tempRoot, 'y2jb_update.zip');
  fs.mkdirSync(path.join(templateDir, 'ps5_autoloader'), { recursive: true });
  fs.writeFileSync(path.join(templateDir, 'main.js'), 'console.log("template");\n');
  fs.writeFileSync(path.join(templateDir, 'update.js'), 'console.log("update");\n');
  fs.writeFileSync(path.join(templateDir, 'icon0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(templateDir, 'ps5_autoloader', 'autoload.txt'), '# template\n');

  const result = await buildY2jbUpdate({
    templateDir,
    workspaceDir,
    outputZip,
    entries: [
      { type: 'message', value: 'Starting test queue' },
      { type: 'delay', value: '750' },
      { type: 'payload', value: 'test-payload.elf' },
    ],
    payloadFiles: [{ name: 'test-payload.elf', data: Buffer.from('test payload') }],
  });

  assert(fs.existsSync(outputZip), 'expected output ZIP');
  assert.strictEqual(result.entryCount > 0, true, 'expected ZIP entries');
  assert.deepStrictEqual(result.entries, [
    'icon0.png',
    'main.js',
    'ps5_autoloader/',
    'ps5_autoloader/autoload.txt',
    'ps5_autoloader/test-payload.elf',
    'update-info.txt',
    'update.js',
  ]);
  const archive = fs.readFileSync(outputZip);
  assert(archive.includes(Buffer.from('ps5_autoloader/autoload.txt')), 'missing autoload manifest');
  assert(!archive.includes(Buffer.from('ps5_autoloader\\autoload.txt')), 'ZIP must use forward slashes');

  const manifest = result.updateInfo;
  assert(manifest.includes('ps5_autoloader/test-payload.elf|12'));
  assert.strictEqual(fs.readFileSync(path.join(workspaceDir, 'ps5_autoloader', 'autoload.txt'), 'utf8').includes('!750'), true);
  console.log('y2jb generator test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
