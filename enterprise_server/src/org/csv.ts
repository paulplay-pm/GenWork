/**
 * Minimal RFC-4180 CSV helpers — the only CSV logic in the codebase.
 * `toCsv` writes a header row (from `columns`) plus one row per record and
 * quotes a field only when it contains a comma, double-quote, or newline
 * (embedded `"` doubled); lines end with `\r\n`. `parseCsv` is its exact
 * inverse: it returns rows as arrays of strings, handles quoted fields with
 * embedded commas/newlines and escaped `""`, and treats a trailing newline
 * as the end of the last record (not an extra empty row). No header
 * semantics — callers own that.
 */

function escapeField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: Record<string, string>[], columns: string[]): string {
  const lines: string[] = [columns.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeField(row[col] ?? '')).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function parseCsv(text: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  // Any real content in the current record; drops the phantom record a
  // trailing newline would otherwise produce (and mid-file empty lines).
  let content = false;

  const commit = (): void => {
    row.push(field);
    field = '';
    if (content || row.length > 1) rows.push(row);
    row = [];
    content = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      // Opening quote at the start of a field; a quote after content is
      // treated as a literal character.
      inQuotes = true;
      content = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      content = true;
    } else if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) {
      // Lone \n, or lone \r — record boundary.
      commit();
    } else if (ch === '\r') {
      // \r of a \r\n pair; skip the \n and treat as one boundary.
      i += 1;
      commit();
    } else {
      field += ch;
      content = true;
    }
  }
  commit();
  return rows;
}
