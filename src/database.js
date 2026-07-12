'use strict';

const path      = require('path');
const fs        = require('fs');
const { app }   = require('electron');
const initSqlJs = require('sql.js');
const log       = require('electron-log');

let db;      // sql.js Database instance
let dbPath;  // path to .db file on disk

// ── Persistence ───────────────────────────────────────────────────────────────
// sql.js is in-memory. saveNow() flushes immediately; save() coalesces writes
// and bulkUpdate() lets scan-heavy callers defer the expensive flush until the
// whole batch finishes.
let _saveTimer = null;
let _bulkDepth = 0;
let _bulkDirty = false;
function save() {
  if (_bulkDepth > 0) {
    _bulkDirty = true;
    return;
  }
  if (_saveTimer) return; // already scheduled
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    // This runs from a timer context, so a throw here is an uncatchable crash.
    try {
      const data = db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (e) {
      log.error('[DB] debounced save failed:', e);
    }
  }, 150);
}
function saveNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function beginBulkUpdate() {
  _bulkDepth++;
}

function endBulkUpdate() {
  if (_bulkDepth <= 0) return;
  _bulkDepth--;
  if (_bulkDepth === 0 && _bulkDirty) {
    _bulkDirty = false;
    saveNow();
  }
}

function bulkUpdate(fn) {
  beginBulkUpdate();
  try {
    return fn();
  } finally {
    endBulkUpdate();
  }
}

// ── Parameter adapter ─────────────────────────────────────────────────────────
// better-sqlite3 callers pass plain {key: val} with @key in SQL.
// sql.js needs the prefix in the object key too: {"@key": val}.
function sqlParams(p) {
  if (!p) return [];
  if (Array.isArray(p)) return p;
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    out[/^[@:$]/.test(k) ? k : '@' + k] = v ?? null;
  }
  return out;
}

// ── Statement wrapper ─────────────────────────────────────────────────────────
// Provides the same .run() / .all() / .get() API as better-sqlite3.
class Stmt {
  constructor(raw) { this._raw = raw; }

  run(params) {
    this._raw.run(sqlParams(params));
    this._raw.free();
    save();
    return {};
  }

  all(params) {
    if (params !== undefined) this._raw.bind(sqlParams(params));
    const rows = [];
    while (this._raw.step()) rows.push(this._raw.getAsObject());
    this._raw.free();
    return rows;
  }

  get(params) {
    if (params !== undefined) this._raw.bind(sqlParams(params));
    const row = this._raw.step() ? this._raw.getAsObject() : undefined;
    this._raw.free();
    return row;
  }
}

