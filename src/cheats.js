'use strict';

const https = require('https');
const http  = require('http');
const log   = require('electron-log');

const INDEX_URL = 'https://raw.githubusercontent.com/TeeKay87/HEN-Cheats-Collection/master/cheats/json.txt';
const FILE_BASE = 'https://raw.githubusercontent.com/TeeKay87/HEN-Cheats-Collection/master/cheats/json/';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'Porkfolio/1.0' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400)
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

// Parse the json.txt index file into structured entries
async function fetchIndex() {
  log.info('[Cheats] Fetching index…');
  const raw  = await httpGet(INDEX_URL);
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eq       = trimmed.indexOf('=');
    const filename = trimmed.slice(0, eq).trim();
    const title    = trimmed.slice(eq + 1).trim();
    // Must be a .json file (case-insensitive)
    if (!/\.json$/i.test(filename)) continue;
    // Try to extract a CUSA-style ID (4 uppercase letters + 5 digits) from start
    const m       = filename.match(/^([A-Z]{4}\d{5})_(.+)\.json$/i);
    const cusaId  = m ? m[1].toUpperCase() : '';
    const version = m ? m[2] : filename.replace(/\.json$/i, '');
    entries.push({ filename, cusaId, version, title });
  }
  log.info(`[Cheats] Index loaded — ${entries.length} entries`);
  return entries;
}

// Download a single cheat JSON file
async function fetchCheatFile(filename) {
  const url  = FILE_BASE + filename;
  const body = await httpGet(url);
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new Error(`Invalid JSON in cheat file: ${filename}`);
  }
}

module.exports = { fetchIndex, fetchCheatFile };
