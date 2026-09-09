import {
  enterpriseClient,
  type CatalogModel,
  type CatalogProvider,
} from '../auth/enterpriseClient';

let providers: CatalogProvider[] = [];
let models: CatalogModel[] = [];

function indexKey(provider: string, modelId: string): string {
  return `${provider} ${modelId}`;
}

const modelIndex = new Map<string, CatalogModel>();

export const catalogResolver = {
  async refresh(): Promise<void> {
    try {
      const body = await enterpriseClient.getCatalog();
      providers = body.providers;
      models = body.models;
      modelIndex.clear();
      for (const m of models) modelIndex.set(indexKey(m.provider, m.model), m);
    } catch {
      providers = [];
      models = [];
      modelIndex.clear();
    }
  },
  listProviders(): CatalogProvider[] { return providers; },
  listModels(): CatalogModel[] { return models; },
  lookupModel(provider: string, modelId: string): CatalogModel | undefined {
    return modelIndex.get(indexKey(provider, modelId));
  },
  resolveCapability(provider: string, modelId: string) {
    const m = modelIndex.get(indexKey(provider, modelId));
    return {
      supportsImage: m?.supportsImage ?? false,
      supportsVideo: m?.supportsVideo ?? false,
      supportsThinking: m?.supportsThinking ?? false,
      contextWindow: m?.contextWindow ?? null,
      maxTokens: m?.maxTokens ?? null,
    };
  },
  _reset(): void { providers = []; models = []; modelIndex.clear(); },
};
