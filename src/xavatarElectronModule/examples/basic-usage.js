/**
 * examples/basic-usage.js
 * Run with: node examples/basic-usage.js <image-path-or-url>
 *
 * Demonstrates direct Node.js usage of xavatar-electron-module
 * without Electron — great for build scripts, CLIs, or server-side tools.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const xavatar = require('../index');      // adjust if installed as npm package

async function main() {
  const input = process.argv[2];

  if (!input) {
    // Demo: convert a raw RGBA buffer (no sharp needed)
    console.log('No input given — generating a solid-colour test avatar...');

    const size = 440;
    const rgba = Buffer.alloc(size * size * 4);
    // Fill with a neon-cyan colour (#00f0ff α=255)
    for (let i = 0; i < size * size; i++) {
      rgba[i * 4    ] = 0x00; // R
      rgba[i * 4 + 1] = 0xF0; // G
      rgba[i * 4 + 2] = 0xFF; // B
      rgba[i * 4 + 3] = 0xFF; // A
    }

    const { buffer, filename } = await xavatar.convertFromRGBA(rgba, size, size, {
      filename: 'test-avatar',
    });

    const outPath = path.join(__dirname, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`Written ${(buffer.length / 1024).toFixed(1)} KB → ${outPath}`);
    return;
  }

  console.log(`Converting: ${input}`);
  const info = xavatar.moduleInfo();
  if (!info.sharpAvailable) {
    console.warn('sharp not found — install it for file/URL conversion:');
    console.warn('  npm install sharp');
    process.exit(1);
  }

  let result;
  if (input.startsWith('http://') || input.startsWith('https://')) {
    result = await xavatar.convertFromURL(input);
  } else {
    result = await xavatar.convertFromPath(path.resolve(input));
  }

  const outPath = path.join(process.cwd(), result.filename);
  fs.writeFileSync(outPath, result.buffer);
  console.log(`Done  ${(result.buffer.length / 1024).toFixed(1)} KB → ${outPath}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
