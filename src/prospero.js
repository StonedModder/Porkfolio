'use strict';

/**
 * PROSPEROPatches.com API — Node.js implementation
 * Mirrors prospero_scraper.py exactly, ported to async/await + node fetch.
 */

const https = require('https');
const http  = require('http');
const log   = require('electron-log');

const BASE_URL = 'https://prosperopatches.com';
const CDN_URL  = 'https://cdn.prosperopatches.com';
const API_BASE = `${BASE_URL}/api/internal`;

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':      'application/json',
  'Referer':     BASE_URL,
  'Origin':      BASE_URL,
};

// ── Low-level HTTP helpers ────────────────────────────────────────────────────

function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...DEFAULT_HEADERS, ...(options.headers || {}) },
    };

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

async function httpGet(url) {
  const res = await httpRequest(url);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.body;
}

async function httpPostJson(url, payload) {
  const body = JSON.stringify(payload);
  const res  = await httpRequest(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  }, body);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
  try {
    return JSON.parse(res.body);
  } catch (_) {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

// ── HTML / regex helpers ──────────────────────────────────────────────────────

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function parseGamePage(html, titleid) {
  const result = {
    dataKey:     null,
    cdnHash:     null,
    name:        '',
    description: '',
    iconUrl:     null,
    bannerUrl:   null,
    contentId:   '',
    publisher:   '',
    publisherId: '',
    region:      '',
  };

  let m;

  // Game name from <title> tag: "PPSA01411: Marvel's Spider-Man | Site"
  m = html.match(/<title>([^<]*)<\/title>/i);
  if (m) {
    const t = m[1].trim()
      .replace(/^[A-Z]{4}\d{5}:\s*/, '')   // strip "PPSA01411: " prefix
      .replace(/\s*[|–\-—].*$/, '')         // strip "| Site Name" suffix
      .trim();
    // Discard if the leftover string is just the site's own name (game not found / generic page)
    if (t && !/^prospero\s*patches/i.test(t)) result.name = t;
  }

  // data-key on #dynpatch
  m = html.match(/id="dynpatch"[^>]*data-key="([a-f0-9]+)"/);
  if (!m) m = html.match(/data-key="([a-f0-9]+)"[^>]*id="dynpatch"/);
  if (m) result.dataKey = m[1];

  // Icon from og:image meta (site switched to twitter:image; keep og:image as fallback)
  m = html.match(/og:image["\s]+content="(https:\/\/cdn\.prosperopatches\.com\/titles\/[^"]+)"/);
  if (!m) m = html.match(/twitter:image["\s]+content="(https:\/\/cdn\.prosperopatches\.com\/titles\/[^"]+)"/);
  if (!m) m = html.match(/background[^;]*url\([\"']?(https:\/\/cdn\.prosperopatches\.com\/titles\/[^\"')]+icon0[^\"')]*)[\"']?\)/);
  if (m) {
    result.iconUrl = m[1];
    const hm = result.iconUrl.match(/\/titles\/[A-Z0-9]+_([a-f0-9]{40,})/);
    if (hm) result.cdnHash = hm[1];
  }

  // Banner from inline background (pic0.webp)
  const bm = html.match(/background[^;]*url\([\"']?(https:\/\/cdn\.prosperopatches\.com\/titles\/[^\"')]+pic0[^\"')]*)[\"']?\)/);
  if (bm) {
    result.bannerUrl = bm[1];
  } else if (result.cdnHash) {
    result.bannerUrl = `${CDN_URL}/titles/${titleid}_${result.cdnHash}/pic0.webp`;
  }

  // Sidebar list items
  const liBlocks = [...html.matchAll(/<li[^>]*bd-links-group[^>]*>([\s\S]*?)<\/li>/g)];
  for (const [, block] of liBlocks) {
    const hm2 = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    if (!hm2) continue;
    const heading = stripTags(hm2[1]).replace(/\bView\b/g, '').replace(/\bSwitch\b/g, '').trim();
    const after   = block.slice(hm2.index + hm2[0].length);
    // Keep text-dark anchor text (publisher name), strip dynamicmodal/View links
    let clean = after
      .replace(/<a\b[^>]*class="[^"]*text-dark[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1')
      .replace(/<a\b[^>]*dynamicmodal[^>]*>[\s\S]*?<\/a>/g, '')
      .replace(/<a\b[^>]*>View<\/a>/g, '');
    const value = stripTags(clean);

    if      (heading === 'Content ID'   && !result.contentId)   result.contentId   = value;
    else if (heading === 'Publisher'    && !result.publisher)    result.publisher   = value;
    else if (heading === 'Publisher ID' && !result.publisherId)  result.publisherId = value;
    else if (heading === 'Region'       && !result.region)       result.region      = value;
  }

  // Game description — use whatever ProsperoPatches provides in meta tags
  let dm;
  dm = html.match(/property="og:description"\s+content="([^"]{10,})"/);
  if (!dm) dm = html.match(/content="([^"]{10,})"\s+property="og:description"/);
  if (!dm) dm = html.match(/name="description"\s+content="([^"]{10,})"/);
  if (!dm) dm = html.match(/content="([^"]{10,})"\s+name="description"/);
  if (dm) {
    result.description = stripTags(dm[1]).replace(/\s+/g, ' ').trim();
  }

  return result;
}

function parseSwitchRegion(html) {
  const variants = [];
  const linkRe = /<a\s+href="(\/[A-Z]{4}\d{5})"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href    = m[1];
    const titleid = href.slice(1);
    const region  = stripTags(m[2]).trim();
    if (region) variants.push({ titleid, region, url: BASE_URL + href });
  }
  return variants;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchPageMetadata(titleid) {
  const html = await httpGet(`${BASE_URL}/${titleid}`);
  return parseGamePage(html, titleid);
}

async function fetchPatches(titleid, dataKey) {
  const data = await httpPostJson(`${API_BASE}/loadpatches`, { titleid, key: dataKey });
  if (!data.success) return { patches: [], lastUpdated: '', count: 0 };
  const patches = (data.patches || []).map(p => ({
    contentVer:       p.content_ver,
    filesize:         p.filesize,
    requiredFirmware: p.required_firmware,
    importDate:       p.import_date,
    isLatest:         p.is_latest,
    changelogCount:   p.changelog_charcount || 0,
    changelogPreview: p.changelog_preview   || '',
    keysetPatch:      p.keyset?.patch       || '',
    keysetDetails:    p.keyset?.details     || '',
    keysetChangeinfo: p.keyset?.changeinfo  || '',
  }));
  return { patches, lastUpdated: data.lastupdated || '', count: data.count || patches.length };
}

async function fetchAdditionalContent(titleid, dataKey) {
  const data = await httpPostJson(`${API_BASE}/loadac`, { titleid, key: dataKey });
  if (!data.success) return [];
  return (data.items || []).map(item => ({
    name:             item.name,
    contentid:        item.contentid,
    contentVer:       item.content_ver,
    filesize:         item.filesize,
    requiredFirmware: item.required_firmware,
    iconUrl:          item.icon,
    revisions:        item.revisions || [],
    key:              item.key,
  }));
}

async function fetchOtherRegions(titleid) {
  const html = await httpGet(`${API_BASE}/data/switch-region.php?titleid=${titleid}`);
  return parseSwitchRegion(html);
}

/**
 * Full game metadata fetch — orchestrates all endpoints.
 * Returns a GameMetadata object.
 */
async function fetchGameMetadata(titleid) {
  const page = await fetchPageMetadata(titleid);
  // The sub-fetches below are optional enrichment — a failure in any one should
  // degrade to empty rather than reject the whole metadata fetch.
  let patches = [], lastUpdated = '', count = 0;
  if (page.dataKey) {
    try { ({ patches, lastUpdated, count } = await fetchPatches(titleid, page.dataKey)); }
    catch (e) { log.warn(`[Prospero] patches fetch failed for ${titleid}: ${e.message}`); }
  }
  let additionalContent = [];
  if (page.dataKey) {
    try { additionalContent = await fetchAdditionalContent(titleid, page.dataKey); }
    catch (e) { log.warn(`[Prospero] DLC fetch failed for ${titleid}: ${e.message}`); }
  }
  let otherRegions = [];
  try { otherRegions = await fetchOtherRegions(titleid); }
  catch (e) { log.warn(`[Prospero] regions fetch failed for ${titleid}: ${e.message}`); }

  return {
    titleid,
    name:            page.name        || '',
    description:     page.description || '',
    region:          page.region,
    contentId:       page.contentId,
    publisher:       page.publisher,
    publisherId:     page.publisherId,
    iconUrl:         page.iconUrl    || '',
    bannerUrl:       page.bannerUrl  || '',
    cdnHash:         page.cdnHash    || '',
    lastUpdated,
    patchCount:      count,
    patches,
    additionalContent,
    otherRegions,
    fetchedAt:       Date.now(),
  };
}

module.exports = {
  fetchPageMetadata,
  fetchPatches,
  fetchAdditionalContent,
  fetchOtherRegions,
  fetchGameMetadata,
  CDN_URL,
  BASE_URL,
};
