# Y2JB Update Generator

[[Pages and Workflows]] · [[Manage Jailbreak]] · [[PS Notify]] · [[Platform Support]]

Y2JB Update Generator is Porkfolio's local workspace-to-archive tool for Y2JB update packages. It ports the archive pipeline and bundled template from [StonedModder/Y2JB-Genny](https://github.com/StonedModder/Y2JB-Genny) into Porkfolio's **Manage Jailbreak** page.

## What it creates

The generator builds a local `y2jb_update.zip` from the bundled Y2JB template. The ZIP includes:

- Required update runtime/template files.
- A generated `ps5_autoloader/autoload.txt`.
- Selected payload files placed under `ps5_autoloader/`.
- A generated `update-info.txt` manifest containing staged file paths and sizes.

The build uses Porkfolio's native PS5-safe ZIP writer. It writes classic ZIP records, uses forward-slash archive paths, avoids ZIP64, and validates that the completed file has ZIP local-file and end-of-central-directory records.

## Page workflow

1. Open **Manage Jailbreak → Y2JB Update Generator**.
2. Select supported payload files (`.elf`, `.bin`, `.js`, or `.jar`).
3. Arrange the generated payload rows. Add optional **Delay** rows (milliseconds) or **Message** rows.
4. Select **Build Update ZIP** and choose an output location.
5. Copy the resulting archive to the USB layout/name required by your Y2JB environment—commonly `y2jb_update.zip` at the USB root when that is what the target workflow expects.

## Autoload rows

| Row | Generated line | Purpose |
|---|---|---|
| Payload | `payload.elf` | Run the matching staged payload file. Paths are case-sensitive. |
| Delay | `!1000` | Wait in milliseconds before the next row. |
| Message | `@ Text` | Add a text/status row to the generated autoload manifest. |

## What the generator validates

Before saving an archive, Porkfolio verifies:

- The bundled template contains `main.js`, `update.js`, and `ps5_autoloader/autoload.txt`.
- Every payload row is a safe relative path and resolves to a staged file.
- Delay values contain only milliseconds.
- ZIP entry names are ASCII and use `/`, not Windows backslashes.
- The archive does not require ZIP64.
- The final file has valid ZIP start/end markers.

## Test-drive record

The automated generator test builds a fresh archive from a temporary template with a payload, message, and `750 ms` delay. It verifies the expected staged archive entries, `update-info.txt` payload size entry, generated autoload content, forward-slash paths, and ZIP structure. This test is included in `npm test` as `test/y2jb-generator.test.js`.

## Relationship to PS Notify

Like [[PS Notify]], this page is a local preparation/diagnostic tool within Porkfolio. It does **not** install or run anything on a console by itself. PS Notify sends a network notification to an already-running companion service; Y2JB Update Generator builds a local update archive for an operator to place and apply using their own compatible Y2JB workflow.

## Safety and compatibility

- Building a ZIP successfully does not establish console, firmware, exploit-host, or payload compatibility.
- Review payload provenance, order, delay values, and target instructions before applying an update.
- Keep a known-good USB/update copy and recovery path.
- Do not use this tool as a substitute for the upstream Y2JB instructions or for verifying a console-specific environment.
