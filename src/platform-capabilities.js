'use strict';

/**
 * Describes conversion features that can run on the current host OS.
 * The UFS2/FFPKG and native ExFAT implementation deliberately rely on
 * Windows-only binaries and drivers, so exposing them on Linux is misleading.
 */
function getConversionCapabilities(platform = process.platform) {
  if (platform === 'win32') {
    return { ufs2: true, exfat: true, reason: '' };
  }

  return {
    ufs2: false,
    exfat: false,
    reason: 'FFPKG/UFS2 and ExFAT image conversion require Windows-only tooling.',
  };
}

module.exports = { getConversionCapabilities };
