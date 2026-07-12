# ufs2-electron-module

Drop-in Electron/Node.js module that drives **UFS2Tool.exe** to execute the
full **PS5 backpork patching + UFS2 conversion** pipeline and to scan game /
firmware folder hierarchies.

> **⚠ Administrator required**  
> `UFS2Tool.exe` uses low-level filesystem drivers that require Windows
> **Administrator** privileges. Without elevation `child_process.spawn()`
> throws `EACCES` and every UFS2 conversion job will fail.  
>  
> **Production builds:** add `requestedExecutionLevel: requireAdministrator`
> to your electron-builder `nsis`/`win` config.  
> **Dev:** right-click your launch `.bat` → "Run as administrator", or have
> the bat auto-elevate with `Start-Process -Verb RunAs`.

---

## Integration

Copy `src/ufs2ElectronModule/` into your project. The user must supply their
own `UFS2Tool.exe` — the module never bundles it.

```js
const ufs2 = require('./src/ufs2ElectronModule');
ufs2.setToolPath('C:/tools/UFS2Tool/UFS2Tool.exe'); // required — user provides the exe
```

---

## Core workflow — `runPorkJob`

The primary entry point. Runs the complete four-phase pipeline:

| Phase | % range | What happens |
|---|---|---|
| 1 — Copy game | 5 → 35 % | Copies game dir to a per-job temp subfolder |
| 2 — Overlay backpork | 35 → 50 % | Copies firmware-specific patch files on top |
| 3 — UFS2 convert | 50 → 95 % | Spawns `UFS2Tool.exe makefs/newfs` → `.ffpkg` **← needs Admin** |
| 4 — Cleanup | 95 → 100 % | Deletes the temp subfolder |

```js
const result = await ufs2.runPorkJob(
  {
    gamePath:     'G:/PS5/Games/PPSA24473-app',
    backporkPath: 'G:/PS5/Backporks/5.xx/PPSA24473',
    outputFile:   'G:/PS5/Games/PPSA24473_5.xx.ffpkg',
    tempDir:      'C:/data/ufs2Temp',   // large-drive scratch space
    jobId:        'job_001',            // optional, auto-generated if omitted
    method:       'makefs',             // 'makefs' (default) | 'newfs'
    // toolPath: '...',                 // override tool path for this job only
  },
  {
    // Called at most once per ~100 ms during copy phases
    onProgress: ({ phase, percent, detail }) =>
      console.log(`${percent}%  ${phase}  ${detail}`),

    // Each log line from all 4 phases
    onLog: (line) => console.log(line),

    // Return true to cancel mid-job (stops at next file boundary)
    getCancelled: () => false,
  }
);
// result: { ok: boolean, outputFile: string, log: string[], error?: string }
```

---

## Scanning helpers (no Admin needed)

```js
// Scan root dirs for PS5/PS4 game folders (PPSA/CUSA patterns, deduped by game ID)
const games = await ufs2.scanGameDirs(['G:/PS5/Games', 'D:/more/games']);
// → [{ game_id, folder_name, source_path, source_root, size }, ...]

// Scan a firmware backpork folder for game sub-directories
const entries = await ufs2.scanBackporkFolder('G:/PS5/Backporks/5.xx');
// → [{ game_id, folder_name, path, size }, ...]

// Game ID regex and extractor
const id = ufs2.extractGameId('PPSA24473-app'); // → 'PPSA24473'
// ufs2.GAME_ID_RE — the raw RegExp
```

---

## Single UFS2 ops (Admin required)

```js
// PS5 makefs (recommended): -S 4096 -t ffs -o version=2,minfree=0,...
const r = await ufs2.makefsPS5('./PPSA01234', './PPSA01234.ffpkg');

// PS5 newfs
const r = await ufs2.newfsPS5('./PPSA01234', './PPSA01234.ffpkg');

// Generic makefs / newfs
await ufs2.makefs(inputDir, outputFile, { sectorSize: '512', fsOptions: 'version=1' });

// Extract, info, ls, fsck
await ufs2.extract('./PPSA01234.ffpkg', './extracted/');
await ufs2.info('./PPSA01234.ffpkg');
await ufs2.ls('./PPSA01234.ffpkg', '/app0');
await ufs2.fsck('./PPSA01234.ffpkg', { mode: 'readonly' }); // 'preen'|'readonly'|'force'

// RunResult: { ok, stdout, stderr, exitCode, durationMs }
// exitCode -1 = spawn/EACCES error,  -2 = timeout
```

---

## Batch ops (Admin required)

