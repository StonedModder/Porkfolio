'use strict';

/**
 * dxt5Encoder.js — pure-JavaScript BC3 / DXT5 encoder
 *
 * Accepts raw RGBA pixel data and produces a DXT5-compressed block stream
 * plus a complete DDS file header.  No native dependencies required.
 *
 * Quality level: near-optimal single-pass encoder using min/max color
 * selection, suitable for PS4/xavatar avatar images.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode an RGBA image to a DDS file (BC3/DXT5).
 *
 * @param {Uint8Array|Buffer} rgba  Raw RGBA bytes, row-major, top-to-bottom.
 * @param {number}           width  Image width in pixels.
 * @param {number}           height Image height in pixels.
 * @returns {Buffer}  Complete DDS file bytes (header + compressed data).
 */
function encodeToDDS(rgba, width, height) {
  const blockData = encodeBC3(rgba, width, height);
  const header    = makeDDSHeader(width, height, blockData.byteLength);
  return Buffer.concat([header, Buffer.from(blockData)]);
}

// ---------------------------------------------------------------------------
// DDS Header (128 bytes)
// ---------------------------------------------------------------------------

function makeDDSHeader(w, h, dataSize) {
  const buf = Buffer.alloc(128, 0);
  // Magic
  buf.write('DDS ', 0, 'ascii');
  buf.writeUInt32LE(124,  4);  // dwSize

  const DDSD_CAPS       = 0x00000001;
  const DDSD_HEIGHT     = 0x00000002;
  const DDSD_WIDTH      = 0x00000004;
  const DDSD_PIXELFORMAT = 0x00001000;
  const DDSD_LINEARSIZE = 0x00080000;

  buf.writeUInt32LE(DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_LINEARSIZE, 8);
  buf.writeUInt32LE(h,       12); // dwHeight
  buf.writeUInt32LE(w,       16); // dwWidth
  buf.writeUInt32LE(dataSize, 20); // dwPitchOrLinearSize
  // dwDepth, dwMipMapCount → 0

  // Pixel format (32 bytes at offset 76)
  buf.writeUInt32LE(32,          76); // pfSize
  buf.writeUInt32LE(0x4,         80); // pfFlags = DDPF_FOURCC
  buf.write('DXT5',              84, 'ascii'); // pfFourCC
  // remaining pf fields → 0

  // Caps
  const DDSCAPS_TEXTURE = 0x1000;
  buf.writeUInt32LE(DDSCAPS_TEXTURE, 108);

  return buf;
}

// ---------------------------------------------------------------------------
// BC3 / DXT5 block encoder
// ---------------------------------------------------------------------------

/**
 * Compress a raw RGBA image to BC3 block data.
 * Width and height do **not** need to be multiples of 4 — the encoder
 * clamps out-of-bounds reads to the nearest valid pixel.
 *
 * @returns {Uint8Array} Raw compressed block data (no DDS header).
 */
