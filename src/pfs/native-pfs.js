'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Native PS5 PFS / FFPFSC builder — a from-scratch JavaScript port of
// ps5-image-studio's lazy_mkpfs engine (Nazky's LazyMkPFS). No Python.
//
// Scope: the UNSIGNED path (PFS_MODE without SIGNED/ENCRYPTED), with optional
// per-block PFSC zlib compression — i.e. exactly the "FFPFSC" (compressed PFS)
// and raw-PFS formats. Signed/encrypted images and FPT hash-collision resolvers
// are intentionally out of scope (throw with a clear message).
//
// Byte layout ported 1:1 from lazy_mkpfs/{consts,types,compression,inspect,
// build,ampr_index}.py. A round-trip self-check (build → parse → extract →
// byte-compare) validates the whole pipeline without needing a real PS5.
//   node src/pfs/native-pfs.js --selfcheck
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');

// ── consts (subset) ──────────────────────────────────────────────────────────
const C = {
  PFS_MAGIC: 20130315,
  PFS_VERSION_PS5: 2,
  PFS_MODE_SIGNED: 0x1,
  PFS_MODE_64BIT_INODES: 0x2,
  PFS_MODE_ENCRYPTED: 0x4,
  PFS_MODE_CASE_INSENSITIVE: 0x8,
  INODE_MODE_O_READ: 0x001, INODE_MODE_O_EXEC: 0x004,
  INODE_MODE_G_READ: 0x008, INODE_MODE_G_EXEC: 0x020,
  INODE_MODE_U_READ: 0x040, INODE_MODE_U_EXEC: 0x100,
  INODE_MODE_DIR: 0x4000, INODE_MODE_FILE: 0x8000,
  INODE_FLAG_COMPRESSED: 0x1, INODE_FLAG_READONLY: 0x10, INODE_FLAG_INTERNAL: 0x20000,
  DIRENT_TYPE_FILE: 2, DIRENT_TYPE_DIRECTORY: 3, DIRENT_TYPE_DOT: 4, DIRENT_TYPE_DOTDOT: 5,
  INODE_D32_SIZE: 0xA8, MAX_DIRECT_BLOCKS: 12, MAX_INDIRECT_BLOCKS: 5,
  INT32_MAX: 0x7FFFFFFF,
  PFSC_MAGIC: 0x43534650, PFSC_UNK4: 0, PFSC_UNK8: 6,
  PFSC_LOGICAL_BLOCK_SIZE: 0x10000, PFSC_HEADER_SIZE: 0x30,
  PFSC_OFFSET_ENTRY_SIZE: 0x8, PFSC_BLOCK_OFFSETS_OFFSET: 0x400,
  PFSC_INITIAL_DATA_OFFSET: 0x10000,
};
C.INODE_RX_ONLY = C.INODE_MODE_O_READ | C.INODE_MODE_O_EXEC | C.INODE_MODE_G_READ |
                  C.INODE_MODE_G_EXEC | C.INODE_MODE_U_READ | C.INODE_MODE_U_EXEC;
C.PFSC_INITIAL_OFFSET_TABLE_CAPACITY = C.PFSC_INITIAL_DATA_OFFSET - C.PFSC_BLOCK_OFFSETS_OFFSET;

const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
const isAscii = (s) => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false; return true; };

// ── FPT hash (flat_path_table) ───────────────────────────────────────────────
function fptHash(name, caseInsensitive = true) {
  let h = 0;
  for (const ch of name) {
    const c = (caseInsensitive ? ch.toUpperCase() : ch).charCodeAt(0);
    h = (c + 31 * h) >>> 0;
  }
  return h >>> 0;
}

// ── Dirent serialization ─────────────────────────────────────────────────────
function direntEntSize(name) {
  let size = name.length + 17;
  const rem = size % 8;
  if (rem) size += 8 - rem;
  return size;
}
function direntBytes(inodeNumber, typeCode, name) {
  if (!isAscii(name)) throw new Error(`Filename ${JSON.stringify(name)} is non-ASCII; PFS is ASCII-only`);
  const entSize = direntEntSize(name);
  const buf = Buffer.alloc(entSize);
  buf.writeUInt32LE(inodeNumber >>> 0, 0);
  buf.writeInt32LE(typeCode, 4);
  buf.writeInt32LE(name.length, 8);
  buf.writeInt32LE(entSize, 12);
  buf.write(name, 16, 'ascii');
  return buf;
}

