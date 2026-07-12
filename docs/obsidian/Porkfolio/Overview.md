# Porkfolio Overview

[[Home]]

## Purpose

Porkfolio is an Electron desktop application that centralizes PS5 homebrew-management workflows. It is designed around a local workstation that communicates with services already running on a user-controlled console.

## Major subsystems

| Area | Primary code | Notes |
|---|---|---|
| Desktop application | `main.js`, `preload.js`, `renderer/` | Electron main/renderer architecture with context isolation. |
| Inventory and metadata | `src/database.js`, `src/prospero.js` | Local SQL-backed game, backup, and metadata records. |
| Console transport | `src/ftp.js`, `src/transfers.js` | FTP connection and queued uploads/downloads. |
| Media | `src/ipc/media.js`, `renderer/modules/media.js` | Screenshot/clip handling and local encoding. |
| Payload tools | `renderer/modules/payload.js`, `build/garlic/` | Payload and autoloader workflows. |
| Save and avatar tools | `src/ipc/garlic-saves.js`, `src/xavatarElectronModule/` | Payload-dependent save workflows and local xAvatar conversion. |
| Conversion | `src/ipc/conversion.js`, `src/pfs/`, `src/exfat/` | Cross-platform PFS paths plus Windows-only image formats. |
| Optional web bridge | `src/web-server.js`, `renderer/pork-web-shim.js` | Local web-facing bridge for supported actions. |

## Safety boundaries

- Porkfolio does not itself jailbreak, exploit, or authenticate a console; users must run and authorize required services separately.
- Verify remote host/port settings before transfer, deletion, or installation actions.
- Keep console credentials, save keys, and webhooks out of source control.
- Treat conversion tools as destructive-workflow-adjacent: always use copies and verify output before deploying it.

## Platform model

Desktop, database, FTP, inventory, media, payload management, and xAvatar workflows run on Linux and Windows. See [[Linux Feature Matrix]] for the conversion exceptions and [[Linux Build and Test]] for the validation procedure.