function prepare(sql) {
  return new Stmt(db.prepare(sql));
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function initialize() {
  dbPath = path.join(app.getPath('userData'), 'porkfolio.db');
  log.info('[DB] Opening:', dbPath);

  // Locate the sql.js WASM file next to the JS bundle
  const sqlJsDist = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({
    locateFile: file => path.join(sqlJsDist, file),
  });

  const buf = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  db = buf ? new SQL.Database(buf) : new SQL.Database();

  db.run('PRAGMA foreign_keys = ON;');

  db.run(`CREATE TABLE IF NOT EXISTS games (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL DEFAULT '',
    game_id      TEXT    UNIQUE NOT NULL,
    content_id   TEXT    DEFAULT '',
    size         INTEGER DEFAULT 0,
    version      TEXT    DEFAULT '',
    installed    INTEGER DEFAULT 0,
    backed_up    INTEGER DEFAULT 0,
    ftp_path     TEXT    DEFAULT '',
    last_scanned TEXT    DEFAULT NULL,
    created_at   TEXT    DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     TEXT    NOT NULL,
    backup_path TEXT    NOT NULL UNIQUE,
    size        INTEGER DEFAULT 0,
    backup_type TEXT    DEFAULT 'dump',
    source      TEXT    DEFAULT 'local',
    created_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS backpork_folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    path       TEXT    NOT NULL UNIQUE,
    created_at TEXT    DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS game_firmware (
    game_id     TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    PRIMARY KEY (game_id, folder_name)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS game_hashes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     TEXT    NOT NULL,
    file_hash   TEXT    NOT NULL,
    file_size   INTEGER NOT NULL,
    backup_path TEXT    NOT NULL UNIQUE,
    verified    INTEGER DEFAULT 1,
    hashed_at   TEXT    DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payload_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    github_url   TEXT    NOT NULL UNIQUE,
    enabled      INTEGER DEFAULT 1,
    last_checked INTEGER DEFAULT NULL,
    latest_tag   TEXT    DEFAULT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payload_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     INTEGER NOT NULL,
    asset_name    TEXT    NOT NULL,
    asset_url     TEXT    DEFAULT NULL,
    remote_hash   TEXT    DEFAULT NULL,
    local_path    TEXT    DEFAULT NULL,
    local_hash    TEXT    DEFAULT NULL,
    local_size    INTEGER DEFAULT NULL,
    version       TEXT    DEFAULT NULL,
    downloaded_at INTEGER DEFAULT NULL,
    UNIQUE(source_id, asset_name),
    FOREIGN KEY (source_id) REFERENCES payload_sources(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cheat_files (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    filename  TEXT    UNIQUE NOT NULL,
    cusa_id   TEXT    NOT NULL,
    version   TEXT    NOT NULL DEFAULT '',
    title     TEXT    NOT NULL DEFAULT '',
    data      TEXT    NOT NULL DEFAULT '{}',
    cached_at TEXT    DEFAULT (datetime('now'))
  )`);
  ensureProsperoColumns();
  // Migrations for existing databases
  try { db.run(`ALTER TABLE backups ADD COLUMN source TEXT DEFAULT 'local'`); } catch (_) {}
  try { db.run(`ALTER TABLE game_hashes ADD COLUMN hash_type TEXT DEFAULT 'game'`); } catch (_) {}
  try { db.run(`ALTER TABLE game_hashes ADD COLUMN firmware_label TEXT DEFAULT NULL`); } catch (_) {}
  db.run(`CREATE INDEX IF NOT EXISTS idx_cheat_cusa        ON cheat_files(cusa_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_backups_game_id   ON backups(game_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_backups_source    ON backups(source)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fw_game_id        ON game_firmware(game_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hashes_game_id    ON game_hashes(game_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bpfolders_path    ON backpork_folders(path)`);
  // Backfill hash_type/firmware_label for existing rows whose backup_path sits inside a known backpork folder
  db.run(`
    UPDATE game_hashes
    SET hash_type      = 'backpork',
        firmware_label = (
          SELECT bf.name FROM backpork_folders bf
          WHERE game_hashes.backup_path LIKE bf.path || '%'
          ORDER BY LENGTH(bf.path) DESC
          LIMIT 1
        )
    WHERE hash_type = 'game'
      AND EXISTS (
        SELECT 1 FROM backpork_folders bf
        WHERE game_hashes.backup_path LIKE bf.path || '%'
      )
  `);
  // Reset fetch timestamp for games missing icon URL so they get re-fetched with the updated regex
  try { db.run(`UPDATE games SET prospero_fetched_at = NULL WHERE (prospero_icon_url IS NULL OR prospero_icon_url = '') AND prospero_fetched_at IS NOT NULL`); } catch (_) {}
  // Remove stale file-level backup entries left by an older scanner version
  db.run(`DELETE FROM backups WHERE backup_type NOT IN ('folder','pkg','iso')`);
  // Tag existing backpork entries based on whether their path lives inside a known backpork folder
  db.run(`
    UPDATE backups SET source = 'backpork'
    WHERE EXISTS (
      SELECT 1 FROM backpork_folders bf
      WHERE backups.backup_path LIKE bf.path || '%'
    )
  `);
  save();
  log.info('[DB] Ready');
}

// Safely add prospero columns to existing databases (migration)
function ensureProsperoColumns() {
  const prosperoColumns = [
    ['porked_firmware',        'TEXT    DEFAULT NULL'],
    ['porked_at',              'TEXT    DEFAULT NULL'],
    ['prospero_name',          'TEXT    DEFAULT NULL'],
    ['prospero_publisher',     'TEXT    DEFAULT NULL'],
    ['prospero_publisher_id',  'TEXT    DEFAULT NULL'],
    ['prospero_icon_url',      'TEXT    DEFAULT NULL'],
    ['prospero_banner_url',    'TEXT    DEFAULT NULL'],
    ['prospero_region',        'TEXT    DEFAULT NULL'],
    ['prospero_last_updated',  'TEXT    DEFAULT NULL'],
    ['prospero_patch_count',   'INTEGER DEFAULT NULL'],
    ['prospero_fetched_at',    'INTEGER DEFAULT NULL'],
    ['prospero_patches',       'TEXT    DEFAULT NULL'],
    ['prospero_dlc',           'TEXT    DEFAULT NULL'],
    ['prospero_other_regions', 'TEXT    DEFAULT NULL'],
    ['prospero_description',   'TEXT    DEFAULT NULL'],
    ['prospero_content_id',    'TEXT    DEFAULT NULL'],
    ['prospero_version',       'TEXT    DEFAULT NULL'],
    ['prospero_size',          'TEXT    DEFAULT NULL'],
  ];
  const existing = prepare('PRAGMA table_info(games)').all().map(r => r.name);
  for (const [col, def] of prosperoColumns) {
    if (!existing.includes(col)) {
      db.run(`ALTER TABLE games ADD COLUMN ${col} ${def}`);
      log.info(`[DB] Migrated: added column ${col}`);
    }
  }
}

// ── Games ─────────────────────────────────────────────────────────────────────
function listGames(filter = {}) {
  // Use pre-aggregated sub-selects joined once rather than correlated subqueries
  // that re-execute for every row. With indexes this is O(n) not O(n²).
  let sql = `
    SELECT g.*,
      COALESCE(lc.cnt, 0)        AS backup_count,
      COALESCE(lc.total_size, 0) AS backup_size,
      COALESCE(bc.cnt, 0)        AS backpork_count,
      fw.firmware_labels,
      COALESCE(cc.cnt, 0)        AS cheat_count
    FROM games g
    LEFT JOIN (
      SELECT game_id, COUNT(*) AS cnt, SUM(size) AS total_size
      FROM backups WHERE source = 'local' GROUP BY game_id
    ) lc ON lc.game_id = g.game_id
    LEFT JOIN (
      SELECT game_id, COUNT(*) AS cnt
      FROM backups WHERE source = 'backpork' GROUP BY game_id
    ) bc ON bc.game_id = g.game_id
    LEFT JOIN (
      SELECT game_id, GROUP_CONCAT(folder_name, ',') AS firmware_labels
      FROM game_firmware GROUP BY game_id
    ) fw ON fw.game_id = g.game_id
    LEFT JOIN (
      SELECT cusa_id, COUNT(*) AS cnt
      FROM cheat_files GROUP BY cusa_id
    ) cc ON cc.cusa_id = g.game_id`;
  const params = [];
  const conds  = [];

  if (filter.installed !== undefined) {
    conds.push('g.installed = ?');
    params.push(filter.installed ? 1 : 0);
  }
  if (filter.backed_up !== undefined) {
    conds.push('g.backed_up = ?');
    params.push(filter.backed_up ? 1 : 0);
  }
  if (filter.search) {
    conds.push('(g.title LIKE ? OR g.game_id LIKE ? OR g.prospero_name LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
  }

  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY g.title ASC';

  return prepare(sql).all(params.length ? params : undefined);
}

function upsertGame(game) {
  return prepare(`
    INSERT INTO games (title, game_id, content_id, size, version, installed, backed_up, ftp_path, last_scanned)
    VALUES (@title, @game_id, @content_id, @size, @version, @installed, @backed_up, @ftp_path, @last_scanned)
    ON CONFLICT(game_id) DO UPDATE SET
      title        = CASE WHEN excluded.title != '' THEN excluded.title ELSE games.title END,
      content_id   = excluded.content_id,
      size         = excluded.size,
      version      = excluded.version,
      installed    = excluded.installed,
      ftp_path     = excluded.ftp_path,
      last_scanned = excluded.last_scanned
  `).run(game);
}

function updateGame(game_id, fields) {
  const cols = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  return prepare(`UPDATE games SET ${cols} WHERE game_id = @game_id`).run({ ...fields, game_id });
}

function getGame(game_id) {
  return prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM backups b WHERE b.game_id = g.game_id AND b.source = 'local') as backup_count,
      (SELECT SUM(b.size)  FROM backups b WHERE b.game_id = g.game_id AND b.source = 'local') as backup_size
    FROM games g WHERE g.game_id = @game_id
  `).get({ game_id });
}

function updateProsperoData(game_id, data) {
  const patches     = data.patches || [];
  const latestPatch = patches.find(p => p.isLatest) || patches[patches.length - 1] || null;
  return prepare(`
    UPDATE games SET
      prospero_name          = @name,
      prospero_publisher     = @publisher,
      prospero_publisher_id  = @publisherId,
      prospero_icon_url      = @iconUrl,
      prospero_banner_url    = @bannerUrl,
      prospero_region        = @region,
      prospero_last_updated  = @lastUpdated,
      prospero_patch_count   = @patchCount,
      prospero_fetched_at    = @fetchedAt,
      prospero_patches       = @patches,
      prospero_dlc           = @dlc,
      prospero_other_regions = @otherRegions,
      prospero_description   = @description,
      prospero_content_id    = @contentId,
      prospero_version       = @prosperoVersion,
      prospero_size          = @prosperoSize
    WHERE game_id = @game_id
  `).run({
    game_id,
    name:            data.name              || '',
    publisher:       data.publisher         || '',
    publisherId:     data.publisherId       || '',
    iconUrl:         data.iconUrl           || '',
    bannerUrl:       data.bannerUrl         || '',
    region:          data.region            || '',
    lastUpdated:     data.lastUpdated       || '',
    patchCount:      data.patchCount        || 0,
    fetchedAt:       data.fetchedAt         || Date.now(),
    patches:         JSON.stringify(patches),
    dlc:             JSON.stringify(data.additionalContent || []),
    otherRegions:    JSON.stringify(data.otherRegions      || []),
    description:     data.description       || '',
    contentId:       data.contentId         || '',
    prosperoVersion: latestPatch?.contentVer || '',
    prosperoSize:    latestPatch?.filesize   || '',
  });
}

function getProsperoAge(game_id) {
  const row = prepare('SELECT prospero_fetched_at FROM games WHERE game_id = @game_id').get({ game_id });
  if (!row || !row.prospero_fetched_at) return Infinity;
  return Date.now() - row.prospero_fetched_at;
}

// ── Backups ───────────────────────────────────────────────────────────────────
function listBackups(game_id = null) {
  if (game_id) {
    return prepare('SELECT * FROM backups WHERE game_id = @game_id ORDER BY created_at DESC').all({ game_id });
  }
  return prepare(`
    SELECT b.*, g.title, g.prospero_name FROM backups b
    LEFT JOIN games g ON b.game_id = g.game_id
    ORDER BY b.created_at DESC
  `).all();
}

function upsertBackup({ game_id, backup_path, size, backup_type, source = 'local' }) {
  return prepare(`
    INSERT INTO backups (game_id, backup_path, size, backup_type, source)
    VALUES (@game_id, @backup_path, @size, @backup_type, @source)
    ON CONFLICT(backup_path) DO UPDATE SET size = excluded.size, source = excluded.source
  `).run({ game_id, backup_path, size, backup_type, source });
}

function deleteBackup(id) {
  return prepare('DELETE FROM backups WHERE id = @id').run({ id });
}

// Remove any backup rows whose path ends with a known archive extension
function purgeArchiveBackups() {
  const exts = ['.rar', '.zip', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.001', '.002', '.003'];
  const conds = exts.map(e => `backup_path LIKE '%${e}'`).join(' OR ');
  return prepare(`DELETE FROM backups WHERE ${conds}`).run();
}

function clearBackupsForGame(game_id) {
  return prepare('DELETE FROM backups WHERE game_id = @game_id').run({ game_id });
}

// Delete backup rows whose path is under folderRoot but NOT in keepPaths.
// Returns the number of rows deleted so the caller can log it.
function deleteStaleBackupsInFolder(folderRoot, keepPaths) {
  const all = prepare('SELECT id, backup_path FROM backups').all();
  const toDelete = all.filter(
    b => b.backup_path.startsWith(folderRoot) && !keepPaths.has(b.backup_path)
  );
  for (const b of toDelete) {
    prepare('DELETE FROM backups WHERE id = @id').run({ id: b.id });
  }
  if (toDelete.length > 0) save();
  return toDelete.length;
}

// Set backed_up = 0 for any game that no longer has any backup row.
function syncBackedUpFlags() {
  return prepare(`
    UPDATE games SET backed_up = 0
    WHERE backed_up = 1
      AND NOT EXISTS (SELECT 1 FROM backups WHERE backups.game_id = games.game_id)
  `).run();
}

// Remove game rows that have no backup entries and no firmware folder links.
// First, clear stale installed/ftp_path flags on games that have nothing left
// locally — this prevents orphan FTP-only ghosts from persisting when the PS5
// is disconnected.  Then delete the now-fully-orphaned rows.
function pruneOrphanScanGames() {
  // Clear stale PS5 flags on games with no backups and no firmware links so
  // they don't survive the DELETE below purely on a stale installed flag.
  prepare(`
    UPDATE games SET installed = 0, ftp_path = ''
    WHERE (installed = 1 OR (ftp_path IS NOT NULL AND ftp_path != ''))
      AND NOT EXISTS (SELECT 1 FROM backups WHERE backups.game_id = games.game_id)
      AND NOT EXISTS (SELECT 1 FROM game_firmware WHERE game_firmware.game_id = games.game_id)
  `).run();

  return prepare(`
    DELETE FROM games
    WHERE backed_up  = 0
      AND installed  = 0
      AND (ftp_path IS NULL OR ftp_path = '')
      AND NOT EXISTS (SELECT 1 FROM backups WHERE backups.game_id = games.game_id)
      AND NOT EXISTS (SELECT 1 FROM game_firmware WHERE game_firmware.game_id = games.game_id)
  `).run();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function getStats() {
  return {
    totalGames:   prepare('SELECT COUNT(*) as c FROM games').get()?.c ?? 0,
    installed:    prepare('SELECT COUNT(*) as c FROM games WHERE installed = 1').get()?.c ?? 0,
    backedUp:     prepare('SELECT COUNT(*) as c FROM games WHERE backed_up = 1').get()?.c ?? 0,
    totalBackups: prepare(`SELECT COUNT(*) as c FROM backups WHERE source = 'local'`).get()?.c ?? 0,
  };
}

// ── DB Viewer ─────────────────────────────────────────────────────────────────
function runQuery(sql) {
  const upper = sql.trim().toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('PRAGMA')) {
    throw new Error('Only SELECT and PRAGMA statements are allowed.');
  }
  return prepare(sql).all();
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportSql() {
  const tables = ['games', 'backups'];
  let out = `-- Porkfolio Export  ${new Date().toISOString()}\n\n`;

  for (const table of tables) {
    const info = prepare(`PRAGMA table_info(${table})`).all();
    const cols = info.map(c => c.name);
    const rows = prepare(`SELECT * FROM ${table}`).all();

    out += `-- ${table}\n`;
    for (const row of rows) {
      const vals = cols.map(c => {
        const v = row[c];
        return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      out += `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals});\n`;
    }
    out += '\n';
  }
  return out;
}

function exportCsv(table) {
  // Guard against injection via the table name — only allow tables that exist.
  const known = prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  if (!known.includes(table)) throw new Error(`Unknown table: ${table}`);
  const rows = prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${(r[h] ?? '').toString().replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
}

// ── Backpork folders ──────────────────────────────────────────────────────────
function listBackporkFolders() {
  return prepare(`
    SELECT bf.*, COUNT(gf.game_id) as game_count
    FROM backpork_folders bf
    LEFT JOIN game_firmware gf ON gf.folder_name = bf.name
    GROUP BY bf.id
    ORDER BY bf.name ASC
  `).all();
}

function addBackporkFolder(name, folderPath) {
  return prepare(`
    INSERT INTO backpork_folders (name, path) VALUES (@name, @path)
    ON CONFLICT(path) DO UPDATE SET name = excluded.name
  `).run({ name, path: folderPath });
}

function removeBackporkFolder(id) {
  const folder = prepare('SELECT name FROM backpork_folders WHERE id = @id').get({ id });
  if (folder) prepare('DELETE FROM game_firmware WHERE folder_name = @name').run({ name: folder.name });
  return prepare('DELETE FROM backpork_folders WHERE id = @id').run({ id });
}

// Minimal upsert — only creates the row if missing; never overwrites FTP-scanned data
function upsertGameMinimal(game_id) {
  return prepare(`
    INSERT INTO games (game_id, title, last_scanned, backed_up)
    VALUES (@game_id, '', datetime('now'), 1)
    ON CONFLICT(game_id) DO UPDATE SET backed_up = 1
  `).run({ game_id });
}

function setGameFirmwareLabel(game_id, folder_name) {
  return prepare(`
    INSERT OR IGNORE INTO game_firmware (game_id, folder_name) VALUES (@game_id, @folder_name)
  `).run({ game_id, folder_name });
}

// Remove firmware label entries for games no longer found in a specific folder.
// keepGameIds is a Set of game_ids that were found during the current scan.
function pruneGameFirmwareForFolder(folder_name, keepGameIds) {
  const rows = prepare('SELECT game_id FROM game_firmware WHERE folder_name = @folder_name').all({ folder_name });
  let removed = 0;
  for (const r of rows) {
    if (!keepGameIds.has(r.game_id)) {
      prepare('DELETE FROM game_firmware WHERE game_id = @game_id AND folder_name = @folder_name')
        .run({ game_id: r.game_id, folder_name });
      removed++;
    }
  }
  if (removed > 0) save();
  return removed;
}

function listFirmwareLabels() {
  return prepare('SELECT DISTINCT folder_name FROM game_firmware ORDER BY folder_name ASC').all()
    .map(r => r.folder_name);
}

// Returns all games in a specific backpork firmware folder, with game data
function listGamesForFolder(folder_name) {
  return prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM backups b WHERE b.game_id = g.game_id AND b.source = 'local') as backup_count
    FROM games g
    JOIN game_firmware gf ON gf.game_id = g.game_id
    WHERE gf.folder_name = @folder_name
    ORDER BY COALESCE(g.prospero_name, g.title, g.game_id) ASC
  `).all({ folder_name });
}