// ── Inode (unsigned D32, 0xA8 bytes) ─────────────────────────────────────────
function makeInode(number, mode, nlink, flags, size, sizeCompressed, blocks, timeSec) {
  return {
    number, mode, nlink, flags, size, sizeCompressed, blocks, timeSec,
    db: new Array(C.MAX_DIRECT_BLOCKS).fill(0),
    ib: new Array(C.MAX_INDIRECT_BLOCKS).fill(0),
  };
}
function inodeToBytesD32(ino) {
  const buf = Buffer.alloc(C.INODE_D32_SIZE);
  buf.writeUInt16LE(ino.mode & 0xFFFF, 0x00);
  buf.writeUInt16LE(ino.nlink & 0xFFFF, 0x02);
  buf.writeUInt32LE(ino.flags >>> 0, 0x04);
  buf.writeBigInt64LE(BigInt(ino.size), 0x08);
  buf.writeBigInt64LE(BigInt(ino.sizeCompressed), 0x10);
  const t = BigInt(ino.timeSec);
  buf.writeBigInt64LE(t, 0x18); buf.writeBigInt64LE(t, 0x20);
  buf.writeBigInt64LE(t, 0x28); buf.writeBigInt64LE(t, 0x30);
  // time_nsec ×4 (0x38..0x48), uid/gid (0x48/0x4C), unk1/unk2 (0x50/0x58) all zero
  buf.writeUInt32LE(ino.blocks >>> 0, 0x60);
  for (let i = 0; i < C.MAX_DIRECT_BLOCKS; i++)   buf.writeInt32LE(ino.db[i] | 0, 0x64 + i * 4);
  for (let i = 0; i < C.MAX_INDIRECT_BLOCKS; i++) buf.writeInt32LE(ino.ib[i] | 0, 0x94 + i * 4);
  return buf;
}

// ── PFS header block (unsigned) ──────────────────────────────────────────────
function buildInodeBlockSigS64(inodeBlockCount, blockSize, now) {
  const sig = Buffer.alloc(0x310);
  sig.writeUInt16LE(0, 0x00);
  sig.writeUInt16LE(1, 0x02);
  sig.writeUInt32LE(C.INODE_FLAG_READONLY >>> 0, 0x04); // unsigned → READONLY
  const sizeBytes = BigInt(inodeBlockCount * blockSize);
  sig.writeBigInt64LE(sizeBytes, 0x08);
  sig.writeBigInt64LE(sizeBytes, 0x10);
  const t = BigInt(now);
  sig.writeBigInt64LE(t, 0x18); sig.writeBigInt64LE(t, 0x20);
  sig.writeBigInt64LE(t, 0x28); sig.writeBigInt64LE(t, 0x30);
  sig.writeUInt32LE(inodeBlockCount >>> 0, 0x60);
  const dbBase = 0x68;
  for (let i = 0; i < 12; i++) {
    const block = i < inodeBlockCount ? (1 + i) : (i === 0 ? 1 : 0); // unsigned branch
    sig.writeBigInt64LE(BigInt(block), dbBase + i * 40 + 32);
  }
  // ib entries (5×) left zero at ibBase = dbBase + 12*40
  return sig;
}
function packPfsHeaderBlock({ blockSize, pfsVersion, mode, nblock, inodeCount, finalNdblock, inodeBlockCount, now }) {
  const hdr = Buffer.alloc(blockSize);
  hdr.writeBigInt64LE(BigInt(pfsVersion), 0x00);
  hdr.writeBigInt64LE(BigInt(C.PFS_MAGIC), 0x08);
  hdr.writeBigInt64LE(0n, 0x10);
  hdr.writeUInt8(0, 0x18); hdr.writeUInt8(0, 0x19); hdr.writeUInt8(1, 0x1A); hdr.writeUInt8(0, 0x1B);
  hdr.writeUInt16LE(mode & 0xFFFF, 0x1C);
  hdr.writeUInt16LE(0, 0x1E);
  hdr.writeUInt32LE(blockSize >>> 0, 0x20);
  hdr.writeUInt32LE(0, 0x24);
  hdr.writeBigInt64LE(BigInt(nblock), 0x28);
  hdr.writeBigInt64LE(BigInt(inodeCount), 0x30);
  hdr.writeBigInt64LE(BigInt(finalNdblock), 0x38);
  hdr.writeBigInt64LE(BigInt(inodeBlockCount), 0x40);
  buildInodeBlockSigS64(inodeBlockCount, blockSize, now).copy(hdr, 0x50);
  hdr.writeUInt32LE(1, 0x368); // unsigned/unencrypted flag slot
  return hdr;
}

