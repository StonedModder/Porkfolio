'use strict';
/**
 * test.js — Standalone test for ufs2ElectronModule
 * ──────────────────────────────────────────────────
 * Run:  node test.js [options]
 *
 * Options / Environment variables:
 *   --tool-path <path>   UFS2Tool.exe path (default: auto-detect)
 *   --input    <dir>     Source directory to pack (default: temp dummy)
 *   --output   <dir>     Output directory for test images (default: temp)
 *   --ps5                Use PS5-preset flags (makefs-ps5 / newfs-ps5)
 *   --method   makefs|newfs  Which command to test (default: makefs)
 *   --batch    <dir>     Folder of sub-dirs for batch test
 *   --skip-cleanup       Keep temp files after test
 *
 * Examples:
 *   node test.js
 *   node test.js --ps5 --method newfs
 *   node test.js --input C:\game\PPSA01234 --output C:\out --ps5
 *   node test.js --batch C:\games --output C:\out --ps5
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const ufs2    = require('./index');

// ─── CLI argument parser ──────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name)       { return argv.includes(name); }
function opt(name, def)   {
  const i = argv.indexOf(name);
  return (i !== -1 && argv[i + 1]) ? argv[i + 1] : def;
}

const TOOL_PATH    = opt('--tool-path', null);
const INPUT_DIR    = opt('--input',     null);
const OUTPUT_DIR   = opt('--output',    null);
const BATCH_DIR    = opt('--batch',     null);
const USE_PS5      = flag('--ps5');
const METHOD       = opt('--method',    'makefs');   // 'makefs' | 'newfs'
const SKIP_CLEANUP = flag('--skip-cleanup');

// ─── Helpers ─────────────────────────────────────────────────────────────

const SEP = '─'.repeat(60);

function pass(label, extra = '') {
  console.log(`  ✓  ${label}${extra ? '  — ' + extra : ''}`);
}

function fail(label, detail = '') {
  console.error(`  ✗  ${label}${detail ? '\n     ' + detail : ''}`);
}

function section(title) {
  console.log(`\n${SEP}`);
  console.log(`  ${title}`);
  console.log(SEP);
}

/** Create a small dummy directory tree for self-contained testing. */
function createDummyDir(baseDir) {
  const dir = path.join(baseDir, 'ufs2_test_input');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello.txt'),  'Hello from ufs2-electron-module test!\n');
  fs.writeFileSync(path.join(dir, 'data.bin'),   Buffer.alloc(1024, 0xAB));
  const sub = path.join(dir, 'subdir');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'nested.txt'), 'Nested file content.\n');
  return dir;
}

