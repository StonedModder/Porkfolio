# System State Controls

[[Pages and Workflows]] · [[Manage Jailbreak]] · [[Settings Reference]] · [[ELF Arsenal]]

Porkfolio integrates [PS5-SystemStateManager](https://github.com/StonedModder/PS5-SystemStateManager), a PS5 payload server for reboot, shutdown, rest mode, and Blu-ray disc ejection.

## How it works

The bundled `SystemStateManager.elf` is sent to a compatible PS5 ELF loader on port `9021`. When it has started, its TCP server listens on port `9112` and accepts newline-terminated commands:

| Porkfolio action | Server command | Result |
|---|---|---|
| Reboot | `REBOOT` | Requests a system reboot. |
| Shutdown | `SHUTDOWN` | Requests a system shutdown. |
| Enter Rest Mode | `RESTMODE` | Requests standby. |
| Eject Disc | `EJECT` | Uses the server's `/dev/cd0` or `/dev/cd1` ioctl path. |
| Check Service | `STATUS` | Returns the payload PID and build tag. |

## Safe control flow

1. Configure the PS5 address in [[Settings Reference]].
2. Select **Deploy SystemStateManager** to send the bundled payload to loader port `9021`.
3. Select **Check Service** until the service reports readiness on port `9112`.
4. Select the desired action. This only opens an inline warning panel.
5. Type the exact displayed phrase, such as `CONFIRM REBOOT`, before **Confirm Action** becomes enabled.

No power-state or eject command is sent by opening the panel or by a single button press.

## Important warnings

These actions have immediate physical or power consequences. Save work and stop active game, storage, transfer, and homebrew operations before confirming a command. The payload's upstream documentation notes that shutdown remains marked as **in testing**; use it conservatively. It can show a rest-mode style message even when it powers down. Rest mode may not display the usual system screen even when the state transition succeeds.

Do not use the controls for systems you do not own or are not authorized to administer. Confirm loader and firmware compatibility before deployment.