// ── PFSC block compression ───────────────────────────────────────────────────
function pfscHeaderSize(blockCount, lbs) {
  const pointerTableSize = (blockCount + 1) * C.PFSC_OFFSET_ENTRY_SIZE;
  const extra = Math.max(0, pointerTableSize - C.PFSC_INITIAL_OFFSET_TABLE_CAPACITY);
  const extraBlocks = extra > 0 ? ceilDiv(extra, lbs) : 0;
  return C.PFSC_INITIAL_DATA_OFFSET + extraBlocks * lbs;
}
function encodePfscPayload(raw, thresholdGain, zlibLevel) {
  const lbs = C.PFSC_LOGICAL_BLOCK_SIZE;
  const blockCount = Math.ceil(raw.length / lbs);
  if (blockCount === 0) return { payload: Buffer.alloc(0), compressed: false };

  const encoded = [];
  let compressedBlocks = 0;
  for (let off = 0; off < raw.length; off += lbs) {
    let block = raw.subarray(off, off + lbs);
    const padded = block.length === lbs ? block : Buffer.concat([block, Buffer.alloc(lbs - block.length)]);
    const comp = zlib.deflateSync(padded, { level: zlibLevel });
    const gain = ((lbs - comp.length) / lbs) * 100;
    const store = comp.length < lbs && gain >= thresholdGain;
    if (store) compressedBlocks++;
    encoded.push(store ? comp : padded);
  }

  const headerSize = pfscHeaderSize(blockCount, lbs);
  const offsets = [headerSize];
  for (const b of encoded) offsets.push(offsets[offsets.length - 1] + b.length);

  const header = Buffer.alloc(headerSize);
  header.writeInt32LE(C.PFSC_MAGIC, 0x00);
  header.writeInt32LE(C.PFSC_UNK4, 0x04);
  header.writeInt32LE(C.PFSC_UNK8, 0x08);
  header.writeInt32LE(lbs, 0x0C);
  header.writeBigInt64LE(BigInt(lbs), 0x10);
  header.writeBigInt64LE(BigInt(C.PFSC_BLOCK_OFFSETS_OFFSET), 0x18);
  header.writeBigUInt64LE(BigInt(headerSize), 0x20);
  header.writeBigInt64LE(BigInt(blockCount * lbs), 0x28);
  for (let i = 0; i < offsets.length; i++) {
    header.writeBigUInt64LE(BigInt(offsets[i]), C.PFSC_BLOCK_OFFSETS_OFFSET + i * 8);
  }

  const payload = Buffer.concat([header, ...encoded]);
  if (compressedBlocks === 0 || payload.length >= raw.length) {
    return { payload: raw, compressed: false };
  }
  return { payload, compressed: true };
}

// Decode a PFSC payload back to logical bytes (for the round-trip self-check).
function decodePfscPayload(payload, expectedLogicalSize) {
  const lbs = payload.readInt32LE(0x0C);
  const magic = payload.readInt32LE(0x00);
  if (magic !== C.PFSC_MAGIC) throw new Error('bad PFSC magic');
  const dataOffset = Number(payload.readBigUInt64LE(0x20));
  const logicalSize = Number(payload.readBigInt64LE(0x28));
  const blockCount = logicalSize / lbs;
  const offsets = [];
  for (let i = 0; i <= blockCount; i++) offsets.push(Number(payload.readBigUInt64LE(C.PFSC_BLOCK_OFFSETS_OFFSET + i * 8)));
  if (offsets[0] !== dataOffset) throw new Error('PFSC offsets must start at data_offset');
  const out = [];
  for (let i = 0; i < blockCount; i++) {
    const stored = payload.subarray(offsets[i], offsets[i + 1]);
    if (stored.length === lbs) out.push(stored);
    else out.push(zlib.inflateSync(stored));
  }
  const logical = Buffer.concat(out);
  return expectedLogicalSize != null ? logical.subarray(0, expectedLogicalSize) : logical;
}

// ── executable/skip heuristic (ported from should_skip_executable_compression) ─
function shouldSkipCompression(name, relPath) {
  const n = name.toLowerCase(), p = relPath.toLowerCase();
  return (n.startsWith('eboot') && n.endsWith('.bin')) ||
         (n.startsWith('param') && n.endsWith('.sfx')) ||
         n.endsWith('.prx') || n.endsWith('.sprx') || n.endsWith('.json') ||
         n.endsWith('.txt') || n.endsWith('.png') || n.endsWith('keystone') ||
         p.includes('sce_module') || p.includes('sce_sys');
}

