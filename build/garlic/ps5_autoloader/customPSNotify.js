// customPSNotify.js — patched build (Porkfolio edition)
// Original by ItsDeidara  https://github.com/ItsDeidara/CustomPSNotify
//
// FIXES in this build
// ───────────────────
// 1. UTF-8 decode: upstream reads each byte with String.fromCharCode(byte),
//    treating the stream as Latin-1 and garbling every multi-byte sequence.
//    This build collects raw bytes and decodes them properly as UTF-8 so
//    emoji and all non-ASCII text display correctly.
//
// 2. Memory leak (main cause of "stops listening after a while"):
//    The original allocates malloc(2048) inside readAll() on EVERY accepted
//    connection and never frees it.  The native heap is finite; once it runs
//    out malloc fails, read8(bad ptr) crashes/hangs, and the server dies.
//    Fixed by allocating the read buffer ONCE as a global and reusing it.
//
// 3. Hanging on stalled clients (port scanners / half-open TCP connections):
//    syscall(read) is a blocking syscall.  Any client that connects but never
//    sends a newline would block readAll() — and therefore the entire accept
//    loop — forever.  Fixed by setting SO_RCVTIMEO (5 s) on each accepted
//    socket so read() returns EAGAIN after the timeout and the loop continues.
//
// 4. Unbounded read accumulation:
//    Without a size cap, a flooding client could grow the bytes[] array until
//    the WebKit VM heap OOMs.  Fixed by capping reads at MAX_READ_BYTES and
//    dropping the connection if the limit is hit without finding a newline.
//
// 5. Unguarded handleClient call in the accept loop:
//    If anything escapes handleClient's internal try/catch the while(true)
//    would die.  Wrapped in its own try/catch so the loop always continues.
//
// 6. Oversized notification payload crashes the PS5 notifier:
//    The PS5 send_notification() call has a very short display limit.
//    Sending a large string (e.g. the entire Bee Movie script) kills it.
//    Fixed by capping message at MAX_NOTIFY_MSG and subMessage at
//    MAX_NOTIFY_SUB characters before the call.

const LISTEN_PORT    = 6969;
const MAX_READ_BYTES = 8192;  // hard cap per connection — prevents heap OOM
const RECV_TIMEOUT_S = 5;     // seconds before a stalled-client read gives up
const MAX_NOTIFY_MSG = 200;   // PS5 notification message length cap
const MAX_NOTIFY_SUB = 100;   // PS5 notification sub-message length cap

const SYSCALL = {
  read:       3n,
  write:      4n,
  open:       5n,
  close:      6n,
  ioctl:      54n,
  accept:     30n,
  socket:     97n,
  bind:       104n,
  setsockopt: 105n,
  listen:     106n,
};

// SOL_SOCKET / socket option constants (FreeBSD)
const SOL_SOCKET   = 0xffffn;
const SO_REUSEADDR = 0x4n;
const SO_REUSEPORT = 0x200n;
const SO_RCVTIMEO  = 0x1006n;

// ── Global reusable read buffer ───────────────────────────────────────────────
// Allocated exactly once so every connection reuses the same native memory.
// This is the primary fix for the heap-exhaustion / "stops after a while" bug.
const READ_BUF      = malloc(MAX_READ_BYTES);
const READ_BUF_SIZE = BigInt(MAX_READ_BYTES);

// ── Global timeval buffer for SO_RCVTIMEO ─────────────────────────────────────
// struct timeval on FreeBSD LP64 = { int64 tv_sec; int64 tv_usec; } = 16 bytes
// Written as two write32 pairs (little-endian 64-bit = lo word first).
const TIMEVAL_BUF = malloc(16);
write32(TIMEVAL_BUF + 0n,  BigInt(RECV_TIMEOUT_S)); // tv_sec  lo
write32(TIMEVAL_BUF + 4n,  0n);                     // tv_sec  hi
write32(TIMEVAL_BUF + 8n,  0n);                     // tv_usec lo
write32(TIMEVAL_BUF + 12n, 0n);                     // tv_usec hi

