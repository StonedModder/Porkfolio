# Porkfolio Pages and Workflows

[[Home]] · [[Overview]] · [[Settings Reference]] · [[Platform Support]]

This note documents every primary Porkfolio navigation page. It describes what each page is for, the actions it exposes, and any prerequisites. Features that contact a console require the relevant authorized FTP service or companion payload to already be running.

## Navigation map

| Area | Page | Main purpose |
|---|---|---|
| Library | [[Dashboard]] | Start page, database overview, quick FTP connection, and pinned cards. |
| Library | [[Games]] | Installed-game library, metadata, updates/DLC, and per-game management. |
| Library | [[Backporks]] | Firmware-labelled patch folders and FTP deployment. |
| Library | [[Backups]] | Local game backup inventory and verification. |
| Library | [[Database]] | Local data explorer, SQL queries, and exports. |
| Console tools | [[Manage Jailbreak]] | Payload/download/update helpers and autoloader management. |
| Console tools | [[Y2JB Update Generator]] | Builds validated local `y2jb_update.zip` archives from the bundled template and selected payloads. |
| Console tools | [[PS Notify]] | PS5 notification debugging and delivery tests. |
| Console tools | [[xAvatar Management]] | `.xavatar` creation, preview, extraction, and FTP upload. |
| Console tools | [[System View]] | Capture-card display, recording, fullscreen, and popout. |
| Console tools | [[Transfers]] | Global FTP transfer queue and job controls. |
| Console tools | [[Media]] | PS5 screenshot/video discovery, downloads, thumbnails, and sharing. |
| Console tools | [[Cheats]] | Cheat collection discovery, download, and FTP installation. |
| Console tools | [[GarlicSaves]] | Optional Garlic worker workflows for supported save operations. |
| Console tools | [[ELF Arsenal]] | ELF catalog/download/management tools. |
| Console tools | [[PFS Ripper]] | PFS image discovery and extraction workflow. |
| Console tools | [[Local Save Manager]] | Payload-backed save transfer, decrypt/resign, and restore tasks. |
| Application | [[Settings Reference]] | Connection, paths, behavior, UI, media, and feature configuration. |

## Recommended operating order

1. Configure [[Settings Reference]] before attempting PS5-connected actions.
2. Use [[Dashboard]] to connect and see the health of the local database.
3. Scan via [[Games]] to create an installed-library baseline.
4. Add and scan local sources with [[Backups]] and, if applicable, [[Backporks]].
5. Monitor all network operations from [[Transfers]].
6. Use specialist pages only after their payload, FTP, or local-hardware prerequisites are met.

## Safety boundaries

- Confirm the target console, remote path, and source data before launching upload, deletion, restore, conversion, or patch workflows.
- Keep save keys, credentials, and webhook URLs out of screenshots, notes, commits, and issue reports.
- Use disposable copies when evaluating conversion, PFS, save, or patch workflows.
- Platform restrictions are documented in [[Platform Support]].