// Returns firmware folder entries for a specific game (for Manage tab backpork list).
// game_path is the game-specific subfolder within the backpork folder.
function getGameBackporkEntries(game_id) {
  return prepare(`
    SELECT gf.folder_name,
           bf.path AS folder_path,
           b.backup_path AS game_path
    FROM game_firmware gf
    JOIN backpork_folders bf ON bf.name = gf.folder_name
    LEFT JOIN backups b
           ON b.game_id = @game_id
          AND b.source = 'backpork'
          AND b.backup_path LIKE bf.path || '%'
    WHERE gf.game_id = @game_id
    ORDER BY gf.folder_name ASC
  `).all({ game_id });
}

function setGamePorked(game_id, firmware_label) {
  return prepare(`
    UPDATE games SET porked_firmware = @firmware_label, porked_at = datetime('now')
    WHERE game_id = @game_id
  `).run({ game_id, firmware_label });
}

// ── Payload Sources ───────────────────────────────────────────────────────────
function listPayloadSources() {
  return prepare('SELECT * FROM payload_sources ORDER BY name ASC').all();
}

function addPayloadSource({ name, github_url }) {
  return prepare(`
    INSERT INTO payload_sources (name, github_url) VALUES (@name, @github_url)
  `).run({ name, github_url });
}

