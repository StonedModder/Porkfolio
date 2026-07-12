'use strict';

// ── Processor Worker ───────────────────────────────────────────────────────────
// Runs processGame entirely off the main thread.
// Communication via worker_threads message passing:
//   Main → Worker:  'cancel'
//   Worker → Main:  { type: 'progress', data }
//                   { type: 'done',     result }
//                   { type: 'error',    message }

const { workerData, parentPort } = require('worker_threads');
const { processGame } = require('./processor');

// Catch any unhandled crash and report it back rather than silently hanging.
process.on('uncaughtException',  err => parentPort.postMessage({ type: 'error', message: `Uncaught: ${err.message}` }));
process.on('unhandledRejection', err => parentPort.postMessage({ type: 'error', message: `Unhandled rejection: ${err?.message ?? err}` }));

let cancelled = false;

parentPort.on('message', msg => {
  if (msg === 'cancel') cancelled = true;
});

const { sourceDir, outputDir, sdkPair, fakelibDir } = workerData;

processGame({
  sourceDir,
  outputDir,
  sdkPair,
  fakelibDir: fakelibDir || null,
  isCancelled: () => cancelled,
  onProgress: data => parentPort.postMessage({ type: 'progress', data }),
})
  .then(result  => parentPort.postMessage({ type: 'done',  result }))
  .catch(err    => parentPort.postMessage({ type: 'error', message: err.message }));
