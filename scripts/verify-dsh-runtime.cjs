'use strict';

// Smoke-test a dsh runtime the same way the app will run it: spawn the CLI
// with Electron as Node (ELECTRON_RUN_AS_NODE=1), boot the web profile, poll
// until the loopback web server answers, and optionally assert configured
// providers/models through the unary RPC API.
//
//   node scripts/verify-dsh-runtime.cjs [--runtime <dir>] [--dsh-home <dir>]
//        [--expect-provider <routeId>] [--expect-model <modelId>] [--keep-home]
//
// This intentionally goes beyond `--version`: the upstream packed-install gate
// only runs a version probe and skips optional platform packages, which is
// exactly where offline breakage hides (ripgrep/koffi/pty binaries).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { removeTree } = require('./dsh-remove-tree.cjs');

const LOG_TAG = '[verify-dsh-runtime]';
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const rootDir = path.resolve(__dirname, '..');
const runtimeArg = readArgValue('--runtime');
const runtimeDir = fs.realpathSync(runtimeArg ? path.resolve(runtimeArg) : path.join(rootDir, 'vendor', 'dsh-runtime', 'current'));
const entryPath = path.join(runtimeDir, 'lib', 'bin.js');
if (!fs.existsSync(entryPath)) {
  fail(`Runtime entry not found: ${entryPath}. Run \`npm run dsh:runtime:host\` first.`);
}

// Under plain Node, require('electron') resolves to the bundled binary path.
const electronPath = require('electron');
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  fail('Could not resolve the Electron executable from node_modules.');
}

const dshHomeArg = readArgValue('--dsh-home');
const ownsDshHome = !dshHomeArg;
const dshHome = dshHomeArg ? path.resolve(dshHomeArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-home-'));
fs.mkdirSync(dshHome, { recursive: true });
const expectProvider = readArgValue('--expect-provider');
const expectModel = readArgValue('--expect-model');
const port = 30800 + Math.floor(Math.random() * 500);
const keepHome = process.argv.includes('--keep-home') || !ownsDshHome;

log(`Runtime: ${runtimeDir}`);
log(`Booting \`web\` on 127.0.0.1:${port} with DSH_HOME=${dshHome}`);

// --expose-internals feeds the Cordis loader's internals requirement the
// official way. The alternative supply (node-addon-require-builtin) loads but
// fails under Electron's Node ("no compatible GetAlignedPointerFromEmbedderData
// symbol"), so the flag is mandatory when running dsh with Electron as Node.
const startedAt = Date.now();
const child = spawn(electronPath, ['--expose-internals', entryPath, 'web', '--port', String(port)], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output += chunk;
    if (output.length > 200_000) output = output.slice(-100_000);
  });
}

let childExited = false;
let verified = false;
child.on('exit', (code, signal) => {
  childExited = true;
  if (!verified) {
    console.error(output);
    fail(`dsh exited before becoming ready (code=${code}, signal=${signal})`);
  }
});

function cleanupAndExit(code) {
  const finish = () => {
    if (!keepHome) {
      try {
        // Never `fs.rm` a dsh home: it is full of links into the runtime.
        removeTree(dshHome);
      } catch {
        // Best-effort cleanup.
      }
    } else if (ownsDshHome) {
      log(`Keeping DSH_HOME at ${dshHome}`);
    }
    process.exit(code);
  };
  if (childExited) {
    finish();
    return;
  }
  child.once('exit', finish);
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!childExited) child.kill('SIGKILL');
  }, 5_000).unref();
}

function fetchIndex(onDone) {
  const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3_000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      if (body.length < 4_096) body += chunk;
    });
    response.on('end', () => onDone(response.statusCode, body));
  });
  request.on('timeout', () => request.destroy(new Error('timeout')));
  request.on('error', () => onDone(0, ''));
}

let rpcCounter = 0;
function rpcCall(method, payload) {
  rpcCounter += 1;
  const rpcId = `verify-${rpcCounter}`;
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/${method}`,
        method: 'POST',
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`${method} -> HTTP ${response.statusCode}: ${raw.slice(0, 400)}`));
            return;
          }
          try {
            const envelope = JSON.parse(raw);
            if (!envelope.result || envelope.result.ok !== true) {
              reject(new Error(`${method} rejected: ${JSON.stringify(envelope.result ?? envelope).slice(0, 400)}`));
              return;
            }
            resolve(envelope.result.value);
          } catch (error) {
            reject(new Error(`${method} returned invalid JSON: ${error.message}`));
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error(`${method} timed out`)));
    request.on('error', reject);
    request.end(body);
  });
}

async function runRpcAssertions() {
  if (expectProvider) {
    const value = await rpcCall('llm.providers');
    const providers = Array.isArray(value?.providers) ? value.providers : [];
    const entry = providers.find((candidate) => candidate && candidate.provider === expectProvider);
    if (!entry) {
      throw new Error(`Provider ${expectProvider} not registered. Providers: ${providers.map((p) => p.provider).join(', ')}`);
    }
    if (entry.active !== true) {
      throw new Error(`Provider ${expectProvider} registered but not active: ${JSON.stringify(entry)}`);
    }
    log(`Provider ${expectProvider} is registered and active.`);
  }
  if (expectModel) {
    const value = await rpcCall('llm.models');
    const groups = Array.isArray(value?.groups) ? value.groups : [];
    const models = groups.flatMap((group) => (Array.isArray(group?.models) ? group.models : []));
    if (!models.some((model) => model && model.id === expectModel)) {
      const failures = Array.isArray(value?.failures) ? JSON.stringify(value.failures) : '[]';
      throw new Error(`Model ${expectModel} not listed. Models: ${models.map((m) => m.id).join(', ')}; failures: ${failures}`);
    }
    log(`Model ${expectModel} is listed in the live catalog.`);
  }
}

function poll() {
  if (childExited) return;
  if (Date.now() - startedAt > READY_TIMEOUT_MS) {
    console.error(output);
    fail(`Web server did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }
  fetchIndex((status, body) => {
    if (status === 200) {
      // A 200 on `/` only proves *something* holds the port. Confirm it is our
      // dsh before asserting anything, otherwise an unrelated local server on
      // the randomly chosen port turns into a bogus 404 failure.
      rpcCall('host.describe')
        .then(() => onServerConfirmed(body))
        .catch(() => setTimeout(poll, POLL_INTERVAL_MS));
    } else {
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  });
}

function onServerConfirmed(body) {
  verified = true;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const looksLikeHtml = /<!doctype html|<html/i.test(body);
  log(`Ready in ${elapsed}s (dsh confirmed, ${looksLikeHtml ? 'HTML page served' : 'non-HTML body'})`);
  if (!looksLikeHtml) {
    console.error(body.slice(0, 500));
    cleanupAndExit(1);
    return;
  }
  runRpcAssertions()
    .then(() => {
      log('Smoke test passed.');
      cleanupAndExit(0);
    })
    .catch((error) => {
      console.error(`${LOG_TAG} RPC assertion failed: ${error.message}`);
      console.error(output.slice(-4_000));
      cleanupAndExit(1);
    });
}

setTimeout(poll, POLL_INTERVAL_MS);