// ── AMPR index (only when fakelib/libSceAmpr.sprx present) ────────────────────
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const key = str.replace(/\\/g, '/').toLowerCase();
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h === 0n ? 1n : h;
}
function ensureAmprIndex(sourceRoot) {
  const indexPath = path.join(sourceRoot, 'ampr_emu.index');
  const sprx = path.join(sourceRoot, 'fakelib', 'libSceAmpr.sprx');
  if (fs.existsSync(indexPath) || !fs.existsSync(sprx)) return;
  // Collect files (sorted, case-insensitive), build AMPRIDX3 (see ampr_index.py).
  const rows = []; // { size, mtime, indexedPath }
  const seen = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(sourceRoot, full).replace(/\\/g, '/');
        const indexed = '/app0/' + rel;
        const key = indexed.toLowerCase();
        if (key === '/app0/ampr_emu.index' || seen.has(key)) continue;
        seen.add(key);
        const st = fs.statSync(full);
        rows.push({ size: st.size, mtime: Math.floor(st.mtimeMs / 1000), indexedPath: indexed });
      }
    }
  };
  walk(sourceRoot);
  if (!rows.length) return;
  rows.sort((a, b) => a.indexedPath.toLowerCase().localeCompare(b.indexedPath.toLowerCase()));

  const RECORD = 24, SLOT = 16, HEADER = 48;
  const pathBlob = [], records = [];
  for (const r of rows) {
    const enc = Buffer.from(r.indexedPath, 'utf8');
    const rec = Buffer.alloc(RECORD);
    rec.writeUInt32LE(pathBlob.reduce((s, b) => s + b.length, 0) >>> 0, 0);
    rec.writeUInt32LE(enc.length >>> 0, 4);
    rec.writeBigUInt64LE(BigInt(r.size), 8);
    rec.writeBigInt64LE(BigInt(r.mtime), 16);
    records.push(rec);
    pathBlob.push(Buffer.concat([enc, Buffer.from([0])]));
  }
  // open-addressed hash slots
  let slotCount = 2; const target = rows.length * 2;
  while (slotCount < target) slotCount <<= 1;
  const slots = new Array(slotCount).fill(null).map(() => ({ h: 0n, idx: 0, flags: 0 }));
  const mask = BigInt(slotCount - 1);
  rows.forEach((r, index) => {
    const h = fnv1a64(r.indexedPath);
    let pos = Number(h & mask);
    while (slots[pos].idx !== 0) {
      if (slots[pos].h === h) slots[pos].flags |= 1;
      pos = (pos + 1) & (slotCount - 1);
    }
    slots[pos] = { h, idx: index + 1, flags: 0 };
  });

  const recordsBuf = Buffer.concat(records);
  const pathBuf = Buffer.concat(pathBlob);
  const pathEnd = HEADER + recordsBuf.length + pathBuf.length;
  const hashOffset = (pathEnd + (SLOT - 1)) & ~(SLOT - 1);
  const padding = Buffer.alloc(hashOffset - pathEnd);
  const header = Buffer.alloc(HEADER);
  Buffer.from('AMPRIDX3', 'ascii').copy(header, 0);
  header.writeUInt32LE(3, 8);
  header.writeUInt32LE(RECORD, 12);
  header.writeBigUInt64LE(BigInt(rows.length), 16);
  header.writeBigUInt64LE(BigInt(pathBuf.length), 24);
  header.writeBigUInt64LE(BigInt(hashOffset), 32);
  header.writeUInt32LE(SLOT, 40);
  header.writeUInt32LE(slotCount, 44);
  const slotBufs = slots.map(s => {
    const b = Buffer.alloc(SLOT);
    b.writeBigUInt64LE(s.h & 0xFFFFFFFFFFFFFFFFn, 0);
    b.writeUInt32LE(s.idx >>> 0, 8);
    b.writeUInt32LE(s.flags >>> 0, 12);
    return b;
  });
  const tmp = indexPath + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([header, recordsBuf, pathBuf, padding, ...slotBufs]));
  fs.renameSync(tmp, indexPath);
}

// ── Tree scan ────────────────────────────────────────────────────────────────
function scanTree(root) {
  const files = []; // { rel, abs, parent, name, rawSize }
  const walk = (dir, relDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) files.push({ rel, abs, parent: relDir, name: e.name, rawSize: fs.statSync(abs).size });
    }
  };
  walk(root, '');
  for (const f of files) if (!isAscii(f.rel)) throw new Error(`Source has non-ASCII path (PFS is ASCII-only): ${f.rel}`);
  files.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));

  // Build dir map (posix rel_dir → node). Root is "".
  const dirs = new Map();
  dirs.set('', { relDir: '', name: 'uroot', parent: null, childDirs: [], childFiles: [] });
  for (const f of files) {
    const parts = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')).split('/') : [];
    let curr = '';
    for (const part of parts) {
      const next = curr ? curr + '/' + part : part;
      if (!dirs.has(next)) {
        dirs.set(next, { relDir: next, name: part, parent: curr, childDirs: [], childFiles: [] });
        dirs.get(curr).childDirs.push(next);
      }
      curr = next;
    }
    dirs.get(f.parent).childFiles.push(f.rel);
  }
  for (const d of dirs.values()) {
    d.childDirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    d.childFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }
  return { dirs, files };
}

