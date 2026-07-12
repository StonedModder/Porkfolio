'use strict';
// Generates build/icon.png (512×512) — Porkfolio app icon.
// Pure Node.js, zero npm dependencies.
// Run: node scripts/gen-icon.js

const zlib = require('zlib');
const path = require('path');
const fs   = require('fs');

const W = 512, H = 512;
const buf = new Uint8Array(W * H * 4); // RGBA, all zeros (transparent)

// ── Drawing primitives ────────────────────────────────────────────────────────

// Porter-Duff "over" blend onto pixel (x, y)
function blend(x, y, r, g, b, a) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i  = (y * W + x) * 4;
  const sa = a / 255, da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa < 1e-4) return;
  buf[i]     = Math.round((r * sa + buf[i]     * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

// Anti-aliased filled disc
function disc(cx, cy, rad, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(cx - rad - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad + 2));
  const y0 = Math.max(0, Math.floor(cy - rad - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad + 2));
  for (let py = y0; py <= y1; py++)
    for (let px = x0; px <= x1; px++) {
      const c = Math.max(0, Math.min(1, rad - Math.hypot(px - cx, py - cy) + 0.5));
      if (c > 0) blend(px, py, r, g, b, Math.round(a * c));
    }
}

// Anti-aliased filled ellipse
function ell(cx, cy, rx, ry, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 2));
  for (let py = y0; py <= y1; py++)
    for (let px = x0; px <= x1; px++) {
      const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
      const c = Math.max(0, Math.min(1, (1 - d) * Math.min(rx, ry) + 0.5));
      if (c > 0) blend(px, py, r, g, b, Math.round(a * c));
    }
}

// Rounded rectangle with anti-aliased corners
function rRect(x, y, w, h, rad, r, g, b, a = 255) {
  for (let py = y; py < y + h; py++)
    for (let px = x; px < x + w; px++) {
      const cx = Math.max(x + rad, Math.min(x + w - rad, px));
      const cy = Math.max(y + rad, Math.min(y + h - rad, py));
      const c  = Math.max(0, Math.min(1, rad - Math.hypot(px - cx, py - cy) + 0.5));
      if (c > 0) blend(px, py, r, g, b, Math.round(a * c));
    }
}

// ── Palette ───────────────────────────────────────────────────────────────────
//                   R     G     B
const BG   = [0x12, 0x09, 0x24];  // #120924 – very dark purple (background)
const GLO  = [0x2C, 0x10, 0x58];  // #2C1058 – radial centre glow
const EAR  = [0x9B, 0x59, 0xD6];  // #9B59D6 – outer ear (medium purple)
const IEAR = [0xE6, 0xCC, 0xFF];  // #E6CCFF – inner ear highlight
const HEAD = [0xBB, 0x86, 0xFC];  // #BB86FC – app accent / pig head
const SHAD = [0x7A, 0x4C, 0xBE];  // #7A4CBE – shadow / depth
const SNT  = [0xE8, 0xD0, 0xFF];  // #E8D0FF – muzzle
const NOS  = [0x7A, 0x46, 0xC8];  // #7A46C8 – nostrils
const EYE  = [0x0D, 0x05, 0x1C];  // #0D051C – near-black eyes
const WHI  = [0xFF, 0xFF, 0xFF];  // white (highlights / specular)

// ── Draw icon ─────────────────────────────────────────────────────────────────

process.stdout.write('Generating Porkfolio icon…\n');

// 1. Background – rounded square (iOS-style, ~16% corner radius)
rRect(0, 0, W, H, 82, ...BG);

// 2. Radial centre glow – slightly lighter purple blooms from the middle
for (let py = 0; py < H; py++)
  for (let px = 0; px < W; px++) {
    if (buf[(py * W + px) * 4 + 3] < 64) continue; // skip transparent corners
    const t = Math.max(0, 1 - Math.hypot(px - 256, py - 260) / 270);
    if (t > 0) blend(px, py, ...GLO, Math.round(72 * t * t));
  }

// 3. Very soft ambient glow halo around the pig head (drawn behind everything)
disc(256, 276, 220, ...HEAD, 10);
disc(256, 276, 205, ...HEAD, 10);

// 4. EARS  –  drawn before the head so they appear behind it
disc(155, 135, 78, ...EAR);       // left outer ear
disc(357, 135, 78, ...EAR);       // right outer ear
disc(155, 135, 50, ...IEAR);      // left inner ear
disc(357, 135, 50, ...IEAR);      // right inner ear

// 5. PIG HEAD  –  main circle in the app's accent purple
disc(256, 276, 184, ...HEAD);

// 5a. Subtle shadow on the left/bottom-left side → adds depth / form
for (let py = 92; py <= 460; py++)
  for (let px = 72; px <= 256; px++) {
    const d = Math.hypot(px - 256, py - 276);
    if (d > 184.5) continue;
    const t = Math.max(0, (256 - px) / 184);
    if (t > 0) blend(px, py, ...SHAD, Math.round(55 * t * t));
  }

// 5b. Specular rim highlight (top-right)
disc(318, 172, 78, ...WHI, 12);
disc(318, 172, 55, ...WHI, 10);
disc(318, 172, 32, ...WHI,  8);

// 6. EYES
disc(200, 236, 30, ...EYE, 50);   // left shadow
disc(312, 236, 30, ...EYE, 50);   // right shadow
disc(198, 232, 26, ...EYE);       // left pupil
disc(314, 232, 26, ...EYE);       // right pupil
disc(208, 222,  9, ...WHI, 225);  // left primary highlight
disc(324, 222,  9, ...WHI, 225);  // right primary highlight
disc(204, 228,  5, ...WHI, 110);  // left secondary highlight
disc(320, 228,  5, ...WHI, 110);  // right secondary highlight

// 7. MUZZLE / SNOUT
ell(256, 332, 87, 63, ...SNT);
ell(256, 323, 66, 42, ...WHI, 24);  // top specular on muzzle

// 8. NOSTRILS
ell(222, 336, 22, 16, ...NOS);
ell(290, 336, 22, 16, ...NOS);
disc(218, 330,  6, ...WHI, 100);  // left nostril shine
disc(286, 330,  6, ...WHI, 100);  // right nostril shine

// ── PNG encode ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb  = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}

// Raw scanlines: one filter byte (0 = None) per row, then RGBA pixels
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const rowBase = y * (1 + W * 4);
  raw[rowBase] = 0; // filter type: None
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4;
    const dst = rowBase + 1 + x * 4;
    raw[dst]     = buf[src];
    raw[dst + 1] = buf[src + 1];
    raw[dst + 2] = buf[src + 2];
    raw[dst + 3] = buf[src + 3];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);

process.stdout.write(`✓  icon.png → ${outPath}  (${(png.length / 1024).toFixed(1)} KB)\n`);
