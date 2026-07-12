'use strict';

/**
 * xavatarCore.js — conversion pipeline for .xavatar archives
 *
 * Entry points:
 *   convertFromRGBA(rgbaBuffer, srcWidth, srcHeight, opts?)   ← fastest; no sharp needed
 *   convertFromImageBuffer(imgBuffer, opts?)                   ← needs sharp
 *   convertFromPath(filePath, opts?)                           ← needs sharp
 *   convertFromURL(url, opts?)                                 ← needs sharp + https
 *
 * All functions return Promise<{ buffer: Buffer, filename: string }>
 */

const path   = require('path');
const https  = require('https');
const http   = require('http');
const zlib   = require('zlib');
const JSZip  = require('jszip');
const { encodeToDDS } = require('./dxt5Encoder');

const SIZES = [440, 260, 128, 64];

// Raw JSON string — preserved verbatim to match the PS4 firmware's expected format.
// The \/ forward-slash escaping and \" inner quotes are part of the exact payload
// originally used by the Python CLI.  Do NOT re-encode with JSON.stringify.
const ONLINE_JSON =
  '{"avatarUrl":"http:\\/\\/static-resource.np.community.playstation.net\\/avatar_xl\\/WWS_E\\/E0012_XL.png",' +
  '"firstName":"","lastName":"",' +
  '"pictureUrl":"https:\\/\\/image.api.np.km.playstation.net\\/images\\/?format=png&w=440&h=440' +
  '&image=https%3A%2F%2Fkfscdn.api.np.km.playstation.net%2F00000000000008%2F000000000000003.png&sign=blablabla019501",' +
  '"trophySummary":"{\\"level\\":1,\\"progress\\":0,\\"earnedTrophies\\":{\\"platinum\\":0,\\"gold\\":0,\\"silver\\":0,\\"bronze\\":0}}",' +
  '"isOfficiallyVerified":"true"}';

// ---------------------------------------------------------------------------
// Sharp loader (optional dependency)
// ---------------------------------------------------------------------------

let _sharp = null;
function loadSharp() {
  if (_sharp) return _sharp;
  try {
    _sharp = require('sharp');
    return _sharp;
  } catch {
    throw new Error(
      'sharp is required for this input type.  Install it via:\n' +
      '  npm install sharp\n' +
      'Or use convertFromRGBA() if you can supply pre-processed RGBA data.'
    );
  }
}

// ---------------------------------------------------------------------------
// Tiny RGBA → PNG encoder (no native deps, uses built-in zlib)
// ---------------------------------------------------------------------------

// CRC-32 table (PNG/zlib polynomial)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePNGChunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const head  = Buffer.allocUnsafe(4);
  head.writeUInt32BE(data.length);
  const crcIn = Buffer.concat([typeB, data]);
  const crcB  = Buffer.allocUnsafe(4);
  crcB.writeUInt32BE(crc32(crcIn));
  return Buffer.concat([head, typeB, data, crcB]);
}

