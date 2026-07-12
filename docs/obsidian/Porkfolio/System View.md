# System View

[[Pages and Workflows]] · [[Settings Reference]]

System View displays a local USB capture-card feed and provides recording controls. It is independent of FTP after the capture hardware is configured.

## What it does

- Enumerates available video and audio capture devices through the browser media APIs.
- Selects video/audio device and supported resolution settings.
- Shows live preview with no-signal handling when no usable feed is available.
- Mutes/unmutes local audio.
- Records compatible video clips and exports GIF captures.
- Opens a popout window and supports fullscreen operation.
- Stores configurable hotkeys and optional auto-load behavior.

## Requirements

- A USB capture card connected to the computer and exposed to the operating system.
- Any required OS/device permission granted by the operator.
- A valid signal path from the PS5 to the capture hardware.

## Caution

Porkfolio cannot fix HDCP, capture-card driver problems, signal-routing issues, or device-specific latency. Test recording with a short local clip before relying on it for an important session.
