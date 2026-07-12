'use strict';
/**
 * gif-encoder.js — self-contained animated GIF89a encoder
 * No dependencies. Exposes global GifEncoder via IIFE.
 *
 * Usage:
 *   const enc = new GifEncoder(640, 360, { fps: 10 });
 *   enc.addFrame(canvas.getContext('2d').getImageData(0,0,w,h).data);
 *   const bytes = enc.encode();   // Uint8Array — complete GIF89a file
 *   const url   = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
 */
(function (root) {

// ── Utilities ──────────────────────────────────────────────────────────────────
function u16le(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
function ascii(s) {
  const a = new Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// ── Median-cut colour quantisation ────────────────────────────────────────────
// Returns up to maxColors {r,g,b} objects representative of the palette.
function buildPalette(frames, maxColors) {
  // Sample every 4th pixel from every 2nd frame for better colour coverage
  const fStep = Math.max(1, frames.length >> 1);
  const seen  = new Set();
  for (let fi = 0; fi < frames.length; fi += fStep) {
    const d = frames[fi];
    for (let i = 0; i < d.length; i += 16) { // every 4th pixel (×4 RGBA)
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
  }

  let colors = [...seen].map(c => ({ r: (c >> 16) & 0xFF, g: (c >> 8) & 0xFF, b: c & 0xFF }));
  if (colors.length <= maxColors) return colors;

  // Median cut
  function splitBucket(bucket) {
    let rMn=255,rMx=0,gMn=255,gMx=0,bMn=255,bMx=0;
    for (const c of bucket) {
      if (c.r < rMn) rMn=c.r; if (c.r > rMx) rMx=c.r;
      if (c.g < gMn) gMn=c.g; if (c.g > gMx) gMx=c.g;
      if (c.b < bMn) bMn=c.b; if (c.b > bMx) bMx=c.b;
    }
    const rR=rMx-rMn, gR=gMx-gMn, bR=bMx-bMn;
    const axis = rR>=gR && rR>=bR ? 'r' : gR>=bR ? 'g' : 'b';
    bucket.sort((a, b) => a[axis] - b[axis]);
    const mid = bucket.length >> 1;
    return [bucket.slice(0, mid), bucket.slice(mid)];
  }

  function representative(bucket) {
    const n = bucket.length;
    let r=0,g=0,b=0;
    for (const c of bucket) { r+=c.r; g+=c.g; b+=c.b; }
    return { r: (r/n+0.5)|0, g: (g/n+0.5)|0, b: (b/n+0.5)|0 };
  }

  let buckets = [colors];
  while (buckets.length < maxColors) {
    let li = 0;
    for (let i = 1; i < buckets.length; i++)
      if (buckets[i].length > buckets[li].length) li = i;
    if (buckets[li].length <= 1) break;
    const [a, b] = splitBucket(buckets[li]);
    buckets.splice(li, 1, a, b);
  }
  return buckets.map(representative);
}

// ── 5-bit-per-channel colour lookup table (32³ = 32,768 entries) ─────────────
// 8× more accurate than the 4-bit (16³) LUT — max quantisation error per
// channel drops from ±8 to ±4 before the nearest-palette search.
function buildLUT(palette) {
  const SZ  = 32;
  const lut = new Uint8Array(SZ * SZ * SZ);
  for (let ri = 0; ri < SZ; ri++) {
    for (let gi = 0; gi < SZ; gi++) {
      for (let bi = 0; bi < SZ; bi++) {
        const R = Math.round(ri * 255 / 31);
        const G = Math.round(gi * 255 / 31);
        const B = Math.round(bi * 255 / 31);
        let best = 0, bestD = 1 << 30;
        for (let pi = 0; pi < palette.length; pi++) {
          const p  = palette[pi];
          const dr = R - p.r, dg = G - p.g, db = B - p.b;
          const d  = dr*dr + dg*dg + db*db;
          if (d < bestD) { bestD = d; best = pi; }
        }
        lut[ri * SZ * SZ + gi * SZ + bi] = best;
      }
    }
  }
  return lut;
}

// ── Floyd-Steinberg dithering quantisation ────────────────────────────────────
// Eliminates colour banding by distributing per-pixel quantisation error to
// neighbouring pixels: right 7/16, below-left 3/16, below 5/16, below-right 1/16.
function quantizeFS(rgba, w, h, palette, lut) {
  const SZ = 32;
  const n  = w * h;

  // Float32 working buffers accumulate error without integer clamping
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = rgba[i * 4];
    G[i] = rgba[i * 4 + 1];
    B[i] = rgba[i * 4 + 2];
  }

  const indices = new Uint8Array(n);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = Math.max(0, Math.min(255, R[i] + 0.5)) | 0;
      const g = Math.max(0, Math.min(255, G[i] + 0.5)) | 0;
      const b = Math.max(0, Math.min(255, B[i] + 0.5)) | 0;

      // Nearest palette entry via 5-bit LUT (O(1) lookup)
      const idx = lut[(r >> 3) * SZ * SZ + (g >> 3) * SZ + (b >> 3)];
      indices[i] = idx;

      // Quantisation error
      const p = palette[idx];
      const er = r - p.r, eg = g - p.g, eb = b - p.b;

      // Distribute error to neighbours
      if (x + 1 < w) {
        R[i + 1]     += er * 0.4375; // 7/16
        G[i + 1]     += eg * 0.4375;
        B[i + 1]     += eb * 0.4375;
      }
      if (y + 1 < h) {
        if (x > 0) {
          R[i + w - 1] += er * 0.1875; // 3/16
          G[i + w - 1] += eg * 0.1875;
          B[i + w - 1] += eb * 0.1875;
        }
        R[i + w]     += er * 0.3125; // 5/16
        G[i + w]     += eg * 0.3125;
        B[i + w]     += eb * 0.3125;
        if (x + 1 < w) {
          R[i + w + 1] += er * 0.0625; // 1/16
          G[i + w + 1] += eg * 0.0625;
          B[i + w + 1] += eb * 0.0625;
        }
      }
    }
  }

  return indices;
}

// ── GIF LZW encoder ───────────────────────────────────────────────────────────
// Returns an Array of bytes (including sub-block framing and block terminator).
function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode   = clearCode + 1;

  // Bit-writer
  const out = [];
  let buf = 0, bufBits = 0;
  function write(code, bits) {
    buf |= (code << bufBits);
    bufBits += bits;
    while (bufBits >= 8) { out.push(buf & 0xFF); buf >>>= 8; bufBits -= 8; }
  }

  let codeSize = minCodeSize + 1;
  let nextCode  = eoiCode + 1;
  // Code table: maps (prefixCode << 8) | pixel → new code
  const table = new Map();

  write(clearCode, codeSize);

  if (!pixels.length) {
    write(eoiCode, codeSize);
    if (bufBits > 0) out.push(buf & 0xFF);
    return packSubBlocks(out);
  }

  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const pix = pixels[i];
    const key = (prefix << 8) | pix;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
    } else {
      write(prefix, codeSize);
      if (nextCode < 4096) {
        table.set(key, nextCode);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
        nextCode++;
      } else {
        // Table full — emit clear code and reset
        write(clearCode, codeSize);
        table.clear();
        nextCode  = eoiCode + 1;
        codeSize  = minCodeSize + 1;
      }
      prefix = pix;
    }
  }
  write(prefix, codeSize);
  write(eoiCode, codeSize);
  if (bufBits > 0) out.push(buf & 0xFF);

  return packSubBlocks(out);
}

