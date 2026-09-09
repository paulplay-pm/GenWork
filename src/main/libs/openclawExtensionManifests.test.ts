import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../');

function readManifest(extensionId: string): Record<string, unknown> {
  const manifestPath = path.join(repoRoot, 'openclaw-extensions', extensionId, 'openclaw.plugin.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

function readContractTools(extensionId: string): string[] {
  const manifest = readManifest(extensionId);
  const contracts = manifest.contracts as { tools?: unknown } | undefined;
  return Array.isArray(contracts?.tools)
    ? contracts.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
}

function readPackageOpenClawExtensions(extensionId: string): string[] {
  const packagePath = path.join(repoRoot, 'openclaw-extensions', extensionId, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { openclaw?: { extensions?: unknown } };
  return Array.isArray(pkg.openclaw?.extensions)
    ? pkg.openclaw.extensions.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

describe('OpenClaw extension manifests', () => {
  test('declares the AskUserQuestion agent tool contract', () => {
    expect(readContractTools('ask-user-question')).toEqual(['AskUserQuestion']);
  });

  test('declares Genwork media generation and skin agent tool contracts', () => {
    expect(readContractTools('genwork-media-generation')).toEqual([
      'genwork_image_generate',
      'genwork_video_generate',
      'genwork_skin_manage',
    ]);
  });

  test('declares TypeScript entries for local extensions that are precompiled for packaging', () => {
    expect(readPackageOpenClawExtensions('mcp-bridge')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('ask-user-question')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('genwork-media-generation')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('genwork-model-compat')).toEqual(['./index.ts']);
  });

  test('declares a strict allowlisted model-profile config for Genwork compatibility', () => {
    const manifest = readManifest('genwork-model-compat');
    expect(manifest.providers).toEqual(['genwork-model-compat']);
    expect(manifest.activation).toBeUndefined();
    expect(manifest.configSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        modelProfiles: {
          type: 'object',
          minProperties: 1,
          propertyNames: {
            pattern: '^[^/\\s]+/[^\\s]+$',
          },
          additionalProperties: {
            type: 'string',
            enum: ['moonshot-kimi-k3'],
          },
        },
        thinkingProfiles: {
          type: 'object',
          minProperties: 1,
          propertyNames: {
            pattern: '^[^/\\s]+/[^\\s]+$',
          },
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              options: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    level: {
                      type: 'string',
                      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                    },
                    openclawLevel: {
                      type: 'string',
                      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
                    },
                  },
                  required: ['level', 'openclawLevel'],
                },
              },
              defaultLevel: {
                type: 'string',
                enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
              },
              requestOptionsVersion: {
                type: 'integer',
                enum: [1],
              },
            },
            required: ['options', 'defaultLevel'],
          },
        },
      },
      anyOf: [
        { required: ['modelProfiles'] },
        { required: ['thinkingProfiles'] },
      ],
    });
  });
});
