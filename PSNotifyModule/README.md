# PSNotifyModule

Drop-in Node.js / Electron module for sending toast notifications to a jailbroken PS5 running `customPSNotify.js`.

No npm dependencies — uses Node's built-in `net` module only.

---

## Setup

1. Copy the `PSNotifyModule/` folder into your project.
2. Make sure `customPSNotify.js` is loaded and running on your PS5.
3. `require` the module by path — done.

```js
const { PS5Notifier, notify } = require('./PSNotifyModule');
```

---

## API

### `notify(host, message, [opts])` — one-shot function

Connects, sends, waits for ACK, disconnects. No instance needed.

```js
const { notify } = require('./PSNotifyModule');

await notify('192.168.1.100', 'Build finished!');

await notify('192.168.1.100', 'Deploy complete', {
  subMessage : 'v2.1.0 is live',
  port       : 6969,    // default
  timeout    : 5000,    // ms, default
});
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `host` | string | yes | PS5 IP address |
| `message` | string | yes | Main toast body |
| `opts.subMessage` | string | no | Smaller text below body |
| `opts.port` | number | no | Port (default `6969`) |
| `opts.timeout` | number | no | Timeout in ms (default `5000`) |

**Returns:** `Promise<{ ok: boolean }>` — resolves with the ACK from the PS5, rejects on connection error / timeout.

---

### `PS5Notifier` — stateful class

Instantiate once, reuse throughout your app. Remembers the host, port, and timeout. Keeps a history of sent notifications.

```js
const { PS5Notifier } = require('./PSNotifyModule');

const ps5 = new PS5Notifier('192.168.1.100');

// send(message, [opts])
await ps5.send('App started');
await ps5.send('Build complete', { subMessage: 'v2.1.0 — 0 errors' });

// history([n]) — last n sent notifications (default 50)
const log = ps5.history();
// [{ ts, message, subMessage, ok }, ...]

// setHost(host) — update IP at runtime
ps5.setHost('192.168.1.105');
```

#### Constructor

```js
new PS5Notifier(host, [defaults])
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `host` | string | yes | PS5 IP address |
| `defaults.port` | number | no | Default port (6969) |
| `defaults.timeout` | number | no | Default timeout ms (5000) |

#### Methods

| Method | Returns | Description |
|---|---|---|
| `send(message, [opts])` | `Promise<{ok}>` | Send a notification |
| `history([n])` | `Array` | Last `n` sent entries |
| `setHost(host)` | `void` | Change the target PS5 IP |

---

## Electron example

```js
// main.js
const { PS5Notifier } = require('./PSNotifyModule');

const ps5 = new PS5Notifier(
  '192.168.1.100',
  { timeout: 3000 }
);

// Call from anywhere in your app:
ipcMain.on('build-complete', async (_, version) => {
  await ps5.send('Build complete', { subMessage: version }).catch(() => {});
});
```

---

## Test

```bash
node test.js <ps5-ip>
node test.js <ps5-ip> "Custom message" "Sub text"
```

Or on Windows, double-click **`test.bat`** and enter your PS5 IP when prompted.

---

## Files

| File | Purpose |
|---|---|
| `index.js` | Module — `notify()` + `PS5Notifier` class |
| `test.js` | Standalone test runner |
| `test.bat` | Windows batch launcher for test.js |
| `package.json` | Module metadata |
| `README.md` | This file |

---

## Wire protocol (for reference)

The module sends a UTF-8 JSON line to the PS5 over TCP:

```
{"message":"Hello!","subMessage":"optional"}\n
```

The PS5 responds:

```
{"ok":true}\n
```
