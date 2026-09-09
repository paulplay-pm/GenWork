import { expect, test } from 'vitest';

import { McpUrlValidationError, normalizeMcpServerUrlInput } from './url';

test('normalizeMcpServerUrlInput accepts absolute HTTP URLs', () => {
  expect(normalizeMcpServerUrlInput(' https://mcp.example.com/servers/gcp/mcp ')).toEqual({
    ok: true,
    url: 'https://mcp.example.com/servers/gcp/mcp',
    extracted: false,
  });
});

test('normalizeMcpServerUrlInput extracts one URL from pasted labels', () => {
  expect(normalizeMcpServerUrlInput('\u670D\u52A1 URL: https://mcp.example.com/servers/gcp/mcp')).toEqual({
    ok: true,
    url: 'https://mcp.example.com/servers/gcp/mcp',
    extracted: true,
  });
});

test('normalizeMcpServerUrlInput rejects non-http URLs', () => {
  expect(normalizeMcpServerUrlInput('file:///tmp/mcp')).toEqual({
    ok: false,
    error: McpUrlValidationError.Invalid,
  });
});

test('normalizeMcpServerUrlInput rejects text with multiple URLs', () => {
  expect(normalizeMcpServerUrlInput('https://a.example/mcp https://b.example/mcp')).toEqual({
    ok: false,
    error: McpUrlValidationError.Multiple,
  });
});
