'use strict';
const fs   = require('fs');
const path = require('path');

// ── Exact copy of convFindGameRoot from main.js ──────────────────────────────
function convFindGameRoot(dir) {
  const MAX_DEPTH = 5;
  const queue = [{ absPath: dir, depth: 0 }];
  let found = null;

  while (queue.length) {
    const { absPath, depth } = queue.shift();

    if (fs.existsSync(path.join(absPath, 'eboot.bin'))) {
      if (found && found !== absPath) return null; // ambiguous
      found = absPath;
      continue;
    }

    if (depth < MAX_DEPTH) {
      try {
        for (const e of fs.readdirSync(absPath, { withFileTypes: true })) {
          let isDir = e.isDirectory();
          if (!isDir && !e.isFile()) {
            try { isDir = fs.statSync(path.join(absPath, e.name)).isDirectory(); } catch (_) { isDir = false; }
          }
          if (isDir) queue.push({ absPath: path.join(absPath, e.name), depth: depth + 1 });
        }
      } catch (_) {}
    }
  }
  return found;
}

// ── Test every game folder ────────────────────────────────────────────────────
const GAMES_DIR = 'G:\\4TB_GAMES\\PS5\\Games';

let entries;
try { entries = fs.readdirSync(GAMES_DIR, { withFileTypes: true }); }
catch (e) { console.error('Cannot read games dir:', e.message); process.exit(1); }

const folders = entries.filter(e => {
  let isDir = e.isDirectory();
  if (!isDir && !e.isFile()) {
    try { isDir = fs.statSync(path.join(GAMES_DIR, e.name)).isDirectory(); } catch (_) {}
  }
  return isDir;
});

console.log(`Found ${folders.length} game folders in ${GAMES_DIR}\n`);

let ok = 0, fail = 0;
for (const f of folders) {
  const gamePath = path.join(GAMES_DIR, f.name);
  const root = convFindGameRoot(gamePath);
  if (root) {
    const rel = path.relative(gamePath, root) || '(folder root)';
    console.log(`✓  ${f.name}`);
    console.log(`   game_path  : ${gamePath}`);
    console.log(`   copyFrom   : ${root}  [${rel}]`);
    console.log(`   eboot.bin  : ${path.join(root, 'eboot.bin')}`);
    ok++;
  } else {
    console.log(`✗  ${f.name}`);
    console.log(`   game_path  : ${gamePath}`);
    console.log(`   RESULT     : eboot.bin NOT FOUND (null)`);
    // Show top 2 levels so we can see the actual structure
    try {
      for (const sub of fs.readdirSync(gamePath, { withFileTypes: true }).slice(0, 10)) {
        const subPath = path.join(gamePath, sub.name);
        let isDir = sub.isDirectory();
        if (!isDir && !sub.isFile()) { try { isDir = fs.statSync(subPath).isDirectory(); } catch (_) {} }
        console.log(`   ${isDir ? 'DIR ' : 'FILE'} ${sub.name}`);
        if (isDir) {
          try {
            for (const sub2 of fs.readdirSync(subPath, { withFileTypes: true }).slice(0, 5)) {
              console.log(`        ${sub2.name}`);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    fail++;
  }
  console.log();
}

console.log(`─────────────────────────────────`);
console.log(`PASS: ${ok}  FAIL: ${fail}`);
