# Media

[[Pages and Workflows]] · [[Transfers]] · [[Settings Reference]]

Media discovers and manages screenshots and video clips available through the configured PS5 FTP service.

## What it does

- Browses supported PS5 media directories through FTP.
- Filters and searches screenshots and clips.
- Downloads selected media to a configured local destination.
- Generates thumbnails for compatible clips using the bundled local ffmpeg workflow.
- Opens the local media destination when supported by the host OS.
- Supports optional Discord webhook sharing; larger clips may use a configured external upload path before a link is posted.

## Setup

Set the local destination and any optional Discord/webhook preferences in [[Settings Reference]]. Connect to FTP before scanning remote media.

## Caution

Review the recipient and media file before sharing. Webhooks and externally hosted links can expose content outside your local network. Keep webhook URLs private and out of git.
