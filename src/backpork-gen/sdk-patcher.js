'use strict';

// ── PS5 SDK Version Patcher ────────────────────────────────────────────────────
// Ports Auto-Backpork/src/ps5_sdk_version_patcher.py (by idlesauce / NazkyYT)
// to pure Node.js Buffer operations — no Python required.

const ELF_MAGIC      = Buffer.from([0x7F, 0x45, 0x4C, 0x46]); // \x7FELF
const PS4_SELF_MAGIC = Buffer.from([0x4F, 0x15, 0x3D, 0x1D]);
const PS5_SELF_MAGIC = Buffer.from([0x54, 0x14, 0xF5, 0xEE]);

// Built-in SDK version pairs { pair# → [ps5Ver, ps4Ver] }
// These are the 10 known pairs from the Auto-Backpork project.
// Additional pairs can be added via customSdkPairs in app settings.
const BUILTIN_SDK_VERSION_PAIRS = {
  1:  [0x01000050, 0x07590001],
  2:  [0x02000009, 0x08050001],
  3:  [0x03000027, 0x08540001],
  4:  [0x04000031, 0x09040001],
  5:  [0x05000033, 0x09590001],
  6:  [0x06000038, 0x10090001],
  7:  [0x07000038, 0x10590001],
  8:  [0x08000041, 0x11090001],
  9:  [0x09000040, 0x11590001],
  10: [0x10000040, 0x12090001],
};

/**
 * Merge built-in pairs with any user-defined custom pairs.
 * customPairs format: { "11": [ps5VerHex, ps4VerHex], ... }
 * Custom entries override built-ins for the same pair number.
 */
function buildSdkVersionPairs(customPairs = {}) {
  const merged = { ...BUILTIN_SDK_VERSION_PAIRS };
  for (const [key, val] of Object.entries(customPairs)) {
    const num = parseInt(key, 10);
    if (!Number.isFinite(num) || num < 1) continue;
    if (!Array.isArray(val) || val.length < 2) continue;
    merged[num] = [Number(val[0]), Number(val[1])];
  }
  return merged;
}

// Default export uses only built-ins; callers that support custom pairs
// should call buildSdkVersionPairs(store.get('customSdkPairs', {})) instead.
const SDK_VERSION_PAIRS = BUILTIN_SDK_VERSION_PAIRS;

// ELF program-header table locations (inside ELF header)
const PHT_OFFSET_OFFSET = 0x20;   // uint64 LE — offset of PHT
const PHT_COUNT_OFFSET  = 0x38;   // uint16 LE — number of PHT entries

// Per-entry offsets (each entry is 0x38 = 56 bytes)
const PHDR_ENTRY_SIZE   = 0x38;
const PHDR_TYPE_OFF     = 0x00;   // uint32 LE
const PHDR_OFFSET_OFF   = 0x08;   // uint64 LE — file offset of segment data

// SCE segment types that hold SDK version info
const PT_SCE_PROCPARAM    = 0x61000001;
const PT_SCE_MODULE_PARAM = 0x61000002;

// Offsets inside the SCE param struct (relative to segment file offset)
const SCE_PARAM_MAGIC_OFF  = 0x08;   // uint32 LE — magic sanity check
const SCE_PARAM_PS4_OFF    = 0x10;   // uint32 LE — PS4 SDK version
const SCE_PARAM_PS5_OFF    = 0x14;   // uint32 LE — PS5 SDK version

const SCE_PROCPARAM_MAGIC   = 0x4942524F;
const SCE_MODULE_PARAM_MAGIC = 0x3C13F4BF;

// Supported file extensions for scanning
const EXECUTABLE_EXTS = new Set(['.bin', '.elf', '.self', '.prx', '.sprx']);

/**
 * Patch SDK version bytes directly inside an ELF Buffer (in-place).
 * @param {Buffer} buf  — mutable Buffer containing ELF data
 * @param {number} ps5Ver — PS5 SDK version (uint32)
 * @param {number} ps4Ver — PS4 SDK version (uint32)
 * @returns {{ ok: boolean, msg: string }}
 */
function patchElfBuffer(buf, ps5Ver, ps4Ver) {
  // Validate magic
  if (!buf.slice(0, 4).equals(ELF_MAGIC)) {
    if (buf.slice(0, 4).equals(PS4_SELF_MAGIC) || buf.slice(0, 4).equals(PS5_SELF_MAGIC)) {
      return { ok: false, msg: 'Skipping SELF file — must be unsigned ELF' };
    }
    return { ok: false, msg: 'Not an ELF file (bad magic)' };
  }

  const phtOffset = Number(buf.readBigUInt64LE(PHT_OFFSET_OFFSET));
  const phnum     = buf.readUInt16LE(PHT_COUNT_OFFSET);
  let patched = false;

  for (let i = 0; i < phnum; i++) {
    const base    = phtOffset + i * PHDR_ENTRY_SIZE;
    const segType = buf.readUInt32LE(base + PHDR_TYPE_OFF);

    if (segType !== PT_SCE_PROCPARAM && segType !== PT_SCE_MODULE_PARAM) continue;

    const segOff  = Number(buf.readBigUInt64LE(base + PHDR_OFFSET_OFF));
    const paramSz = buf.readUInt32LE(segOff);

    // Empty module param is OK — skip silently and keep looking for PROCPARAM
    if (paramSz === 0 && segType === PT_SCE_MODULE_PARAM) continue;

    if (paramSz < SCE_PARAM_PS5_OFF + 4) {
      return { ok: false, msg: `Unexpected param size 0x${paramSz.toString(16)}` };
    }

    const magic = buf.readUInt32LE(segOff + SCE_PARAM_MAGIC_OFF);
    const expectedMagic = segType === PT_SCE_PROCPARAM ? SCE_PROCPARAM_MAGIC : SCE_MODULE_PARAM_MAGIC;
    if (magic !== expectedMagic) {
      return { ok: false, msg: `Invalid param magic 0x${magic.toString(16).padStart(8, '0')}` };
    }

    buf.writeUInt32LE(ps5Ver, segOff + SCE_PARAM_PS5_OFF);
    buf.writeUInt32LE(ps4Ver, segOff + SCE_PARAM_PS4_OFF);
    patched = true;
  }

  if (!patched) return { ok: false, msg: 'No SCE param segment found' };
  return { ok: true, msg: 'SDK version patched' };
}

module.exports = { SDK_VERSION_PAIRS, BUILTIN_SDK_VERSION_PAIRS, buildSdkVersionPairs, patchElfBuffer, ELF_MAGIC, PS4_SELF_MAGIC, PS5_SELF_MAGIC, EXECUTABLE_EXTS };
