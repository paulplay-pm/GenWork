/**
 * Merge an admin-configured model's sampling parameters into the client's
 * upstream request body.
 *
 * Admin values win: a non-null stored value overrides whatever the client
 * sent. A null stored value leaves the client's value untouched — we never
 * erase a client-supplied param just because the admin left the field blank.
 *
 * Only inference-time sampling params are injected: `temperature`, `top_p`,
 * and `max_output_tokens` (emitted as OpenAI's `max_tokens`). The capability
 * flags (`supports_*`) and the model limit (`context_window`) are catalog
 * metadata, not per-request params, so they are deliberately NOT written into
 * the body.
 *
 * Returns the body unchanged (same reference) when it isn't a plain object or
 * there is nothing to apply, so the pass-through path stays allocation-free.
 */
export interface ModelSamplingParams {
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
}

export function applyModelParams(body: unknown, params: ModelSamplingParams): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (params.temperature !== null) out.temperature = params.temperature;
  if (params.top_p !== null) out.top_p = params.top_p;
  if (params.max_output_tokens !== null) out.max_tokens = params.max_output_tokens;
  return out;
}
