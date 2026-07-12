'use strict';

const assert = require('assert');
const { getConversionCapabilities } = require('../src/platform-capabilities');

const linux = getConversionCapabilities('linux');
assert.deepStrictEqual(linux, {
  ufs2: false,
  exfat: false,
  reason: 'FFPKG/UFS2 and ExFAT image conversion require Windows-only tooling.',
});

const windows = getConversionCapabilities('win32');
assert.deepStrictEqual(windows, {
  ufs2: true,
  exfat: true,
  reason: '',
});

console.log('platform capabilities test passed');
