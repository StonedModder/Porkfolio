# PS Notify

[[Pages and Workflows]] · [[Settings Reference]] · [[Transfers]]

PS Notify is a diagnostic and notification page for compatible PS5 notification services.

## What it does

- Sends a manually composed notification message and optional sub-message.
- Tests the configured host, port, and timeout.
- Displays per-session notification history and delivery failures.
- Is used by other Porkfolio workflows to report transfer, media, conversion, and task state where enabled.

## Setup

Configure the target host, UDP port, and timeout in [[Settings Reference]]. The default values are only defaults; use the values required by the notification service actually running on your console.

## Troubleshooting

A failed test can indicate an incorrect network address, firewall/network isolation, wrong port, or an unavailable notification payload. It does not by itself imply a fault in unrelated FTP features.
