'use strict';

// ── ELF → Fake-Signed SELF ────────────────────────────────────────────────────
// Ports Auto-Backpork/src/make_fself.py (john-tornblom / NazkyYT)
// to pure Node.js Buffer operations — no Python required.
//
// Wraps an unsigned ELF file in a fake-signed SELF container.  The output is
// structurally valid but NOT cryptographically signed — it works only with
// modified PS5 firmware (jailbroken consoles running BackPork payload).

const crypto = require('crypto');

function alignUp(x, a) { return (x + a - 1) & ~(a - 1); }
function ilog2(x)       { return 31 - Math.clz32(x >>> 0); }

// ── Constants ─────────────────────────────────────────────────────────────────

// SELF magic — PS4 "fake signed" format used by BackPork
const SELF_MAGIC   = Buffer.from([0x4F, 0x15, 0x3D, 0x1D]);
const SELF_VERSION  = 0x00;
const SELF_MODE     = 0x01;
const SELF_ENDIAN   = 0x01;
const SELF_ATTRIBS  = 0x12;
const SELF_KEY_TYPE = 0x101;
const SELF_FLAGS    = 0x22;   // 0x2 | (2 << 4) — signed_block_count=2

// Segment sizes
const BLOCK_SIZE      = 0x4000;   // 16 KiB blocks for signed entries
const DIGEST_SIZE     = 0x20;     // SHA-256
const SIGNATURE_SIZE  = 0x100;    // empty for fake signing

// ExInfo program type
const PTYPE_FAKE = 0x1;

// ELF segment types that get SELF entries
const PT_LOAD           = 0x1;
const PT_SCE_RELRO      = 0x61000010;
const PT_SCE_DYNLIBDATA = 0x61000000;
const PT_SCE_COMMENT    = 0x6FFFFF00;
const PT_SCE_VERSION    = 0x6FFFFF01;
const LOADABLE = new Set([PT_LOAD, PT_SCE_RELRO, PT_SCE_DYNLIBDATA, PT_SCE_COMMENT]);

// ELF header field offsets
const ELF_PHOFF_OFF     = 0x20;
const ELF_EHSIZE_OFF    = 0x34;
const ELF_PHENTSIZE_OFF = 0x36;
const ELF_PHNUM_OFF     = 0x38;

// ELF phdr field offsets (within 56-byte phdr)
const PHDR_TYPE_OFF   = 0;
const PHDR_FILESZ_OFF = 32;
const PHDR_OFFSET_OFF = 8;

/**
 * Convert an unsigned ELF Buffer to a fake-signed SELF Buffer.
 *
 * @param {Buffer} elfBuf   — raw ELF file content
 * @param {object} [opts]
 * @param {bigint|number} [opts.paid=0x3100000000000002n] — Program Auth ID
 * @param {number}        [opts.ptype=PTYPE_FAKE]         — program type
 * @returns {Buffer} the fake-signed SELF
 */
