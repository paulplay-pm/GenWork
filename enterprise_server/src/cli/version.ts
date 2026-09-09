const VERSION = process.env.VERSION ?? 'dev';

export function run(): void {
  console.log(`genwork-server ${VERSION}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