function removePayloadSource(id) {
  return prepare('DELETE FROM payload_sources WHERE id = @id').run({ id });
}

function togglePayloadSource(id) {
  return prepare('UPDATE payload_sources SET enabled = NOT enabled WHERE id = @id').run({ id });
}

function updatePayloadSourceChecked(id, tag) {
  return prepare(`
    UPDATE payload_sources SET last_checked = @now, latest_tag = @tag WHERE id = @id
  `).run({ id, now: Date.now(), tag });
}

function upsertPayloadFile({ source_id, asset_name, asset_url, remote_hash, version }) {
  return prepare(`
    INSERT INTO payload_files (source_id, asset_name, asset_url, remote_hash, version)
    VALUES (@source_id, @asset_name, @asset_url, @remote_hash, @version)
    ON CONFLICT(source_id, asset_name) DO UPDATE SET
      asset_url   = excluded.asset_url,
      remote_hash = excluded.remote_hash,
      version     = excluded.version
  `).run({ source_id, asset_name, asset_url: asset_url ?? null, remote_hash: remote_hash ?? null, version: version ?? null });
}

function updatePayloadFileLocal({ source_id, asset_name, local_path, local_hash, local_size, version }) {
  return prepare(`
    UPDATE payload_files SET
      local_path    = @local_path,
      local_hash    = @local_hash,
      local_size    = @local_size,
      version       = @version,
      downloaded_at = @now
    WHERE source_id = @source_id AND asset_name = @asset_name
  `).run({ source_id, asset_name, local_path: local_path ?? null, local_hash: local_hash ?? null, local_size: local_size ?? null, version: version ?? null, now: Date.now() });
}

