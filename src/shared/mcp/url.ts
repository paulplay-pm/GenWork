export const McpUrlProtocol = {
  Http: 'http:',
  Https: 'https:',
} as const;
export type McpUrlProtocol = typeof McpUrlProtocol[keyof typeof McpUrlProtocol];

export const McpUrlValidationError = {
  Empty: 'empty',
  Invalid: 'invalid',
  Multiple: 'multiple',
} as const;
export type McpUrlValidationError =
  typeof McpUrlValidationError[keyof typeof McpUrlValidationError];

export type NormalizedMcpUrlResult =
  | { ok: true; url: string; extracted: boolean }
  | { ok: false; error: McpUrlValidationError };

const URL_CANDIDATE_RE = /https?:\/\/[^\s"'<>\uFF0C\u3002\uFF1B]+/gi;
const TRAILING_PUNCTUATION_RE = /[),.;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001]+$/;

function parseHttpUrl(value: string): string | null {
  if (/\s/.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== McpUrlProtocol.Http && url.protocol !== McpUrlProtocol.Https) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function trimUrlCandidate(value: string): string {
  return value.trim().replace(TRAILING_PUNCTUATION_RE, '');
}

export function normalizeMcpServerUrlInput(input: string | undefined | null): NormalizedMcpUrlResult {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return { ok: false, error: McpUrlValidationError.Empty };
  }

  const direct = parseHttpUrl(trimmed);
  if (direct) {
    return { ok: true, url: direct, extracted: false };
  }

  const candidates = Array.from(trimmed.matchAll(URL_CANDIDATE_RE))
    .map(match => trimUrlCandidate(match[0]))
    .map(parseHttpUrl)
    .filter((url): url is string => Boolean(url));
  const uniqueCandidates = Array.from(new Set(candidates));

  if (uniqueCandidates.length === 1) {
    return { ok: true, url: uniqueCandidates[0], extracted: true };
  }
  if (uniqueCandidates.length > 1) {
    return { ok: false, error: McpUrlValidationError.Multiple };
  }
  return { ok: false, error: McpUrlValidationError.Invalid };
}