/**
 * Encode raw RGBA (Uint8Array or Buffer) to a PNG Buffer.
 * @param {Uint8Array|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodeRGBAtoPNG(rgba, width, height) {
  const SIG  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width,  0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 6; // colour type RGBA
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0; // comp/filter/interlace

  // Filter type 0 (None) prepended to each row
  const stride  = width * 4;
  const rawBuf  = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    rawBuf[y * (1 + stride)] = 0;
    Buffer.from(rgba.buffer || rgba, y * stride, stride)
          .copy(rawBuf, y * (1 + stride) + 1);
  }
  const compressed = zlib.deflateSync(rawBuf, { level: 6 });

  return Buffer.concat([
    SIG,
    makePNGChunk('IHDR', ihdrData),
    makePNGChunk('IDAT', compressed),
    makePNGChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Bilinear resizer (RGBA)
// Used when sharp is unavailable; input is already at known dimensions.
// ---------------------------------------------------------------------------

function resizeRGBA(src, srcW, srcH, dstW, dstH) {
  const dst   = Buffer.allocUnsafe(dstW * dstH * 4);
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const ySrc = y * yScale;
    const y0   = Math.floor(ySrc);
    const y1   = Math.min(y0 + 1, srcH - 1);
    const yF   = ySrc - y0;

    for (let x = 0; x < dstW; x++) {
      const xSrc = x * xScale;
      const x0   = Math.floor(xSrc);
      const x1   = Math.min(x0 + 1, srcW - 1);
      const xF   = xSrc - x0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const dstIdx = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        dst[dstIdx + c] = Math.round(
          src[i00 + c] * (1 - xF) * (1 - yF) +
          src[i10 + c] *      xF  * (1 - yF) +
          src[i01 + c] * (1 - xF) *      yF  +
          src[i11 + c] *      xF  *      yF
        );
      }
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Build xavatar ZIP from a 440×440 RGBA buffer
// ---------------------------------------------------------------------------

/**
 * Core packaging step — accepts a 440×440 RGBA buffer (already cropped/resized)
 * and produces the complete .xavatar archive in memory.
 *
 * @param {Buffer|Uint8Array} rgba440  Raw RGBA 440×440
 * @param {string}            name     Stem used as the archive filename hint
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function buildXavatarFromRGBA440(rgba440, name = 'avatar') {
  const zip = new JSZip();

  // Avatar + picture PNG (full 440×440)
  const avatarPNG = encodeRGBAtoPNG(rgba440, 440, 440);
  zip.file('avatar.png',  avatarPNG);
  zip.file('picture.png', avatarPNG);

  // DDS files for each target size
  for (const size of SIZES) {
    const resized  = size === 440
      ? Buffer.from(rgba440.buffer || rgba440)
      : resizeRGBA(rgba440, 440, 440, size, size);
    const ddsBytes = encodeToDDS(resized, size, size);
    zip.file(`avatar${size}.dds`,  ddsBytes);
    zip.file(`picture${size}.dds`, ddsBytes);
  }

  zip.file('online.json', ONLINE_JSON);

  const buffer   = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename = `${name}.xavatar`;
  return { buffer, filename };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a pre-processed RGBA buffer (any size) directly to .xavatar.
 * Does NOT require sharp.  If srcWidth/srcHeight ≠ 440, bilinear resizing
 * is applied automatically.
 *
 * @param {Buffer|Uint8Array} rgbaBuffer  Raw RGBA pixel data (row-major, top-bottom)
 * @param {number}            srcWidth
 * @param {number}            srcHeight
 * @param {{ filename?: string }} [opts]
 */
async function convertFromRGBA(rgbaBuffer, srcWidth, srcHeight, opts = {}) {
  const name = opts.filename || 'avatar';
  const rgba440 = (srcWidth === 440 && srcHeight === 440)
    ? Buffer.from(rgbaBuffer.buffer || rgbaBuffer)
    : resizeRGBA(rgbaBuffer, srcWidth, srcHeight, 440, 440);
  return buildXavatarFromRGBA440(rgba440, name);
}

/**
 * Convert an in-memory encoded image (PNG/JPEG/WebP/etc) to .xavatar.
 * Requires sharp.
 *
 * @param {Buffer}  imgBuffer  Encoded image bytes
 * @param {{ filename?: string }} [opts]
 */
async function convertFromImageBuffer(imgBuffer, opts = {}) {
  const sharp = loadSharp();
  const name  = opts.filename || 'avatar';

  const { data, info } = await sharp(imgBuffer)
    .resize(440, 440, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return buildXavatarFromRGBA440(data, name);
}

/**
 * Convert an image file to .xavatar.
 * Requires sharp.
 *
 * @param {string} filePath  Absolute path to the source image
 * @param {{ filename?: string }} [opts]
 */
async function convertFromPath(filePath, opts = {}) {
  const sharp    = loadSharp();
  const name     = opts.filename || path.basename(filePath, path.extname(filePath));

  const { data } = await sharp(filePath)
    .resize(440, 440, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return buildXavatarFromRGBA440(data, name);
}

/**
 * Fetch an image from a URL and convert it to .xavatar.
 * Requires sharp.
 *
 * @param {string} url  HTTP/HTTPS image URL
 * @param {{ filename?: string }} [opts]
 */
async function convertFromURL(url, opts = {}) {
  const imgBuffer = await fetchURL(url);
  const stem      = opts.filename || (new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, '') || 'avatar');
  return convertFromImageBuffer(imgBuffer, { ...opts, filename: stem });
}

// ---------------------------------------------------------------------------
// Internal: HTTP/HTTPS fetch
// ---------------------------------------------------------------------------

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'xavatar-electron-module/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  ()  => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  convertFromRGBA,
  convertFromImageBuffer,
  convertFromPath,
  convertFromURL,
  /** Exposed for advanced use — accepts pre-resized 440×440 RGBA directly. */
  buildXavatarFromRGBA440,
  SIZES,
  ONLINE_JSON,
};
