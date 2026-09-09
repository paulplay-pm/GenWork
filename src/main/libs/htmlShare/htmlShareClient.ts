import fs from 'fs';

import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
  HtmlShareDisabledSource,
  HtmlSharePublicRoute,
  HtmlShareSourceType,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '../../../shared/htmlShare/constants';
import {
  PublishingCountMode,
  PublishingIdentityType,
  type PublishingQuota,
  type PublishingQuotaErrorData,
  PublishingResourceKind,
} from '../../../shared/publishing/constants';

export interface CreateHtmlShareUploadInput {
  archivePath: string;
  sourceType: (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType];
  clientSourceKey?: string;
  sessionId?: string;
  artifactId?: string;
  title: string;
  entryFile: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
  sourceSha256: string;
}

export interface HtmlShareCreateResult {
  success: boolean;
  shareId?: string;
  url?: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatusValue;
  moderationStatus?: string;
  updatedAt?: string;
  contentUpdatedAt?: string;
  accessExpiresAt?: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledSource?: HtmlShareDisabledSource | null;
  restoredByUpdate?: boolean;
  error?: string;
  code?: number;
  quota?: PublishingQuotaErrorData;
}

export interface HtmlShareQuotaResult {
  success: boolean;
  data?: PublishingQuota;
  error?: string;
  code?: number;
}

export interface HtmlShareLookupResult {
  success: boolean;
  share?: HtmlShareCreateResult | null;
  error?: string;
  code?: number;
}

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

export function buildHtmlSharePublicUrl(publicBaseUrl: string, shareId: string): string {
  const normalizedBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');
  return `${normalizedBaseUrl}/${encodeURIComponent(shareId)}`;
}

export interface EnterpriseHtmlShareCreateInput {
  archivePath: string;
  sourceType: (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType];
  clientSourceKey: string;
  title: string;
  entryFile: string;
  sourceSha256: string;
  expiresAt?: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
}

interface EnterpriseHtmlShareMetadataResponse {
  shareId?: string;
  publicUrl?: string;
  expiresAt?: string | null;
  accessMode?: string;
}

async function createHtmlShareMetadata(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  payload: {
    title: string;
    sourceType: string;
    sourceSha256: string;
    clientSourceKey: string;
    expiresAt?: string;
    accessMode?: string;
  },
): Promise<{
  shareId: string;
  publicUrl: string;
  expiresAt?: string | null;
  accessMode?: string;
}> {
  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // enterprise_server returns a flat JSON body (no code/data envelope) and a
  // 400 with { error } when required fields are missing.
  const body = (await response.json().catch((): null => null)) as
    | (EnterpriseHtmlShareMetadataResponse & { error?: string })
    | null;
  if (!response.ok || !body?.shareId || !body.publicUrl) {
    const message = body?.error || `Share metadata create failed: ${response.status}`;
    throw new Error(message);
  }
  return {
    shareId: body.shareId,
    publicUrl: body.publicUrl,
    ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    ...(body.accessMode !== undefined ? { accessMode: body.accessMode } : {}),
  };
}

async function uploadHtmlShareArchive(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  archivePath: string,
): Promise<void> {
  const buffer = await fs.promises.readFile(archivePath);
  // enterprise_server reads the request as a raw binary body
  // (`Buffer.from(c.req.arrayBuffer())`), so send the zip bytes directly —
  // not a multipart field.
  const archiveBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/uploads/${encodeURIComponent(shareId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: archiveBuffer,
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch((): null => null)) as { error?: string } | null;
    throw new Error(body?.error || `Share upload failed: ${response.status}`);
  }
}

