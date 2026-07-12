# Database

[[Pages and Workflows]] · [[Games]] · [[Backups]]

Database exposes Porkfolio's local application data for inspection and export.

## What it does

- Browses stored game, backup, and hash records.
- Displays local library statistics used by the Dashboard.
- Runs user-entered SQL queries against the local Porkfolio database.
- Exports supported data as CSV or a SQL dump.
- Provides clear/reset actions for selected local records.

## Use cases

- Diagnose unexpected library results after a scan.
- Export a local inventory for backup or analysis.
- Clear stale local cache/data before rebuilding an inventory from configured sources.

## Caution

The query runner and clear actions operate on local Porkfolio data. Export first and review SQL carefully. Clearing local records does not undo remote console changes, but it can remove the local associations and history that make later workflows easier to audit.
