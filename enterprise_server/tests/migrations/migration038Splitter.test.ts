import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIG_038 = join(__dirname, '../../src/db/migrations/038_org_skills.sql');

/**
 * Pin on the 038 PLpgSQL auto-seed trigger (see the migration header, which
 * documents this fragility). The `CREATE FUNCTION` body is written as a
 * single-quoted plpgsql string with NO dollar-quoting precisely so the
 * `splitStatements` production splitter keeps the whole `CREATE FUNCTION` as
 * ONE statement. A regression that naively splits on `;` would sever the body
 * (the embedded `DO NOTHING;` sits inside the plpgsql string) and the
 * migration would fail on the production single-statement path.
 *
 * This is a pure string assertion (no DB) so it is cheap and runs on its own;
 * the DB-backed `migrationSplitterFidelity` test additionally proves every
 * migration — including 038 — still applies end-to-end.
 */
describe('migration 038 splitStatements pin', () => {
  const stmts = splitStatements(readFileSync(MIG_038, 'utf8'));

  test('splits into a stable statement count', () => {
    // A pin against accidental statement additions/removals in the file.
    expect(stmts.length).toBe(26);
  });

  test('keeps the CREATE FUNCTION plpgsql body intact in a single statement', () => {
    const fnStatements = stmts.filter((s) =>
      s.includes('CREATE OR REPLACE FUNCTION skill_marketplace_ensure_bucket'));
    expect(fnStatements.length).toBe(1);
    const fn = fnStatements[0];
    // The full body — from plpgsql `BEGIN` through the trailing `END;` — must
    // survive in ONE statement, including the `DO NOTHING;` that lives inside
    // the plpgsql string (the classic split-on-`;` trap).
    expect(fn).toContain('BEGIN');
    expect(fn).toContain('ON CONFLICT (org_id, category_id) DO NOTHING; RETURN NULL; END;');
    // The trigger that references the function is a SEPARATE statement; the
    // function statement must not have swallowed it.
    expect(fn).not.toContain('CREATE TRIGGER');
  });
});
