#!/usr/bin/env node
import { spawn } from 'node:child_process';

const subcommand = process.argv[2];
// Args after the subcommand, for subcommands that take flags. Subcommands
// without flags ignore this (their run() takes no parameters).
const subArgs = process.argv.slice(3);

async function main(): Promise<void> {
  switch (subcommand) {
    case 'init':
      await import('./init.js').then((m) => m.run(subArgs));
      break;
    case 'start':
      await import('./start.js').then((m) => m.run());
      break;
    case 'migrate':
      await import('./migrate.js').then((m) => m.run());
      break;
    case 'status':
      await import('./status.js').then((m) => m.run());
      break;
    case 'backup':
      await import('./backup.js').then((m) => m.run());
      break;
    case 'restore':
      await import('./restore.js').then((m) => m.run());
      break;
    case 'upgrade':
      await import('./upgrade.js').then((m) => m.run(subArgs));
      break;
    case 'logs': {
      const composeFile = process.env.COMPOSE_FILE ?? '/etc/genwork/compose.yml';
      const child = spawn('docker', ['compose', '-f', composeFile, 'logs', ...subArgs], {
        stdio: 'inherit',
      });
      child.on('exit', (code) => process.exit(code ?? 0));
      break;
    }
    case 'reinit':
      // Delegated to the legacy CLI to preserve its signature.
      await import('../cli/reinit.js');
      break;
    case 'version':
      await import('./version.js').then((m) => m.run());
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  const lines = [
    'genwork-server — Enterprise Server lifecycle CLI',
    '',
    'Subcommands:',
    '  init       Host-side: prepare /etc/genwork/ and bootstrap the database',
    '  start      Container-side: run migrations and start the server',
    '  migrate    Container-side: apply pending DB migrations (or dry-run if GENWORK_MIGRATE_DRY_RUN=1)',
    '  status     Host-side: report health / version / uptime',
    '  logs       Host-side: tail docker compose logs',
    '  backup     Host-side: dump the database and tar /etc/genwork/data',
    '  restore    Host-side: restore from a backup tarball',
    '  upgrade    Host-side: pull a new image and restart with rollback on failure',
    '  reinit     Legacy: re-open the /setup flow (preserved unchanged)',
    '  version    Print the build-time version string',
  ];
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
