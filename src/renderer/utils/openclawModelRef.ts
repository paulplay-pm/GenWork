import { OpenClawProviderId, ProviderName } from '@shared/providers/constants';

import type { Model } from '../store/slices/modelSlice';

// `name` is the openclaw-facing model display name (the upstream name for
// server models, e.g. "Qwen3.8-27B"); for non-server models it matches `id`.
type ModelRefInput = Pick<Model, 'id' | 'name' | 'providerKey' | 'openClawProviderId' | 'isServerModel'>;

function resolveModelOpenClawProviderId(model: ModelRefInput): string {
  if (model.isServerModel) {
    return OpenClawProviderId.GenworkServer;
  }
  return model.openClawProviderId || OpenClawProviderId.GenworkServer;
}

export function toOpenClawModelRef(model: ModelRefInput): string {
  // Server (enterprise) models are identified by their catalog row UUID so
  // two same-named models under different provider keys resolve to distinct
  // refs. The enterprise proxy resolves the UUID and rewrites the wire
  // `model` field to the upstream name; `name` stays the display label.
  // Legacy name-based refs (saved before the identity change) are tolerated
  // via the name fallback in resolveOpenClawModelRef.
  const modelId = model.id;
  return `${resolveModelOpenClawProviderId(model)}/${modelId}`;
}

export function matchesOpenClawModelRef(
  modelRef: string,
  model: ModelRefInput,
): boolean {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return false;
  if (normalizedRef.includes('/')) {
    return normalizedRef === toOpenClawModelRef(model);
  }
  return normalizedRef === model.id;
}

export function resolveOpenClawModelRef<T extends ModelRefInput>(
  modelRef: string,
  availableModels: T[],
): T | null {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return null;

  if (normalizedRef.includes('/')) {
    const exact = availableModels.find((model) => toOpenClawModelRef(model) === normalizedRef) ?? null;
    if (exact) return exact;

    // When the available list is empty the failure is by construction: the
    // boot sequence dispatches setAvailableModels([]) in App.tsx and the
    // server-model list only fills when the user opens ModelSelector, so any
    // render in the meantime will fail every enterprise ref. Log at debug
    // level to keep DevTools clean; the non-empty case stays at log level so
    // real ref-mismatches remain visible.
    if (availableModels.length === 0) {
      console.debug('[openclawModelRef] exact match skipped for', normalizedRef, '(availableModels empty)');
    } else {
      console.log('[openclawModelRef] exact match failed for', normalizedRef, 'available refs:', availableModels.map(m => toOpenClawModelRef(m)));
    }

    const slashIndex = normalizedRef.indexOf('/');
    const providerId = normalizedRef.slice(0, slashIndex);
    const modelId = normalizedRef.slice(slashIndex + 1);

    // OpenAI OAuth provider migration compatibility between older
    // `openai-codex/*` refs and the current `openai/*` refs.
    if (providerId === OpenClawProviderId.OpenAI || providerId === OpenClawProviderId.OpenAICodex) {
      const migratedProviderId = providerId === OpenClawProviderId.OpenAICodex
        ? OpenClawProviderId.OpenAI
        : OpenClawProviderId.OpenAICodex;
      const migratedMatch = availableModels.find((model) => (
        model.id === modelId
        && model.providerKey === ProviderName.OpenAI
        && resolveModelOpenClawProviderId(model) === migratedProviderId
      )) ?? null;
      if (migratedMatch) return migratedMatch;
    }

    // Generic provider fallback: match by model ID if unique
    const idMatches = availableModels.filter((model) => model.id === modelId);
    if (idMatches.length === 1) {
      console.log('[openclawModelRef] provider fallback: resolved', normalizedRef, 'to', toOpenClawModelRef(idMatches[0]));
      return idMatches[0];
    }
    // Legacy fallback for refs saved before server-model identity moved to the
    // catalog UUID: `genwork-server/<upstream name>`. When the name maps to a
    // single server model, resolve it; when several same-named rows exist the
    // ref is ambiguous — report it as such instead of guessing, so the user
    // re-picks and the stored ref is rewritten to the unambiguous UUID form.
    if (providerId === OpenClawProviderId.GenworkServer) {
      const nameMatches = availableModels.filter((model) => (
        model.isServerModel && model.name === modelId
      ));
      if (nameMatches.length === 1) {
        console.log('[openclawModelRef] legacy name fallback: resolved', normalizedRef, 'to', toOpenClawModelRef(nameMatches[0]));
        return nameMatches[0];
      }
      if (nameMatches.length > 1) {
        console.warn('[openclawModelRef] legacy name ref is ambiguous for', normalizedRef, 'among', nameMatches.map((m) => toOpenClawModelRef(m)));
      }
    }
    return null;
  }

  const matchingModels = availableModels.filter((model) => model.id === normalizedRef);
  return matchingModels.length === 1 ? matchingModels[0] : null;
}
