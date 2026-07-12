# Games

[[Pages and Workflows]] · [[Backups]] · [[Backporks]] · [[Transfers]] · [[Settings Reference]]

Games is Porkfolio's installed-library page. It scans configured PS5 game locations and groups entries by title/game ID, including common `PPSA#####` and `CUSA#####` naming patterns.

## What it shows

- Installed game entries from configured remote locations.
- Search, filtering, and sorting for the local library.
- Metadata retrieved through the Prospero integration, where available: title, publisher, icon, banner, version, region, patches, DLC, and related regional entries.
- Per-game backup and install state.

## Per-game management

Open a game to inspect its information, updates, DLC, regions, and management actions. Depending on your configuration and console services, management can link a local backup, store a remote game path, queue upload/download work, request a hash operation, or hand off to a matching backpork workflow.

## Prerequisites

- Configure remote game paths in [[Settings Reference]].
- Connect to an authorized FTP service before scanning or deploying files.
- Metadata enrichment depends on network availability and upstream data.

## Caution

A discovered folder name is not a guarantee that the folder is complete or deployable. Verify its remote path, local backup contents, and firmware/patch compatibility before transfer.
