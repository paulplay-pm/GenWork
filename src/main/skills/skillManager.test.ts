import { afterEach, expect, test, vi } from 'vitest';

const nodeRuntimeMocks = vi.hoisted(() => ({
  resolveNodeRuntimeForSpawn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() }, fetch: vi.fn() } },
}));

vi.mock('../libs/nodeRuntime', () => nodeRuntimeMocks);

import * as electron from 'electron';

import { __skillManagerTestUtils } from './skillManager';
vi.mock('../auth/enterpriseClient', () => ({
  enterpriseClient: { getToken: vi.fn().mockResolvedValue('tok-123') },
}));

const { parseFrontmatter, isTruthy, extractDescription, getSkillScriptRuntimeCandidates, catalogSkillIdForSource, isRemoteZipSource } = __skillManagerTestUtils;

afterEach(() => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReset();
});

// ==================== parseFrontmatter ====================

test('parseFrontmatter: simple key-value pairs', () => {
  const raw = '---\nname: demo\ndescription: A simple skill\nofficial: true\n---\n# Content here\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.description).toBe('A simple skill');
  expect(frontmatter.official).toBe(true); // YAML parses 'true' as boolean
  expect(content.trim()).toBe('# Content here');
});

test('parseFrontmatter: block scalar with pipe (|)', () => {
  const raw = '---\nname: demo\ndescription: |\n  A multi-line description.\n  Second line.\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.description).toBe('A multi-line description.\nSecond line.\n');
  expect(content.trim()).toBe('# Content');
});

test('parseFrontmatter: folded scalar with greater-than (>)', () => {
  const raw = '---\nname: demo\ndescription: >\n  A folded\n  description.\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.description).toBe('A folded description.\n');
});

test('parseFrontmatter: quoted strings', () => {
  const raw = '---\nname: "quoted name"\ndescription: \'single quoted\'\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('quoted name');
  expect(frontmatter.description).toBe('single quoted');
});

test('parseFrontmatter: nested objects', () => {
  const raw = '---\nname: demo\nmetadata:\n  short-description: A short desc\n  version: 2\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.metadata).toEqual({ 'short-description': 'A short desc', version: 2 });
});

test('parseFrontmatter: arrays', () => {
  const raw = '---\nname: demo\ntags:\n  - tool\n  - search\n  - web\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.tags).toEqual(['tool', 'search', 'web']);
});

test('parseFrontmatter: boolean values as native YAML booleans', () => {
  const raw = '---\nname: demo\nofficial: true\nisOfficial: false\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.official).toBe(true);
  expect(frontmatter.isOfficial).toBe(false);
});

test('parseFrontmatter: no frontmatter returns empty object and full content', () => {
  const raw = '# Just a heading\nSome content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter).toEqual({});
  expect(content).toBe(raw);
});

test('parseFrontmatter: empty frontmatter returns empty object', () => {
  const raw = '---\n\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter).toEqual({});
  expect(content.trim()).toBe('# Content');
});

test('parseFrontmatter: BOM is stripped', () => {
  const raw = '\uFEFF---\nname: bom-test\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('bom-test');
});

test('parseFrontmatter: Windows line endings (CRLF)', () => {
  const raw = '---\r\nname: win\r\ndescription: windows\r\n---\r\n# Content\r\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('win');
  expect(frontmatter.description).toBe('windows');
});

test('parseFrontmatter: invalid YAML returns empty frontmatter gracefully', () => {
  const raw = '---\n: invalid\n  bad:\n    - [\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter).toEqual({});
  expect(content).toMatch(/# Content/);
});

// ==================== isTruthy ====================

test('isTruthy: native boolean true', () => {
  expect(isTruthy(true)).toBe(true);
});

test('isTruthy: native boolean false', () => {
  expect(isTruthy(false)).toBe(false);
});

test('isTruthy: string "true"', () => {
  expect(isTruthy('true')).toBe(true);
  expect(isTruthy('True')).toBe(true);
  expect(isTruthy('TRUE')).toBe(true);
});

test('isTruthy: string "yes" and "1"', () => {
  expect(isTruthy('yes')).toBe(true);
  expect(isTruthy('1')).toBe(true);
});

test('isTruthy: string "false" and others', () => {
  expect(isTruthy('false')).toBe(false);
  expect(isTruthy('no')).toBe(false);
  expect(isTruthy('0')).toBe(false);
  expect(isTruthy('random')).toBe(false);
});

test('isTruthy: undefined and null', () => {
  expect(isTruthy(undefined)).toBe(false);
  expect(isTruthy(null)).toBe(false);
});

test('isTruthy: number and object', () => {
  expect(isTruthy(1)).toBe(false);
  expect(isTruthy({})).toBe(false);
});

// ==================== extractDescription ====================

test('extractDescription: extracts first non-empty line', () => {
  expect(extractDescription('\n\nFirst line\nSecond line\n')).toBe('First line');
});

test('extractDescription: strips markdown heading markers', () => {
  expect(extractDescription('## Heading\nContent')).toBe('Heading');
  expect(extractDescription('### Sub heading')).toBe('Sub heading');
});

test('extractDescription: returns empty string for empty content', () => {
  expect(extractDescription('')).toBe('');
  expect(extractDescription('\n\n\n')).toBe('');
});

test('getSkillScriptRuntimeCandidates delegates to shared node runtime resolution', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    env: {},
  });

  expect(getSkillScriptRuntimeCandidates({ PATH: 'ignored' })).toEqual([{
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    extraEnv: undefined,
  }]);
});

