'use strict';

const { Worker }                          = require('worker_threads');
const { buildSdkVersionPairs }            = require('../backpork-gen/sdk-patcher');
const WORKER_PATH = require('path').join(__dirname, '../backpork-gen/processor-worker.js');
const {
  scanFakelibBase,
  ensurePupUnpacker,
  extractPupToDir,
  MANUAL_DL_URL,
} = require('../backpork-gen/fakelib-manager');

module.exports = function register(ipcMain, { win, db, log, path, fs, dialog, app, store }) {
  let _cancelFlag  = false;
  let _activeWorker = null;

  // Run processGame in a dedicated worker thread so the main process stays free.
  function runGameInWorker({ sourceDir, outputDir, sdkPair, fakelibDir, onProgress }) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: { sourceDir, outputDir, sdkPair, fakelibDir },
      });
      _activeWorker = worker;

      // Track settlement so we never leave the promise hanging.
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      worker.on('message', msg => {
        if      (msg.type === 'progress') onProgress(msg.data);
        else if (msg.type === 'done')     { _activeWorker = null; settle(resolve, msg.result); }
        else if (msg.type === 'error')    { _activeWorker = null; settle(reject, new Error(msg.message)); }
      });

      worker.on('error', err  => { _activeWorker = null; settle(reject, err); });
      // Always settle on exit — if already resolved this is a safe no-op via the settled flag.
      worker.on('exit',  code => {
        if (_activeWorker === worker) _activeWorker = null;
        settle(reject, new Error(code !== 0
          ? `Worker exited with code ${code}`
          : 'Worker exited without completing'));
      });
    });
  }

  // Helper: get the current merged pairs (built-in + any user-defined custom pairs)
  function getActiveSdkPairs() {
    const custom = store?.get('customSdkPairs', {}) || {};
    return buildSdkVersionPairs(custom);
  }

  ipcMain.handle('bpgen:sdk-pairs', () => {
    return Object.entries(getActiveSdkPairs()).map(([k, [ps5, ps4]]) => ({
      pair:   Number(k),
      ps5Ver: `0x${ps5.toString(16).padStart(8, '0').toUpperCase()}`,
      ps4Ver: `0x${ps4.toString(16).padStart(8, '0').toUpperCase()}`,
    }));
  });

  ipcMain.handle('bpgen:custom-sdk-pairs-get', () => store?.get('customSdkPairs', {}) || {});
  ipcMain.handle('bpgen:custom-sdk-pairs-set', (_e, pairs) => {
    store?.set('customSdkPairs', pairs || {});
    return { ok: true };
  });

  ipcMain.handle('bpgen:list-missing', (_e, { firmwareLabel = '' } = {}) => {
    const all = db.listGamesWithLocalFolder();
    const withBP = db.gameIdsWithBackporkForFw(firmwareLabel || null);
    return all.filter(g => !withBP.has(g.game_id));
  });

  ipcMain.handle('bpgen:list-all-with-local', () => db.listGamesWithLocalFolder());

  ipcMain.handle('bpgen:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Folder',
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('bpgen:cancel', () => {
    _cancelFlag = true;
    _activeWorker?.postMessage('cancel');
  });

  ipcMain.handle('bpgen:fakelib-scan', () => {
    const baseDir = store?.get('bpgenFakelibBaseDir', '') || '';
    if (!baseDir) return { baseDir: '', pairs: [] };
    return { baseDir, pairs: scanFakelibBase(baseDir) };
  });

  ipcMain.handle('bpgen:fakelib-set-basedir', async (_e, { dir } = {}) => {
    if (dir) {
      store?.set('bpgenFakelibBaseDir', dir);
      store?.set('bpgen.fakelibBaseDir', dir);
      return { baseDir: dir, pairs: scanFakelibBase(dir) };
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Fakelib Base Directory',
    });
    if (canceled) return null;
    const baseDir = filePaths[0];
    store?.set('bpgenFakelibBaseDir', baseDir);
    store?.set('bpgen.fakelibBaseDir', baseDir);
    return { baseDir, pairs: scanFakelibBase(baseDir) };
  });

  ipcMain.handle('bpgen:fakelib-pick-pup', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select Decrypted PS5 Firmware PUP',
      filters: [
        { name: 'Decrypted PUP', extensions: ['dec'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('bpgen:fakelib-extract', async (_e, opts) => {
    const { pupPath, sdkPair, baseDir: optBaseDir } = opts || {};
    if (!pupPath || !sdkPair) throw new Error('pupPath and sdkPair are required');

    const baseDir = optBaseDir || store?.get('bpgenFakelibBaseDir', '') || '';
    if (!baseDir) throw new Error('Set a Fakelib Base Directory first');

    const targetDir = path.join(baseDir, String(sdkPair));
    const toolsDir = app ? path.join(app.getPath('userData'), 'tools') : path.join(baseDir, '.tools');
    const emitFL = (type, payload) => win?.webContents.send('bpgen:fakelib-progress', { type, ...payload });

    emitFL('start', { sdkPair });
    log.info(`[FakelibMgr] Extracting PUP for SDK pair ${sdkPair} -> ${targetDir}`);

    try {
      let toolPath;
      try {
        toolPath = await ensurePupUnpacker(toolsDir, ({ stage, pct, msg }) =>
          emitFL('tool-progress', { stage, pct, msg })
        );
      } catch (e) {
        if (e.manualRequired) {
          emitFL('tool-manual', { msg: e.message, url: MANUAL_DL_URL });
          throw e;
        }
        throw e;
      }

      const { libCount } = await extractPupToDir({
        pupPath,
        targetDir,
        toolPath,
        isCancelled: () => false,
        onProgress: ({ stage, pct, msg }) => emitFL('extract-progress', { stage, pct, msg }),
      });

      log.info(`[FakelibMgr] Done - ${libCount} libraries extracted for pair ${sdkPair}`);
      emitFL('done', { sdkPair, libCount, targetDir });
      return { libCount, targetDir };
    } catch (err) {
      log.error(`[FakelibMgr] Extraction failed: ${err.message}`);
      emitFL('error', { msg: err.message });
      throw err;
    }
  });

  ipcMain.handle('bpgen:run', async (_e, opts) => {
    const {
      gameIds = [],
      sdkPair,
      outputDir,
      firmwareLabel,
      fakelibDir: fakelibDirOpt = null,
      filterFw = '',
      overwrite = false,
    } = opts || {};

    if (!sdkPair || !outputDir) {
      throw new Error('sdkPair and outputDir are required');
    }

    const activePairs = getActiveSdkPairs();
    const targetPairs = sdkPair === 'all'
      ? Object.keys(activePairs).map(Number).sort((a, b) => a - b)
      : [Number(sdkPair)];
    if (!targetPairs.length || targetPairs.some(pair => !activePairs[pair])) {
      throw new Error(`Invalid or unconfigured SDK pair: ${sdkPair}. Add PS5/PS4 version values in Settings → Custom SDK Pairs.`);
    }
    if (sdkPair !== 'all' && !firmwareLabel) {
      throw new Error('firmwareLabel is required for a single SDK target');
    }

    _cancelFlag = false;
    const emit = (type, payload) => win?.webContents.send('bpgen:progress', { type, ...payload });

    const totalInDb = db.getStats().totalGames;
    let games = db.listGamesWithLocalFolder();
    const noLocalFolder = totalInDb - games.length; // games in DB with no local folder recorded
    if (gameIds.length > 0) {
      const set = new Set(gameIds);
      games = games.filter(g => set.has(g.game_id));
    } else if (filterFw) {
      const withBP = db.gameIdsWithBackporkForFw(filterFw);
      games = games.filter(g => !withBP.has(g.game_id));
    } else {
      // For single-pair runs use the specific firmware label so games that
      // already have a backpork for a *different* firmware are not skipped.
      // For all-pairs mode firmwareLabel is '' here; each pair re-filters below.
      const withBP = db.gameIdsWithBackporkForFw(firmwareLabel || null);
      games = games.filter(g => !withBP.has(g.game_id));
    }

    if (games.length === 0) {
      emit('done', { total: 0, ok: 0, failed: 0, skipped: 0 });
      return { total: 0, ok: 0, failed: 0 };
    }

    const pairPlans = targetPairs.map(targetPair => {
      const targetFirmwareLabel = sdkPair === 'all' ? `${targetPair}.xx` : firmwareLabel;
      const pairGames = sdkPair === 'all'
        ? games.filter(g => !db.gameIdsWithBackporkForFw(targetFirmwareLabel).has(g.game_id))
        : games;
      return { targetPair, targetFirmwareLabel, pairGames };
    });

    const totalRuns = pairPlans.reduce((sum, plan) => sum + plan.pairGames.length, 0);
    emit('start', { total: totalRuns, games: games.length, pairs: targetPairs.length, noLocalFolder });
    emit('run-config', {
      sdkPair,
      firmwareLabel,
      outputDir,
      fakelibDir: fakelibDirOpt || '',
      overwrite,
      selectedGames: games.length,
      targetPairs,
    });
    log.info(`[BackporkGen] Starting: ${games.length} game(s), target=${sdkPair}`);

    let totalOk = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let processedCount = 0;

    for (const plan of pairPlans) {
      const { targetPair, targetFirmwareLabel, pairGames } = plan;
      let fakelibDir = fakelibDirOpt || null;
      if (!fakelibDir) {
        const baseDir = store?.get('bpgenFakelibBaseDir', '') || '';
        if (baseDir) {
          const pairStatus = scanFakelibBase(baseDir).find(p => p.pair === targetPair);
          if (pairStatus?.hasLibs) {
            fakelibDir = pairStatus.dir;
            log.info(`[BackporkGen] Auto-resolved fakelib for pair ${targetPair}: ${fakelibDir}`);
          }
        }
      }

      const pairIndex    = targetPairs.indexOf(targetPair) + 1; // 1-based
      const totalPairs   = targetPairs.length;
      let pairGameIndex  = 0;

      // Always emit pair-start so the counter advances even when all games are already done
      emit('pair-start', {
        pairIndex,
        totalPairs,
        sdkPair: targetPair,
        firmwareLabel: targetFirmwareLabel,
        gamesInPair: pairGames.length,
      });

      for (const game of pairGames) {
        if (_cancelFlag) {
          emit('cancelled', { processed: processedCount });
          break;
        }

        processedCount++;
        pairGameIndex++;
        const sourceDir = game.backup_path;
        const gameOutDir = path.join(outputDir, targetFirmwareLabel, game.game_id);

        emit('game-start', {
          gameId: game.game_id,
          title: game.prospero_name || game.title || game.game_id,
          index: processedCount,
          total: totalRuns,
          // Per-pair counters so the renderer can display [X/58 · pair Y/10]
          pairGameIndex,
          pairTotal: pairGames.length,
          pairIndex,
          totalPairs,
          sdkPair: targetPair,
          firmwareLabel: targetFirmwareLabel,
        });

        if (!overwrite && fs.existsSync(gameOutDir)) {
          try {
            if (fs.readdirSync(gameOutDir).length > 0) {
              emit('game-skip', {
                gameId: game.game_id,
                reason: 'output already exists',
                sdkPair: targetPair,
                firmwareLabel: targetFirmwareLabel,
              });
              totalSkipped++;
              continue;
            }
          } catch {}
        }

        if (!fs.existsSync(sourceDir)) {
          emit('game-error', {
            gameId: game.game_id,
            msg: 'Source folder not found on disk',
            sdkPair: targetPair,
            firmwareLabel: targetFirmwareLabel,
          });
          totalFailed++;
          continue;
        }

        try {
          const result = await runGameInWorker({
            sourceDir,
            outputDir: gameOutDir,
            sdkPair: targetPair,
            fakelibDir: fakelibDir || null,
            onProgress: progress => emit('file-progress', {
              gameId: game.game_id,
              sdkPair: targetPair,
              firmwareLabel: targetFirmwareLabel,
              ...progress,
            }),
          });

          totalOk += result.ok;
          totalFailed += result.failed;
          totalSkipped += result.skipped;

          try {
            const fwFolderPath = path.join(outputDir, targetFirmwareLabel);
            const existing = db.listBackporkFolders().find(
              f => path.normalize(f.path).toLowerCase() === path.normalize(fwFolderPath).toLowerCase()
            );
            if (!existing) db.addBackporkFolder(targetFirmwareLabel, fwFolderPath);

            db.upsertGameMinimal(game.game_id);
            db.setGameFirmwareLabel(game.game_id, targetFirmwareLabel);

            const size = await getDirSize(gameOutDir);
            db.upsertBackup({
              game_id: game.game_id,
              backup_path: gameOutDir,
              size,
              backup_type: 'folder',
              source: 'backpork',
            });
            db.updateGame(game.game_id, { backed_up: 1 });
          } catch (dbErr) {
            log.warn(`[BackporkGen] DB register failed for ${game.game_id}: ${dbErr.message}`);
          }

          emit('game-done', {
            gameId: game.game_id,
            ok: result.ok,
            failed: result.failed,
            sdkPair: targetPair,
            firmwareLabel: targetFirmwareLabel,
          });
        } catch (err) {
          log.error(`[BackporkGen] Failed ${game.game_id}: ${err.message}`);
          // Remove partial output so a re-run doesn't see a non-empty dir and
          // wrongly skip this failed game as "output already exists".
          try { fs.rmSync(gameOutDir, { recursive: true, force: true }); } catch {}
          emit('game-error', {
            gameId: game.game_id,
            msg: err.message,
            sdkPair: targetPair,
            firmwareLabel: targetFirmwareLabel,
          });
          totalFailed++;
        }
      }

      if (_cancelFlag) break;
    }

    emit('done', { total: totalRuns, ok: totalOk, failed: totalFailed, skipped: totalSkipped });
    log.info(`[BackporkGen] Done - ok:${totalOk} failed:${totalFailed} skipped:${totalSkipped}`);
    return { total: totalRuns, ok: totalOk, failed: totalFailed };
  });

  async function getDirSize(dir) {
    let total = 0;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await getDirSize(full);
        else {
          try { total += (await fs.promises.stat(full)).size; } catch {}
        }
      }
    } catch {}
    return total;
  }
};
