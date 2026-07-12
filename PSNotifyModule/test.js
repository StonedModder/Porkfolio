'use strict';
/**
 * test.js — Standalone test for PSNotifyModule
 * ─────────────────────────────────────────────
 * Run:  node test.js <ps5-ip> ["Message"] ["Sub text"]
 *
 * Examples:
 *   node test.js 192.168.1.100
 *   node test.js 192.168.1.100 "Build done" "v2.1.0"
 */

const { PS5Notifier, notify, DEFAULT_PORT } = require('./index');

const [,, host, message, subMessage] = process.argv;

if (!host) {
  console.error('Usage: node test.js <ps5-ip> ["Message"] ["Sub text"]');
  process.exit(1);
}

// ─── Test 1: one-shot notify() function ──────────────────────────────────────

async function runTests() {
  console.log(`\nPSNotifyModule Test`);
  console.log(`Target : ${host}:${DEFAULT_PORT}`);
  console.log('─'.repeat(40));

  // Test 1 — raw notify()
  console.log('\n[1] One-shot notify()...');
  try {
    const res = await notify(host, message || 'Test from PSNotifyModule', {
      subMessage: subMessage || 'one-shot notify()',
    });
    console.log('    OK —', JSON.stringify(res));
  } catch (e) {
    console.error('    FAIL —', e.message);
  }

  // Test 2 — PS5Notifier class with send()
  console.log('\n[2] PS5Notifier.send()...');
  const ps5 = new PS5Notifier(host);
  try {
    const res = await ps5.send(message || 'Test from PS5Notifier', {
      subMessage: subMessage || 'class-based API',
    });
    console.log('    OK —', JSON.stringify(res));
  } catch (e) {
    console.error('    FAIL —', e.message);
  }

  // Test 3 — history
  console.log('\n[3] History:');
  ps5.history().forEach((entry, i) => {
    console.log(`    [${i}] ${entry.ts}  ok=${entry.ok}  msg="${entry.message}"`);
  });

  // Test 4 — bad host (error handling)
  console.log('\n[4] Error handling (bad host, short timeout)...');
  try {
    await notify('0.0.0.0', 'should fail', { timeout: 1500 });
    console.log('    WARN — expected failure but got success');
  } catch (e) {
    console.log('    OK — caught expected error:', e.message);
  }

  console.log('\n' + '─'.repeat(40));
  console.log('Tests complete.\n');
}

runTests().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
