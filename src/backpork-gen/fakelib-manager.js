'use strict';

// ── Fakelib Manager — Core Logic ─────────────────────────────────────────────
// Handles obtaining fakelib (.sprx/.prx) files from decrypted PS5 firmware PUPs.
//
// Pipeline (adapted from PS5-BACKPORK-KITCHEN by rajeshca911):
//   1. Ensure ps5-pup-unpacker tool is present (auto-download from GitHub)
//   2. User provides a decrypted .PUP.dec file (decrypted on jailbroken PS5
//      using ps5_pup_decrypt.elf — see https://github.com/zecoxao/ps5-pup-decrypt)
//   3. Run ps5-pup-unpacker to extract contents
//   4. Collect all .sprx / .prx libraries found in the extraction tree
//   5. Copy them to baseDir/<pair>/ (numbered by SDK pair 1–10)
//
// Fakelibs cannot be distributed directly — they must be extracted from
// official Sony firmware the user already has legal access to.

const https    = require('https');
const { spawn } = require('child_process');
const fs       = require('fs');
const path     = require('path');

const TOOL_FILENAME    = 'ps5-pup-unpacker.exe';
const GITHUB_API_URL   = 'https://api.github.com/repos/zecoxao/ps5-pup-unpacker/releases/latest';
const MANUAL_DL_URL    = 'https://www.psx-place.com/resources/ps5-pup-decrypter-and-unpacker.1449/';
module.exports = {
  TOOL_FILENAME,
  MANUAL_DL_URL,
  scanFakelibBase,
  ensurePupUnpacker,
  extractPupToDir,
};

// ── scanFakelibBase ───────────────────────────────────────────────────────────
// Scan a base directory for ANY numbered subfolders (no upper limit).
// Discovers whatever pair folders actually exist (1, 2, ... 30, etc).
// Returns: Array<{ pair, dir, libCount, hasLibs }>
function scanFakelibBase(baseDir) {
  const results = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const pairNums = entries
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
      .map(e => parseInt(e.name, 10))
      .sort((a, b) => a - b);
    for (const pair of pairNums) {
      const dir      = path.join(baseDir, String(pair));
      const libCount = countLibrariesRecursive(dir);
      results.push({ pair, dir, libCount, hasLibs: libCount > 0 });
    }
  } catch {}
  return results;
}

function countLibrariesRecursive(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += countLibrariesRecursive(full);
    else if (/\.(sprx|prx)$/i.test(entry.name)) total++;
  }
  return total;
}

// ── ensurePupUnpacker ─────────────────────────────────────────────────────────
// Ensures ps5-pup-unpacker.exe is available in toolsDir.
// Attempts to download latest release from GitHub; falls back to manual instructions.
// Returns: string — absolute path to the tool exe.
async function ensurePupUnpacker(toolsDir, onProgress) {
  const toolPath = path.join(toolsDir, TOOL_FILENAME);
  if (fs.existsSync(toolPath)) return toolPath;

  onProgress?.({ stage: 'download-tool', pct: 0, msg: 'Fetching ps5-pup-unpacker from GitHub…' });

  if (!fs.existsSync(toolsDir)) fs.mkdirSync(toolsDir, { recursive: true });

  // Try GitHub releases API first
  let downloadUrl = null;
  try {
    const release = await fetchJson(GITHUB_API_URL);
    const asset   = (release.assets || []).find(
      a => a.name === TOOL_FILENAME || (a.name.toLowerCase().endsWith('.exe') && a.name.toLowerCase().includes('unpacker'))
    );
    if (asset) downloadUrl = asset.browser_download_url;
  } catch (e) {
    // GitHub unreachable — fall through to manual error
  }

  if (!downloadUrl) {
    throw new ManualDownloadRequired(
      `Could not auto-download ${TOOL_FILENAME} from GitHub.\n` +
      `Please download it manually from:\n${MANUAL_DL_URL}\n` +
      `Extract ${TOOL_FILENAME} and place it in:\n${toolsDir}`
    );
  }

  onProgress?.({ stage: 'download-tool', pct: 5, msg: 'Downloading ps5-pup-unpacker…' });

  try {
    await downloadFile(downloadUrl, toolPath, pct =>
      onProgress?.({ stage: 'download-tool', pct: 5 + Math.round(pct * 0.93), msg: `Downloading ps5-pup-unpacker… ${pct}%` })
    );
  } catch (e) {
    // Clean up partial download
    try { fs.unlinkSync(toolPath); } catch {}
    throw new Error(`Failed to download ps5-pup-unpacker: ${e.message}\n\nManual download: ${MANUAL_DL_URL}`);
  }

  onProgress?.({ stage: 'download-tool', pct: 99, msg: 'ps5-pup-unpacker downloaded' });
  return toolPath;
}

