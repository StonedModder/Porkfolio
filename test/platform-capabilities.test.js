'use strict';

const assert = require('assert');
const { getConversionCapabilities } = require('../src/platform-capabilities');

const linux = getConversionCapabilities('linux');
assert.deepStrictEqual(linux, {
  ufs2: false,
  exfat: false,
  disableHardwareAcceleration: true,
  reason: 'FFPKG/UFS2 and ExFAT image conversion require Windows-only tooling.',
});

const windows = getConversionCapabilities('win32');
assert.deepStrictEqual(windows, {
  ufs2: true,
  exfat: true,
  disableHardwareAcceleration: false,
  reason: '',
});

console.log('platform capabilities test passed');
