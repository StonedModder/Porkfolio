# Backporks

[[Pages and Workflows]] · [[Games]] · [[Transfers]] · [[Settings Reference]]

Backporks organizes local folders containing firmware-labelled game patches and lets you match them to titles in the Porkfolio library.

## What it does

- Registers one or more local backpork roots.
- Discovers firmware-labelled child folders, such as `4.xx`, `5.xx`, or `6.xx`.
- Scans folders to identify game entries.
- Shows available patch folders for games in [[Games]].
- Queues a selected patch folder for FTP deployment to the configured console destination.

## Setup

1. Add a root folder in **Settings → Backpork Folders** or through the page.
2. Scan that root so Porkfolio records its firmware labels and game entries.
3. Confirm each game's destination path before using a deployment action.

## Caution

Firmware compatibility is the operator's responsibility. A folder label is only an organizational hint; verify the patch, game version, and target console environment before applying anything.
