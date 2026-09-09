import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export type GenWorkApiType = 'anthropic' | 'openai';

export type GenWorkApiConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: GenWorkApiType;
};

const CONFIG_FILE_NAME = 'api-config.json';

function getConfigPath(): string {
  const userDataPath = app.getPath('userData');
  return join(userDataPath, CONFIG_FILE_NAME);
}

export function loadGenWorkApiConfig(): GenWorkApiConfig | null {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
      return null;
    }

    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as GenWorkApiConfig;
    if (config.apiKey && config.baseURL && config.model) {
      const normalizedApiType =
        config.apiType === 'openai' || config.apiType === 'anthropic'
          ? config.apiType
          : 'anthropic';
      config.apiType = normalizedApiType;
      return config;
    }

    return null;
  } catch (error) {
    console.error('[cowork-config] Failed to load API config:', error);
    return null;
  }
}

export function saveGenWorkApiConfig(config: GenWorkApiConfig): void {
  const configPath = getConfigPath();
  const userDataPath = app.getPath('userData');

  if (!existsSync(userDataPath)) {
    mkdirSync(userDataPath, { recursive: true });
  }

  if (!config.apiKey || !config.baseURL || !config.model) {
    throw new Error('Invalid config: apiKey, baseURL, and model are required');
  }

  const normalized: GenWorkApiConfig = {
    apiKey: config.apiKey.trim(),
    baseURL: config.baseURL.trim(),
    model: config.model.trim(),
    apiType: config.apiType === 'openai' ? 'openai' : 'anthropic',
  };

  writeFileSync(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  console.info('[cowork-config] API config saved successfully');
}

export function deleteGenWorkApiConfig(): void {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      unlinkSync(configPath);
      console.info('[cowork-config] API config deleted');
    }
  } catch (error) {
    console.error('[cowork-config] Failed to delete API config:', error);
  }
}
