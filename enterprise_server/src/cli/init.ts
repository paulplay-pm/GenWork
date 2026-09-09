import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { Client } from 'pg';

import { assertDockerOnPath, assertRoot } from './lib/preflight.js';

const DEFAULT_DATA_DIR = '/etc/genwork';
const DEFAULT_INSTALL_DIR =
  process.env.INSTALL_DIR ?? dirname(new URL(import.meta.url).pathname);

type Options = {
  noDbBootstrap?: boolean;
  printEnvTemplate?: boolean;
  force?: boolean;
};

function parseUrl(u: string): URL {
  try {
    return new URL(u);
  } catch {
    throw new Error(`Invalid URL: ${u}`);
  }
}

function roleFromUrl(u: string): string {
  return decodeURIComponent(parseUrl(u).username);
}

async function dbBootstrap(): Promise<void> {
  const su = process.env.POSTGRES_SUPERUSER_URL;
  const app = process.env.DATABASE_URL;
  if (!su || !app) {
    throw new Error('POSTGRES_SUPERUSER_URL and DATABASE_URL are required for db bootstrap.');
  }
  if (roleFromUrl(su) === roleFromUrl(app)) {
    throw new Error(
      'Refusing to bootstrap: POSTGRES_SUPERUSER_URL and DATABASE_URL use the same role. ' +
        'Run `init --no-db-bootstrap` after creating the application role manually.',
    );
  }
  const target = parseUrl(app);
  const dbName = target.pathname.replace(/^\//, '');
  const appRole = roleFromUrl(app);
  // Decode the password to its raw bytes (URL parsing decodes %xx escapes).
  // pg's Client accepts a decoded password in a parsed connection string;
  // we use parameterization for both CREATE ROLE and CREATE DATABASE to
  // prevent SQL-injection through the password or DB name.
  const client = new Client({ connectionString: su });
  await client.connect();
  try {
    await client.query({
      text: `CREATE ROLE "${appRole.replace(/"/g, '""')}" LOGIN PASSWORD $1`,
      values: [target.password ?? ''],
    });
    console.log(`[init] created role ${appRole}`);
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err?.code === '42710') console.log(`[init] role ${appRole} already exists`);
    else throw e;
  }
  try {
    await client.query({
      text: `CREATE DATABASE "${dbName.replace(/"/g, '""')}" OWNER "${appRole.replace(/"/g, '""')}"`,
    });
    console.log(`[init] created database ${dbName}`);
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err?.code === '42P04') console.log(`[init] database ${dbName} already exists`);
    else throw e;
  }
  await client.end();
}

/**
 * Resolve the host-side binary path that the `genwork-server` symlink should
 * point at. Derived from the install dir (the directory containing
 * docker-compose.yml / caddyfile.example) plus the conventional
 * `<install>/cli/dist/index.js` location. Exposed for tests.
 */
export function resolveInstallBin(installDir: string): string {
  return join(installDir, 'cli', 'dist', 'index.js');
}

function writeFiles(installDir: string, dataDir: string, imageTag: string): void {
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(join(installDir, 'docker-compose.yml'), join(dataDir, 'compose.yml'));
  copyFileSync(join(installDir, 'caddyfile.example'), join(dataDir, 'caddyfile.example'));
  writeFileSync(join(dataDir, 'current-version'), imageTag);
  // Host-side binary symlink — best-effort. Skip in test envs (where the
  // install dir is a temp dir and /usr/local/bin is not writable).
  if (process.env.INIT_SKIP_SYMLINK === '1') return;
  const link = '/usr/local/bin/genwork-server';
  const target = resolveInstallBin(installDir);
  if (!existsSync(target)) {
    console.warn(
      `[init] could not create ${link}: target ${target} does not exist. ` +
        `Re-run after installing the genwork-server package.`,
    );
    return;
  }
  try {
    if (!existsSync(link)) symlinkSync(target, link);
  } catch (e) {
    console.warn(
      `[init] could not create symlink ${link} -> ${target}: ${(e as Error).message}. ` +
        `You can symlink it manually or invoke the CLI via \`node ${target}\`.`,
    );
  }
  try {
    chmodSync(target, 0o755);
  } catch (e) {
    console.warn(
      `[init] could not chmod ${target}: ${(e as Error).message}. ` +
        `If the binary is not executable, run \`chmod +x ${target}\` manually.`,
    );
  }
}

function printEnvTemplate(): void {
  console.log(
    [
      'Required .env keys (fill in, do not commit):',
      '  DATABASE_URL=postgres://<role>:<password>@<host>:<port>/<db>',
      '  JWT_SECRET=<openssl rand -hex 32>',
      '  GENWORK_VAULT_MASTER_KEY=<openssl rand -base64 32>',
      '  PORT=8787',
      '  IMAGE_TAG=latest',
      '  DATA_DIR=/data',
      '  # Used only by `init`. Remove after init succeeds.',
      '  POSTGRES_SUPERUSER_URL=postgres://postgres:postgres@<host>:<port>/postgres',
    ].join('\n'),
  );
}

function validateEnvStrength(): void {
  const jwt = process.env.JWT_SECRET ?? '';
  if (jwt.length < 32) {
    throw new Error('JWT_SECRET must be ≥32 chars. Generate with: openssl rand -hex 32');
  }
  const vault = process.env.GENWORK_VAULT_MASTER_KEY ?? '';
  if (!vault) {
    throw new Error(
      'GENWORK_VAULT_MASTER_KEY is required. Generate with: openssl rand -base64 32',
    );
  }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-db-bootstrap') opts.noDbBootstrap = true;
    else if (a === '--print-env-template') opts.printEnvTemplate = true;
    else if (a === '--force') opts.force = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (opts.printEnvTemplate) {
    printEnvTemplate();
    return;
  }
  assertRoot();
  assertDockerOnPath();

  const dataDir = process.env.INIT_DATA_DIR ?? DEFAULT_DATA_DIR;

  try {
    if (existsSync(join(dataDir, 'compose.yml')) && !opts.force) {
      throw new Error(`${dataDir} is already initialized. Pass --force to overwrite.`);
    }
    validateEnvStrength();
    if (!opts.noDbBootstrap) {
      await dbBootstrap();
    }
    const imageTag = process.env.IMAGE_TAG ?? 'latest';
    writeFiles(DEFAULT_INSTALL_DIR, dataDir, imageTag);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  }
  console.log(
    '[init] done. Next: edit .env, then `genwork-server start` (or `docker compose -f /etc/genwork/compose.yml up -d`).',
  );
}
