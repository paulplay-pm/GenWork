export interface UpstreamRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface UpstreamResponse {
  status: number;
  bodyText: string;
  usage: { tokenIn: number; tokenOut: number } | null;
  stream?: ReadableStream;
}

export async function callOpenAI(req: UpstreamRequest): Promise<UpstreamResponse> {
  const res = await fetch(req.endpoint, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  if (req.body && (req.body as { stream?: boolean }).stream) {
    return { status: res.status, bodyText: '', usage: null, stream: res.body ?? undefined };
  }
  const bodyText = await res.text();
  let usage: UpstreamResponse['usage'] = null;
  try {
    const j = JSON.parse(bodyText) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (j.usage) {
      usage = {
        tokenIn: j.usage.prompt_tokens ?? 0,
        tokenOut: j.usage.completion_tokens ?? 0,
      };
    }
  } catch {
    /* non-json */
  }
  return { status: res.status, bodyText, usage };
}