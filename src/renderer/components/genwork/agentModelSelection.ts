import { supportsGenWorkRequestOptionsV1 } from '@shared/providers/genworkRequestOptions';
import {
  getModelThinkingLevels,
  type ModelThinkingLevel,
} from '@shared/providers/modelThinking';
import { useMemo } from 'react';
import { useSelector } from 'react-redux';

import type { RootState } from '../../store';
import { type Model, selectAgentSelectedModel } from '../../store/slices/modelSlice';
import type { GenWorkAgentEngine } from '../../types/genwork';
import { resolveOpenClawModelRef } from '../../utils/openclawModelRef';

type ResolveAgentModelSelectionInput = {
  sessionModel?: string;
  agentModel: string;
  availableModels: Model[];
  fallbackModel: Model | null;
  engine: GenWorkAgentEngine;
};

type ResolveAgentModelSelectionResult = {
  selectedModel: Model | null;
  usesFallback: boolean;
  hasInvalidExplicitModel: boolean;
};

export function resolveModelThinkingLevel(
  model: Pick<Model, 'requestCapabilities' | 'thinkingConfig'> | null | undefined,
  persistedLevel: ModelThinkingLevel | '' | null | undefined,
): ModelThinkingLevel | undefined {
  const config = model?.thinkingConfig;
  if (!config || !supportsGenWorkRequestOptionsV1(model.requestCapabilities)) return undefined;
  if (persistedLevel && getModelThinkingLevels(config).includes(persistedLevel)) {
    return persistedLevel;
  }
  return config.defaultLevel;
}

/**
 * Determine which Model object the prompt input should use for capability
 * checks (e.g. supportsImage).
 *
 * On the **home page** (no sessionId) the selectors use the current agent's
 * resolved model. Callers persist user changes to the agent model before
 * passing that value back here, so image capability checks must honour it.
 *
 * Inside a **session** (has sessionId) the agent-level resolution
 * (session override → agent model → fallback) is authoritative.
 */
export function resolveEffectiveModel({
  sessionId,
  agentSelectedModel,
  globalSelectedModel,
}: {
  sessionId: string | undefined;
  agentSelectedModel: Model | null;
  globalSelectedModel: Model | null;
}): Model | null {
  return sessionId ? agentSelectedModel : globalSelectedModel;
}

export function resolveAgentModelSelection({
  sessionModel,
  agentModel,
  availableModels,
  fallbackModel,
}: ResolveAgentModelSelectionInput): ResolveAgentModelSelectionResult {
  const normalizedSessionModel = sessionModel?.trim() ?? '';
  if (normalizedSessionModel) {
    const explicitSessionModel = resolveOpenClawModelRef(normalizedSessionModel, availableModels) ?? null;
    if (explicitSessionModel) {
      return { selectedModel: explicitSessionModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: true };
  }

  const normalizedAgentModel = agentModel.trim();
  if (normalizedAgentModel) {
    const explicitModel = resolveOpenClawModelRef(normalizedAgentModel, availableModels) ?? null;
    if (explicitModel) {
      return { selectedModel: explicitModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: false };
  }

  return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: false };
}

/**
 * Hook: resolve the effective selected model for a given agent.
 *
 * Shared by CoworkView (header) and CoworkPromptInput (prompt area) to avoid
 * duplicating the per-agent model resolution logic.
 */
export function useAgentSelectedModel(agentId: string, agentModelRef: string): Model {
  const modelState = useSelector((state: RootState) => state.model);
  return useMemo(
    () => selectAgentSelectedModel(modelState, agentId, agentModelRef),
    [modelState, agentId, agentModelRef],
  );
}
