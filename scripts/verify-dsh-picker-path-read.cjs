'use strict';

// Guards how the directory picker reads the folder the user chose.
//
// IShellItem::GetDisplayName hands back a native UTF-16 pointer. Upstream read
// it with `koffi.view(address, 32768)`, an external ArrayBuffer over memory
// outside V8's heap: fine under stock Node, fatal under Electron's sandboxed
// V8 (`FATAL ERROR: Error::New napi_get_last_error_info`, exit 134). Every dsh
// child we spawn runs as ELECTRON_RUN_AS_NODE, so that aborted the dialog
// worker the instant a user confirmed a folder — reported upstream as "win32
// folder dialog worker exited before reporting a result". Cancelling skips the
// read entirely, which is why the dialog itself always looked healthy.
//
// So this check has to run under Electron to mean anything:
//
//   ELECTRON_RUN_AS_NODE=1 <electron> scripts/verify-dsh-picker-path-read.cjs <runtime-dir>
//
// It asserts the patched marshalling (scripts/dsh-patches/.../02-picker-*.cjs)
// is present in the installed runtime and that it survives this V8, using
// SHGetKnownFolderPath — same shape of out-parameter, no dialog required.

const fs = require('fs');
const path = require('path');

const LOG_TAG = '[verify-dsh-picker-path-read]';

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

const runtimeDir = process.argv[2];
if (!runtimeDir) fail('Usage: verify-dsh-picker-path-read.cjs <runtime-dir>');
if (process.platform !== 'win32') {
  console.log(`${LOG_TAG} skipped: win32-only check (${process.platform})`);
  process.exit(0);
}

const runtimeLabel = process.versions.electron
  ? `electron ${process.versions.electron} (node ${process.versions.node})`
  : `node ${process.versions.node}`;
if (!process.versions.electron) {
  console.warn(`${LOG_TAG} WARNING: running under ${runtimeLabel}; the abort this guards only happens under Electron`);
}

// 1. The patch must be in the runtime that actually shipped.
const workerPath = path.join(
  runtimeDir,
  'node_modules',
  '@deepseek-ai',
  'dsh-host-directory-picker-native',
  'lib',
  'worker.cjs'
);
if (!fs.existsSync(workerPath)) fail(`dialog worker missing from the runtime: ${workerPath}`);
const worker = fs.readFileSync(workerPath, 'utf8');
if (!worker.includes('_Out_ str16 *name')) {
  fail('worker.cjs reads the chosen path without koffi string marshalling — the picker patch is missing');
}
if (/const path = readUtf16\(koffi, nameOut\[0\]\)/.test(worker)) {
  fail('worker.cjs still reads the chosen path through koffi.view() — it will abort under Electron');
}

// 2. That marshalling must survive this V8.
const koffi = require(path.join(runtimeDir, 'node_modules', 'koffi'));
const shell32 = koffi.load('shell32.dll');
const getKnownFolderPath = shell32.func('__stdcall', 'SHGetKnownFolderPath', 'int32', [
  'void *',
  'uint32',
  'void *',
  '_Out_ str16 *',
]);

// FOLDERID_Profile, as the 16 little-endian GUID bytes CoCreateInstance-style
// APIs expect.
const folderId = Buffer.from('8f856c5e220e60479afeea3317b67173', 'hex');
const out = [null];
const hr = getKnownFolderPath(folderId, 0, null, out);
if (hr < 0) fail(`SHGetKnownFolderPath failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
if (typeof out[0] !== 'string' || out[0].length === 0) {
  fail(`the out-parameter did not marshal into a string: ${JSON.stringify(out[0])}`);
}

console.log(`${LOG_TAG} ${runtimeLabel}: picker reads native paths safely (got ${out[0]})`);
