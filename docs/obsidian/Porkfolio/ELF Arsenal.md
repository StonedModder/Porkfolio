# ELF Arsenal

[[Pages and Workflows]] · [[Manage Jailbreak]] · [[Settings Reference]] · [[System State Controls]]

ELF Arsenal is a self-contained PS5 payload and homebrew environment from [soniciso](https://git.etawen.dev/soniciso/elf-arsenal). After it is sent to a compatible loader, it serves its own full WebUI on the PS5 at `http://<PS5-IP>:6969/`.

## Porkfolio integration

Porkfolio's **ELF Arsenal** tab embeds that WebUI directly. It does not recreate or proxy individual ELF Arsenal pages, file APIs, launch behavior, or settings. This keeps Porkfolio aligned with the exact version of ELF Arsenal currently running on the console.

The tab checks the configured PS5 address and port `6969`, then loads the payload's root WebUI in an embedded frame. Use **Reload WebUI** after restarting or updating ELF Arsenal.

## Before using it

1. Configure the PS5 address in [[Settings Reference]].
2. Jailbreak only hardware you are authorized to use and start a compatible loader.
3. Send the ELF Arsenal payload to the loader, normally on port `9021`.
4. Wait until `http://<PS5-IP>:6969/` is reachable.
5. Open the Porkfolio ELF Arsenal tab.

## What the embedded WebUI provides

The upstream project documents a web interface for homebrew, file management, configured payload helpers, save tooling, statistics, and settings. It includes a local WebUI on port `6969`; related services can use additional ports such as FTP on `2121`, klog on `3232`, and save management on `8082`.

Porkfolio does not claim that every upstream capability is compatible with every firmware, jailbreak, or payload stack. Refer to the upstream project documentation and release notes before using an operation.

## Safety boundaries

- The embedded page only works while ELF Arsenal is already running on the configured console.
- Features in the WebUI can change console state. Review their native warnings and use only on systems you own and are authorized to modify.
- Verify payload source, firmware support, loader compatibility, and recovery steps independently.
- System power actions are provided separately through [[System State Controls]] and require a typed confirmation phrase in Porkfolio.
