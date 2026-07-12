# xavatar-electron-module

Drop-in Electron / Node.js module that converts any image into a PS4/PS5-compatible `.xavatar` archive.

A `.xavatar` file is a ZIP containing:
| File | Description |
|---|---|
| `avatar.png` / `picture.png` | 440 × 440 pixel PNG |
| `avatar440.dds` … `avatar64.dds` | DXT5 (BC3) DDS at 440 / 260 / 128 / 64 px |
| `picture440.dds` … `picture64.dds` | Same DDS files (required duplicates) |
| `online.json` | PS Network metadata stub |

---

## Quick install

```bash
npm install xavatar-electron-module jszip
# Optional — needed for file-path / URL / Buffer inputs (not required for RGBA path)
npm install sharp
```

---

## Integration patterns

### 1 — Drop into an existing Electron app

**`main.js`**
```js
const { app, BrowserWindow, ipcMain } = require('electron');
const xavatar = require('xavatar-electron-module');

let cleanup;
app.whenReady().then(() => {
  // Register IPC handlers once
  cleanup = xavatar.registerIpcHandlers(ipcMain);

  const win = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      // Inject the preload — exposes window.xavatarAPI in every renderer
      preload: require.resolve('xavatar-electron-module/preload'),
    },
  });
  win.loadFile('index.html');
});

app.on('will-quit', () => cleanup && cleanup());
```

**`renderer.js`** (runs in the browser context)
```js
import XavatarClient from 'xavatar-electron-module/renderer';

const client = new XavatarClient();

// Wire a file input, paste, and drag-and-drop all at once
client.wireFileInput(document.getElementById('file-input'));
client.wirePaste(document);
client.wireDropZone(document.getElementById('drop-zone'));

// React to events
client.on('image-ready', (canvas) => {
  document.getElementById('preview').src = canvas.toDataURL();
});

document.getElementById('convert-btn').addEventListener('click', async () => {
  await client.convertAndDownload();  // triggers browser file-save dialog
});
```

---

### 2 — Pure Node.js / CLI usage (no Electron required)

```js
const xavatar = require('xavatar-electron-module');
const fs      = require('fs');

// From a local file (needs sharp)
const { buffer, filename } = await xavatar.convertFromPath('./my-photo.jpg');
fs.writeFileSync(filename, buffer);
// → my-photo.xavatar

// From a URL (needs sharp)
const outPath = await xavatar.convertURLAndSave(
  'https://example.com/avatar.png',
  './output'
);
console.log('Saved to', outPath);

// From an in-memory image buffer (needs sharp)
const imgBuf  = fs.readFileSync('./sprite.webp');
const result  = await xavatar.convertFromImageBuffer(imgBuf, { filename: 'sprite' });

// From raw RGBA (NO sharp required)
const rgba440 = new Uint8Array(440 * 440 * 4); // your pixel data
const result2 = await xavatar.convertFromRGBA(rgba440, 440, 440);
```

---

### 3 — Use the low-level DXT5 encoder directly

```js
const { encodeToDDS } = require('xavatar-electron-module/src/dxt5Encoder');

// rgba is a Uint8Array / Buffer of raw RGBA pixels
const ddsBuffer = encodeToDDS(rgba, width, height);
// ddsBuffer is a standard DDS file — DXT5 / BC3 compressed
```

---

## API reference

### Main-process / Node.js API

All functions return `Promise<{ buffer: Buffer, filename: string }>` unless noted.

| Function | Sharp? | Description |
|---|:---:|---|
| `convertFromRGBA(rgba, w, h, opts?)` | No | Raw RGBA pixel data |
| `convertFromImageBuffer(buf, opts?)` | Yes | Encoded image bytes (PNG/JPEG/…) |
| `convertFromPath(filePath, opts?)` | Yes | File path on disk |
| `convertFromURL(url, opts?)` | Yes | Remote HTTP/HTTPS image |
| `convertAndSave(filePath, outDir?, opts?)` | Yes | Convert + write file; returns path string |
| `convertURLAndSave(url, outDir, opts?)` | Yes | Fetch + convert + write file; returns path string |
| `registerIpcHandlers(ipcMain)` | — | Call once in main process; returns cleanup fn |
| `moduleInfo()` | — | Returns `{ version, sharpAvailable }` |

