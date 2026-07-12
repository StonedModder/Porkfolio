'use strict';

const assert = require('assert');
const { normalizeSystemStateCommand, parseSystemStateResponse } = require('../src/system-state-client');

assert.strictEqual(normalizeSystemStateCommand('reboot'), 'REBOOT');
assert.strictEqual(normalizeSystemStateCommand('restmode'), 'RESTMODE');
assert.strictEqual(normalizeSystemStateCommand('eject'), 'EJECT');
assert.throws(() => normalizeSystemStateCommand('shutdown-now'), /Unsupported/);
assert.deepStrictEqual(parseSystemStateResponse('OK pid=321 build=test\n'), { ok: true, response: 'pid=321 build=test' });
assert.deepStrictEqual(parseSystemStateResponse('ERR errno=5 path=/dev/cd0\n'), { ok: false, response: 'errno=5 path=/dev/cd0' });

console.log('system state client test passed');
