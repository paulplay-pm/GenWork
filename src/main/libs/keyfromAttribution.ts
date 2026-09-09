import fs from 'fs';
import path from 'path';

import {
  DefaultKeyfrom,
  type KeyfromAttribution,
  type KeyfromBuildInfo,
  KeyfromBuildResource,
  KeyfromEnv,
  KeyfromStoreKey,
} from '../../shared/keyfrom';
import type { SqliteStore } from '../sqliteStore';

const KEYFROM_PATTERN = /^[a-z0-9_-]{1,64}$/;

let cachedAttribution: KeyfromAttribution | null = null;

export function normalizeKeyfrom(value: unknown): string {
  if (typeof value !== 'string') return DefaultKeyfrom.Official;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DefaultKeyfrom.Official;
  if (!KEYFROM_PATTERN.test(normalized)) return DefaultKeyfrom.Official;
  return normalized;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    console.warn(`[Keyfrom] failed to read build keyfrom file at ${filePath}:`, error);
    return null;
  }
}

function shouldUseDevelopmentKeyfromSources(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || !!env.ELECTRON_START_URL;
}

function resolveBuildInfoPaths(env: NodeJS.ProcessEnv): string[] {
  const resourcePath = process.resourcesPath
    ? path.join(
        process.resourcesPath,
        KeyfromBuildResource.Directory,
        KeyfromBuildResource.Filename,
      )
    : '';
  const devPath = shouldUseDevelopmentKeyfromSources(env)
    ? path.join(process.cwd(), '.keyfrom-build', KeyfromBuildResource.Filename)
    : '';
  const paths = [resourcePath, devPath].filter(Boolean);
  return Array.from(new Set(paths));
}

export function resolveCurrentKeyfrom(env: NodeJS.ProcessEnv = process.env): string {
  const rawEnvKeyfrom = env[KeyfromEnv.Keyfrom];
  if (rawEnvKeyfrom !== undefined && shouldUseDevelopmentKeyfromSources(env)) {
    const normalized = normalizeKeyfrom(rawEnvKeyfrom);
    if (
      normalized === DefaultKeyfrom.Official &&
      rawEnvKeyfrom.trim().toLowerCase() !== DefaultKeyfrom.Official
    ) {
      console.warn('[Keyfrom] invalid KEYFROM environment value, falling back to official');
    }
    return normalized;
  }

  for (const filePath of resolveBuildInfoPaths(env)) {
    const buildInfo = readJsonFile<KeyfromBuildInfo>(filePath);
    if (!buildInfo) continue;
    const normalized = normalizeKeyfrom(buildInfo.keyfrom);
    if (
      typeof buildInfo.keyfrom === 'string' &&
      normalized === DefaultKeyfrom.Official &&
      buildInfo.keyfrom.trim().toLowerCase() !== DefaultKeyfrom.Official
    ) {
      console.warn('[Keyfrom] invalid build keyfrom value, falling back to official');
    }
    return normalized;
  }

  return DefaultKeyfrom.Official;
}

function isValidAttribution(value: unknown): value is KeyfromAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<KeyfromAttribution>;
  return (
    normalizeKeyfrom(candidate.firstKeyfrom) === candidate.firstKeyfrom &&
    normalizeKeyfrom(candidate.latestKeyfrom) === candidate.latestKeyfrom &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt)
  );
}

export function readKeyfromAttribution(store: Pick<SqliteStore, 'get'>): KeyfromAttribution | null {
  try {
    const stored = store.get<unknown>(KeyfromStoreKey.Attribution);
    if (!stored) return null;
    if (isValidAttribution(stored)) return stored;
    console.warn('[Keyfrom] stored attribution is invalid, ignoring it');
    return null;
  } catch (error) {
    console.error('[Keyfrom] failed to read attribution from SQLite:', error);
    return null;
  }
}

export function saveKeyfromAttribution(
  store: Pick<SqliteStore, 'set'>,
  attribution: KeyfromAttribution,
): void {
  try {
    store.set(KeyfromStoreKey.Attribution, attribution);
  } catch (error) {
    console.error('[Keyfrom] failed to save attribution to SQLite:', error);
  }
}

export function initializeKeyfromAttribution(
  store: Pick<SqliteStore, 'get' | 'set'>,
  options: { currentKeyfrom?: string; now?: number } = {},
): KeyfromAttribution {
  const currentKeyfrom = normalizeKeyfrom(options.currentKeyfrom ?? resolveCurrentKeyfrom());
  const existing = readKeyfromAttribution(store);
  const firstKeyfrom = existing?.firstKeyfrom || currentKeyfrom;
  const latestKeyfrom = currentKeyfrom;
  const attribution: KeyfromAttribution = {
    firstKeyfrom,
    latestKeyfrom,
    updatedAt: options.now ?? Date.now(),
  };

  saveKeyfromAttribution(store, attribution);
  cachedAttribution = attribution;

  if (!existing?.firstKeyfrom) {
    console.log(`[Keyfrom] initialized first keyfrom as ${firstKeyfrom}`);
  }
  if (existing?.latestKeyfrom !== latestKeyfrom) {
    console.log(`[Keyfrom] updated latest keyfrom as ${latestKeyfrom}`);
  }
  console.log(`[Keyfrom] resolved current keyfrom as ${currentKeyfrom}`);

  return attribution;
}

export function getKeyfromAttribution(store?: Pick<SqliteStore, 'get'>): KeyfromAttribution {
  if (store) {
    const stored = readKeyfromAttribution(store);
    if (stored) {
      cachedAttribution = stored;
      return stored;
    }
  }
  if (cachedAttribution) return cachedAttribution;
  const currentKeyfrom = normalizeKeyfrom(resolveCurrentKeyfrom());
  return {
    firstKeyfrom: currentKeyfrom,
    latestKeyfrom: currentKeyfrom,
    updatedAt: Date.now(),
  };
}
