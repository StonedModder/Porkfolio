# Local Save Manager

[[Pages and Workflows]] · [[GarlicSaves]] · [[PFS Ripper]] · [[Settings Reference]]

Local Save Manager coordinates supported save-file workflows with a compatible PS5 save-management payload/service.

## What it does

- Connects to the configured save-management companion service.
- Requests/downloads supported save data.
- Supports local decrypt, resign, re-encrypt, upload, and restore-oriented tasks where the required keys/service are available.
- Provides helpers for supported empty-save, icon, and USB-related workflows.

## Prerequisites

- The relevant companion payload/service must already be running on the target console.
- Required keys, account information, and paths must be valid and handled privately.
- An authorized FTP/network route may be needed by portions of the workflow.

## Critical safety note

Save operations can be destructive and may involve sensitive keys or account identifiers. Work from copies, retain the original encrypted save, never publish keys, and validate a restored save only on a disposable/test path first.
