import { execSync } from 'node:child_process';

export function assertDockerOnPath(): void {
  try {
    execSync('command -v docker', { stdio: 'ignore' });
  } catch {
    console.error('Docker is not on PATH. Install Docker first: https://docs.docker.com/engine/install/');
    process.exit(1);
  }
}

export function assertRoot(): void {
  if (process.getuid?.() !== 0) {
    console.error('This command must run as root (or via sudo).');
    process.exit(1);
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}
