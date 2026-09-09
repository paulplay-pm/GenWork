'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_KEYFROM = 'official';
const KEYFROM_PATTERN = /^[a-z0-9_-]{1,64}$/;

function normalizeKeyfrom(value) {
  if (typeof value !== 'string') return DEFAULT_KEYFROM;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_KEYFROM;
  if (!KEYFROM_PATTERN.test(normalized)) return DEFAULT_KEYFROM;
  return normalized;
}

function main() {
  const rawKeyfrom = process.env.KEYFROM;
  const keyfrom = normalizeKeyfrom(rawKeyfrom);
  if (
    rawKeyfrom !== undefined &&
    keyfrom === DEFAULT_KEYFROM &&
    rawKeyfrom.trim().toLowerCase() !== DEFAULT_KEYFROM
  ) {
    console.warn('[Keyfrom] invalid KEYFROM environment value, writing official');
  }

  const outputDir = path.join(__dirname, '..', '.keyfrom-build');
  const outputPath = path.join(outputDir, 'keyfrom.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({ keyfrom, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[Keyfrom] generated build keyfrom as ${keyfrom}`);
}

main();
