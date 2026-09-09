import { auditStore } from '../audit/auditStore';
import { pool } from '../db/pool';
import { modelCatalog } from '../models/modelCatalog';
import { tokenUsage } from '../models/tokenUsage';
import { timezone } from '../org/timezone';
import { AuditAction, ProviderProxyQuotaReason, ProviderProxyResultCode } from '../shared/enterpriseServerConstants';
import { providerKeyVault } from '../vault/providerKeyVault';
import { applyModelParams } from './applyModelParams';
import { idempotency } from './idempotency';
import { callOpenAI, type UpstreamRequest } from './upstream';

export interface ProviderClaims {
  sub: string;
  orgId: string;
  roles: string[];
}

export type ProviderName = 'openai' | 'anthropic' | 'deepseek';

export const providerProxy = {
  async handle(
    provider: ProviderName,
    input: { model_id: string; body: unknown },
    claims: ProviderClaims | null,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    if (!claims) {
      return new Response('unauthorized', { status: ProviderProxyResultCode.Unauthorized });
    }

    const idemKey = extraHeaders['idempotency-key'];
    if (idemKey && idempotency.seen(idemKey)) {
      const prior = idempotency.lookup(idemKey) ?? 200;
      return new Response(JSON.stringify({ error: 'idempotent_replay' }), { status: prior });
    }

    const model = await modelCatalog.getById(input.model_id);
    if (!model || !model.enabled) {
      return new Response('model not found', { status: ProviderProxyResultCode.NotFound });
    }
    if (model.org_id !== claims.orgId) {
      return new Response('model not in your org', { status: ProviderProxyResultCode.NotFound });
    }

    const pol = await modelCatalog.getModelPolicy(claims.orgId, input.model_id);
    if (pol?.disabled) {
      return new Response('model disabled by admin', {
        status: ProviderProxyResultCode.ModelDisabled,
      });
    }

    // ---- Ruling F1: quota check + reservation in one transaction, serialised by
    // SELECT ... FOR UPDATE on the model_catalog row. Without FOR UPDATE, two
    // concurrent requests both read used=50/100 and both forward upstream,
    // overrunning the per-day quota. The lock blocks the second tx until the
    // first commits, so the second sees the freshly-written usage and 429s.
    if (model.quota_per_user_per_day !== null) {
      const windowDate = await timezone.quotaWindowDate(claims.sub, new Date());
      const reserved = await reserveQuota({
        orgId: claims.orgId,
        userId: claims.sub,
        modelId: input.model_id,
        windowDate,
        quota: model.quota_per_user_per_day,
      });
      if (!reserved.ok) {
        await tokenUsage.write({
          orgId: claims.orgId,
          userId: claims.sub,
          modelId: input.model_id,
          provider,
          tokenIn: 0,
          tokenOut: 0,
          resultCode: ProviderProxyResultCode.QuotaExceeded,
        });
        await auditStore.write({
          orgId: claims.orgId,
          userId: claims.sub,
          action: AuditAction.QuotaExceeded,
          targetType: 'model',
          targetId: input.model_id,
          payload: { used: reserved.used, quota: model.quota_per_user_per_day },
        });
        return new Response(
          JSON.stringify({
            error: 'quota_exceeded',
            reason: ProviderProxyQuotaReason.DailyQuotaExhausted,
            used: reserved.used,
            quota: model.quota_per_user_per_day,
            reset_at: `${windowDate}T00:00:00Z`,
          }),
          { status: ProviderProxyResultCode.QuotaExceeded }
        );
      }
    }

    // 释放 quota lock：在上面的 reserveQuota 已经 tx.commit 了，所以 lock 已被释放。
    // 这里在新的小事务里读 quota_window_date，避免再次持锁。
    let apiKey: string;
    let endpoint: string;
    try {
      apiKey = await providerKeyVault.getDecrypted(model.provider_key_id);
      const pkRow = await providerKeyVault.getRow(model.provider_key_id);
      if (!pkRow) throw new Error('provider key row missing');
      endpoint = pkRow.endpoint ?? defaultEndpoint(provider);
    } catch {
      return new Response(
        JSON.stringify({ error: 'provider_key_unavailable' }),
        { status: 502 }
      );
    }

    const req: UpstreamRequest = {
      endpoint: provider === 'openai' ? `${endpoint.replace(/\/$/, '')}/chat/completions` : endpoint,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      // The wire is always OpenAI chat-completions shape, so the admin-configured
      // sampling params (temperature / top_p / max_output_tokens→max_tokens) are
      // merged in here, admin-wins, before the request is forwarded. Capability
      // flags and context_window are catalog metadata, not per-request params.
      body: applyModelParams(input.body, {
        temperature: model.temperature,
        top_p: model.top_p,
        max_output_tokens: model.max_output_tokens,
      }),
    };

    const start = Date.now();
    let upstream;
    try {
      upstream = await callOpenAI(req);
    } catch {
      await tokenUsage.write({
        orgId: claims.orgId,
        userId: claims.sub,
        modelId: input.model_id,
        provider,
        tokenIn: 0,
        tokenOut: 0,
        resultCode: 502,
        durationMs: Date.now() - start,
      });
      return new Response(JSON.stringify({ error: 'upstream_failed' }), { status: 502 });
    }

    if (upstream.usage) {
      await tokenUsage.write({
        orgId: claims.orgId,
        userId: claims.sub,
        modelId: input.model_id,
        provider,
        tokenIn: upstream.usage.tokenIn,
        tokenOut: upstream.usage.tokenOut,
        resultCode: upstream.status,
        durationMs: Date.now() - start,
      });
      if (model.quota_per_user_per_day !== null) {
        const windowDate = await timezone.quotaWindowDate(claims.sub, new Date());
        const total = await tokenUsage.usageInWindow(claims.sub, input.model_id, windowDate);
        const ratio = total / model.quota_per_user_per_day;
        if (ratio >= 0.9) {
          await auditStore.write({
            orgId: claims.orgId,
            userId: claims.sub,
            action: AuditAction.QuotaWarning,
            targetType: 'model',
            targetId: input.model_id,
            payload: { used: total, quota: model.quota_per_user_per_day, threshold: 0.9 },
          });
        }
      }
      await auditStore.write({
        orgId: claims.orgId,
        userId: claims.sub,
        action: AuditAction.ProviderCall,
        targetType: 'model',
        targetId: input.model_id,
        payload: {
          provider,
          token_in: upstream.usage.tokenIn,
          token_out: upstream.usage.tokenOut,
          duration_ms: Date.now() - start,
        },
      });
    }

    if (idemKey) idempotency.record(idemKey, upstream.status);
    // Streamed upstream responses (e.g. the OpenClaw gateway sends `stream:
    // true`) carry their payload in `upstream.stream`; `upstream.bodyText` is
    // empty by construction for those. Returning bodyText would hand the
    // client a 200 with a 0-byte body — the gateway then parses an empty
    // completion and reports "empty response". Forward the stream verbatim
    // with the SSE content type so the client receives the real events.
    if (upstream.stream) {
      return new Response(upstream.stream, {
        status: upstream.status,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(upstream.bodyText, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  },
};

function defaultEndpoint(provider: ProviderName): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
  }
}

interface ReserveResult {
  ok: boolean;
  used: number;
}

async function reserveQuota(input: {
  orgId: string;
  userId: string;
  modelId: string;
  windowDate: string;
  quota: number;
}): Promise<ReserveResult> {
  // Ruling F1 (corrected): serialise the read-then-reserve per (user, model,
  // window) so two concurrent requests can't both read used=50/100 and both
  // forward upstream, overrunning the per-day quota.
  //
  // The original implementation used `SELECT ... SUM(...) ... FOR UPDATE`,
  // which PostgreSQL REJECTS — `FOR UPDATE` is not allowed on aggregate
  // queries (error 0A000 feature_not_supported). That made every quota-gated
  // proxied request 500 on a real database. It went unnoticed in tests because
  // pglite's tx has no `_isPg` flag, so the FOR UPDATE branch was skipped.
  //
  // Fix: take a transaction-scoped advisory lock keyed on the quota resource.
  // `pg_advisory_xact_lock` is released automatically at COMMIT/ROLLBACK, so
  // the second concurrent tx blocks until the first commits, then re-reads the
  // freshly-written usage and 429s. On pglite (single connection) the event
  // loop already serialises, so the lock is a harmless no-op there.
  return pool.transaction(async (tx) => {
    const isPg = (tx as unknown as { _isPg?: boolean })._isPg === true;
    if (isPg) {
      // 64-bit lock key from two 32-bit hashes keeps collision risk negligible
      // at (user × model) × (org × window) cardinality.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [`${input.userId}:${input.modelId}`, `${input.orgId}:${input.windowDate}`]
      );
    }
    const r = await tx.query<{ used: string }>(
      `SELECT COALESCE(SUM(total_tokens),0) AS used FROM token_usage
       WHERE user_id=$1 AND model_id=$2 AND quota_window_date=$3`,
      [input.userId, input.modelId, input.windowDate]
    );
    const used = Number(r.rows[0].used);
    if (used >= input.quota) return { ok: false, used };
    return { ok: true, used };
  });
}