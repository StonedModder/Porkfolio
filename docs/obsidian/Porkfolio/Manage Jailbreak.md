# Manage Jailbreak

[[Pages and Workflows]] · [[ELF Arsenal]] · [[Settings Reference]]

Manage Jailbreak groups helper workflows for user-authorized PS5 homebrew environments. Porkfolio does not jailbreak, exploit, or authenticate a console.

## What it does

- Manages configured payload sources and local payload files.
- Downloads supported payload assets and can queue FTP deployment to configured remote paths.
- Provides YTJB updater/deployment helpers where configured.
- Creates, imports, exports, and restores autoloader snapshots.
- Lets users inspect and adjust an autoloader payload sequence and delay settings.

## Before using it

- Confirm the console already runs the required compatible environment.
- Configure local/remote payload paths in [[Settings Reference]].
- Validate every downloaded asset and destination before deployment.

## Caution

Payload compatibility is not inferred from a filename. Do not deploy unfamiliar binaries, overwrite an autoload sequence without an export/snapshot, or assume a payload is safe across firmware versions.
