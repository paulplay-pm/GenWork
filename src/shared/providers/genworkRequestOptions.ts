// `OptionsV1` is a wire-protocol value exchanged with the server. The string
// literal `genwork-options-v1` is the wire-protocol value exchanged with the
// server. Coordinated with the enterprise_server rename; the legacy value is
// no longer accepted (no dual-read).
export const GenWorkRequestCapability = {
  OptionsV1: 'genwork-options-v1',
} as const;

export type GenWorkRequestCapability =
  typeof GenWorkRequestCapability[keyof typeof GenWorkRequestCapability];

export const GENWORK_REQUEST_OPTIONS_FIELD = 'genwork_options';
export const GENWORK_REQUEST_OPTIONS_VERSION = 1;

// Client-capabilities handshake header. The desktop advertises which
// feature-gated behaviours the server may enable for this build.
// Relocated here from the deleted `modelRuntimeProfiles` module — these are
// protocol identifiers, not catalog data. The `GENWORK_`/`X-Genwork-` naming
// is the identifier the server expects.
export const GENWORK_CLIENT_CAPABILITIES_HEADER = 'X-Genwork-Client-Capabilities';
export const GENWORK_CLIENT_VERSION_HEADER = 'X-Genwork-Client-Version';
export const KIMI_K3_AGENTIC_CAPABILITY = 'kimi-k3-agentic-v1';
export const THINKING_LEVEL_CONTROL_CAPABILITY = 'thinking-level-control-v1';
export const GENWORK_CLIENT_CAPABILITIES = [
  KIMI_K3_AGENTIC_CAPABILITY,
  THINKING_LEVEL_CONTROL_CAPABILITY,
].join(',');

const GENWORK_REQUEST_CAPABILITY_VALUES = new Set<string>(
  Object.values(GenWorkRequestCapability),
);

export const parseGenWorkRequestCapabilities = (
  value: unknown,
): GenWorkRequestCapability[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const result: GenWorkRequestCapability[] = [];
  const seen = new Set<GenWorkRequestCapability>();
  for (const candidate of value) {
    if (
      typeof candidate !== 'string'
      || !GENWORK_REQUEST_CAPABILITY_VALUES.has(candidate)
    ) {
      continue;
    }
    const capability = candidate as GenWorkRequestCapability;
    if (!seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return result.length > 0 ? result : undefined;
};

export const supportsGenWorkRequestOptionsV1 = (
  capabilities: readonly GenWorkRequestCapability[] | undefined,
): boolean => capabilities?.includes(GenWorkRequestCapability.OptionsV1) === true;
