#!/usr/bin/env node
//
// patch-esm-imports.mjs
//
// Rewrites bare relative import specifiers in enterprise_server/dist/**/*.js
// to include the .js extension. Node's ESM loader requires the extension
// for relative paths; enterprise_server's source uses bare specifiers
// (`./db/pool`, not `./db/pool.js`) and tsc with moduleResolution: Bundler
// preserves them as-is.
//
// This is a workaround for the package's pre-existing source style. Once
// the source is migrated to NodeNext-style imports, delete this script.
//
// Scope (intentionally narrow):
//   - Only specifiers starting with `./` or `../`.
//   - Skips specifiers already ending in .js / .mjs / .json.
//   - Verifies the resolved target exists on disk before rewriting; leaves
//     unresolved specifiers alone (likely runtime dynamic imports or
//     purposely-bare paths that the app handles another way).
//   - Handles static `import ... from '...'`, `export ... from '...'`,
//     side-effect `import '...'`, and dynamic `import('...')`.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const distRoot = process.argv[2];
if (!distRoot) {
  console.error('Usage: node patch-esm-imports.mjs <dist-root>');
  process.exit(2);
}

const SPECIFIER_RE =
  /(from\s+|import\s+|import\()(['"])(\.\.?\/[^'"]+)\2/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (s.isFile() && name.endsWith('.js')) yield p;
  }
}

// Resolve a specifier against the importing file's directory. Returns the
// absolute path of a file that exists, or null when nothing matches.
function resolveSpec(fromFile, spec) {
  const base = dirname(fromFile);
  const trimmed = spec.endsWith('/') ? spec : spec;
  const direct = join(base, trimmed);
  const tries = [direct, `${direct}.js`, join(direct, 'index.js')];
  for (const t of tries) {
    try {
      if (statSync(t).isFile()) return t;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

let fileCount = 0;
let rewriteCount = 0;

for (const file of walk(distRoot)) {
  const src = readFileSync(file, 'utf8');
  let rewrites = 0;
  const updated = src.replace(SPECIFIER_RE, (match, lead, quote, spec) => {
    if (/\.(?:js|mjs|json)$/.test(spec)) return match;
    if (!resolveSpec(file, spec)) return match;
    rewrites++;
    return `${lead}${quote}${spec}.js${quote}`;
  });
  if (rewrites > 0) {
    writeFileSync(file, updated);
    fileCount++;
    rewriteCount += rewrites;
  }
}

console.log(
  `[patch-esm-imports] rewrote ${rewriteCount} specifier(s) across ${fileCount} file(s) under ${distRoot}`,
);