test('getSkillScriptRuntimeCandidates preserves Electron-as-node fallback env', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\GenWork\\GenWork.exe',
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });

  expect(getSkillScriptRuntimeCandidates({ PATH: 'ignored' })).toEqual([{
    command: 'C:\\GenWork\\GenWork.exe',
    args: [],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  }]);
});

// ==================== Integration: real-world SKILL.md patterns ====================

test('integration: typical official skill frontmatter', () => {
  const raw = [
    '---',
    'name: docx',
    'description: "Comprehensive document creation, editing, and analysis"',
    'license: Proprietary. LICENSE.txt has complete terms',
    'official: true',
    '---',
    '',
    '# DOCX creation, editing, and analysis',
    'Detailed instructions here.',
  ].join('\n');

  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('docx');
  expect(frontmatter.description).toBe('Comprehensive document creation, editing, and analysis');
  expect(frontmatter.license).toBe('Proprietary. LICENSE.txt has complete terms');
  expect(isTruthy(frontmatter.official)).toBe(true);
  expect(content).toMatch(/# DOCX creation/);
});

test('integration: skill with metadata nested object', () => {
  const raw = [
    '---',
    'name: create-plan',
    'description: Create a concise plan',
    'official: true',
    'metadata:',
    '  short-description: Create a plan',
    '---',
    '',
    '# Create Plan',
  ].join('\n');

  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('create-plan');
  expect(frontmatter.metadata).toEqual({ 'short-description': 'Create a plan' });
});

test('integration: skill with block scalar description', () => {
  const raw = [
    '---',
    'name: demo',
    'description: |',
    '  A multi-line description.',
    '  Second line.',
    '---',
    '',
    '# Demo Skill',
  ].join('\n');

  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(String(frontmatter.description || '').trim()).toBe('A multi-line description.\nSecond line.');
  expect(content).toMatch(/# Demo Skill/);
});

// ==================== parseClawhubUrl ====================

/**
 * Unit tests for parseClawhubUrl in skillManager.ts.
 *
 * Logic is mirrored inline because skillManager.ts imports Electron APIs
 * which cannot be loaded outside the Electron main process.
 */

// ---------------------------------------------------------------------------
// Mirror of parseClawhubUrl from skillManager.ts
// ---------------------------------------------------------------------------

const parseClawhubUrl = (source: string): { name: string } | null => {
  try {
    const url = new URL(source);
    if (url.hostname !== 'clawhub.ai' && url.hostname !== 'www.clawhub.ai') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    // Format: /skills/{owner}/{name}
    if (segments.length >= 3 && segments[0] === 'skills') {
      return { name: segments[2] };
    }
    // Format: /skills/{name}
    if (segments.length >= 2 && segments[0] === 'skills') {
      return { name: segments[1] };
    }
    // Format: /{owner}/{name} (no /skills/ prefix)
    if (segments.length >= 2) {
      return { name: segments[1] };
    }
    return null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// /{owner}/{name} format
// ---------------------------------------------------------------------------

test('clawhub: /{owner}/{name} extracts skill name', () => {
  expect(parseClawhubUrl('https://clawhub.ai/steipete/slack')).toEqual({ name: 'slack' });
});

test('clawhub: /{owner}/{name} with www prefix', () => {
  expect(parseClawhubUrl('https://www.clawhub.ai/steipete/slack')).toEqual({ name: 'slack' });
});

test('clawhub: /{owner}/{name} with trailing slash', () => {
  expect(parseClawhubUrl('https://clawhub.ai/anthropic/web-search/')).toEqual({ name: 'web-search' });
});

// ---------------------------------------------------------------------------
// /skills/{owner}/{name} format
// ---------------------------------------------------------------------------

test('clawhub: /skills/{owner}/{name} extracts skill name', () => {
  expect(parseClawhubUrl('https://clawhub.ai/skills/steipete/slack')).toEqual({ name: 'slack' });
});

test('clawhub: /skills/{owner}/{name} with trailing slash', () => {
  expect(parseClawhubUrl('https://clawhub.ai/skills/anthropic/web-search/')).toEqual({ name: 'web-search' });
});

// ---------------------------------------------------------------------------
// /skills/{name} format
// ---------------------------------------------------------------------------

test('clawhub: /skills/{name} extracts skill name', () => {
  expect(parseClawhubUrl('https://clawhub.ai/skills/slack')).toEqual({ name: 'slack' });
});

// ---------------------------------------------------------------------------
// Rejected inputs
// ---------------------------------------------------------------------------

test('clawhub: non-clawhub hostname returns null', () => {
  expect(parseClawhubUrl('https://github.com/steipete/slack')).toBeNull();
});

test('clawhub: root path returns null', () => {
  expect(parseClawhubUrl('https://clawhub.ai/')).toBeNull();
});

test('clawhub: single segment path returns null', () => {
  expect(parseClawhubUrl('https://clawhub.ai/about')).toBeNull();
});

test('clawhub: invalid URL returns null', () => {
  expect(parseClawhubUrl('not-a-url')).toBeNull();
});

test('clawhub: empty string returns null', () => {
  expect(parseClawhubUrl('')).toBeNull();
});

// ---------------------------------------------------------------------------
// downloadZipUrl auth header
// ---------------------------------------------------------------------------

const fetchMock = (electron.session.defaultSession as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;

test('downloadZipUrl attaches a Bearer token for the enterprise origin', async () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
  await expect(
    __skillManagerTestUtils.downloadZipUrl('https://ent.example/api/skill-marketplace/download/sk1', process.cwd()),
  ).rejects.toThrow();
  const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(headers.authorization).toBe('Bearer tok-123');
});

test('downloadZipUrl omits the auth header for a non-enterprise origin', async () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
  await expect(
    __skillManagerTestUtils.downloadZipUrl('https://github.com/x/y.zip', process.cwd()),
  ).rejects.toThrow();
  const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(headers.authorization).toBeUndefined();
});

// ---------------------------------------------------------------------------
// catalogSkillIdForSource
// ---------------------------------------------------------------------------

test('catalogSkillIdForSource: enterprise download URL returns the catalog id', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  expect(catalogSkillIdForSource('https://ent.example/api/skill-marketplace/download/sk1')).toBe('sk1');
});

test('catalogSkillIdForSource: enterprise download URL with a trailing slash still returns the id', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  expect(catalogSkillIdForSource('https://ent.example/api/skill-marketplace/download/sk1/')).toBe('sk1');
});

test('catalogSkillIdForSource: non-enterprise origin returns null', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  expect(catalogSkillIdForSource('https://github.com/x/api/skill-marketplace/download/sk1')).toBeNull();
});

