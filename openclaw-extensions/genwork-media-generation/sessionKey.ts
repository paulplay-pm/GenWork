const LEGACY_GENWORK_SESSION_PREFIX = 'genwork:';
const AGENT_SESSION_PREFIX = 'agent:';
const GENWORK_SESSION_MARKER = 'genwork';
const SUBAGENT_SESSION_MARKER = 'subagent';

export function isGenworkDesktopSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? '').trim();
  if (!raw) return false;

  if (raw.startsWith(LEGACY_GENWORK_SESSION_PREFIX)) {
    return raw.slice(LEGACY_GENWORK_SESSION_PREFIX.length).trim().length > 0;
  }

  if (!raw.startsWith(AGENT_SESSION_PREFIX)) {
    return false;
  }

  const parts = raw.split(':');
  if (parts.length < 4 || parts[0] !== 'agent') {
    return false;
  }

  const agentId = parts[1]?.trim() ?? '';
  const source = parts[2]?.trim() ?? '';
  const sessionId = parts.slice(3).join(':').trim();
  return agentId.length > 0
    && sessionId.length > 0
    && (source === GENWORK_SESSION_MARKER || source === SUBAGENT_SESSION_MARKER);
}