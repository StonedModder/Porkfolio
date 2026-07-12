'use strict';

const fs     = require('fs');
const crypto = require('crypto');

/**
 * Compute SHA-256 of a file, streaming it so large PKGs don't eat RAM.
 * onProgress({ bytesRead, total, percent }) is called each chunk.
 */
function hashFile(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { return reject(e); }

    const total  = stat.size;
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 }); // 4 MB chunks

    let bytesRead = 0;

    stream.on('data', chunk => {
      hash.update(chunk);
      bytesRead += chunk.length;
      onProgress?.({ bytesRead, total, percent: Math.round((bytesRead / total) * 100) });
    });

    stream.on('end',   ()  => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

module.exports = { hashFile };