// ── extractPupToDir ───────────────────────────────────────────────────────────
// Extract a decrypted PUP file and copy .sprx/.prx libraries to targetDir.
// opts = { pupPath, targetDir, toolPath, isCancelled?, onProgress? }
// Returns: { libCount }
async function extractPupToDir(opts) {
  const { pupPath, targetDir, toolPath, isCancelled, onProgress } = opts;

  if (!fs.existsSync(pupPath)) throw new Error('PUP file not found: ' + pupPath);
  if (!fs.existsSync(toolPath)) throw new Error('ps5-pup-unpacker not found: ' + toolPath);

  // Temporary extraction directory alongside targetDir
  const tempDir = path.join(path.dirname(targetDir), `_pup_tmp_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // ── Step 1: Unpack PUP ──────────────────────────────────────────────────
    onProgress?.({ stage: 'unpack', pct: 5, msg: 'Running ps5-pup-unpacker…' });

    await runTool(toolPath, [pupPath, tempDir], line => {
      onProgress?.({ stage: 'unpack', pct: 30, msg: line });
    });

    if (isCancelled?.()) throw new Error('Cancelled');

    // ── Step 2: Find libraries ───────────────────────────────────────────────
    onProgress?.({ stage: 'find-libs', pct: 55, msg: 'Searching for .sprx/.prx files…' });

    const libs = [];
    walkForLibs(tempDir, libs);

    if (!libs.length) {
      throw new Error(
        'No .sprx/.prx library files found in extracted PUP.\n' +
        'Make sure the PUP file is decrypted (.PUP.dec).\n' +
        'Encrypted PUPs must be decrypted on a jailbroken PS5 first.\n' +
        'See: https://github.com/zecoxao/ps5-pup-decrypt'
      );
    }

    if (isCancelled?.()) throw new Error('Cancelled');

    // ── Step 3: Copy libraries to targetDir ─────────────────────────────────
    onProgress?.({ stage: 'copy-libs', pct: 60, msg: `Found ${libs.length} libraries — copying…` });

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    let copied = 0;
    for (const libPath of libs) {
      if (isCancelled?.()) throw new Error('Cancelled');
      const dest = path.join(targetDir, path.basename(libPath));
      fs.copyFileSync(libPath, dest);
      copied++;
      const pct = 60 + Math.round((copied / libs.length) * 38);
      onProgress?.({ stage: 'copy-libs', pct, msg: `${path.basename(libPath)}` });
    }

    onProgress?.({ stage: 'done', pct: 100, msg: `Extracted ${copied} libraries` });
    return { libCount: copied };

  } finally {
    // Always clean up temp dir
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function walkForLibs(dir, results) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkForLibs(full, results);
      else if (/\.(sprx|prx)$/i.test(entry.name)) results.push(full);
    }
  } catch {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Porkfolio/1.0', 'Accept': 'application/vnd.github.v3+json' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON from GitHub API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('GitHub API request timed out')); });
  });
}

function downloadFile(url, dest, onPct) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Porkfolio/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest, onPct).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const total    = Number(res.headers['content-length'] || 0);
      let received   = 0;
      const ws       = fs.createWriteStream(dest);
      res.on('data', chunk => {
        received += chunk.length;
        ws.write(chunk);
        if (total) onPct?.(Math.round((received / total) * 100));
      });
      res.on('end', () => ws.end(resolve));
      res.on('error', reject);
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

function runTool(toolPath, args, onLine) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(toolPath, args, {
      stdio:       ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', d => {
      for (const line of d.toString().split('\n').filter(Boolean)) onLine(line.trim());
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code === 0) return resolve();
      const detail = stderr.trim() || `exit code ${code}`;
      // Exit code 148 or "Usage" / ".dec" in output = encrypted PUP
      if (code === 148 || detail.toLowerCase().includes('.dec') || detail.toLowerCase().includes('usage')) {
        return reject(new Error(
          'The PUP file appears to be encrypted.\n' +
          'You must decrypt it first using ps5_pup_decrypt.elf on a jailbroken PS5.\n' +
          'The output will be a .PUP.dec file — import that file instead.\n' +
          'Reference: https://github.com/zecoxao/ps5-pup-decrypt'
        ));
      }
      reject(new Error(`ps5-pup-unpacker failed: ${detail}`));
    });
    child.on('error', e => {
      if (e.code === 'ENOENT') reject(new Error('ps5-pup-unpacker.exe not found'));
      else reject(e);
    });
  });
}

class ManualDownloadRequired extends Error {
  constructor(msg) { super(msg); this.name = 'ManualDownloadRequired'; this.manualRequired = true; }
}