function getPayloadFiles(source_id) {
  return prepare('SELECT * FROM payload_files WHERE source_id = @source_id ORDER BY asset_name ASC').all({ source_id });
}

function deletePayloadFile(id) {
  return prepare('DELETE FROM payload_files WHERE id = @id').run({ id });
}

// ── Game hashes ───────────────────────────────────────────────────────────────
function addGameHash({ game_id, file_hash, file_size, backup_path, hash_type = 'game', firmware_label = null, verified = 1 }) {
  return prepare(`
    INSERT INTO game_hashes (game_id, file_hash, file_size, backup_path, hash_type, firmware_label, verified)
    VALUES (@game_id, @file_hash, @file_size, @backup_path, @hash_type, @firmware_label, @verified)
    ON CONFLICT(backup_path) DO UPDATE SET
      file_hash      = excluded.file_hash,
      file_size      = excluded.file_size,
      hash_type      = excluded.hash_type,
      firmware_label = excluded.firmware_label,
      verified       = excluded.verified,
      hashed_at      = datetime('now')
  `).run({ game_id, file_hash, file_size, backup_path, hash_type, firmware_label, verified });
}

// Return the firmware folder name for a given backup path (for backpork hashes).
function getBackporkFirmwareLabel(backup_path) {
  const row = prepare(`
    SELECT name FROM backpork_folders
    WHERE @path LIKE path || '%'
    ORDER BY LENGTH(path) DESC LIMIT 1
  `).get({ path: backup_path });
  return row?.name ?? null;
}

