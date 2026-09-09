export const isSubagentSessionKey = (sessionKey: string): boolean => sessionKey.includes(':subagent:');

export const parseAgentIdFromSubagentSessionKey = (sessionKey: string): string | null => {
  const match = sessionKey.match(/^agent:([^:]+):subagent:/);
  return match?.[1]?.trim() || null;
};