**`opts` fields:**
- `filename` — stem for the output `.xavatar` filename (no extension)

---

### IPC channels (main ↔ renderer)

All channels use `ipcMain.handle` / `ipcRenderer.invoke` (async).  
Response shape: `{ ok: true, buffer: Uint8Array, filename: string }` or `{ ok: false, error: string }`.

| Channel | Payload | Sharp? |
|---|---|:---:|
| `xavatar:convert-rgba` | `{ rgba, width, height, filename? }` | No |
| `xavatar:convert-buffer` | `{ buffer, filename? }` | Yes |
| `xavatar:convert-path` | `{ filePath, filename? }` | Yes |
| `xavatar:convert-url` | `{ url, filename? }` | Yes |
| `xavatar:version` | *(none)* | — |

---

### `window.xavatarAPI` (preload bridge)

Exposed in renderer context when `preload.js` is loaded.

| Method | Description |
|---|---|
| `convertFromCanvas(canvas, opts?)` | Extract RGBA from `<canvas>` → call main |
| `convertFromRGBA(rgba, w, h, opts?)` | Raw RGBA array |
| `convertFromDataURL(dataURL, opts?)` | `data:image/…;base64,…` |
| `convertFromURL(url, opts?)` | Remote URL (bypasses CORS, main process fetches) |
| `convertFromPath(filePath, opts?)` | Absolute path |
| `download(buffer, filename)` | Trigger browser file download |
| `version()` | Get `{ version, sharpAvailable }` |

---

### `XavatarClient` renderer class

High-level wrapper around `window.xavatarAPI`.

```js
import XavatarClient from 'xavatar-electron-module/renderer';
const client = new XavatarClient(/* { api?, masterSize? } */);
```

**Loading methods** — all trigger the `image-ready` event:
- `client.loadFile(file)` — `File` or `Blob`
- `client.loadURL(url)`   — cross-origin safe (decodes in renderer canvas)
- `client.loadRGBA(rgba, w, h)`

**DOM wiring** — return an unwire cleanup function:
- `client.wireFileInput(inputEl)`
- `client.wirePaste(target?)`
- `client.wireDropZone(dropEl)`

**Conversion:**
- `client.convert(opts?)` → `Promise<{ buffer, filename }>`
- `client.convertAndDownload(opts?)` — convert + save dialog

**Crop utility:**
- `client.cropAndResize(srcCanvas, { x, y, w, h }, targetSize?)`

**Events** (`.on(event, handler)`):

| Event | Payload |
|---|---|
| `image-ready` | `HTMLCanvasElement` |
| `convert-start` | — |
| `convert-done` | `{ buffer, filename }` |
| `convert-error` | `Error` |
| `load-error` | `Error` |

---

## Project structure

```
xavatarElectronModule/
├── index.js                  Main entry — Node.js / main-process API
├── preload.js                Electron contextBridge preload
├── package.json
├── src/
│   ├── xavatarCore.js        Conversion pipeline (resize → DXT5 → ZIP)
│   ├── dxt5Encoder.js        Pure-JS BC3/DXT5 encoder (no native deps)
│   └── ipcHandlers.js        IPC handler registration helper
└── renderer/
    └── xavatarRenderer.js    Renderer-side XavatarClient class
```

---

## Dependencies

| Package | Required | Purpose |
|---|:---:|---|
| `jszip` | Yes | Build ZIP archive |
| `sharp` | Optional | Decode/resize image files, buffers & URLs |

When `sharp` is not installed, only `convertFromRGBA` (and the `xavatar:convert-rgba` IPC channel) is available — the renderer can decode and resize an image entirely via browser `<canvas>` and pass the pixel data to the main process using `window.xavatarAPI.convertFromCanvas()`.

---

## License

MIT