function getGameHashes(game_id) {
  return prepare('SELECT * FROM game_hashes WHERE game_id = @game_id ORDER BY hashed_at DESC').all({ game_id });
}

function exportAllHashes() {
  // backup_path is intentionally excluded — it's a local filesystem path
  // and carries no meaning for community hash sharing.
  return prepare(
    'SELECT game_id, file_hash, file_size FROM game_hashes WHERE verified = 1 ORDER BY game_id'
  ).all();
}

// All hashed rows (lightweight — includes type/label fields for summary).
function getAllGameHashes() {
  return prepare('SELECT game_id, file_hash, hash_type, firmware_label FROM game_hashes WHERE verified = 1').all();
}

// Quick count of verified hashes.
function getHashCount() {
  return prepare('SELECT COUNT(*) as c FROM game_hashes WHERE verified = 1').get()?.c ?? 0;
}

function resetAllProsperoFetchedAt() {
  prepare('UPDATE games SET prospero_fetched_at = NULL').run();
  save();
  return prepare('SELECT game_id FROM games').all().map(r => r.game_id);
}

// ── Cheats ────────────────────────────────────────────────────────────────────
function upsertCheatFile(filename, cusaId, version, title, dataJson) {
  prepare(`
    INSERT INTO cheat_files (filename, cusa_id, version, title, data, cached_at)
    VALUES (@filename, @cusa_id, @version, @title, @data, datetime('now'))
    ON CONFLICT(filename) DO UPDATE SET
      title     = excluded.title,
      data      = excluded.data,
      cached_at = excluded.cached_at
  `).run({ filename, cusa_id: cusaId, version, title, data: dataJson });
}

