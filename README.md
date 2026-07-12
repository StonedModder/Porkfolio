# Porkfolio

Porkfolio is an Electron management utility for PS5 homebrew and console workflows: FTP transfers, game and backup inventory, media tools, payload management, save tooling, xAvatar conversion, notifications, and conversion helpers.

Current source version: **`1.0.8`**.

> [!IMPORTANT]
> Use Porkfolio only with consoles, software, backups, and homebrew you are authorized to use. PS5-facing features require services/payloads already running on the target console.

## Linux status

Porkfolio now packages and runs on 64-bit Linux as a portable AppImage. Core desktop, database, FTP, game inventory, backup, media, payload, save, xAvatar, notification, and web-bridge features are cross-platform.

Two conversion modes remain intentionally unavailable on Linux:

- **FFPKG/UFS2** requires the bundled Windows `UFS2Tool.exe`.
- **ExFAT image creation** requires Windows OSFMount drivers/tools.

The conversion UI reports this clearly on non-Windows systems; raw PFS/FFPFSC paths remain available where supported by their underlying workflow.

## Install and run on Linux

Download the `Porkfolio-1.0.8.AppImage` artifact from the release, then:

```bash
chmod +x Porkfolio-1.0.8.AppImage
./Porkfolio-1.0.8.AppImage
```

If your distribution cannot mount AppImages through FUSE, use:

```bash
./Porkfolio-1.0.8.AppImage --appimage-extract
./squashfs-root/AppRun
```

See [[docs/obsidian/Porkfolio/Linux Build and Test]] for the exact validation record and [[docs/obsidian/Porkfolio/Linux Feature Matrix]] for the platform boundaries.

## Development

### Requirements

- Node.js 18+ (validated with Node 22)
- npm
- A PS5 FTP service only when exercising PS5-connected functions
- Linux desktop session (Wayland or X11) for GUI smoke testing

### Setup and test

```bash
npm ci
npm test
npm start
```

`npm test` performs renderer-ID and JavaScript syntax checks, a Linux/Windows conversion-capability test, and smoke tests for xAvatar and UFS2 modules.

### Build a portable Linux app

```bash
npm run build -- --linux
```

The AppImage is written to `dist/` (ignored by git). For a faster unpacked desktop smoke test:

```bash
npx electron-builder --linux --dir
./dist/linux-unpacked/porkfolio
```

## First-time setup

1. Open **Settings → FTP Connection** and enter the target console's host, port, username, and password as required.
2. Add local backup roots under **Settings → Game Source Folders**.
3. Add firmware-labelled backpork roots under **Settings → Backpork Folders**.
4. Confirm remote game paths under **Settings → Remote Game Paths**.
5. Configure Media output and optional notification integrations.
6. Use **Dashboard → Connect** and then **Scan PS5** to build the local inventory.

## Project layout

```text
.
├── main.js                         # Electron main process and IPC wiring
├── preload.js                      # Renderer bridge
├── renderer/                       # UI, pages, and renderer modules
├── src/                            # Core services, IPC helpers, DB, FTP, web server
├── docs/obsidian/Porkfolio/        # Obsidian-compatible user/developer notes
├── PSNotifyModule/                 # PS5 notification helper module
├── src/ufs2ElectronModule/         # UFS2 conversion module (Windows tooling)
├── src/xavatarElectronModule/      # xAvatar conversion module
├── build/                          # Runtime assets and payload/tool bundles
└── assets/                         # Project branding assets
```

## Security and repository hygiene

Do not commit `.env` files, IP addresses, passwords, private keys, save keys, Discord webhooks, Catbox/API tokens, Electron logs, generated builds, or local database/configuration state. The supplied `.gitignore` excludes these items and build output.

## Documentation vault

The Markdown files under `docs/obsidian/` are an Obsidian-compatible vault kept with the source. Open that directory as a vault in Obsidian to browse the linked notes:

- [[docs/obsidian/Porkfolio/Overview]]
- [[docs/obsidian/Porkfolio/Linux Build and Test]]
- [[docs/obsidian/Porkfolio/Linux Feature Matrix]]
- [[docs/obsidian/Porkfolio/Contributing]]

## License

No license was included in the supplied source archive. Add the intended license before accepting external contributions or redistributing derivative work.
