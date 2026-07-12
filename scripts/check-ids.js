'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rendererDir = path.join(root, 'renderer');
const htmlPath = path.join(rendererDir, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const definedIds = new Set();
const idAttrRe = /\bid\s*=\s*["']([^"'${}<>\s]+)["']/g;
let match;
while ((match = idAttrRe.exec(html)) !== null) definedIds.add(match[1]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'output') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(rendererDir).filter((file) => !file.endsWith(`${path.sep}Originalrenderer.js`));

// IDs can be declared by renderer-created modal/template HTML. Count those too
// so this check focuses on genuinely missing hard-coded references.
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  while ((match = idAttrRe.exec(code)) !== null) definedIds.add(match[1]);
}

const referencePatterns = [
  /\$\(\s*["']([^"'${}<>\s]+)["']\s*\)(?=\s*(?:\.|\?|;|,|\)|\]))/g,
  /document\.getElementById\(\s*["']([^"'${}<>\s]+)["']\s*\)/g,
  /querySelector\(\s*["']#([A-Za-z_][\w:-]*)/g,
  /querySelectorAll\(\s*["']#([A-Za-z_][\w:-]*)/g,
];

const refs = new Map();
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  for (const re of referencePatterns) {
    while ((match = re.exec(code)) !== null) {
      const id = match[1];
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id).push(rel);
    }
  }
}

const missing = [...refs.entries()]
  .filter(([id]) => !definedIds.has(id))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length) {
  console.error(`Missing renderer IDs (${missing.length}):`);
  for (const [id, locations] of missing) {
    console.error(`  ${id} -> ${[...new Set(locations)].slice(0, 5).join(', ')}`);
  }
  process.exit(1);
}

console.log(`Renderer ID check passed (${refs.size} referenced IDs, ${definedIds.size} defined IDs).`);
