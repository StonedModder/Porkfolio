# BDJB Genny

[[Pages and Workflows]] · [[Manage Jailbreak]] · [[Y2JB Update Generator]] · [[Settings Reference]]

BDJB Genny is Porkfolio's native generator for a **Cyberpunk-themed Blu-ray Disc Java (BD-J) autoloader ISO**. It ports the relevant build template and workflow from [Themed BD-UN-JB Poops Autoloader](https://github.com/StonedModder/Themed-BD-UN-JB-Poops-Autoloader).

## What it creates

The generator stages a BD-J disc template, selected `.elf` or `.bin` payloads, and an ordered `ps5_autoloader/autoload.txt` script. It then invokes the upstream BD-J SDK toolchain to compile the Java payload and make a UDF ISO.

The output is a local ISO image. Porkfolio does not burn the disc, insert it, send it to a console, or run the staged payloads.

## Workflow

1. Open **Manage Jailbreak → BDJB Genny**.
2. Enter a disc title.
3. Add payload files. Payload names must be unique and are retained in the autoloader folder by filename.
4. Arrange the execution order. Add delay rows in milliseconds where payload startup needs spacing.
5. Select **Build BDJB ISO** and choose an output location.
6. Follow the visible progress bar and full build log until Porkfolio reports that the ISO was validated.

## Included template behavior

The port is based on the upstream Cyberpunk template. It includes the BD-J assets, compiled payload JAR, autoloader directory, loader binaries, Java sources, and Makefile necessary for the upstream ISO build. The generator writes your staged payloads and `autoload.txt` into the workspace before compilation.

The autoloader script uses filenames for payload rows and `!<milliseconds>` for delay rows. At least one selected payload must be present in the sequence.

## Build prerequisites

The ISO build calls the upstream `john-tornblom/bdj-sdk` toolchain. On a build machine, configure:

- `BDJ_SDK` pointing at a complete BD-J SDK installation with `host/bin/makefs`.
- `JAVA8_HOME` pointing at a Java 8 JDK with `bin/javac`.

Porkfolio reports missing prerequisites in the verbose build log before any ISO output is claimed. The template staging and validation logic can still be tested independently of the toolchain.

## Validation and safety

Before compilation, Porkfolio verifies that the bundled template contains required source/assets, each selected payload exists, filenames are safe relative names, extensions are `.elf` or `.bin`, and every autoload reference matches a selected payload. After compilation, it verifies that the expected ISO exists and has usable content before copying it to the selected destination.

Use only payloads and console workflows you are authorized to use. Confirm firmware, loader, disc compatibility, and recovery procedures independently.
