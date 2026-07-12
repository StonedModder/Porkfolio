# PFS Ripper

[[Pages and Workflows]] · [[Local Save Manager]] · [[Platform Support]]

PFS Ripper is the local PFS image discovery and extraction page.

## What it does

- Scans configured local locations for recognized PFS image candidates.
- Displays discovered image files for inspection.
- Coordinates supported extraction/rip tasks and reports progress through the application.
- Keeps its workflow separate from FTP library scanning because its inputs are local image files.

## Before using it

Use copies of input images. Confirm available disk space and choose a local extraction destination that is not itself part of a source backup tree.

## Caution

PFS workflows can produce large output and are sensitive to input integrity. A successful discovery scan only finds candidates; it does not certify that an image is complete, decryptable, or compatible with every extraction path.
