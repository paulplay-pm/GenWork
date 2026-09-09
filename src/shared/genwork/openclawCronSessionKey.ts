export interface OpenClawCronSessionKey {
  agentId: string | null;
  scheduledTaskId: string;
  cacheKey: string;
}

export const OpenClawCronRunMetadataKey = {
  SessionKey: 'openclawCronRunSessionKey',
  EntryIndex: 'openclawCronRunEntryIndex',
} as const;

const LEGACY_CRON_SESSION_KEY_RE = /^cron:([^:\s]+)$/i;
const AGENT_CRON_SESSION_KEY_RE = /^agent:([^:]+):cron:([^:\s]+)(?::run:.+)?$/i;

/** Parse the OpenClaw session keys used for isolated scheduled-task runs. */
export const parseOpenClawCronSessionKey = (
  sessionKey: string,
): OpenClawCronSessionKey | null => {
  const legacyMatch = sessionKey.match(LEGACY_CRON_SESSION_KEY_RE);
  if (legacyMatch) {
    const scheduledTaskId = legacyMatch[1];
    return {
      agentId: null,
      scheduledTaskId,
      cacheKey: `cron:${scheduledTaskId}`,
    };
  }

  const agentMatch = sessionKey.match(AGENT_CRON_SESSION_KEY_RE);
  if (!agentMatch) return null;

  const agentId = agentMatch[1];
  const scheduledTaskId = agentMatch[2];
  return {
    agentId,
    scheduledTaskId,
    cacheKey: `agent:${agentId}:cron:${scheduledTaskId}`,
  };
};

export const isOpenClawCronSessionKey = (sessionKey: string): boolean => (
  parseOpenClawCronSessionKey(sessionKey) !== null
);