export async function createHtmlShareFromHtmlFile(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: EnterpriseHtmlShareCreateInput,
): Promise<HtmlShareCreateResult> {
  try {
    const metadata = await createHtmlShareMetadata(serverBaseUrl, fetchWithAuth, {
      title: input.title,
      sourceType: input.sourceType,
      sourceSha256: input.sourceSha256,
      clientSourceKey: input.clientSourceKey,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.accessMode ? { accessMode: input.accessMode } : {}),
    });
    await uploadHtmlShareArchive(serverBaseUrl, fetchWithAuth, metadata.shareId, input.archivePath);
    const accessMode =
      metadata.accessMode === HtmlShareAccessMode.Org
        ? HtmlShareAccessMode.Org
        : metadata.accessMode === HtmlShareAccessMode.Public
          ? HtmlShareAccessMode.Public
          : undefined;
    return {
      success: true,
      shareId: metadata.shareId,
      url: metadata.publicUrl,
      status: HtmlShareStatus.Live,
      ...(accessMode !== undefined ? { accessMode } : {}),
      ...(metadata.expiresAt !== undefined ? { accessExpiresAt: metadata.expiresAt } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create share',
    };
  }
}

export async function getHtmlShare(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
): Promise<HtmlShareLookupResult> {
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}`,
  );
  // enterprise_server returns a flat single-share body (no code/data envelope)
  // and a 404 with { error } when the share does not exist for the org.
  const body = (await response.json().catch((): null => null)) as
    | (Partial<HtmlShareCreateResult> & {
        shareId?: string;
        error?: string;
        expiresAt?: string | null;
      })
    | null;
  if (!response.ok) {
    return {
      success: false,
      error: body?.error || `Share lookup failed: ${response.status}`,
    };
  }
  const raw = body ?? {};
  if (typeof raw.shareId !== 'string' || !raw.shareId) {
    return { success: false, error: `Share lookup returned no share id: ${response.status}` };
  }
  const shareUrl = buildHtmlSharePublicUrl(
    `${serverBaseUrl}${HtmlSharePublicRoute.Root}`,
    raw.shareId,
  );
  const share: HtmlShareCreateResult = {
    success: true,
    shareId: raw.shareId,
    url: shareUrl,
    status: HtmlShareStatus.Live,
    ...(typeof raw.expiresAt === 'string' ? { accessExpiresAt: raw.expiresAt } : {}),
  };
  return { success: true, share };
}

export async function getHtmlShareQuota(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
): Promise<HtmlShareQuotaResult> {
  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares/quota`);
  // enterprise_server returns a flat { used, quota } body (no code/data
  // envelope) and a 4xx with { error } when the quota cannot be read.
  const body = (await response.json().catch((): null => null)) as
    | { used?: number; quota?: number; error?: string }
    | null;
  if (
    !response.ok
    || typeof body?.used !== 'number'
    || typeof body?.quota !== 'number'
  ) {
    return {
      success: false,
      error: body?.error || `Share quota request failed: ${response.status}`,
    };
  }
  const used = body.used;
  const limit = body.quota;
  return {
    success: true,
    data: {
      resourceKind: PublishingResourceKind.File,
      identityType: PublishingIdentityType.Enterprise,
      countMode: PublishingCountMode.Total,
      used,
      limit,
      canReleaseByClosing: false,
      allowed: used < limit,
      remaining: Math.max(0, limit - used),
    },
  };
}

// ---------------------------------------------------------------------------
// Compatibility shims for shareDeployment and other in-process callers.
// The legacy upload/update entry points intentionally return success:false;
// use createHtmlShareFromHtmlFile / getHtmlShareBySource / updateHtmlShareStatus
// / updateHtmlShareAccessMode against the enterprise server.
// ---------------------------------------------------------------------------

export async function uploadHtmlShare(
  _serverBaseUrl: string,
  _publicBaseUrl: string,
  _fetchWithAuth: FetchWithAuth,
  _input: CreateHtmlShareUploadInput,
): Promise<HtmlShareCreateResult> {
  return {
    success: false,
    error: 'html-share upload is handled by the enterprise server; use createHtmlShareFromHtmlFile',
  };
}

export async function updateHtmlShare(
  _serverBaseUrl: string,
  _publicBaseUrl: string,
  _fetchWithAuth: FetchWithAuth,
  _shareId: string,
  _input: CreateHtmlShareUploadInput,
): Promise<HtmlShareCreateResult> {
  return {
    success: false,
    error: 'html-share update is not supported by the enterprise server',
  };
}

