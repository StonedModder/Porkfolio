# Linux Feature Matrix

[[Home]] · [[Overview]] · [[Linux Build and Test]]

| Feature group | Linux | Notes |
|---|---:|---|
| Electron desktop UI | Yes | Packaged and smoke-tested as a native x64 Linux app. |
| Local database and inventory | Yes | Stored in Electron user data (`~/.config/porkfolio` on the validation host). |
| FTP, transfers, backups, game metadata | Yes | Requires a reachable, authorized console FTP service when used. |
| Media, thumbnails, local ffmpeg workflows | Yes | Validate capture hardware separately if System View is used. |
| Payload, notification, save, xAvatar workflows | Yes | External console payload/service availability still applies. |
| Optional local web bridge | Yes | Enable only on trusted networks and use the app's access controls. |
| Raw PFS/FFPFSC conversion paths | Workflow-dependent | Test using disposable input before console deployment. |
| FFPKG/UFS2 conversion | No | Requires Windows `UFS2Tool.exe` and its Windows filesystem tooling. |
| ExFAT image creation | No | Requires Windows OSFMount drivers/tooling. |

## UI behavior for unsupported conversions

On non-Windows hosts, Porkfolio returns an explicit unsupported capability for FFPKG/UFS2 and ExFAT. The conversion UI shows the reason instead of prompting users to configure nonfunctional `.exe` or OSFMount paths.

## Why these features stay unavailable

The source's UFS2 implementation calls `UFS2Tool.exe`. The native ExFAT builder is explicitly guarded as Windows-only and launches `cmd.exe` plus OSFMount. Packaging those Windows dependencies into a Linux Electron build would not make them executable or reliable, so the application keeps the boundary explicit.
