/**
 * Rename the dev Electron.app bundle to GenWork on macOS.
 *
 * In dev, `npm run start:electron` launches the Electron binary from
 * node_modules/electron/dist/Electron.app. macOS derives the top-left menu-bar
 * app name and the Dock tooltip from that bundle's Info.plist (CFBundleName /
 * CFBundleDisplayName), which app.setName() cannot override. This script
 * rewrites those keys to "GenWork" so the menu bar and Dock tooltip read
 * GenWork instead of Electron.
 *
 * It ALSO rewrites CFBundleIdentifier to a project-unique value. Electron's
 * default identifier (com.github.Electron) is shared by every Electron app on
 * the machine, and macOS resolves the Dock tooltip / menu-bar name by
 * identifier — so with multiple Electron projects present, macOS can resolve
 * the tooltip to a sibling project's bundle (still named "Electron") instead
 * of ours. A unique identifier disambiguates. The ElectronAsarIntegrity check
 * only references asar paths, not the identifier, so this is safe.
 *
 * It does NOT touch CFBundleExecutable (the actual binary name), so the app
 * still launches. Idempotent: it only writes a plist when a value differs, and
 * is a no-op on non-macOS platforms or when the bundle is absent.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_NAME = 'GenWork';
// Unique bundle identifier (matches APP_USER_MODEL_ID in appConstants.ts) so
// this dev bundle is not conflated with other Electron apps on the machine.
const APP_IDENTIFIER = 'com.genwork.app';
const ROOT = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
);
const PLIST = path.join(ROOT, 'Contents', 'Info.plist');

// (plist key, target value) pairs to force onto the dev bundle.
const KEY_VALUES = [
  ['CFBundleName', APP_NAME],
  ['CFBundleDisplayName', APP_NAME],
  ['CFBundleIdentifier', APP_IDENTIFIER],
];

// LaunchServices caches bundle identity (name, icon) keyed by path+identifier.
// After rewriting the plist, force a re-registration so the cached "Electron"
// name is dropped and the Dock tooltip / top-left menu name pick up "GenWork".
// The tool ships with macOS; guard so a failure never breaks the dev launch.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function plutilExtract(key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', PLIST], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function plutilReplace(key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, PLIST], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

// In-place `plutil` edits can re-serialize the file (e.g. XML -> JSON) in ways
// LaunchServices cannot read; a malformed Info.plist makes macOS fall back to
// the executable name ("Electron") for the menu bar and Dock tooltip. Force
// the canonical XML format after any mutation so the plist is always valid.
function ensureValidXml() {
  try {
    execFileSync('plutil', ['-convert', 'xml1', PLIST], { stdio: 'ignore' });
  } catch (err) {
    console.warn(`[patch-electron-dev-name] plist is not valid: ${err.message}`);
  }
}

function main() {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(PLIST)) {
    console.log('[patch-electron-dev-name] no Electron.app bundle; skipping');
    return;
  }
  let changed = false;
  for (const [key, value] of KEY_VALUES) {
    const current = plutilExtract(key);
    if (current !== value) {
      plutilReplace(key, value);
      changed = true;
    }
  }
  if (changed) {
    ensureValidXml();
  }

  // Safety net: CFBundleExecutable names the actual binary ("Electron"). If a
  // plutil write ever drops it, the bundle can't launch, so re-insert it.
  if (plutilExtract('CFBundleExecutable') !== 'Electron') {
    execFileSync('plutil', ['-insert', 'CFBundleExecutable', '-string', 'Electron', PLIST], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    ensureValidXml();
    console.warn('[patch-electron-dev-name] restored missing CFBundleExecutable');
  }

  console.log(
    changed
      ? `[patch-electron-dev-name] updated ${KEY_VALUES.map(([k]) => k).join(' + ')} -> ${APP_NAME} / ${APP_IDENTIFIER}`
      : `[patch-electron-dev-name] already ${APP_NAME} / ${APP_IDENTIFIER}`,
  );

  // Force re-registration with LaunchServices so it re-reads the plist and
  // resolves the (now unique) identifier to GenWork. Use `-f` only: `-u`
  // (unregister) removes the healthy entry and can leave a degraded
  // "no-info.plist" registration that falls back to "Electron".
  if (fs.existsSync(LSREGISTER)) {
    try {
      execFileSync(LSREGISTER, ['-f', ROOT], { stdio: 'ignore' });
      console.log('[patch-electron-dev-name] re-registered bundle with LaunchServices');
    } catch (err) {
      console.warn(
        `[patch-electron-dev-name] lsregister failed: ${err.message}`,
      );
    }
  }
}

main();