// ── Main build ───────────────────────────────────────────────────────────────
function buildPfs(opts) {
  const {
    sourceDir, outputPath, compress = true, blockSize = 0x10000, zlibLevel = 6,
    thresholdGain = 0, caseInsensitive = false, onLog = () => {}, onProgress = () => {},
    isCancelled = () => false,
  } = opts;

  const source = path.resolve(sourceDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`Source not found: ${source}`);
  ensureAmprIndex(source);

  const now = Math.floor(Date.now() / 1000);
  onProgress({ phase: 'Scanning source…' });
  const { dirs, files } = scanTree(source);
  const dirNodes = [...dirs.values()].sort((a, b) => a.relDir.toLowerCase().localeCompare(b.relDir.toLowerCase()));

  // Decide storage per file (compress eligible → in-memory PFSC; else raw stream).
  // ponytail: compressible files are held in memory while packed; the big ones
  // (eboot/prx/sprx/png/json/sce_*) are skipped and streamed, so peak memory
  // stays bounded in practice. Full temp-spool streaming is the upgrade path.
  onProgress({ phase: 'Compressing…', total: files.length });
  let processed = 0;
  for (const f of files) {
    if (isCancelled()) throw new Error('Cancelled');
    let compressed = false, storedBuf = null, storedSize = f.rawSize;
    if (compress && f.rawSize > 0 && !shouldSkipCompression(f.name, f.rel)) {
      const raw = fs.readFileSync(f.abs);
      const enc = encodePfscPayload(raw, thresholdGain, zlibLevel);
      if (enc.compressed) { compressed = true; storedBuf = enc.payload; storedSize = enc.payload.length; }
    }
    f.compressed = compressed;
    f.storedBuf = storedBuf;        // set only when compressed
    f.storedSize = storedSize;
    onProgress({ phase: 'Compressing…', files: 1 });
    processed++;
  }

  // Inodes: super_root(0), fpt(1), uroot(2), non-root dirs, files.
  const inodes = [];
  const superRoot = makeInode(0, C.INODE_MODE_DIR | C.INODE_RX_ONLY, 1, C.INODE_FLAG_INTERNAL | C.INODE_FLAG_READONLY, blockSize, blockSize, 1, now);
  const fptInode  = makeInode(1, C.INODE_MODE_FILE | C.INODE_RX_ONLY, 1, C.INODE_FLAG_INTERNAL | C.INODE_FLAG_READONLY, 0, 0, 1, now);
  const uroot     = makeInode(2, C.INODE_MODE_DIR | C.INODE_RX_ONLY, 3, C.INODE_FLAG_READONLY, blockSize, blockSize, 1, now);
  inodes.push(superRoot, fptInode, uroot);
  const inodeByPath = new Map([['dir:', uroot]]);
  dirs.get('').inode = uroot;
  let nextNum = 3;
  const nonRootDirs = dirNodes.filter(d => d.relDir !== '');
  for (const d of nonRootDirs) {
    const ino = makeInode(nextNum++, C.INODE_MODE_DIR | C.INODE_RX_ONLY, 2, C.INODE_FLAG_READONLY, blockSize, blockSize, 1, now);
    d.inode = ino; inodeByPath.set('dir:' + d.relDir, ino); inodes.push(ino);
  }
  for (const f of files) {
    const flags = C.INODE_FLAG_READONLY | (f.compressed ? C.INODE_FLAG_COMPRESSED : 0);
    const blocks = f.storedSize > 0 ? Math.max(1, ceilDiv(f.storedSize, blockSize)) : 1;
    const sizeCompressed = f.compressed ? ceilDiv(f.rawSize, blockSize) * blockSize : f.storedSize;
    const ino = makeInode(nextNum++, C.INODE_MODE_FILE | C.INODE_RX_ONLY, 1, flags, f.storedSize, sizeCompressed, blocks, now);
    f.inode = ino; inodeByPath.set('file:' + f.rel, ino); inodes.push(ino);
  }

  // Dirents per directory.
  const fileByRel = new Map(files.map(f => [f.rel, f]));
  for (const d of dirNodes) {
    const thisIno = inodeByPath.get('dir:' + d.relDir);
    const parentIno = inodeByPath.get('dir:' + (d.parent != null ? d.parent : ''));
    d.dirents = [
      { n: thisIno.number, t: C.DIRENT_TYPE_DOT, name: '.' },
      { n: (d.relDir !== '' ? parentIno.number : thisIno.number), t: C.DIRENT_TYPE_DOTDOT, name: '..' },
    ];
    for (const cd of d.childDirs) { d.dirents.push({ n: dirs.get(cd).inode.number, t: C.DIRENT_TYPE_DIRECTORY, name: dirs.get(cd).name }); thisIno.nlink++; }
    for (const cf of d.childFiles) d.dirents.push({ n: fileByRel.get(cf).inode.number, t: C.DIRENT_TYPE_FILE, name: fileByRel.get(cf).name });
  }

  // Flat path table (throw on hash collision — unsupported here).
  const fptBlob = makeFptBlob(dirNodes, files, inodeByPath, caseInsensitive);
  fptInode.size = fptBlob.length; fptInode.sizeCompressed = fptBlob.length;
  fptInode.blocks = Math.max(1, ceilDiv(fptBlob.length, blockSize));

  const superRootDirents = [
    direntBytes(fptInode.number, C.DIRENT_TYPE_FILE, 'flat_path_table'),
    direntBytes(uroot.number, C.DIRENT_TYPE_DIRECTORY, 'uroot'),
  ];

  const inodeCount = inodes.length;
  const inodesPerBlock = Math.floor(blockSize / C.INODE_D32_SIZE);
  const inodeBlockCount = ceilDiv(inodeCount, inodesPerBlock);

  // all_nodes_data: uroot dir blob, non-root dir blobs, files.
  const dirBlob = (d) => Buffer.concat(d.dirents.map(e => direntBytes(e.n, e.t, e.name)));
  const nodes = []; // { inode, payloadSize, isDir, bytes|null, file|null }
  const rootBlob = dirBlob(dirs.get(''));
  nodes.push({ inode: uroot, payloadSize: rootBlob.length, isDir: true, bytes: rootBlob, file: null });
  for (const d of nonRootDirs) { const b = dirBlob(d); nodes.push({ inode: d.inode, payloadSize: b.length, isDir: true, bytes: b, file: null }); }
  for (const f of files) nodes.push({ inode: f.inode, payloadSize: f.storedSize, isDir: false, bytes: f.compressed ? f.storedBuf : null, file: f.compressed ? null : f });

  // Unsigned block layout.
  let ndblock = 1 + inodeBlockCount;
  superRoot.db[0] = ndblock; for (let i = 1; i < C.MAX_DIRECT_BLOCKS; i++) superRoot.db[i] = -1;
  ndblock += superRoot.blocks;
  fptInode.db[0] = ndblock; for (let i = 1; i < C.MAX_DIRECT_BLOCKS; i++) fptInode.db[i] = -1;
  ndblock += fptInode.blocks;
  ndblock += 1; // reserved empty block (would hold collision_resolver)
  for (const nd of nodes) {
    const blocks = nd.payloadSize > 0 ? Math.max(1, ceilDiv(nd.payloadSize, blockSize)) : 1;
    nd.inode.db[0] = ndblock; for (let i = 1; i < C.MAX_DIRECT_BLOCKS; i++) nd.inode.db[i] = -1;
    nd.inode.blocks = blocks;
    if (nd.isDir) { nd.inode.size = blocks * blockSize; nd.inode.sizeCompressed = nd.inode.size; }
    else if (!(nd.inode.flags & C.INODE_FLAG_COMPRESSED)) { nd.inode.size = nd.payloadSize; nd.inode.sizeCompressed = nd.payloadSize; }
    else { nd.inode.size = nd.payloadSize; } // compressed: sizeCompressed already logical-padded
    ndblock += blocks;
  }
  const finalNdblock = ndblock;
  if (finalNdblock > C.INT32_MAX) throw new Error('Image exceeds D32 block pointer limit');

  // Write the image (truncate then seek/write at computed offsets).
  const mode = (caseInsensitive ? C.PFS_MODE_CASE_INSENSITIVE : 0);
  const imageSize = finalNdblock * blockSize;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const tmp = path.resolve(outputPath) + '.tmp';
  onProgress({ phase: 'Writing image…', total: imageSize });
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.ftruncateSync(fd, imageSize);
    const hdr = packPfsHeaderBlock({ blockSize, pfsVersion: C.PFS_VERSION_PS5, mode, nblock: 1, inodeCount, finalNdblock, inodeBlockCount, now });
    fs.writeSync(fd, hdr, 0, hdr.length, 0);

    // Inode table.
    const inodeTable = Buffer.alloc(inodeBlockCount * blockSize);
    let pos = 0;
    for (const ino of inodes) {
      inodeToBytesD32(ino).copy(inodeTable, pos);
      pos += C.INODE_D32_SIZE;
      if ((pos % blockSize) > (blockSize - C.INODE_D32_SIZE)) pos += blockSize - (pos % blockSize);
    }
    fs.writeSync(fd, inodeTable, 0, inodeTable.length, blockSize);

    // Super-root dirents.
    fs.writeSync(fd, Buffer.concat(superRootDirents), 0, superRootDirents.reduce((s, b) => s + b.length, 0), superRoot.db[0] * blockSize);
    // FPT.
    fs.writeSync(fd, fptBlob, 0, fptBlob.length, fptInode.db[0] * blockSize);

    // Node payloads.
    let written = 0;
    for (const nd of nodes) {
      if (isCancelled()) throw new Error('Cancelled');
      const base = nd.inode.db[0] * blockSize;
      if (nd.bytes) { fs.writeSync(fd, nd.bytes, 0, nd.bytes.length, base); written += nd.bytes.length; }
      else {
        // Stream raw file to offset.
        const rfd = fs.openSync(nd.file.abs, 'r');
        try {
          const buf = Buffer.alloc(4 * 1024 * 1024);
          let off = 0, r;
          while ((r = fs.readSync(rfd, buf, 0, buf.length, off)) > 0) {
            fs.writeSync(fd, buf, 0, r, base + off);
            off += r; written += r;
            onProgress({ phase: 'Writing image…', bytes: r });
          }
        } finally { fs.closeSync(rfd); }
      }
    }
  } finally { fs.closeSync(fd); }

  fs.renameSync(tmp, path.resolve(outputPath));
  onLog(`Wrote PFS image (${(imageSize / 1048576).toFixed(1)} MB, ${files.length} files, ${inodeCount} inodes)`);
  return { output: path.resolve(outputPath), imageSize, inodeCount, fileCount: files.length, blockSize };
}

