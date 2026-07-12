# Platform Support

[[Home]] · [[Pages and Workflows]] · [[Linux Build and Test]]

Porkfolio is an Electron desktop application with Windows, macOS, and Linux packaging targets.

| Capability | Windows | macOS | Linux |
|---|---:|---:|---:|
| Desktop UI, local database, library, FTP, backups, transfers | Supported target | Supported target | Native build smoke-tested |
| Media, xAvatar, payload, notification, save pages | Depends on required companion service/hardware | Depends on required companion service/hardware | Depends on required companion service/hardware |
| System View | Capture-card/browser support required | Capture-card/browser support required | Capture-card/browser support required |
| FFPKG/UFS2 conversion | Windows tooling required | Not supported by bundled tool | Not supported by bundled tool |
| ExFAT image creation | Windows OSFMount tooling required | Not supported by bundled tool | Not supported by bundled tool |

## Build targets

The package configuration defines:

- Windows NSIS installer target.
- macOS DMG target.
- Linux AppImage target.

Build each platform from its native supported environment or platform-appropriate CI runner:

```bash
npm run build -- --win
npm run build -- --mac
npm run build -- --linux
```

## Linux graphics fallback

Porkfolio disables Electron hardware acceleration on non-Windows hosts because the SteamOS/Wayland validation environment repeatedly failed Electron GPU child-process startup. This selects software compositing to preserve application startup. See [[Linux Build and Test]] for the validation record.