function encodeBC3(rgba, width, height) {
  const blockCountX = Math.ceil(width  / 4);
  const blockCountY = Math.ceil(height / 4);
  const output      = new Uint8Array(blockCountX * blockCountY * 16);
  let   outOffset   = 0;

  const block = new Uint8Array(64); // reusable 4×4 RGBA scratch

  for (let by = 0; by < blockCountY; by++) {
    for (let bx = 0; bx < blockCountX; bx++) {
      extractBlock(rgba, width, height, bx * 4, by * 4, block);
      encodeAlphaBlock(block, output, outOffset);      outOffset += 8;
      encodeColorBlock(block, output, outOffset);      outOffset += 8;
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

/** Fill `block` (64 bytes, 16 RGBA pixels) from source image with clamped edges. */
function extractBlock(rgba, width, height, x0, y0, block) {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const px  = Math.min(x0 + x, width  - 1);
      const py  = Math.min(y0 + y, height - 1);
      const src = (py * width + px) * 4;
      const dst = (y  * 4    + x)  * 4;
      block[dst    ] = rgba[src    ];
      block[dst + 1] = rgba[src + 1];
      block[dst + 2] = rgba[src + 2];
      block[dst + 3] = rgba[src + 3];
    }
  }
}

// ---------------------------------------------------------------------------
// Alpha block (8 bytes)
// ---------------------------------------------------------------------------

function encodeAlphaBlock(block, output, offset) {
  // --- Find min/max alpha across the 16 texels ---
  let aMin = 255, aMax = 0;
  for (let i = 0; i < 16; i++) {
    const a = block[i * 4 + 3];
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
  }

  // Use 8-interpolated-value mode by ensuring alpha0 > alpha1
  const alpha0 = aMax; // stored first  → drives 8-value palette
  const alpha1 = aMin; // stored second

  output[offset    ] = alpha0;
  output[offset + 1] = alpha1;

  // Build 8-value palette
  const pal = new Uint8Array(8);
  pal[0] = alpha0;
  pal[1] = alpha1;
  // alpha0 > alpha1 branch (always true here unless both equal)
  for (let i = 1; i <= 6; i++) {
    pal[1 + i] = Math.round(((7 - i) * alpha0 + i * alpha1) / 7) & 0xFF;
  }
  if (alpha0 === alpha1) { pal[6] = 0; pal[7] = 255; } // edge-case

  // Encode 16 × 3-bit indices packed into 6 bytes (48 bits, little-endian)
  let lo32 = 0; // bits  0-31  (covers texels 0-10)
  let hi16 = 0; // bits 32-47  (covers texels 11-15)

  for (let i = 0; i < 16; i++) {
    const a       = block[i * 4 + 3];
    let   bestIdx = 0, bestDist = 256;
    for (let j = 0; j < 8; j++) {
      const d = Math.abs(a - pal[j]);
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    const shift = i * 3;
    if (shift < 32) {
      lo32 |= (bestIdx << shift);
    } else {
      hi16 |= (bestIdx << (shift - 32));
    }
  }

  // Write 6 bytes LE
  output[offset + 2] = (lo32       ) & 0xFF;
  output[offset + 3] = (lo32 >>  8 ) & 0xFF;
  output[offset + 4] = (lo32 >> 16 ) & 0xFF;
  output[offset + 5] = (lo32 >> 24 ) & 0xFF;
  output[offset + 6] = (hi16       ) & 0xFF;
  output[offset + 7] = (hi16 >>  8 ) & 0xFF;
}

// ---------------------------------------------------------------------------
// Color block — DXT1 sub-format (8 bytes)
// ---------------------------------------------------------------------------

function rgb888ToRGB565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function rgb565ToRGB888(c, out) {
  out[0] = ((c >> 11) & 0x1F) * 255 / 31 | 0;
  out[1] = ((c >>  5) & 0x3F) * 255 / 63 | 0;
  out[2] = ( c        & 0x1F) * 255 / 31 | 0;
}

// Simple principal axis bounding-box selector
function findMinMaxColors(block, minC, maxC) {
  minC[0] = minC[1] = minC[2] = 255;
  maxC[0] = maxC[1] = maxC[2] = 0;
  for (let i = 0; i < 16; i++) {
    const r = block[i * 4], g = block[i * 4 + 1], b = block[i * 4 + 2];
    if (r < minC[0]) minC[0] = r; if (r > maxC[0]) maxC[0] = r;
    if (g < minC[1]) minC[1] = g; if (g > maxC[1]) maxC[1] = g;
    if (b < minC[2]) minC[2] = b; if (b > maxC[2]) maxC[2] = b;
  }
}

function encodeColorBlock(block, output, offset) {
  const minC = new Int32Array(3), maxC = new Int32Array(3);
  findMinMaxColors(block, minC, maxC);

  // Make color0 > color1 (choose highest-luma direction as color0) for 4-color mode
  const lum0 = 0.299 * maxC[0] + 0.587 * maxC[1] + 0.114 * maxC[2];
  const lum1 = 0.299 * minC[0] + 0.587 * minC[1] + 0.114 * minC[2];

  // Pick c0 as higher-luma color so packed value is >= c1 (ensures 4-color interp)
  let eR0 = lum0 >= lum1 ? maxC[0] : minC[0];
  let eG0 = lum0 >= lum1 ? maxC[1] : minC[1];
  let eB0 = lum0 >= lum1 ? maxC[2] : minC[2];
  let eR1 = lum0 >= lum1 ? minC[0] : maxC[0];
  let eG1 = lum0 >= lum1 ? minC[1] : maxC[1];
  let eB1 = lum0 >= lum1 ? minC[2] : maxC[2];

  let c0 = rgb888ToRGB565(eR0, eG0, eB0);
  let c1 = rgb888ToRGB565(eR1, eG1, eB1);

  // Ensure c0 >= c1 for 4-color mode (required by DXT spec)
  if (c0 < c1) {
    [c0, c1]            = [c1, c0];
    [eR0, eG0, eB0, eR1, eG1, eB1] = [eR1, eG1, eB1, eR0, eG0, eB0];
  }

  // Decode back to 8-bit for palette generation (round-trip)
  const dec0 = new Int32Array(3), dec1 = new Int32Array(3);
  rgb565ToRGB888(c0, dec0); rgb565ToRGB888(c1, dec1);

  // 4-color palette
  const pal = [
    [dec0[0], dec0[1], dec0[2]],
    [dec1[0], dec1[1], dec1[2]],
    [(2 * dec0[0] + dec1[0] + 1) / 3 | 0, (2 * dec0[1] + dec1[1] + 1) / 3 | 0, (2 * dec0[2] + dec1[2] + 1) / 3 | 0],
    [(dec0[0] + 2 * dec1[0] + 1) / 3 | 0, (dec0[1] + 2 * dec1[1] + 1) / 3 | 0, (dec0[2] + 2 * dec1[2] + 1) / 3 | 0],
  ];

  // Write color endpoints
  const dv = new DataView(output.buffer, output.byteOffset + offset);
  dv.setUint16(0, c0, true);
  dv.setUint16(2, c1, true);

  // Encode 16 × 2-bit indices
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    const r = block[i * 4], g = block[i * 4 + 1], b = block[i * 4 + 2];
    let bestIdx = 0, bestDist = Infinity;
    for (let j = 0; j < 4; j++) {
      const dr = r - pal[j][0], dg = g - pal[j][1], db = b - pal[j][2];
      const d  = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    indices = (indices | (bestIdx << (i * 2))) >>> 0;
  }
  dv.setUint32(4, indices, true);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { encodeToDDS, encodeBC3, makeDDSHeader };
