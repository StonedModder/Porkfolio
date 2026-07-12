'use strict';
// Generates renderer/assets/no-signal/no-signal.png
// Pure Node.js — no npm packages. Run: node scripts/gen-no-signal.js

const zlib = require('zlib');
const path = require('path');
const fs   = require('fs');

const W = 640, H = 360;

// ── CRC32 ──────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk writer ───────────────────────────────────────────────────────────
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcBuf    = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

// ── Pixel canvas (RGBA) ────────────────────────────────────────────────────────
const pixels = new Uint8Array(W * H * 4);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
}

function fillRect(x, y, w, h, r, g, b, a = 255) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(x + dx, y + dy, r, g, b, a);
}

// ── Background ─────────────────────────────────────────────────────────────────
fillRect(0, 0, W, H, 0x12, 0x12, 0x12);

// ── Scanlines (subtle horizontal lines) ───────────────────────────────────────
for (let y = 0; y < H; y += 3)
  for (let x = 0; x < W; x++)
    setPixel(x, y, 0x00, 0x00, 0x00, 26); // ~10% black overlay

// ── Pixel-font glyph data ──────────────────────────────────────────────────────
// Each char is a 5×7 bitmap (5 cols, 7 rows), stored as 7 bytes (one per row,
// bits 4..0 = columns left-to-right).

const GLYPHS = {
  'A': [0x0E,0x11,0x11,0x1F,0x11,0x11,0x11],
  'B': [0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E],
  'C': [0x0E,0x11,0x10,0x10,0x10,0x11,0x0E],
  'D': [0x1C,0x12,0x11,0x11,0x11,0x12,0x1C],
  'E': [0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F],
  'F': [0x1F,0x10,0x10,0x1E,0x10,0x10,0x10],
  'G': [0x0E,0x11,0x10,0x17,0x11,0x11,0x0F],
  'H': [0x11,0x11,0x11,0x1F,0x11,0x11,0x11],
  'I': [0x0E,0x04,0x04,0x04,0x04,0x04,0x0E],
  'J': [0x07,0x02,0x02,0x02,0x02,0x12,0x0C],
  'K': [0x11,0x12,0x14,0x18,0x14,0x12,0x11],
  'L': [0x10,0x10,0x10,0x10,0x10,0x10,0x1F],
  'M': [0x11,0x1B,0x15,0x11,0x11,0x11,0x11],
  'N': [0x11,0x19,0x15,0x13,0x11,0x11,0x11],
  'O': [0x0E,0x11,0x11,0x11,0x11,0x11,0x0E],
  'P': [0x1E,0x11,0x11,0x1E,0x10,0x10,0x10],
  'Q': [0x0E,0x11,0x11,0x11,0x15,0x12,0x0D],
  'R': [0x1E,0x11,0x11,0x1E,0x14,0x12,0x11],
  'S': [0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E],
  'T': [0x1F,0x04,0x04,0x04,0x04,0x04,0x04],
  'U': [0x11,0x11,0x11,0x11,0x11,0x11,0x0E],
  'V': [0x11,0x11,0x11,0x11,0x11,0x0A,0x04],
  'W': [0x11,0x11,0x11,0x15,0x15,0x1B,0x11],
  'X': [0x11,0x11,0x0A,0x04,0x0A,0x11,0x11],
  'Y': [0x11,0x11,0x0A,0x04,0x04,0x04,0x04],
  'Z': [0x1F,0x01,0x02,0x04,0x08,0x10,0x1F],
  ' ': [0x00,0x00,0x00,0x00,0x00,0x00,0x00],
  '-': [0x00,0x00,0x00,0x1F,0x00,0x00,0x00],
};

function drawText(text, cx, cy, scale, r, g, b) {
  // cx/cy = center of text block
  const charW = 5 * scale + scale; // 5 cols + 1 gap
  const totalW = text.length * charW - scale;
  let x = Math.round(cx - totalW / 2);

  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] || GLYPHS[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row] & (0x10 >> col)) {
          fillRect(x + col * scale, cy - 3 * scale + row * scale, scale, scale, r, g, b);
        }
      }
    }
    x += charW;
  }
}

// ── "NO SIGNAL" — small grey text, above centre ───────────────────────────────
// accent: #9E9E9E
drawText('NO SIGNAL', W / 2, H / 2 - 48, 2, 0x9E, 0x9E, 0x9E);

// ── "BACKPORK" — large purple pixel text, centred ─────────────────────────────
// accent: #BB86FC
drawText('BACKPORK', W / 2, H / 2 + 14, 5, 0xBB, 0x86, 0xFC);

// ── Corner decorations (small purple squares) ─────────────────────────────────
const cornerSize = 8;
for (const [cx, cy] of [[20,20],[W-20-cornerSize,20],[20,H-20-cornerSize],[W-20-cornerSize,H-20-cornerSize]]) {
  fillRect(cx, cy, cornerSize, cornerSize, 0xBB, 0x86, 0xFC, 120);
}

// ── Encode as PNG ──────────────────────────────────────────────────────────────
// Raw image data: for each row, prepend filter byte 0x00 (None)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter type: None
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4;
    const dst = y * (1 + W * 4) + 1 + x * 4;
    raw[dst]   = pixels[src];
    raw[dst+1] = pixels[src+1];
    raw[dst+2] = pixels[src+2];
    raw[dst+3] = pixels[src+3];
  }
}

const idatData = zlib.deflateRawSync(raw, { level: 6 });

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8]  = 8;  // bit depth
ihdr[9]  = 6;  // colour type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

const png = Buffer.concat([
  Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', idatData),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir  = path.join(__dirname, '..', 'renderer', 'assets', 'no-signal');
const outFile = path.join(outDir, 'no-signal.png');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, png);
console.log(`Written ${png.length} bytes → ${outFile}`);
