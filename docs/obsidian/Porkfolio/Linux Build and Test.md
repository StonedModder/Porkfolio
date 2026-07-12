# Linux Build and Test

[[Home]] · [[Linux Feature Matrix]]

## Prerequisites

- 64-bit Linux desktop session (X11 or Wayland)
- Node.js 18 or newer
- npm
- Network access for `npm ci` and Electron runtime downloads

## Reproducible build

From the repository root:

```bash
npm ci
npm test
rm -rf dist/linux-unpacked dist/__appImage-*
npx electron-builder --linux --dir
```

Create the portable release artifact:

```bash
rm -rf dist/linux-unpacked dist/__appImage-*
npm run build -- --linux
```

The portable artifact is `dist/Porkfolio-<version>.AppImage`.

## Validation record: Linux baseline

Validated on SteamOS-derived Linux kernel `6.16.12-valve24.4-1-neptune-616-gfe145653a794`, Node `22.23.1`, npm `10.9.8`, and Electron `33.4.11`.

The validation suite passed:

- Renderer ID checks
- JavaScript syntax checks
- Platform capability test
- xAvatar module smoke test
- UFS2 module smoke test

The unpacked Linux application was launched in a Wayland desktop session with Electron hardware acceleration disabled on non-Windows hosts. It remained alive for a 10-second unattended smoke window without the prior `GPU process isn't usable` fatal. Electron main, GPU, network, renderer, and audio processes started; the local Porkfolio database initialized and the app registered ELF Arsenal and PFS Ripper IPC handlers without startup errors.

## Manual smoke checklist

Run this checklist on a target desktop before a release:

- [ ] Launch `./dist/linux-unpacked/porkfolio`.
- [ ] Verify the dashboard appears and Settings can be opened.
- [ ] Confirm a blank/local database initializes cleanly.
- [ ] Verify FTP connect/disconnect against an authorized test service.
- [ ] Verify folder selection and a non-destructive local backup scan.
- [ ] Confirm FFPKG/UFS2 and ExFAT display the Linux unsupported message.
- [ ] Verify PFS/FFPFSC workflows only with disposable test data.
- [ ] Build the AppImage and launch it, or extract it with `--appimage-extract` if FUSE is unavailable.

## Troubleshooting

### AppImage will not mount

Use the extraction path:

```bash
./Porkfolio-<version>.AppImage --appimage-extract
./squashfs-root/AppRun
```

### Electron does not display a window

Confirm a graphical session is present:

```bash
printf 'DISPLAY=%s WAYLAND_DISPLAY=%s XDG_SESSION_TYPE=%s\n' "$DISPLAY" "$WAYLAND_DISPLAY" "$XDG_SESSION_TYPE"
```

Run the unpacked executable from a terminal and inspect `~/.config/porkfolio/logs/main.log` for application-level errors.