// Pack raw bytes into GIF sub-blocks (≤255 bytes each), terminated with 0x00.
function packSubBlocks(bytes) {
  const result = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const end = Math.min(i + 255, bytes.length);
    result.push(end - i);
    for (let j = i; j < end; j++) result.push(bytes[j]);
  }
  result.push(0); // block terminator
  return result;
}

// ── GifEncoder class ──────────────────────────────────────────────────────────
class GifEncoder {
  /**
   * @param {number} width
   * @param {number} height
   * @param {{ fps?: number, maxColors?: number }} [opts]
   */
  constructor(width, height, { fps = 10, maxColors = 256 } = {}) {
    this.w      = width;
    this.h      = height;
    // GIF delay is in units of 1/100 s; minimum 2 (= 50 fps max)
    this.delay  = Math.max(2, Math.round(100 / fps));
    this.maxColors = Math.max(2, Math.min(256, maxColors | 0 || 256));
    this._frames = [];
  }

  /** @param {Uint8ClampedArray} data — RGBA pixel data (width × height × 4 bytes) */
  addFrame(data) {
    this._frames.push(data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer ?? data));
  }

  get frameCount() { return this._frames.length; }

  /**
   * Encode all added frames into an animated GIF.
   * @returns {Uint8Array}
   */
  encode() {
    const { w, h, delay, _frames: frames } = this;
    if (!frames.length) return new Uint8Array(0);

    // ── Build global colour palette (up to 256 colours) ────────────────────────
    let palette = buildPalette(frames, this.maxColors);
    // Must be exactly a power-of-2 size between 2 and 256
    const palPow = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
    const palSize = 1 << palPow;
    while (palette.length < palSize) palette.push({ r: 0, g: 0, b: 0 });

    const minCodeSize = Math.max(2, palPow);
    const lut = buildLUT(palette);

    // ── Assemble GIF binary ────────────────────────────────────────────────────
    const out = [];
    function push(...items) {
      for (const item of items) {
        if (Array.isArray(item)) { for (const b of item) out.push(b); }
        else out.push(item);
      }
    }

    // Header
    push(ascii('GIF89a'));

    // Logical Screen Descriptor
    push(
      u16le(w), u16le(h),
      0x80 | (palPow - 1),   // Global CT flag set; CT size = palPow−1
      0,                      // Background colour index
      0,                      // Pixel aspect ratio
    );

    // Global Colour Table (3 bytes per entry: R, G, B)
    for (const c of palette) push(c.r, c.g, c.b);

    // Application Extension — Netscape 2.0 (loop forever)
    push(
      0x21, 0xFF, 0x0B,
      ascii('NETSCAPE2.0'),
      0x03, 0x01, 0x00, 0x00, // loop count = 0 → infinite
      0x00,                   // sub-block terminator
    );

    // ── Frames ─────────────────────────────────────────────────────────────────
    for (const rgba of frames) {
      // Floyd-Steinberg dithered quantisation for each frame
      const indices = quantizeFS(rgba, w, h, palette, lut);

      // Graphic Control Extension
      push(
        0x21, 0xF9, 0x04,
        0x00,           // packed: disposal = 0, no user input, no transparent
        u16le(delay),   // delay in 1/100 s units
        0x00,           // transparent colour index (unused)
        0x00,           // block terminator
      );

      // Image Descriptor
      push(
        0x2C,
        u16le(0), u16le(0),  // left, top
        u16le(w), u16le(h),
        0x00,                 // packed: no local CT, not interlaced
      );

      // Image Data
      push(minCodeSize);
      push(lzwEncode(indices, minCodeSize));
    }

    // Trailer
    push(0x3B);

    return new Uint8Array(out);
  }
}

// Export
root.GifEncoder = GifEncoder;

}(typeof window !== 'undefined' ? window : global));
