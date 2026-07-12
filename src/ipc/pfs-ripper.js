'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PFS Ripper — native port of Deckerr97's "PFS Ripper" (Windows app, no public
// source). Browses/manages/exports a library of PS5 PFS-family image files
// (.ffpkg / .ffpfsc / .pkg / .exfat / .img / .iso and PFS dumps) sitting in one
// or more configured folders. Extracts the PPSA/CUSA title ID + version from
// each image's name (cover art is fetched by the renderer via the existing
// ProsperoPatches metadata), supports search, and exports images (copy to a
// folder, reveal in Explorer, or hand off to the FTP transfer queue).
//
// ponytail: title/version come from the filename (the reliable, universal
// convention for these dumps). Reading TITLE_ID/APP_VER from an embedded
// param.sfo is the upgrade path if filenames ever prove insufficient.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function register(ipcMain, { win, store, log, path, fs, dialog, shell, ftp, transferMgr }) {
  const IMAGE_EXTS = new Set(['.ffpkg', '.ffpfsc', '.pkg', '.exfat', '.img', '.iso', '.bin']);

  const foldersGet = () => store.get('pfsRipper.folders', []);
  const foldersSet = (arr) => store.set('pfsRipper.folders', arr);

  // ── Metadata parsing from a filename ───────────────────────────────────────
  function parseImageName(name) {
    // Not \b after the digits: a trailing "_" (word char) would defeat it. Use a
    // negative digit lookahead so exactly-5-digit IDs match even before "_00".
    const idMatch = name.match(/(PPSA|CUSA)(\d{5})(?!\d)/i);
    const gameId  = idMatch ? (idMatch[1].toUpperCase() + idMatch[2]) : '';

    // Version: prefer explicit vX.YZ, else the "-A0105" app-version convention
    // (A + 4 digits → 01.05), else blank.
    let version = '';
    const vExplicit = name.match(/\bv(\d+\.\d{2,})\b/i);
    if (vExplicit) {
      version = vExplicit[1];
    } else {
      const aVer = name.match(/[-_.]A(\d{2})(\d{2})\b/i);
      if (aVer) version = `${parseInt(aVer[1], 10)}.${aVer[2]}`;
    }
    return { gameId, version };
  }

  function scanFolder(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { log.warn(`[PFSRipper] cannot read ${dir}: ${e.message}`); return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanFolder(full, out); // recurse — libraries are often nested per-title
      } else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        const { gameId, version } = parseImageName(e.name);
        out.push({
          file:    e.name,
          path:    full,
          folder:  dir,
          ext:     path.extname(e.name).toLowerCase().slice(1),
          size:    stat.size,
          mtime:   stat.mtimeMs,
          gameId,
          version,
        });
      }
    }
  }

  // ── Folder management ──────────────────────────────────────────────────────
  ipcMain.handle('pfsripper:folders:list', () => foldersGet());

  ipcMain.handle('pfsripper:folders:add', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select a PFS image library folder',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return foldersGet();
    const folders = foldersGet();
    if (!folders.includes(filePaths[0])) folders.push(filePaths[0]);
    foldersSet(folders);
    return folders;
  });

  ipcMain.handle('pfsripper:folders:remove', (_e, { folder }) => {
    const folders = foldersGet().filter(f => f !== folder);
    foldersSet(folders);
    return folders;
  });

  // ── Scan the whole library ─────────────────────────────────────────────────
  ipcMain.handle('pfsripper:scan', () => {
    const out = [];
    for (const dir of foldersGet()) {
      if (dir && fs.existsSync(dir)) scanFolder(dir, out);
    }
    out.sort((a, b) => (a.gameId || a.file).localeCompare(b.gameId || b.file));
    log.info(`[PFSRipper] scan found ${out.length} image(s)`);
    return out;
  });

  // ── Export: copy an image to a chosen folder ───────────────────────────────
  ipcMain.handle('pfsripper:export-copy', async (_e, { path: srcPath }) => {
    if (!srcPath || !fs.existsSync(srcPath)) throw new Error('Source image not found.');
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select destination folder for the exported image',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return { canceled: true };
    const dest = path.join(filePaths[0], path.basename(srcPath));
    await fs.promises.copyFile(srcPath, dest);
    return { ok: true, dest };
  });

  // ── Export: send an image to the PS5 via the FTP transfer queue ────────────
  ipcMain.handle('pfsripper:export-ftp', (_e, { path: srcPath, remoteDir }) => {
    if (!srcPath || !fs.existsSync(srcPath)) throw new Error('Source image not found.');
    if (!transferMgr) throw new Error('Transfer manager unavailable.');
    const base = path.basename(srcPath);
    const rdir = (remoteDir || store.get('conv.remotePfsPath', '/data')).replace(/\/+$/, '');
    return transferMgr.enqueue('upload', {
      label:      `PFS export → ${base}`,
      localPath:  srcPath,
      remotePath: `${rdir}/${base}`,
    });
  });

  // ── Reveal an image in the OS file manager ─────────────────────────────────
  ipcMain.handle('pfsripper:reveal', (_e, { path: p }) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return { ok: true };
  });

  log.info('[PFSRipper] IPC handlers registered');

  // Self-check for the filename parser (main-process modules aren't unit-tested
  // elsewhere; this validates the one piece of non-trivial logic).
  if (process.env.PORK_SELFCHECK) {
    const assert = require('assert');
    assert.deepStrictEqual(parseImageName('PPSA01234_00-GAME-A0105-V0100.ffpkg'),
      { gameId: 'PPSA01234', version: '1.05' });
    assert.deepStrictEqual(parseImageName('PPSA00219-App.ffpfsc'),
      { gameId: 'PPSA00219', version: '' });
    assert.deepStrictEqual(parseImageName('CUSA12345 v1.02 backup.pkg'),
      { gameId: 'CUSA12345', version: '1.02' });
    assert.deepStrictEqual(parseImageName('random.iso'), { gameId: '', version: '' });
    log.info('[PFSRipper] parser self-check OK');
  }
};
