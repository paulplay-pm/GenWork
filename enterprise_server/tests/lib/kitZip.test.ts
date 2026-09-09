import AdmZip from 'adm-zip';
import { describe, expect, test } from 'vitest';

import { hasPathTraversal, KitZipError, MAX_KIT_ZIP_BYTES, parseKitZip } from '../../src/lib/kitZip';

function zip(entries: Array<[string, string]>): Buffer {
  const z = new AdmZip();
  for (const [name, data] of entries) z.addFile(name, Buffer.from(data));
  return Buffer.from(z.toBuffer());
}

describe('parseKitZip', () => {
  test('accepts a flat multi-skill kit (many SKILL.md at the root)', () => {
    const buf = zip([['architecture/SKILL.md', '# a'], ['code-review/SKILL.md', '# b']]);
    const p = parseKitZip(buf);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.size).toBeGreaterThan(0);
  });

  test('accepts a single-skill kit', () => {
    const p = parseKitZip(zip([['solo/SKILL.md', '# s']]));
    expect(p.size).toBeGreaterThan(0);
  });

  test('rejects empty', () => {
    expect(() => parseKitZip(Buffer.alloc(0))).toThrow(KitZipError);
  });

  test('rejects over-limit zip', () => {
    expect(() => parseKitZip(Buffer.alloc(MAX_KIT_ZIP_BYTES + 1))).toThrow(KitZipError);
  });

  test('rejects a zip with no SKILL.md anywhere', () => {
    expect(() => parseKitZip(zip([['foo/bar.txt', 'x']]))).toThrow(KitZipError);
  });

  test('rejects path traversal entry names', () => {
    expect(hasPathTraversal('foo/../../../etc/SKILL.md')).toBe(true);
    expect(hasPathTraversal('../etc/passwd')).toBe(true);
    expect(hasPathTraversal('safe/../evil.txt')).toBe(true);
    expect(hasPathTraversal('a/b/SKILL.md')).toBe(false);
    expect(hasPathTraversal('SKILL.md')).toBe(false);
  });
});
