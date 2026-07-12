# GarlicSaves

[[Pages and Workflows]] · [[Local Save Manager]] · [[Settings Reference]]

GarlicSaves is Porkfolio's optional integration point for Garlic worker save workflows.

## What it does

- Obtains and sends the configured Garlic worker payload where supported.
- Uploads the companion configuration to its configured console location.
- Starts compatible backup and restore requests.
- Displays step-level progress and errors for the worker interaction.

## Before using it

Confirm that the worker version, target console environment, configuration, storage location, and network ports match the Garlic workflow you intend to use. This page is optional; it is not required for Porkfolio's ordinary FTP, library, or media features.

## Caution

Treat worker payloads, configuration, and save data as sensitive. Back up the original save state and configuration before restore actions. Do not commit or share any keys, account identifiers, or host-specific configuration files.