function makeFptBlob(dirNodes, files, inodeByPath, caseInsensitive) {
  const entries = [];
  for (const d of dirNodes) { if (d.relDir === '') continue; entries.push(['/' + d.relDir, inodeByPath.get('dir:' + d.relDir).number, true]); }
  for (const f of files) entries.push(['/' + f.rel, inodeByPath.get('file:' + f.rel).number, false]);
  const byHash = new Map();
  for (const e of entries) {
    const h = fptHash(e[0], caseInsensitive);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(e);
  }
  for (const v of byHash.values()) if (v.length > 1) throw new Error('FPT hash collision — not supported by the native builder yet');
  const hashMap = new Map();
  for (const [h, v] of byHash) { const [, num, isDir] = v[0]; hashMap.set(h, (num | (isDir ? 0x20000000 : 0)) >>> 0); }
  const sorted = [...hashMap.keys()].sort((a, b) => a - b);
  const fpt = Buffer.alloc(sorted.length * 8);
  sorted.forEach((h, i) => { fpt.writeUInt32LE(h >>> 0, i * 8); fpt.writeUInt32LE(hashMap.get(h) >>> 0, i * 8 + 4); });
  return fpt;
}

// ── Round-trip parser (validation only) ──────────────────────────────────────
function parseHeader(buf) {
  return {
    version: Number(buf.readBigInt64LE(0x00)),
    magic: Number(buf.readBigInt64LE(0x08)),
    readonly: buf.readUInt8(0x1A),
    mode: buf.readUInt16LE(0x1C),
    blockSize: buf.readUInt32LE(0x20),
    inodeCount: Number(buf.readBigInt64LE(0x30)),
    ndblock: Number(buf.readBigInt64LE(0x38)),
    inodeBlockCount: Number(buf.readBigInt64LE(0x40)),
  };
}
function parseInode(blob) {
  return {
    mode: blob.readUInt16LE(0x00), nlink: blob.readUInt16LE(0x02), flags: blob.readUInt32LE(0x04),
    size: Number(blob.readBigInt64LE(0x08)), sizeCompressed: Number(blob.readBigInt64LE(0x10)),
    blocks: blob.readUInt32LE(0x60),
    db: Array.from({ length: 12 }, (_, i) => blob.readInt32LE(0x64 + i * 4)),
    isDir: (blob.readUInt16LE(0x00) & C.INODE_MODE_DIR) !== 0,
    isFile: (blob.readUInt16LE(0x00) & C.INODE_MODE_FILE) !== 0,
    isCompressed: (blob.readUInt32LE(0x04) & C.INODE_FLAG_COMPRESSED) !== 0,
  };
}
function parseDirents(blob) {
  const out = []; let off = 0;
  while (off + 16 <= blob.length) {
    const inodeNumber = blob.readUInt32LE(off), type = blob.readInt32LE(off + 4),
          nameLen = blob.readInt32LE(off + 8), entSize = blob.readInt32LE(off + 12);
    if (inodeNumber === 0 && type === 0 && nameLen === 0 && entSize === 0) break;
    if (entSize < 17 || (entSize % 8) !== 0 || nameLen < 0 || nameLen > entSize - 16 || off + entSize > blob.length) break;
    out.push({ inodeNumber, type, name: blob.toString('ascii', off + 16, off + 16 + nameLen) });
    off += entSize;
  }
  return out;
}

