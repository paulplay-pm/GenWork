const toEntry = (raw: { title?: string; content?: unknown[] } | undefined) => ({
  title: typeof raw?.title === 'string' ? raw.title : '',
  content: Array.isArray(raw?.content)
    ? raw.content.filter((c): c is string => typeof c === 'string')
    : [],
});

export interface ParsedUpdateChangeLogEntry {
  title: string;
  content: string[];
}

export interface ParsedUpdate {
  latestVersion: string;
  date: string;
  changeLog: { zh: ParsedUpdateChangeLogEntry; en: ParsedUpdateChangeLogEntry };
  macIntelUrl: string | null;
  macArmUrl: string | null;
  windowsX64Url: string | null;
}

export interface EnterpriseUpdatePayload {
  latest?: boolean;
  version?: string;
  date?: string;
  changeLog?: {
    zh?: { title?: string; content?: unknown[] };
    en?: { title?: string; content?: unknown[] };
  };
  macIntel?: { url?: string };
  macArm?: { url?: string };
  windowsX64?: { url?: string };
}

/**
 * Parse the clean enterprise update payload. Returns null if the server says
 * there is no update available yet. All three platform URLs are exposed; the
 * coordinator selects one via `pickPlatformUrl()`.
 */
export function parseEnterpriseUpdate(payload: EnterpriseUpdatePayload): ParsedUpdate | null {
  if (payload.latest !== true) return null;
  const version = payload.version?.trim();
  if (!version) return null;
  return {
    latestVersion: version,
    date: payload.date?.trim() ?? '',
    changeLog: {
      zh: toEntry(payload.changeLog?.zh),
      en: toEntry(payload.changeLog?.en),
    },
    macIntelUrl: payload.macIntel?.url?.trim() || null,
    macArmUrl: payload.macArm?.url?.trim() || null,
    windowsX64Url: payload.windowsX64?.url?.trim() || null,
  };
}

export interface YoudaoChangeLogLang {
  title?: string;
  content?: string[];
}

export interface YoudaoUpdatePayload {
  code?: number;
  data?: {
    value?: {
      version?: string;
      date?: string;
      changeLog?: { ch?: YoudaoChangeLogLang; en?: YoudaoChangeLogLang };
      macIntel?: { url?: string };
      macArm?: { url?: string };
      windowsX64?: { url?: string };
    };
  };
}

/**
 * Parse the legacy Youdao envelope. Returns null on `code !== 0` or missing
 * version. URL chosen by the caller via `pickPlatformUrl()`.
 */
export function parseYoudaoUpdate(payload: YoudaoUpdatePayload): ParsedUpdate | null {
  if (payload.code !== 0) return null;
  const value = payload.data?.value;
  if (!value) return null;
  const version = value.version?.trim();
  if (!version) return null;
  return {
    latestVersion: version,
    date: value.date?.trim() ?? '',
    changeLog: {
      zh: toEntry(value.changeLog?.ch),
      en: toEntry(value.changeLog?.en),
    },
    macIntelUrl: value.macIntel?.url?.trim() || null,
    macArmUrl: value.macArm?.url?.trim() || null,
    windowsX64Url: value.windowsX64?.url?.trim() || null,
  };
}

/**
 * Pure helper used by the coordinator after parsing. Returns the URL for the
 * current process.platform/arch, or null if there is no URL for that platform.
 */
export function pickPlatformUrl(parsed: {
  macIntelUrl: string | null;
  macArmUrl: string | null;
  windowsX64Url: string | null;
}): string | null {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? parsed.macArmUrl : parsed.macIntelUrl;
  }
  if (process.platform === 'win32') {
    return parsed.windowsX64Url;
  }
  return null;
}