export async function updateHtmlShareStatus(
  serverBaseUrl: string,
  _publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  status: HtmlShareConfigurableStatus,
): Promise<HtmlShareCreateResult> {
  try {
    const response = await fetchWithAuth(
      `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
    const body = (await response.json().catch((): null => null)) as
      | { code?: number; message?: string }
      | null;
    if (!response.ok || body?.code !== 0) {
      return {
        success: false,
        error: body?.message || `Share status update failed: ${response.status}`,
        ...(typeof body?.code === 'number' ? { code: body.code } : {}),
      };
    }
    return { success: true, status };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update share status',
    };
  }
}

export async function updateHtmlShareAccessMode(
  serverBaseUrl: string,
  _publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  accessMode: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode],
): Promise<HtmlShareCreateResult> {
  try {
    const response = await fetchWithAuth(
      `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}/access-mode`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessMode }),
      },
    );
    // enterprise_server returns a flat { accessMode } body (no code/envelope)
    // and a 404 with { error } when the share does not belong to the org.
    const body = (await response.json().catch((): null => null)) as
      | { accessMode?: string; error?: string }
      | null;
    if (!response.ok) {
      return {
        success: false,
        error: body?.error || `Share access-mode update failed: ${response.status}`,
      };
    }
    return { success: true, accessMode };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update share access mode',
    };
  }
}

interface HtmlShareRecord {
  share_id: string;
  org_id: string;
  user_id: string;
  source_type: string | null;
  client_source_key: string | null;
  access_mode: string;
  expires_at: string | null;
}

interface HtmlShareBySourceResponse {
  shares?: HtmlShareRecord[];
}

function buildHtmlShareBySourceResult(
  record: HtmlShareRecord,
  publicBaseUrl: string,
): HtmlShareCreateResult {
  const shareUrl = buildHtmlSharePublicUrl(publicBaseUrl, record.share_id);
  // The server's by-source lookup returns the raw `access_mode`
  // ('code' | 'public' | 'org'). Map it onto the shared enum so the UI can
  // distinguish an org-only share from a public one (previously 'org' was
  // collapsed into 'code').
  const accessMode: HtmlShareAccessModeValue =
    record.access_mode === HtmlShareAccessMode.Public
      ? HtmlShareAccessMode.Public
      : record.access_mode === HtmlShareAccessMode.Org
        ? HtmlShareAccessMode.Org
        : HtmlShareAccessMode.Code;
  return {
    success: true,
    shareId: record.share_id,
    url: shareUrl,
    accessMode,
    ...(record.expires_at ? { accessExpiresAt: record.expires_at } : {}),
  };
}

export async function getHtmlShareBySource(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  sourceType: (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType],
  clientSourceKey: string,
): Promise<HtmlShareLookupResult> {
  try {
    const params = new URLSearchParams({
      sourceType,
      clientSourceKey,
    });
    const response = await fetchWithAuth(
      `${serverBaseUrl}/api/html-shares?${params.toString()}`,
    );
    const body = (await response.json().catch((): null => null)) as
      | (HtmlShareBySourceResponse & { code?: number; message?: string; error?: string })
      | null;
    if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
      return {
        success: false,
        error: body?.error || body?.message || `Share by-source lookup failed: ${response.status}`,
        ...(typeof body?.code === 'number' ? { code: body.code } : {}),
      };
    }
    const first = Array.isArray(body?.shares) ? body.shares[0] : undefined;
    if (!first) {
      return { success: true, share: null };
    }
    return { success: true, share: buildHtmlShareBySourceResult(first, publicBaseUrl) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to look up share by source',
    };
  }
}

// Delete a share. enterprise_server only exposes DELETE (owner-scoped); there
// is no PATCH status/access-mode endpoint, so "stop sharing" maps to a delete.
export async function deleteHtmlShare(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetchWithAuth(
      `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}`,
      { method: 'DELETE' },
    );
    const body = (await response.json().catch((): null => null)) as
      | { deleted?: boolean; error?: string }
      | null;
    if (!response.ok) {
      return {
        success: false,
        error: body?.error || `Share delete failed: ${response.status}`,
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete share',
    };
  }
}