function makeFself(elfBuf, opts = {}) {
  const paidRaw = opts.paid  ?? 0x3100000000000002n;
  const paid    = typeof paidRaw === 'bigint' ? paidRaw : BigInt(paidRaw);
  const ptype   = opts.ptype ?? PTYPE_FAKE;

  // ── Parse ELF ────────────────────────────────────────────────────────────
  const ehsize    = elfBuf.readUInt16LE(ELF_EHSIZE_OFF);
  const phentsize = elfBuf.readUInt16LE(ELF_PHENTSIZE_OFF);
  const phnum     = elfBuf.readUInt16LE(ELF_PHNUM_OFF);
  const phoff     = Number(elfBuf.readBigUInt64LE(ELF_PHOFF_OFF));

  const phdrs    = [];
  const segments = [];
  let versionData = null;

  for (let i = 0; i < phnum; i++) {
    const base   = phoff + i * phentsize;
    const type   = elfBuf.readUInt32LE(base + PHDR_TYPE_OFF);
    const off    = Number(elfBuf.readBigUInt64LE(base + PHDR_OFFSET_OFF));
    const filesz = Number(elfBuf.readBigUInt64LE(base + PHDR_FILESZ_OFF));
    phdrs.push({ type, offset: off, filesz });
    const seg = filesz > 0 ? elfBuf.slice(off, off + filesz) : Buffer.alloc(0);
    segments.push(seg);
    if (type === PT_SCE_VERSION) versionData = seg;
  }

  const elfDigest = crypto.createHash('sha256').update(elfBuf).digest();

  // ── Build entry list (2 entries per loadable segment) ────────────────────
  // meta_entry: signed + has_digests, segment_index = data_entry index
  // data_entry: signed + has_blocks + block_size, segment_index = ELF phdr index
  const BLOCK_SIZE_SHIFT_VAL = ilog2(BLOCK_SIZE) - 12; // = 2 for 0x4000

  const loadableIdxs = phdrs.reduce((acc, ph, i) => {
    if (LOADABLE.has(ph.type)) acc.push(i);
    return acc;
  }, []);

  const numEntries = loadableIdxs.length * 2;

  // ── Size calculations ─────────────────────────────────────────────────────
  // header_size = align16(common(8) + ext(24) + entries(n*32) + max(ehsize, phHdrEnd)) + exInfo(64) + npdrm(48)
  const elfHdrAreaSize = Math.max(ehsize, phoff + phentsize * phnum);
  const headerSize = alignUp(8 + 24 + numEntries * 32 + elfHdrAreaSize, 16) + 64 + 48;
  // meta_size = entries*80(MetaBlocks) + 80(MetaFooter) + 256(Signature)
  const metaSize = numEntries * 80 + 80 + SIGNATURE_SIZE;

  // ── Assign offsets for data / digest blocks ───────────────────────────────
  const entryDefs = []; // { props, offset, filesz, memsz, data }
  let segOffset = headerSize + metaSize;
  let entryIdx  = 0;

  for (const phdrIdx of loadableIdxs) {
    const ph = phdrs[phdrIdx];

    // Meta entry (digest placeholder, one DIGEST_SIZE chunk per block)
    const numBlocks = Math.max(1, Math.ceil(ph.filesz / BLOCK_SIZE));
    const metaData  = Buffer.alloc(numBlocks * DIGEST_SIZE, 0);
    let metaProps   = 0n;
    metaProps |= 0x4n;                         // signed
    metaProps |= 0x10000n;                     // has_digests
    metaProps |= BigInt(entryIdx + 1) << 20n;  // segment_index → next (data) entry
    entryDefs.push({ props: metaProps, offset: segOffset, filesz: metaData.length, memsz: metaData.length, data: metaData });
    segOffset = alignUp(segOffset + metaData.length, 16);

    // Data entry (actual segment bytes)
    const segData  = segments[phdrIdx];
    let dataProps  = 0n;
    dataProps |= 0x4n;                                // signed
    dataProps |= 0x800n;                              // has_blocks
    dataProps |= BigInt(BLOCK_SIZE_SHIFT_VAL) << 12n; // block_size field
    dataProps |= BigInt(phdrIdx) << 20n;              // segment_index → ELF phdr
    entryDefs.push({ props: dataProps, offset: segOffset, filesz: ph.filesz, memsz: ph.filesz, data: segData });
    segOffset = alignUp(segOffset + ph.filesz, 16);

    entryIdx += 2;
  }

  const fileSize  = segOffset;
  const totalSize = fileSize + (versionData ? versionData.length : 0);
  const out       = Buffer.alloc(totalSize, 0);

  // ── Write common header (8 bytes) ─────────────────────────────────────────
  let pos = 0;
  SELF_MAGIC.copy(out, pos);  pos += 4;
  out[pos++] = SELF_VERSION;
  out[pos++] = SELF_MODE;
  out[pos++] = SELF_ENDIAN;
  out[pos++] = SELF_ATTRIBS;

  // ── Write extended header (24 bytes) ─────────────────────────────────────
  out.writeUInt32LE(SELF_KEY_TYPE,  pos); pos += 4;
  out.writeUInt16LE(headerSize,     pos); pos += 2;
  out.writeUInt16LE(metaSize,       pos); pos += 2;
  out.writeBigUInt64LE(BigInt(fileSize), pos); pos += 8;
  out.writeUInt16LE(numEntries,     pos); pos += 2;
  out.writeUInt16LE(SELF_FLAGS,     pos); pos += 2;
  pos += 4; // padding — stays zero

  // ── Write entries (numEntries × 32 bytes) ─────────────────────────────────
  for (const e of entryDefs) {
    out.writeBigUInt64LE(e.props,          pos); pos += 8;
    out.writeBigUInt64LE(BigInt(e.offset), pos); pos += 8;
    out.writeBigUInt64LE(BigInt(e.filesz), pos); pos += 8;
    out.writeBigUInt64LE(BigInt(e.memsz),  pos); pos += 8;
  }

  // ── Write ELF headers (elfHdrAreaSize bytes, then align to 16) ───────────
  const elfHdrStart = pos;
  elfBuf.copy(out, pos, 0, elfHdrAreaSize);
  pos = alignUp(elfHdrStart + elfHdrAreaSize, 16);

  // ── Write ExInfo (64 bytes) ───────────────────────────────────────────────
  out.writeBigUInt64LE(paid,         pos); pos += 8;
  out.writeBigUInt64LE(BigInt(ptype), pos); pos += 8;
  out.writeBigUInt64LE(0n,            pos); pos += 8; // app_version
  out.writeBigUInt64LE(0n,            pos); pos += 8; // fw_version
  elfDigest.copy(out, pos);                pos += 32;

  // ── Write NPDRM control block (48 bytes) ──────────────────────────────────
  // type(2) + pad(14) + content_id(19, zeros) + random_pad(13, zeros)
  out.writeUInt16LE(0x3, pos); pos += 2;
  pos += 14; // padding
  pos += 19; // content_id (zeros)
  pos += 13; // random_pad (zeros)
  // pos should now == headerSize

  // ── Write meta blocks (numEntries × 80 zeros) ────────────────────────────
  pos += numEntries * 80;

  // ── Write meta footer (80 bytes): 48 zeros + uint32(0x10000) + 28 zeros ──
  pos += 48;
  out.writeUInt32LE(0x10000, pos); pos += 4;
  pos += 28;

  // ── Signature (256 zeros — already zero from Buffer.alloc) ───────────────
  pos += SIGNATURE_SIZE;
  // pos should now == headerSize + metaSize

  // ── Write segment data at their computed offsets ──────────────────────────
  for (const e of entryDefs) {
    if (e.data && e.data.length > 0) {
      e.data.copy(out, e.offset, 0, e.filesz);
    }
  }

  // ── Append PT_SCE_VERSION data after fileSize ─────────────────────────────
  if (versionData && versionData.length > 0) {
    versionData.copy(out, fileSize);
  }

  return out;
}

module.exports = { makeFself, PTYPE_FAKE };
