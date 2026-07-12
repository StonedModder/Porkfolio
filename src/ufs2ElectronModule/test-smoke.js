'use strict';

const assert = require('assert');
const ufs2 = require('./index');

assert.strictEqual(typeof ufs2.makefs, 'function', 'makefs export missing');
assert.strictEqual(typeof ufs2.makefsPS5, 'function', 'makefsPS5 export missing');
assert.strictEqual(typeof ufs2.newfs, 'function', 'newfs export missing');
assert.strictEqual(typeof ufs2.newfsPS5, 'function', 'newfsPS5 export missing');
assert.strictEqual(typeof ufs2.batchFromFolder, 'function', 'batchFromFolder export missing');
assert.strictEqual(typeof ufs2.createBatchRunner, 'function', 'createBatchRunner export missing');

const info = ufs2.moduleInfo();
assert.strictEqual(info.version, require('./package.json').version, 'moduleInfo version mismatch');
assert.strictEqual(typeof info.toolPath, 'string', 'moduleInfo toolPath missing');
assert.strictEqual(typeof info.toolAvailable, 'boolean', 'moduleInfo toolAvailable missing');

const runner = ufs2.createBatchRunner();
assert(runner && typeof runner.on === 'function', 'createBatchRunner did not return an EventEmitter-like runner');

console.log('ufs2 module smoke test passed');