function getCheatFiles(cusaId) {
  return prepare(`SELECT filename, cusa_id, version, title, data, cached_at
                  FROM cheat_files WHERE cusa_id = @cusa_id ORDER BY version`
  ).all({ cusa_id: cusaId });
}

function searchCheats(query) {
  const q = `%${query}%`;
  return prepare(`
    SELECT filename, cusa_id, version, title,
           (SELECT COUNT(*) FROM cheat_files c2 WHERE c2.cusa_id = cf.cusa_id) as file_count
    FROM cheat_files cf
    WHERE cf.title LIKE @q OR cf.cusa_id LIKE @q
    GROUP BY cf.cusa_id
    ORDER BY cf.title ASC
    LIMIT 200
  `).all({ q });
}

function listAllCheatsGrouped() {
  return prepare(`
    SELECT cusa_id, title, COUNT(*) as file_count
    FROM cheat_files
    GROUP BY cusa_id
    ORDER BY title ASC
  `).all({});
}

function listCachedFilenames() {
  return prepare('SELECT filename FROM cheat_files').all({}).map(r => r.filename);
}

function getAllCheatFilesWithData() {
  return prepare('SELECT filename, data FROM cheat_files ORDER BY filename').all({});
}

function getCheatStats() {
  const row = prepare('SELECT COUNT(*) as files, COUNT(DISTINCT cusa_id) as games FROM cheat_files').get({});
  return row || { files: 0, games: 0 };
}

function getUnmatchedCheats() {
  return prepare(`SELECT filename, cusa_id, version, title, cached_at
                  FROM cheat_files
                  WHERE cusa_id IS NULL OR cusa_id = ''
                  ORDER BY title ASC`).all({});
}

function assignCheatCusaId(filename, cusaId) {
  prepare(`UPDATE cheat_files SET cusa_id = @cusa_id WHERE filename = @filename`)
    .run({ filename, cusa_id: cusaId.trim().toUpperCase() });
  save();
}

function getGamesMissingIconUrl() {
  return prepare(`SELECT game_id FROM games WHERE game_id != '' AND (prospero_icon_url IS NULL OR prospero_icon_url = '')`).all().map(r => r.game_id);
}

function clearHashes() {
  db.run('DELETE FROM game_hashes');
  save();
}

function clearAll() {
  db.run('DELETE FROM cheat_files');
  db.run('DELETE FROM payload_files');
  db.run('DELETE FROM payload_sources');
  db.run('DELETE FROM game_hashes');
  db.run('DELETE FROM game_firmware');
  db.run('DELETE FROM backpork_folders');
  db.run('DELETE FROM backups');
  db.run('DELETE FROM games');
  save();
}

/**
 * Selectively clear specific categories of data.
 * @param {Object} opts
 * @param {boolean} opts.games    - Clear games table
 * @param {boolean} opts.backups  - Clear backups table
 * @param {boolean} opts.hashes   - Clear game_hashes table
 * @param {boolean} opts.backporks - Clear backpork_folders + game_firmware tables
 * @param {boolean} opts.payloads - Clear payload_sources + payload_files tables
 * @param {boolean} opts.cheats   - Clear cheat_files table
 */
