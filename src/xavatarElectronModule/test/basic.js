'use strict';

const assert = require('assert');
const JSZip = require('jszip');
const xavatar = require('..');

(async () => {
  assert.strictEqual(typeof xavatar.convertFromRGBA, 'function', 'convertFromRGBA export missing');
  assert.strictEqual(typeof xavatar.registerIpcHandlers, 'function', 'registerIpcHandlers export missing');

  const info = xavatar.moduleInfo();
  assert.strictEqual(info.version, require('../package.json').version, 'moduleInfo version mismatch');

  const rgba = Buffer.from([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 255,
  ]);

  const result = await xavatar.convertFromRGBA(rgba, 2, 2, { filename: 'smoke-avatar' });
  assert(Buffer.isBuffer(result.buffer), 'conversion did not return a Buffer');
  assert.strictEqual(result.filename, 'smoke-avatar.xavatar');

  const zip = await JSZip.loadAsync(result.buffer);
  for (const entry of ['avatar.png', 'avatar64.dds', 'avatar128.dds', 'avatar260.dds', 'avatar440.dds', 'online.json']) {
    assert(zip.file(entry), `missing ${entry} in generated xavatar archive`);
  }

  console.log('xavatar smoke test passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