// ─────────────────────────────────────────────────────────────────────────────

function disablePF() {
  try {
    const DIOCSTOP = 0x20004477n;
    const O_RDWR  = 2n;
    const fd = syscall(SYSCALL.open, alloc_string("/dev/pf"), O_RDWR, 0n);
    if (Number(fd) >= 0) {
      const r = syscall(SYSCALL.ioctl, fd, DIOCSTOP, 0n);
      syscall(SYSCALL.close, fd);
      log("pf ioctl ret: " + Number(r));
    } else {
      log("pf open errno: " + (-Number(fd)));
    }
  } catch (e) {
    log("pf error: " + e.message);
  }
}

function makeSockaddr(port) {
  const sa = malloc(16);
  for (let i = 0n; i < 16n; i++) write8(sa + i, 0n);
  write8(sa + 0n, 16n);
  write8(sa + 1n, 2n);
  write8(sa + 2n, BigInt((port >> 8) & 0xff));
  write8(sa + 3n, BigInt(port & 0xff));
  write32(sa + 4n, 0n);
  return sa;
}

function setSockOptInt(fd, opt) {
  const val = malloc(4);
  write32(val, 1n);
  syscall(SYSCALL.setsockopt, fd, SOL_SOCKET, opt, val, 4n);
  // val leaks 4 bytes but setSockOptInt is called a fixed number of times
  // at startup — not on every connection — so this is acceptable.
}

// Set SO_RCVTIMEO on an accepted client fd using the pre-allocated global
// TIMEVAL_BUF.  This means a stalled client can block read() for at most
// RECV_TIMEOUT_S seconds before read() returns -EAGAIN and we drop it.
function setRecvTimeout(fd) {
  syscall(SYSCALL.setsockopt, fd, SOL_SOCKET, SO_RCVTIMEO, TIMEVAL_BUF, 16n);
}

// ─── UTF-8 decoder ───────────────────────────────────────────────────────────
// Decodes a Uint8-value array as UTF-8 into a JS string, emitting UTF-16
// surrogate pairs for codepoints above U+FFFF (i.e. all 4-byte emoji).

function decodeUtf8(bytes) {
  let out = '';
  let i   = 0;
  while (i < bytes.length) {
    const b = bytes[i];

    if (b < 0x80) {
      // 1-byte: 0xxxxxxx — plain ASCII
      out += String.fromCharCode(b);
      i += 1;

    } else if ((b & 0xE0) === 0xC0 && i + 1 < bytes.length) {
      // 2-byte: 110xxxxx 10xxxxxx
      const cp = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
      out += String.fromCharCode(cp);
      i += 2;

    } else if ((b & 0xF0) === 0xE0 && i + 2 < bytes.length) {
      // 3-byte: 1110xxxx 10xxxxxx 10xxxxxx
      const cp = ((b & 0x0F) << 12) |
                 ((bytes[i + 1] & 0x3F) << 6) |
                  (bytes[i + 2] & 0x3F);
      out += String.fromCharCode(cp);
      i += 3;

    } else if ((b & 0xF8) === 0xF0 && i + 3 < bytes.length) {
      // 4-byte: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx → UTF-16 surrogate pair
      const cp     = ((b & 0x07) << 18) |
                     ((bytes[i + 1] & 0x3F) << 12) |
                     ((bytes[i + 2] & 0x3F) << 6)  |
                      (bytes[i + 3] & 0x3F);
      const offset = cp - 0x10000;
      out += String.fromCharCode(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF));
      i += 4;

    } else {
      // Invalid / truncated sequence — pass raw byte through as Latin-1
      out += String.fromCharCode(b);
      i += 1;
    }
  }
  return out;
}

// ─── readAll ─────────────────────────────────────────────────────────────────
// Reads from fd into the global READ_BUF, accumulates bytes, stops on newline
// or MAX_READ_BYTES, then UTF-8 decodes to a string.
//
// If the client stalls, SO_RCVTIMEO (set in handleClient before calling this)
// makes read() return ≤ 0 after RECV_TIMEOUT_S, so we break safely.