function clearSelective(opts = {}) {
  if (opts.cheats)    db.run('DELETE FROM cheat_files');
  if (opts.payloads) {
    db.run('DELETE FROM payload_files');
    db.run('DELETE FROM payload_sources');
  }
  if (opts.hashes)    db.run('DELETE FROM game_hashes');
  if (opts.backporks) {
    db.run('DELETE FROM game_firmware');
    db.run('DELETE FROM backpork_folders');
  }
  if (opts.backups)   db.run('DELETE FROM backups');
  if (opts.games) {
    // Clearing games also clears backup records so games don't reappear
    // on the next rescan (upsertGameMinimal would otherwise recreate them
    // from the orphaned backup rows that pointed to the same folders).
    db.run('DELETE FROM backups');
    db.run('DELETE FROM game_hashes');
    db.run('DELETE FROM game_firmware');
    db.run('DELETE FROM games');
  }
  save();
}

/**
 * Delete specific rows by id from an allowed table.
 * @param {string} table - One of 'games', 'backups', 'game_hashes'
 * @param {number[]} ids - Array of row ids to delete
 * @returns {number} Number of rows deleted
 */
function deleteRows(table, ids) {
  const allowed = ['games', 'backups', 'game_hashes'];
  if (!allowed.includes(table)) throw new Error(`Cannot delete from table: ${table}`);
  if (!ids || !ids.length) return 0;
  // sql.js doesn't support array params, so use IN with placeholders
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`);
  stmt.bind(ids);
  stmt.step();
  stmt.free();
  const deleted = db.getRowsModified();
  // If we deleted games, also clean up related backups/hashes/firmware for those game_ids
  if (table === 'games' && ids.length) {
    // Get game_ids we just deleted — they're gone, so clean up by orphan check
    db.run(`DELETE FROM backups WHERE game_id NOT IN (SELECT game_id FROM games WHERE game_id != '')`);
    db.run(`DELETE FROM game_hashes WHERE game_id NOT IN (SELECT game_id FROM games WHERE game_id != '')`);
    db.run(`DELETE FROM game_firmware WHERE game_id NOT IN (SELECT game_id FROM games WHERE game_id != '')`);
  }
  save();
  return deleted;
}

function close() {
  if (db) { saveNow(); db.close(); }
}

// ── Auto-Backpork Generator helpers ───────────────────────────────────────────

/** Games that have at least one local folder backup (usable as backpork source).
 *  Returns exactly one row per game using the most recently added backup path. */
function listGamesWithLocalFolder() {
  return prepare(`
    SELECT g.game_id, g.title, g.prospero_name, g.prospero_icon_url,
           b.backup_path
      FROM games g
      JOIN backups b ON b.rowid = (
        SELECT MAX(b2.rowid) FROM backups b2
         WHERE b2.game_id = g.game_id
           AND b2.source = 'local'
           AND b2.backup_type = 'folder'
      )
     ORDER BY COALESCE(g.prospero_name, g.title, g.game_id)
  `).all();
}

/**
 * Set of game_ids that already have a backpork for the given firmware label.
 * Pass null/'' to return all game_ids that have ANY backpork.
 */
function gameIdsWithBackporkForFw(firmwareLabel) {
  if (firmwareLabel) {
    return new Set(
      prepare('SELECT DISTINCT game_id FROM game_firmware WHERE folder_name = @fw')
        .all({ fw: firmwareLabel }).map(r => r.game_id)
    );
  }
  return new Set(
    prepare("SELECT DISTINCT game_id FROM backups WHERE source = 'backpork'")
      .all().map(r => r.game_id)
  );
}

module.exports = {
  initialize, listGames, upsertGame, updateGame, getGame,
  updateProsperoData, getProsperoAge, resetAllProsperoFetchedAt,
  listBackups, upsertBackup, deleteBackup, purgeArchiveBackups, clearBackupsForGame,
  deleteStaleBackupsInFolder, syncBackedUpFlags, pruneOrphanScanGames, getStats,
  runQuery, exportSql, exportCsv,
  listBackporkFolders, addBackporkFolder, removeBackporkFolder,
  upsertGameMinimal, setGameFirmwareLabel, pruneGameFirmwareForFolder, listFirmwareLabels,
  listGamesForFolder, getGameBackporkEntries, setGamePorked,
  addGameHash, getGameHashes, exportAllHashes, getAllGameHashes, getHashCount, getBackporkFirmwareLabel,
  listPayloadSources, addPayloadSource, removePayloadSource, togglePayloadSource,
  updatePayloadSourceChecked, upsertPayloadFile, updatePayloadFileLocal,
  getPayloadFiles, deletePayloadFile,
  upsertCheatFile, getCheatFiles, searchCheats, listAllCheatsGrouped,
  listCachedFilenames, getAllCheatFilesWithData, getCheatStats, getUnmatchedCheats, assignCheatCusaId,
  getGamesMissingIconUrl,
  listGamesWithLocalFolder, gameIdsWithBackporkForFw,
  beginBulkUpdate, endBulkUpdate, bulkUpdate,
  clearHashes, clearAll, clearSelective, deleteRows, close,
};