```js
const batch = await ufs2.batchMakefsPS5([
  { inputDir: './PPSA01234', outputFile: './out/PPSA01234.ffpkg' },
  './PPSA05678',   // bare path — outputFile auto-derived as ./PPSA05678.ffpkg
], {
  onProgress: (current, total, item) => console.log(`${current}/${total}`, item.ok),
  stopOnError: false,
});
// BatchResult: { results[], succeeded, failed, durationMs }

// Convert every sub-directory of a folder in one call
await ufs2.batchFromFolder('./games/', './output/', { method: 'makefs', ps5: true });
```

---

## Electron IPC integration

### Main process

```js
const { app, ipcMain } = require('electron');
const ufs2             = require('./src/ufs2ElectronModule');

app.whenReady().then(() => {
  ufs2.setToolPath(settings.toolPath);          // user-supplied path
  const cleanup = ufs2.registerIpcHandlers(ipcMain);
  app.on('will-quit', cleanup);
});
```

### BrowserWindow preload

```js
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    preload: require.resolve('./src/ufs2ElectronModule/preload'),
  }
});
```

### Renderer (`window.ufs2API`)

```js
// Subscribe BEFORE starting the job
const unsubP = ufs2API.onPorkProgress(({ jobId, phase, percent, detail }) =>
  console.log(percent, phase, detail));
const unsubL = ufs2API.onPorkLog(({ jobId, line }) =>
  console.log(line));

const result = await ufs2API.runPorkJob({
  gamePath, backporkPath, outputFile, tempDir,
  jobId: 'job_001', method: 'makefs',
});
unsubP(); unsubL();

// Cancel a running job (can call at any time while invoke is in-flight)
await ufs2API.cancelPorkJob('job_001');

// Scanning (no Admin)
const { games }   = await ufs2API.scanGames(['G:/PS5/Games']);
const { entries } = await ufs2API.scanBackpork('G:/PS5/Backporks/5.xx');

// Direct UFS2 ops (Admin required)
const r = await ufs2API.makefsPS5(inputDir, outputFile);

// Batch with progress
const unsub = ufs2API.onBatchProgress(ev => console.log(ev));
const batch = await ufs2API.batchMakefsPS5(entries);
unsub();
```

---

## IPC channel reference

| Channel | Direction | Payload |
|---|---|---|
| `ufs2:version` | invoke | → `{ ok, version, toolPath, toolAvailable }` |
| `ufs2:set-tool-path` | invoke | `{ toolPath }` |
| `ufs2:run-pork-job` | invoke | job opts → `{ ok, jobId, outputFile, log }` |
| `ufs2:cancel-pork-job` | invoke | `{ jobId }` |
| `ufs2:pork-progress` | **push** | `{ jobId, phase, percent, detail }` |
| `ufs2:pork-log` | **push** | `{ jobId, line }` |
| `ufs2:scan-games` | invoke | `{ sourceDirs[] }` → `{ ok, games[] }` |
| `ufs2:scan-backpork` | invoke | `{ folderPath }` → `{ ok, entries[] }` |
| `ufs2:makefs` / `newfs` / `makefs-ps5` / `newfs-ps5` | invoke | `{ inputDir, outputFile, opts? }` → RunResult |
| `ufs2:extract` | invoke | `{ imageFile, outputDir, fsPath? }` → RunResult |
| `ufs2:info` / `ls` / `fsck` | invoke | per-op params → RunResult |
| `ufs2:batch-makefs` / `batch-newfs` / `batch-extract` | invoke | `{ entries, opts? }` → BatchResult |
| `ufs2:batch-progress` | **push** | `{ batchId, current, total, ok, entry, result }` |

---

## File structure

```
src/ufs2ElectronModule/
  index.js          ← main entry point & re-exports
  preload.js        ← contextBridge → window.ufs2API
  package.json
  README.md
  src/
    ufs2Core.js     ← all business logic (pure Node, no Electron dep)
    ipcHandlers.js  ← ipcMain handler registration
  test.js           ← standalone test runner (node test.js)
  test.bat
```

---

## Result shapes

### runPorkJob result

```js
{ ok: boolean, outputFile: string, log: string[], error?: string }
```

### RunResult (single UFS2 ops)

```js
{ ok: boolean, stdout: string, stderr: string, exitCode: number, durationMs: number }
// exitCode: 0 = success, -1 = spawn error / EACCES (not elevated), -2 = timeout
```

### BatchResult

```js
{ results: Array<{ ok, entry, result: RunResult }>, succeeded: number, failed: number, durationMs: number }
```

