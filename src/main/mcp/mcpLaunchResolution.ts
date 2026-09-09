import crypto from 'crypto';

import type { McpServerRecord } from './mcpStore';

export const McpLaunchResolverKind = {
  Npx: 'npx',
  Uvx: 'uvx',
  Python: 'python',
  Raw: 'raw',
} as const;
export type McpLaunchResolverKind = typeof McpLaunchResolverKind[keyof typeof McpLaunchResolverKind];

export const McpLaunchResolutionStatus = {
  Pending: 'pending',
  Installing: 'installing',
  Ready: 'ready',
  Failed: 'failed',
  Unsupported: 'unsupported',
} as const;
export type McpLaunchResolutionStatus =
  typeof McpLaunchResolutionStatus[keyof typeof McpLaunchResolutionStatus];

export interface McpLaunchResolution {
  serverId: string;
  resolverKind: McpLaunchResolverKind;
  sourceFingerprint: string;
  status: McpLaunchResolutionStatus;
  packageName?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  installDir?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  error?: string;
  installedAt?: number;
  resolvedAt?: number;
  lastProbeAt?: number;
  lastProbeStatus?: string;
  updatedAt: number;
}

export function createMcpLaunchSourceFingerprint(server: McpServerRecord): string {
  const payload = {
    transportType: server.transportType,
    command: server.command || '',
    args: server.args || [],
    env: server.env || {},
    registryId: server.registryId || '',
    platform: process.platform,
    arch: process.arch,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function normalizeMcpCommand(command?: string): string {
  return (command || '').trim().toLowerCase();
}

export function isNpxMcpServer(server: McpServerRecord): boolean {
  const command = normalizeMcpCommand(server.command);
  return (
    command === 'npx'
    || command === 'npx.cmd'
    || command.endsWith('\\npx.cmd')
    || command.endsWith('/npx.cmd')
  );
}