module.exports = { buildPfs, encodePfscPayload, decodePfscPayload, fptHash, parseHeader, parseInode, parseDirents, C };

// ── Self-check: build a tiny tree, parse it back, extract & byte-compare ──────
if (require.main === module && process.argv.includes('--selfcheck')) {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfs-sc-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  const fileA = Buffer.from('HELLO'.repeat(50000));            // compressible
  const fileB = Buffer.from([1, 2, 3, 4, 5, 6, 7]);            // tiny raw
  const fileC = Buffer.from('x');                              // 1 byte
  fs.writeFileSync(path.join(src, 'sub', 'a.dat'), fileA);
  fs.writeFileSync(path.join(src, 'b.bin'), fileB);
  fs.writeFileSync(path.join(src, 'c.txt'), fileC);            // .txt → skipped from compression
  const outPath = path.join(tmp, 'out.pfs');
  const res = buildPfs({ sourceDir: src, outputPath: outPath, compress: true, zlibLevel: 6 });

  const img = fs.readFileSync(outPath);
  const hdr = parseHeader(img.subarray(0, 0x400));
  assert.strictEqual(hdr.magic, C.PFS_MAGIC, 'magic');
  assert.strictEqual(hdr.version, C.PFS_VERSION_PS5, 'version');
  assert.strictEqual(hdr.readonly, 1, 'readonly');
  assert.strictEqual(hdr.blockSize, 0x10000, 'block size');

  // Parse inode table.
  const inodesPerBlock = Math.floor(hdr.blockSize / C.INODE_D32_SIZE);
  const inodes = [];
  for (let bi = 0; bi < hdr.inodeBlockCount && inodes.length < hdr.inodeCount; bi++) {
    const block = img.subarray((1 + bi) * hdr.blockSize, (2 + bi) * hdr.blockSize);
    for (let i = 0; i < inodesPerBlock && inodes.length < hdr.inodeCount; i++) {
      inodes.push(parseInode(block.subarray(i * C.INODE_D32_SIZE, (i + 1) * C.INODE_D32_SIZE)));
    }
  }
  assert.strictEqual(inodes.length, res.inodeCount, 'inode count round-trips');

  // Walk from uroot (inode 2) and extract every file, comparing bytes.
  const readInodePayload = (ino) => {
    // stored_size = size (compressed) or size_compressed (uncompressed)
    const storedSize = ino.isCompressed ? ino.size : ino.sizeCompressed;
    const raw = Buffer.from(img.subarray(ino.db[0] * hdr.blockSize, ino.db[0] * hdr.blockSize + storedSize));
    if (!ino.isCompressed) return raw;
    // Logical payload is padded to a block multiple; the reference does not store
    // the exact raw size, so real data is a prefix of this padded output.
    return decodePfscPayload(raw, ino.sizeCompressed);
  };
  const expected = { 'sub/a.dat': fileA, 'b.bin': fileB, 'c.txt': fileC };
  const got = {};
  const walk = (inodeNum, prefix) => {
    const dirents = parseDirents(readInodePayload(inodes[inodeNum]));
    for (const de of dirents) {
      if (de.name === '.' || de.name === '..') continue;
      const rel = prefix ? prefix + '/' + de.name : de.name;
      if (de.type === C.DIRENT_TYPE_DIRECTORY) walk(de.inodeNumber, rel);
      else got[rel] = readInodePayload(inodes[de.inodeNumber]);
    }
  };
  walk(2, '');
  for (const k of Object.keys(expected)) {
    const src = expected[k];
    assert.ok(got[k], `extracted ${k}`);
    assert.ok(got[k].subarray(0, src.length).equals(src), `real bytes round-trip for ${k}`);
    assert.ok(got[k].subarray(src.length).every(b => b === 0), `only zero padding after data for ${k}`);
  }
  // At least one file should have chosen PFSC compression.
  assert.ok(inodes.some(i => i.isCompressed), 'a.dat stored compressed');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('native-pfs selfcheck OK —', JSON.stringify(res));
}
