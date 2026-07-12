'use strict';

// ── Auto-Backpork Pipeline Processor ──────────────────────────────────────────
//
// 1:1 Node.js port of Auto-Backpork/Backport.py (NazkyYT).
//
// Files are identified by MAGIC BYTES (not extension), matching the original:
//   \x7FELF            → unsigned ELF  → patch SDK → fake-sign → output SELF
//   PS4/PS5 SELF magic → fake SELF     → extract ELF → patch SDK → fake-sign → output SELF
//   anything else      → skipped entirely (no copy, no output)
//   .bak files         → always skipped
//
// Output folder contains ONLY the processed SELF files preserving relative paths,
// plus the fakelib directory if provided.
// The libc.prx patch is applied AFTER signing, on the SELF output files.

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');

const { ELF_MAGIC, PS4_SELF_MAGIC, PS5_SELF_MAGIC,
        patchElfBuffer, SDK_VERSION_PAIRS } = require('./sdk-patcher');
const { extractElf }     = require('./decrypt-fself');
const { makeFself, PTYPE_FAKE } = require('./make-fself');

// ── libc.prx byte patch (SDK pairs 1-6 need it, 7-10 need it reverted) ───────
const LIBC_PATTERN     = Buffer.from('4h6F1LLbTiw#A#B', 'ascii');
const LIBC_REPLACEMENT = Buffer.from('IWIBBdTHit4#A#B', 'ascii');

/** Apply or revert the libc.prx patch in a Buffer (returns new Buffer). */
function applyLibcPatch(buf, apply = true) {
  const from = apply ? LIBC_PATTERN     : LIBC_REPLACEMENT;
  const to   = apply ? LIBC_REPLACEMENT : LIBC_PATTERN;
  if (!buf.includes(from)) return null; // pattern not found
  // Replace all occurrences
  let result = buf;
  let idx;
  while ((idx = result.indexOf(from)) !== -1) {
    const tmp = Buffer.from(result);
    to.copy(tmp, idx);
    result = tmp;
  }
  return result;
}

/** Walk a directory recursively, yielding file paths. */
function* walkDir(dir, skipDirs = new Set()) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDirs.has(e.name.toLowerCase())) yield* walkDir(full, skipDirs);
    } else {
      yield full;
    }
  }
}

// Extensions that PS5 ELF/SELF executables actually use.
// No-extension files are excluded — PS5 executables always have one of these.
// This avoids opening thousands of shader/data files (e.g. Returnal).
const CANDIDATE_EXTS = new Set(['.bin', '.elf', '.self', '.prx', '.sprx']);

/** Determine whether a file is ELF or SELF from its first 4 bytes.
 *  Returns 'skip' immediately if the extension rules it out. */
function detectType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CANDIDATE_EXTS.has(ext)) return 'other';
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf.equals(ELF_MAGIC))      return 'elf';
    if (buf.equals(PS4_SELF_MAGIC)) return 'self';
    if (buf.equals(PS5_SELF_MAGIC)) return 'self';
    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * Process a game source folder through the Auto-Backpork pipeline.
 *
 * @param {object} opts
 * @param {string}   opts.sourceDir      — game's existing backup folder (input)
 * @param {string}   opts.outputDir      — where to write the processed game folder
 * @param {number}   opts.sdkPair        — 1-10
 * @param {bigint|number} [opts.paid]    — PAID (default 0x3100000000000002)
 * @param {number}   [opts.ptype]        — program type (default PTYPE_FAKE)
 * @param {string}   [opts.fakelibDir]   — path to fakelib/ SPRX folder (optional)
 * @param {boolean}  [opts.applyLibcPatch=true]
 * @param {Function} [opts.onProgress]   — ({ step, file, msg }) callback
 * @param {Function} [opts.isCancelled]  — () => boolean
 * @returns {{ ok: number, failed: number, skipped: number, files: object[] }}
 */