/** Create multiple dummy sub-dirs for batch test. */
function createDummyBatchDirs(baseDir, count = 3) {
  const root = path.join(baseDir, 'ufs2_batch_input');
  fs.mkdirSync(root, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const d = path.join(root, `PPSA0000${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'file.txt'), `Content for PPSA0000${i}\n`);
  }
  return root;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const tmpBase  = os.tmpdir();
  const outDir   = OUTPUT_DIR  ? path.resolve(OUTPUT_DIR)  : path.join(tmpBase, 'ufs2_test_output');
  const cleanup  = [];

  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n  ufs2-electron-module  Standalone Test');
  console.log(`  Method : ${USE_PS5 ? `${METHOD}-ps5 (PS5 preset)` : METHOD}`);

  // ── [0] Tool path ────────────────────────────────────────────────────────
  section('[0] Tool configuration');
  if (TOOL_PATH) ufs2.setToolPath(path.resolve(TOOL_PATH));
  const info = ufs2.moduleInfo();
  console.log(`  Tool   : ${info.toolPath}`);
  console.log(`  Found  : ${info.toolAvailable ? 'YES' : 'NO ← tests will fail without the exe'}`);
  console.log(`  Module : v${info.version}`);

  if (!info.toolAvailable) {
    console.warn('\n  WARNING: UFS2Tool.exe not found at the configured path.');
    console.warn('  Set the correct path with  --tool-path <abs-path>  or');
    console.warn('  ensure UFS2Tool/ is at the project root.\n');
  }

  // ── [1] Single image creation ────────────────────────────────────────────
  section('[1] Single image creation');
  let inputDir = INPUT_DIR ? path.resolve(INPUT_DIR) : null;
  let ownedInput = false;

  if (!inputDir) {
    inputDir   = createDummyDir(tmpBase);
    ownedInput = true;
    if (!SKIP_CLEANUP) cleanup.push(() => fs.rmSync(inputDir, { recursive: true, force: true }));
    console.log(`  Using dummy input dir: ${inputDir}`);
  }

  const singleOut = path.join(outDir, `test_single_${METHOD}.ffpkg`);
  if (!SKIP_CLEANUP) cleanup.push(() => { try { fs.unlinkSync(singleOut); } catch {} });

  console.log(`  Input  : ${inputDir}`);
  console.log(`  Output : ${singleOut}`);
  console.log('  Running...');

  let singleResult;
  if (METHOD === 'newfs') {
    singleResult = USE_PS5
      ? await ufs2.newfsPS5(inputDir, singleOut)
      : await ufs2.newfs(inputDir, singleOut);
  } else {
    singleResult = USE_PS5
      ? await ufs2.makefsPS5(inputDir, singleOut)
      : await ufs2.makefs(inputDir, singleOut);
  }

  if (singleResult.ok) {
    const stat = fs.existsSync(singleOut) ? fs.statSync(singleOut) : null;
    pass('Image created', stat ? `${(stat.size / 1024).toFixed(1)} KB` : 'file exists');
  } else {
    fail('Image creation failed', singleResult.stderr || singleResult.stdout || `exit ${singleResult.exitCode}`);
    if (singleResult.stderr && singleResult.stderr.includes('EACCES')) {
      console.warn('  NOTE: UFS2Tool.exe requires Administrator privileges.');
      console.warn('  Re-run this test in an elevated (Run as Administrator) terminal.');
    } else {
      console.log('  stdout:', singleResult.stdout);
      console.log('  stderr:', singleResult.stderr);
    }
  }
  console.log(`  Duration: ${singleResult.durationMs} ms`);

  // ── [2] info & ls on created image ──────────────────────────────────────
  if (singleResult.ok) {
    section('[2] Image inspection (info / ls)');

    const infoResult = await ufs2.info(singleOut);
    if (infoResult.ok || infoResult.stdout) {
      pass('info');
      if (infoResult.stdout) console.log(infoResult.stdout.split('\n').map((l) => '  ' + l).join('\n'));
    } else {
      fail('info', infoResult.stderr);
    }

    const lsResult = await ufs2.ls(singleOut);
    if (lsResult.ok || lsResult.stdout) {
      pass('ls /');
      if (lsResult.stdout) console.log(lsResult.stdout.split('\n').map((l) => '  ' + l).join('\n'));
    } else {
      fail('ls', lsResult.stderr);
    }

    // ── [3] fsck ───────────────────────────────────────────────────────────
    section('[3] Filesystem check (fsck -n read-only)');
    const fsckResult = await ufs2.fsck(singleOut, { mode: 'readonly' });
    if (fsckResult.ok || fsckResult.exitCode === 0) {
      pass('fsck -n clean');
    } else {
      fail('fsck', fsckResult.stderr || fsckResult.stdout);
    }

    // ── [4] Extract ─────────────────────────────────────────────────────────
    section('[4] Extract');
    const extractDir = path.join(outDir, 'test_extract');
    if (!SKIP_CLEANUP) cleanup.push(() => fs.rmSync(extractDir, { recursive: true, force: true }));
    const extractResult = await ufs2.extract(singleOut, extractDir);
    if (extractResult.ok) {
      pass('extract', extractDir);
    } else {
      fail('extract', extractResult.stderr);
    }
  }

  // ── [5] Batch creation ───────────────────────────────────────────────────
  section('[5] Batch image creation');

  let batchSrcDir = BATCH_DIR ? path.resolve(BATCH_DIR) : null;
  if (!batchSrcDir) {
    batchSrcDir = createDummyBatchDirs(tmpBase, 3);
    if (!SKIP_CLEANUP) cleanup.push(() => fs.rmSync(batchSrcDir, { recursive: true, force: true }));
    console.log(`  Using dummy batch source: ${batchSrcDir}`);
  }

  const batchOutDir = path.join(outDir, 'batch_output');
  fs.mkdirSync(batchOutDir, { recursive: true });
  if (!SKIP_CLEANUP) cleanup.push(() => fs.rmSync(batchOutDir, { recursive: true, force: true }));

  console.log(`  Source : ${batchSrcDir}`);
  console.log(`  Output : ${batchOutDir}`);
  console.log('  Running batch...\n');

  const batchResult = await ufs2.batchFromFolder(batchSrcDir, batchOutDir, {
    ps5:    USE_PS5,
    method: METHOD,
    onProgress: (current, total, item) => {
      const status = item.ok ? '✓' : '✗';
      const name   = path.basename(item.entry.inputDir || item.entry.imageFile || '?');
      console.log(`  [${current}/${total}] ${status}  ${name}  (${item.result.durationMs} ms)`);
    },
  });

  console.log();
  if (batchResult.succeeded > 0) {
    pass(`Batch done — ${batchResult.succeeded}/${batchResult.results.length} succeeded`, `${batchResult.durationMs} ms total`);
  }
  if (batchResult.failed > 0) {
    fail(`${batchResult.failed} batch item(s) failed`);
    batchResult.results.filter((r) => !r.ok).forEach((r) => {
      console.error(`     ${path.basename(r.entry.inputDir || '?')}: ${r.result.stderr || r.result.stdout}`);
    });
  }

  // ── [6] createBatchRunner (EventEmitter API) ─────────────────────────────
  section('[6] EventEmitter batch runner (batchFromFolder shortcut)');
  const runner = ufs2.createBatchRunner();
  let evtFired = false;
  runner.on('progress', ({ current, total }) => {
    evtFired = true;
    process.stdout.write(`  EventEmitter progress: ${current}/${total}\r`);
  });
  const runnerResult = await runner.runMakefs(
    [{ inputDir, outputFile: path.join(outDir, 'runner_test.ffpkg') }],
    { ps5: USE_PS5 }
  );
  if (!SKIP_CLEANUP) cleanup.push(() => { try { fs.unlinkSync(path.join(outDir, 'runner_test.ffpkg')); } catch {} });
  console.log();
  if (runnerResult.results.length > 0) {
    pass('createBatchRunner works', `progress event fired: ${evtFired}`);
  } else {
    fail('createBatchRunner returned empty results');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  section('Summary');
  console.log(`  Method  : ${USE_PS5 ? `${METHOD}-ps5` : METHOD}`);
  console.log(`  Single  : ${singleResult.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  Batch   : ${batchResult.failed === 0 ? 'PASS' : batchResult.succeeded + '/' + batchResult.results.length + ' passed'}`);
  console.log(`  Output  : ${outDir}`);
  if (SKIP_CLEANUP) {
    console.log('  Temp files kept (--skip-cleanup)');
  } else {
    cleanup.forEach((fn) => { try { fn(); } catch {} });
    console.log('  Temp files cleaned up.');
  }
  const runnerFailures = runnerResult.results.filter((r) => !r.ok).length;
  if (!singleResult.ok || batchResult.failed > 0 || runnerFailures > 0) {
    console.error('\n  One or more UFS2 integration checks failed.');
    process.exitCode = 1;
  }
  console.log();
}

main().catch((err) => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
