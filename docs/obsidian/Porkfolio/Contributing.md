# Contributing

[[Home]] · [[Linux Build and Test]]

## Development loop

1. Install dependencies with `npm ci`.
2. Before editing production code, add a focused regression or behavior test where a test seam exists.
3. Run the specific test and observe it fail for the expected reason.
4. Implement the minimal change, rerun the focused test, then run `npm test`.
5. Smoke-test the Electron application on the platform affected by the change.
6. Build the target artifact before publishing a release.

## Required checks

```bash
npm test
npx electron-builder --linux --dir
```

For a portable Linux release:

```bash
npm run build -- --linux
```

## Documentation

- Keep user-facing changes reflected in `README.md`.
- Add or update an Obsidian note under `docs/obsidian/Porkfolio/` for workflows, platform constraints, and architecture decisions.
- Link new notes from [[Home]].
- Never put credentials, console IPs, private payloads, save keys, tokens, webhooks, or local paths in documentation.

## Release hygiene

- Keep `dist/` untracked; it is generated output.
- Inspect `git status` before every commit.
- Confirm the intended license before accepting external code or publishing redistributable binaries.