async function processGame(opts) {
  const {
    sourceDir,
    outputDir,
    sdkPair,
    paid     = 0x3100000000000002n,
    ptype    = PTYPE_FAKE,
    fakelibDir = null,
    applyLibcPatch: doLibcPatch = true,
    onProgress  = () => {},
    isCancelled = () => false,
  } = opts;

  if (!SDK_VERSION_PAIRS[sdkPair]) throw new Error(`Unknown SDK pair: ${sdkPair}`);
  const [ps5Ver, ps4Ver] = SDK_VERSION_PAIRS[sdkPair];

  const results = { ok: 0, failed: 0, skipped: 0, files: [] };

  await fsp.mkdir(outputDir, { recursive: true });

  // ── Walk ALL files; identify ELF/SELF by magic bytes (matching original) ──
  // .bak / .esbak backup files and the 'decrypted' subfolder are always skipped.
  const isBackupFile = f => f.endsWith('.bak') || f.endsWith('.esbak');

  onProgress({ step: 'scan', file: '', msg: 'Scanning game folder…' });

  // Walk files with candidate extensions only — skips thousands of
  // .pak / .ucas / .utoc / shader files etc. without opening them at all.
  // Emits periodic progress so large directories (e.g. Returnal) never look frozen.
  const allFiles = [];
  let scanned = 0;
  for (const f of walkDir(sourceDir, new Set(['decrypted']))) {
    if (isBackupFile(f)) { scanned++; continue; }
    const ext = path.extname(f).toLowerCase();
    if (CANDIDATE_EXTS.has(ext)) allFiles.push(f);
    scanned++;
    if (scanned % 500 === 0) {
      onProgress({ step: 'scan', file: '', msg: `Scanning… ${scanned.toLocaleString()} entries checked, ${allFiles.length} candidates so far` });
    }
  }

  onProgress({ step: 'scan', file: '', msg: `Found ${allFiles.length} candidate file(s) in ${scanned.toLocaleString()} total entries, verifying magic bytes…` });

  // Magic-byte check only the small candidate set (type cached — no double-open).
  const elfSelfFiles = []; // [{ srcPath, fileType }]
  for (const f of allFiles) {
    const t = detectType(f);
    if (t === 'elf' || t === 'self') elfSelfFiles.push({ srcPath: f, fileType: t });
  }

  onProgress({ step: 'inventory', totalFiles: elfSelfFiles.length, executableFiles: elfSelfFiles.length });

  for (let fileIndex = 0; fileIndex < elfSelfFiles.length; fileIndex++) {
    const { srcPath, fileType } = elfSelfFiles[fileIndex];
    if (isCancelled()) break;

    const rel      = path.relative(sourceDir, srcPath);
    const dstPath  = path.join(outputDir, rel);
    const progressBase = { file: rel, fileIndex: fileIndex + 1, totalFiles: elfSelfFiles.length };

    // Non-fatal: if the file vanished/locked between scan and now, let the per-file
    // try/catch below fail just this file instead of aborting the whole game.
    let fileSizeMb = '?';
    try { fileSizeMb = (fs.statSync(srcPath).size / 1048576).toFixed(1); } catch {}
    onProgress({ step: 'process', ...progressBase, msg: `Processing ${rel} (${fileType}, ${fileSizeMb} MB)`, fileType });

    try {
      await fsp.mkdir(path.dirname(dstPath), { recursive: true });

      // 1. Get an ELF buffer — decrypt fake SELF wrapper if needed
      let elfBuf;
      if (fileType === 'self') {
        onProgress({ step: 'decrypt', ...progressBase, msg: `Reading ${fileSizeMb} MB SELF…` });
        const selfBuf = await fsp.readFile(srcPath);
        onProgress({ step: 'decrypt', ...progressBase, msg: 'Extracting ELF from SELF…' });
        elfBuf = extractElf(selfBuf);
      } else {
        onProgress({ step: 'patch', ...progressBase, msg: `Reading ${fileSizeMb} MB ELF…` });
        elfBuf = Buffer.from(await fsp.readFile(srcPath));
      }

      // 2. Patch SDK version fields in ELF (in-place on buffer)
      onProgress({ step: 'patch', ...progressBase, msg: 'Patching SDK version…' });
      const patchResult = patchElfBuffer(elfBuf, ps5Ver, ps4Ver);
      if (!patchResult.ok) {
        onProgress({ step: 'warn', ...progressBase, msg: `SDK patch: ${patchResult.msg}` });
        results.files.push({ path: rel, status: 'warn', msg: patchResult.msg });
      } else {
        onProgress({ step: 'patch', ...progressBase, msg: patchResult.msg });
      }

      // 3. Fake-sign patched ELF → SELF
      onProgress({ step: 'sign', ...progressBase, msg: 'Creating fake-signed SELF…' });
      const selfOut = makeFself(elfBuf, { paid, ptype });
      onProgress({ step: 'sign', ...progressBase, msg: `Writing ${(selfOut.length / 1048576).toFixed(1)} MB output…` });
      await fsp.writeFile(dstPath, selfOut);

      results.ok++;
      results.files.push({ path: rel, status: 'ok' });
    } catch (err) {
      onProgress({ step: 'error', ...progressBase, msg: err.message });
      results.files.push({ path: rel, status: 'error', msg: err.message });
      results.failed++;
    }
  }

  if (isCancelled()) return results;

  // ── libc.prx patch / revert on SELF files in output ─────────────────────
  if (doLibcPatch) {
    const applyPatch = sdkPair <= 6;
    // Identify SELF files in output by magic bytes — same approach as original
    const libcTargets = [...walkDir(outputDir, new Set(['decrypted', 'sce_sys', 'fakelib']))]
      .filter(outPath => !isBackupFile(outPath) && detectType(outPath) === 'self');
    onProgress({
      step: 'libc',
      file: '',
      msg: applyPatch ? 'Applying libc.prx patch…' : 'Reverting libc.prx patch (SDK > 6)…',
      totalFiles: libcTargets.length,
    });

    for (let libcIndex = 0; libcIndex < libcTargets.length; libcIndex++) {
      if (isCancelled()) break;
      const outPath = libcTargets[libcIndex];

      try {
        const buf     = await fsp.readFile(outPath);
        const patched = applyLibcPatch(buf, applyPatch);
        if (patched) {
          await fsp.writeFile(outPath, patched);
          onProgress({
            step: 'libc-progress',
            file: path.relative(outputDir, outPath),
            msg: applyPatch ? 'libc patch applied' : 'libc patch reverted',
            fileIndex: libcIndex + 1,
            totalFiles: libcTargets.length,
          });
        } else {
          onProgress({
            step: 'libc-progress',
            file: path.relative(outputDir, outPath),
            msg: 'No libc pattern found',
            fileIndex: libcIndex + 1,
            totalFiles: libcTargets.length,
          });
        }
      } catch { /* non-fatal */ }
    }
  }

  if (isCancelled()) return results;

  // ── Copy fakelib into output (1:1 with Nazky's _copy_fakelib +
  //    _copy_fakelib_to_eboot_dirs) ─────────────────────────────────────────
  if (fakelibDir && fs.existsSync(fakelibDir)) {
    onProgress({ step: 'fakelib', file: '', msg: 'Copying fakelib…' });

    // Helper: copy fakelib dir to a destination path
    async function copyFakelibTo(destDir) {
      const files = [...walkDir(fakelibDir)];
      await fsp.mkdir(destDir, { recursive: true });
      for (const src of files) {
        if (isCancelled()) break;
        const rel = path.relative(fakelibDir, src);
        const dst = path.join(destDir, rel);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
      }
    }

    try {
      // Step 1: copy fakelib to output root
      await copyFakelibTo(path.join(outputDir, 'fakelib'));
      onProgress({ step: 'fakelib', file: '', msg: 'fakelib copied to output root' });

      // Step 2: also copy fakelib beside every eboot.bin in a subdirectory
      // (matches Nazky's _copy_fakelib_to_eboot_dirs)
      for (const outFile of walkDir(outputDir, new Set(['fakelib']))) {
        if (path.basename(outFile).toLowerCase() !== 'eboot.bin') continue;
        const ebootDir = path.dirname(outFile);
        if (ebootDir === outputDir) continue; // root already handled above
        if (isCancelled()) break;
        try {
          await copyFakelibTo(path.join(ebootDir, 'fakelib'));
          onProgress({ step: 'fakelib', file: '', msg: `fakelib copied beside ${path.relative(outputDir, outFile)}` });
        } catch (err) {
          onProgress({ step: 'warn', file: '', msg: `fakelib copy to ${path.relative(outputDir, ebootDir)} failed: ${err.message}` });
        }
      }
    } catch (err) {
      onProgress({ step: 'warn', file: '', msg: `fakelib copy failed: ${err.message}` });
    }
  }

  return results;
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { processGame, SDK_VERSION_PAIRS };
