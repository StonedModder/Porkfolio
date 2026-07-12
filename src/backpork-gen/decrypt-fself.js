'use strict';

// ── SELF → ELF Extractor ───────────────────────────────────────────────────────
// Ports Auto-Backpork/src/decrypt_fself.py (john-tornblom / NazkyYT)
// to pure Node.js Buffer operations — no Python required.
//
// "Fake-signed" SELF files store ELF segment data in plaintext — there is no
// actual cryptographic decryption needed. We just need to reassemble the ELF
// from the segment data stored in the SELF container.

const { ELF_MAGIC, PS4_SELF_MAGIC, PS5_SELF_MAGIC } = require('./sdk-patcher');

function alignUp(x, a) { return (x + a - 1) & ~(a - 1); }

// ── SELF header layout (all little-endian) ────────────────────────────────────
// Offset  Size  Field
//  0       4    magic (PS4: 4F 15 3D 1D, PS5: 54 14 F5 EE)
//  4       1    version
//  5       1    mode
//  6       1    endian
//  7       1    attrs
//  8       4    key_type  (uint32)
// 12       2    header_size (uint16)
// 14       2    meta_size   (uint16)
// 16       8    file_size   (uint64)
// 24       2    num_entries (uint16)
// 26       2    flags       (uint16)
// 28       4    padding
// 32+      n*32 entries array
//
// Each entry (32 bytes):
//  0  8  props   (uint64) — bitfield flags + segment index
//  8  8  offset  (uint64) — file offset of this segment's data in the SELF
// 16  8  enc_size(uint64) — data size in SELF (filesz)
// 24  8  dec_size(uint64) — decoded size (memsz)
//
// props bitfield:
//  bit 11     = has_blocks  (set → this is a data entry, not digest)
//  bits 20-35 = segment_index (which ELF phdr this belongs to)

const SELF_HDR_COMMON = 8;   // magic+attrs
const SELF_HDR_EXT    = 24;  // key_type..padding
const ENTRY_SIZE      = 32;

const PROPS_HAS_BLOCKS_BIT   = 11n;
const PROPS_SEG_INDEX_SHIFT  = 20n;
const PROPS_SEG_INDEX_MASK   = 0xFFFFn;

// ELF program-header field offsets (within each 56-byte phdr entry)
const PHDR_TYPE_OFF   = 0;   // uint32
const PHDR_OFFSET_OFF = 8;   // uint64
const PHDR_FILESZ_OFF = 32;  // uint64

// ELF header field offsets
const ELF_PHOFF_OFF     = 0x20;  // uint64
const ELF_EHSIZE_OFF    = 0x34;  // uint16
const ELF_PHENTSIZE_OFF = 0x36;  // uint16
const ELF_PHNUM_OFF     = 0x38;  // uint16

/**
 * Returns true if the buffer is a fake-signed SELF file.
 */
function isSelf(buf) {
  if (buf.length < 4) return false;
  return buf.slice(0, 4).equals(PS4_SELF_MAGIC) || buf.slice(0, 4).equals(PS5_SELF_MAGIC);
}

/**
 * Extract the unsigned ELF from a fake-signed SELF Buffer.
 * @param {Buffer} selfBuf
 * @returns {Buffer} the extracted ELF
 */
function extractElf(selfBuf) {
  if (!isSelf(selfBuf)) throw new Error('Not a fake-signed SELF file');

  // Parse extended header
  const numEntries = selfBuf.readUInt16LE(24);

  // Parse entry table (starts at byte 32)
  const entries = [];
  for (let i = 0; i < numEntries; i++) {
    const base     = 32 + i * ENTRY_SIZE;
    const props    = selfBuf.readBigUInt64LE(base);
    const offset   = Number(selfBuf.readBigUInt64LE(base + 8));
    const encSize  = Number(selfBuf.readBigUInt64LE(base + 16));
    const hasBlocks = ((props >> PROPS_HAS_BLOCKS_BIT) & 1n) === 1n;
    const segIndex  = Number((props >> PROPS_SEG_INDEX_SHIFT) & PROPS_SEG_INDEX_MASK);
    entries.push({ offset, encSize, hasBlocks, segIndex });
  }

  // The ELF header is embedded in the SELF right after the entry table, aligned to 16
  const elfOff = alignUp(32 + numEntries * ENTRY_SIZE, 16);

  if (!selfBuf.slice(elfOff, elfOff + 4).equals(ELF_MAGIC)) {
    throw new Error(`ELF magic not found at SELF offset 0x${elfOff.toString(16)}`);
  }

  const ehsize    = selfBuf.readUInt16LE(elfOff + ELF_EHSIZE_OFF);
  const phentsize = selfBuf.readUInt16LE(elfOff + ELF_PHENTSIZE_OFF);
  const phnum     = selfBuf.readUInt16LE(elfOff + ELF_PHNUM_OFF);
  const phoff     = Number(selfBuf.readBigUInt64LE(elfOff + ELF_PHOFF_OFF));

  // Parse embedded program headers
  const phdrs = [];
  for (let i = 0; i < phnum; i++) {
    const base   = elfOff + phoff + i * phentsize;
    const offset = Number(selfBuf.readBigUInt64LE(base + PHDR_OFFSET_OFF));
    const filesz = Number(selfBuf.readBigUInt64LE(base + PHDR_FILESZ_OFF));
    phdrs.push({ offset, filesz });
  }

  // Calculate output ELF size: max(ehsize, phdr table end, last segment end)
  let elfSize = Math.max(ehsize, phoff + phnum * phentsize);
  for (const ph of phdrs) {
    if (ph.filesz > 0) elfSize = Math.max(elfSize, ph.offset + ph.filesz);
  }

  const elfBuf = Buffer.alloc(elfSize, 0);

  // Copy ELF header + program headers verbatim from SELF
  const elfHdrBytes = phoff + phnum * phentsize;
  selfBuf.copy(elfBuf, 0, elfOff, elfOff + elfHdrBytes);

  // Copy segment data from SELF into the output ELF
  const dataEntries = entries.filter(e => e.hasBlocks);
  for (const entry of dataEntries) {
    if (entry.segIndex >= phdrs.length) continue;
    const ph = phdrs[entry.segIndex];
    if (ph.filesz === 0) continue;
    const copyLen = Math.min(entry.encSize, ph.filesz);
    selfBuf.copy(elfBuf, ph.offset, entry.offset, entry.offset + copyLen);
  }

  return elfBuf;
}

module.exports = { isSelf, extractElf };