test('catalogSkillIdForSource: enterprise origin but non-skill-marketplace path returns null', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  expect(catalogSkillIdForSource('https://ent.example/api/other/x')).toBeNull();
});

test('catalogSkillIdForSource: download prefix with empty id returns null', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  expect(catalogSkillIdForSource('https://ent.example/api/skill-marketplace/download/')).toBeNull();
});

test('catalogSkillIdForSource: local paths return null (no throw)', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  expect(catalogSkillIdForSource('/tmp/local/skill-dir')).toBeNull();
  expect(catalogSkillIdForSource('relative/path')).toBeNull();
});

test('catalogSkillIdForSource: ENTERPRISE_SERVER_URL unset returns null without throwing', () => {
  const prev = process.env.ENTERPRISE_SERVER_URL;
  delete process.env.ENTERPRISE_SERVER_URL;
  try {
    expect(() => catalogSkillIdForSource('https://ent.example/api/skill-marketplace/download/sk1')).not.toThrow();
    expect(catalogSkillIdForSource('https://ent.example/api/skill-marketplace/download/sk1')).toBeNull();
  } finally {
    if (prev !== undefined) process.env.ENTERPRISE_SERVER_URL = prev;
  }
});

// ---------------------------------------------------------------------------
// isRemoteZipSource — the dispatch predicate deciding zip download vs git clone
// ---------------------------------------------------------------------------

test('isRemoteZipSource: enterprise catalog download URL (no .zip suffix) is a zip source', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  // The catalog URL has no `.zip` suffix — the server returns zip bytes via
  // content-disposition. Without the catalog check it fell through to
  // normalizeGitSource and git-clone failed with "Authentication failed".
  expect(isRemoteZipSource('https://ent.example/api/skill-marketplace/download/sk1')).toBe(true);
});

test('isRemoteZipSource: ordinary .zip URL stays a zip source', () => {
  expect(isRemoteZipSource('https://github.com/x/y/archive/main.zip')).toBe(true);
});

test('isRemoteZipSource: git URL is NOT a zip source', () => {
  expect(isRemoteZipSource('https://github.com/x/y.git')).toBe(false);
});

test('isRemoteZipSource: non-enterprise origin on the download path is NOT a zip source', () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  // A different host serving the same path is not our catalog → still a git
  // source (or rejected upstream), never an authenticated zip fetch.
  expect(isRemoteZipSource('https://evil.example/api/skill-marketplace/download/sk1')).toBe(false);
});

test('isRemoteZipSource: ENTERPRISE_SERVER_URL unset degrades to the .zip check', () => {
  const prev = process.env.ENTERPRISE_SERVER_URL;
  delete process.env.ENTERPRISE_SERVER_URL;
  try {
    expect(isRemoteZipSource('https://ent.example/api/skill-marketplace/download/sk1')).toBe(false);
    expect(isRemoteZipSource('https://example.com/skills/foo.zip')).toBe(true);
  } finally {
    if (prev !== undefined) process.env.ENTERPRISE_SERVER_URL = prev;
  }
});