function readAll(fd) {
  const bytes = [];

  while (true) {
    const n = Number(syscall(SYSCALL.read, fd, READ_BUF, READ_BUF_SIZE));
    if (n <= 0) break;  // EOF, timeout (EAGAIN), or error — stop cleanly

    for (let i = 0; i < n; i++)
      bytes.push(Number(read8(READ_BUF + BigInt(i))));

    if (bytes.indexOf(0x0A) !== -1) break;          // newline received — done
    if (bytes.length >= MAX_READ_BYTES)  { break; } // flood guard — drop
  }

  return decodeUtf8(bytes).trim();
}

// ─────────────────────────────────────────────────────────────────────────────

function writeStr(fd, s) {
  syscall(SYSCALL.write, fd, alloc_string(s), BigInt(s.length));
}

function handleClient(fd) {
  // Arm the receive timeout BEFORE reading so a stalled client can't block
  // the accept loop indefinitely.
  setRecvTimeout(fd);

  try {
    const raw = readAll(fd);
    log("recv: " + raw);
    let message = raw, subMessage = "";
    try {
      const p = JSON.parse(raw);
      if (p.message)    message    = String(p.message);
      if (p.subMessage) subMessage = String(p.subMessage);
    } catch (e2) {}
    // Truncate before handing to the PS5 notification system — oversized
    // strings cause the notifier to crash (e.g. if someone sends a novel).
    message    = message.slice(0, MAX_NOTIFY_MSG);
    subMessage = subMessage.slice(0, MAX_NOTIFY_SUB);
    send_notification(message + (subMessage ? "\n" + subMessage : ""));
    writeStr(fd, '{"ok":true}\n');
  } catch (e) {
    log("handleClient error: " + e.message);
    try { writeStr(fd, '{"ok":false}\n'); } catch (e3) {}
  }
  try { syscall(SYSCALL.close, fd); } catch (_) {}
}

function main() {
  log("customPSNotify starting (Porkfolio UTF-8 build)");

  disablePF();

  const server = syscall(SYSCALL.socket, 2n, 1n, 0n);
  log("socket fd: " + Number(server));
  if (Number(server) < 0) {
    send_notification("socket() failed (errno " + (-Number(server)) + ")");
    return;
  }

  setSockOptInt(server, SO_REUSEADDR);
  setSockOptInt(server, SO_REUSEPORT);

  const sa = makeSockaddr(LISTEN_PORT);

  let ret = syscall(SYSCALL.bind, server, sa, 16n);
  log("bind ret: " + Number(ret));
  if (Number(ret) < 0) {
    send_notification("bind() failed (errno " + (-Number(ret)) + ")");
    syscall(SYSCALL.close, server);
    return;
  }

  ret = syscall(SYSCALL.listen, server, 8n);
  log("listen ret: " + Number(ret));
  if (Number(ret) < 0) {
    send_notification("listen() failed (errno " + (-Number(ret)) + ")");
    syscall(SYSCALL.close, server);
    return;
  }

  send_notification("customPSNotify ready\nPort " + LISTEN_PORT + " (UTF-8 build)");
  log("Listening on 0.0.0.0:" + LISTEN_PORT);

  while (true) {
    let client;
    try {
      client = syscall(SYSCALL.accept, server, 0n, 0n);
    } catch (e) {
      // accept() itself threw — log and keep looping rather than dying
      log("accept threw: " + e.message);
      continue;
    }

    if (Number(client) < 0) {
      log("accept errno: " + (-Number(client)));
      continue;
    }

    log("client fd: " + Number(client));

    // Guard the entire handleClient call so any uncaught exception inside
    // it can never kill the outer accept loop.
    try {
      handleClient(client);
    } catch (e) {
      log("unhandled in handleClient: " + e.message);
      try { syscall(SYSCALL.close, client); } catch (_) {}
    }
  }
}

main();
