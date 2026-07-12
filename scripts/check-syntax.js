'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const skipDirs = new Set(['.git', 'node_modules', 'dist', 'output', '.playwright-cli', 'coverage']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
}

walk(root);

let failures = 0;
for (const file of files.sort()) {
  const code = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const isModule = /^\s*(?:import|export)\s/m.test(code);
  const result = isModule
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8' })
    : spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });

  if (result.status !== 0) {
    failures += 1;
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    console.error(`Syntax check failed: ${rel}`);
    if (output) console.error(output);
  }
}

if (failures) {
  console.error(`JavaScript syntax check failed for ${failures}/${files.length} files.`);
  process.exit(1);
}

console.log(`JavaScript syntax check passed (${files.length} files).`);
