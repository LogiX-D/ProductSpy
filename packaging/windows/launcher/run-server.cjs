'use strict';
/* eslint @typescript-eslint/no-require-imports: "off" -- Next standalone server.js is CommonJS and bootstraps via require. */

// The wrapper uses Next's own SIGTERM cleanup even on Windows, where an external
// TerminateProcess would skip cleanup. No extra HTTP endpoint or browser secret.
const fs = require('node:fs');
const path = require('node:path');
const serverFile = path.resolve(__dirname, '../app/apps/web/server.js');
const stopFile = process.env.PRODUCTSPY_STOP_FILE;
const launchId = process.env.PRODUCTSPY_LAUNCH_ID;
const parentPid = Number(process.env.PRODUCTSPY_LAUNCHER_PID);
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(control);
  console.log('[ProductSpy] Stopping the local workspace.');
  const handlers = process.listenerCount('SIGTERM');
  if (handlers) process.emit('SIGTERM', 'SIGTERM');
  else process.exit(0);
  setTimeout(() => process.exit(0), 10_000).unref();
}

const control = setInterval(() => {
  try {
    if (stopFile && fs.existsSync(stopFile)) {
      const request = JSON.parse(fs.readFileSync(stopFile, 'utf8').replace(/^\uFEFF/, ''));
      if (request.launchId === launchId) stop();
    }
  } catch {
    // A partially written stop request is retried on the next iteration.
  }
  // A damaged control file must never suppress ownership/liveness checks.
  try {
    if (parentPid > 0) process.kill(parentPid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') stop();
  }
}, 250);
control.unref();
require(serverFile);
