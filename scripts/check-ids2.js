'use strict';

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'renderer', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const ids = [
  'btn-clip-thumbs',
  's-media-discord-notify',
  's-time-format',
];

const missing = ids.filter((id) => !html.includes(`id="${id}"`) && !html.includes(`id='${id}'`));
for (const id of ids) console.log(`${id} -> ${missing.includes(id) ? 'missing' : 'found'}`);

if (missing.length) {
  console.error(`Missing required renderer IDs: ${missing.join(', ')}`);
  process.exit(1);
}
