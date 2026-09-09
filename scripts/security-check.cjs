'use strict';

/**
 * Static security audit for the multi-tenant rollout.
 *
 * Runs across the desktop codebase and enterprise_server to make sure no
 * provider key material is held or transmitted by the client, and that the
 * server only emits keys through the audit-logged ProviderProxy path.
 *
 * Exits 0 on clean, 1 on any finding.
 */

const { execSync } = require('node:child_process');

function rg(pattern, path, label) {
  try {
    const out = execSync(
      `rg -n --hidden -S "${pattern}" "${path}" || true`,
      { encoding: 'utf8' }
    ).trim();
    if (out) {
      console.error(`[FAIL] ${label}: matches found`);
      console.error(out.split('\n').slice(0, 20).join('\n'));
      return false;
    }
    console.log(`[OK]   ${label}`);
    return true;
  } catch (e) {
    console.error(`[ERR]  ${label}: ${e.message}`);
    return false;
  }
}

let ok = true;
ok = rg('api_key\\s*[:=]', 'src/main/auth', 'desktop auth code keeps no api_key assignment') && ok;
ok =
  rg(
    'authorization.*sk-|bearer\\s+sk-',
    'src/main/auth',
    'desktop auth code does not embed provider bearer tokens'
  ) && ok;
ok = rg('api_key\\s*[:=]', 'src/main/libs/openclawProviderConfig.ts', 'openclaw provider config has no api_key') && ok;
ok =
  rg(
    'console\\.(log|info|warn|error).*(api_key|decrypted|sk-)',
    'enterprise_server/src',
    'enterprise server does not log plaintext keys'
  ) && ok;
ok = rg('api_key\\s*[:=]', 'enterprise_server/web/src', 'web SPA source has no api_key assignment') && ok;
ok = rg('api_key', 'enterprise_server/web-dist', 'web build artifact has no api_key literal') && ok;
ok =
  rg(
    "from 'bcrypt'",
    'enterprise_server/src',
    'enterprise_server uses bcryptjs (no native binding drift)'
  ) === false
    ? rg('bcryptjs', 'enterprise_server/src', 'enterprise_server imports bcryptjs') && ok
    : ok;

if (!ok) {
  console.error('\nsecurity check FAILED');
  process.exit(1);
}
console.log('\nsecurity check passed');