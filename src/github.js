'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const log   = require('electron-log');

// ── Low-level HTTP helper ──────────────────────────────────────────────────────
// Follows redirects, returns { status, body } as a string buffer.

function httpGet(url, extraHeaders = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'Porkfolio/0.1 (github.com/porkfolio)',
        'Accept':     'application/vnd.github.v3+json',
        ...extraHeaders,
      },
    };

    const req = lib.request(options, res => {
      // Follow redirects (GitHub asset downloads redirect through CDN)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain the redirect body so the socket is freed
        if (depth >= 5) { reject(new Error('Too many redirects')); return; }
        return resolve(httpGet(res.headers.location, extraHeaders, depth + 1));
      }

      const chunks = [];
      res.on('data',  chunk => chunks.push(chunk));
      res.on('end',   ()    => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      res.on('error', err   => reject(err));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('GitHub request timed out')));
    req.end();
  });
}

// ── URL parsing ────────────────────────────────────────────────────────────────

function parseGitHubUrl(url) {
  const m = String(url).match(/github\.com\/([^/\s]+)\/([^/?\s#]+)/);
  if (!m) throw new Error(`Not a valid GitHub repository URL: ${url}`);
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

// ── GitHub Releases API ────────────────────────────────────────────────────────

// Fetches an arbitrary page URL and scrapes it for .bin / .js / .elf download links.
// Used when a source URL is a GitHub Pages site or any other hosted release page.
async function fetchPagePayloads(url) {
  log.info(`[GitHub] Scraping page for payload links: ${url}`);
  const { status, body } = await httpGet(url, { Accept: 'text/html,*/*' });
  if (status !== 200) throw new Error(`HTTP ${status} fetching page: ${url}`);

  // Collect all href values ending in .bin / .js / .elf (case-insensitive)
  const linkRe = /href=["']([^"']*\.(?:bin|js|elf)(?:\?[^"']*)?)["']/gi;
  const assets = [];
  const seen   = new Set();
  let m;
  while ((m = linkRe.exec(body)) !== null) {
    const href   = m[1];
    const absUrl = href.startsWith('http') ? href : new URL(href, url).href;
    const name   = decodeURIComponent(absUrl.split('/').pop().split('?')[0]);
    if (!seen.has(name)) {
      seen.add(name);
      assets.push({ name, url: absUrl, size: 0 });
    }
  }

  // Best-effort version: look for a semver-like string in the page title or an <h1>/release heading
  const titleM = body.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  const verM   = body.match(/v?(\d+\.\d+[.\w-]*)/);
  const tag    = verM ? `v${verM[1]}` : (titleM ? titleM[1].trim().slice(0, 60) : 'latest');

  log.info(`[GitHub] Page scrape found ${assets.length} payload(s), tag: ${tag}`);
  return { tag, name: tag, date: null, assets };
}

async function fetchLatestRelease(githubUrl) {
  // Non-GitHub URLs (e.g. github.io, any hosted page) — scrape for payload links
  if (!/github\.com\//.test(githubUrl)) {
    return fetchPagePayloads(githubUrl);
  }

  const { owner, repo } = parseGitHubUrl(githubUrl);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  log.info(`[GitHub] Fetching latest release for ${owner}/${repo}`);
  const { status, body } = await httpGet(apiUrl);

  if (status === 404) throw new Error(`No releases found for ${owner}/${repo}`);
  if (status !== 200) throw new Error(`GitHub API returned HTTP ${status} for ${owner}/${repo}`);

  let release;
  try { release = JSON.parse(body); } catch (_) { throw new Error('Invalid JSON from GitHub API'); }

  return {
    tag:    release.tag_name  || '',
    name:   release.name      || release.tag_name || '',
    date:   release.published_at || null,
    assets: (release.assets || []).map(a => ({
      name: a.name,
      url:  a.browser_download_url,
      size: a.size || 0,
    })),
  };
}

// ── Checksum file handling ─────────────────────────────────────────────────────
// Looks for a checksum file asset (sha256/checksums/sums/sha2 in name).
// Parses standard sha256sum output: "<64hexchars>  <filename>" or "<64hexchars> *<filename>"
// Returns Map<filename → sha256hex> — empty Map if no checksum asset found.

async function fetchChecksums(assets) {
  const checksumAsset = assets.find(a => /sha256|checksums|sha2|sums/i.test(a.name));
  if (!checksumAsset) {
    log.info('[GitHub] No checksums file found in release assets');
    return new Map();
  }

  log.info(`[GitHub] Downloading checksums file: ${checksumAsset.name}`);
  const { status, body } = await httpGet(checksumAsset.url);
  if (status !== 200) {
    log.warn(`[GitHub] Checksums download returned HTTP ${status}`);
    return new Map();
  }

  const hashMap = new Map();
  for (const line of body.split(/\r?\n/)) {
    // Match: 64-char hex, whitespace (possibly with *), then filename
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m) {
      hashMap.set(m[2].trim(), m[1].toLowerCase());
    }
  }
  log.info(`[GitHub] Parsed ${hashMap.size} checksum(s) from ${checksumAsset.name}`);
  return hashMap;
}

// ── Asset downloader ──────────────────────────────────────────────────────────
// Downloads a GitHub release asset to localPath, streaming with progress.
// onProgress({ percent, transferred, total, speedBps })

function downloadAsset(assetUrl, localPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    function doDownload(url, depth = 0) {
      const parsed = new URL(url);
      const lib    = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'User-Agent': 'Porkfolio/0.1' },
      };

      const req = lib.request(options, res => {
        // Follow redirects (GitHub CDN)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain the redirect body so the socket is freed
          if (depth >= 5) { reject(new Error('Too many redirects')); return; }
          return doDownload(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
        }

        const total     = parseInt(res.headers['content-length'] || '0') || 0;
        let   done      = 0;
        let   lastTime  = Date.now();
        let   lastBytes = 0;

        const out = fs.createWriteStream(localPath);

        res.on('data', chunk => {
          done += chunk.length;
          const now = Date.now();
          const dt  = (now - lastTime) / 1000;
          if (dt >= 0.25) {
            const speedBps = (done - lastBytes) / dt;
            onProgress?.({
              percent:     total > 0 ? Math.round((done / total) * 100) : 0,
              transferred: done,
              total,
              speedBps,
            });
            lastTime  = now;
            lastBytes = done;
          }
        });

        res.on('error', err => { out.destroy(); reject(err); });
        out.on('error', err => reject(err));
        out.on('finish', () => {
          onProgress?.({ percent: 100, transferred: done, total: done, speedBps: 0 });
          resolve(localPath);
        });

        res.pipe(out);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('Asset download timed out')));
      req.end();
    }

    doDownload(assetUrl);
  });
}

module.exports = { parseGitHubUrl, fetchLatestRelease, fetchPagePayloads, fetchChecksums, downloadAsset };
