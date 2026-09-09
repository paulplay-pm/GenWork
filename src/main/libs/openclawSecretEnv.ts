const ENV_PLACEHOLDER_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export const collectReferencedEnvVarNames = (value: unknown): Set<string> => {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  const names = new Set<string>();
  if (!source) return names;

  for (const match of source.matchAll(ENV_PLACEHOLDER_PATTERN)) {
    names.add(match[1]);
  }

  return names;
};

export const pickReferencedSecretEnvVars = (
  env: Record<string, string>,
  referencedNames: Set<string>,
): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (referencedNames.has(key)) {
      picked[key] = env[key];
    }
  }
  return picked;
};
