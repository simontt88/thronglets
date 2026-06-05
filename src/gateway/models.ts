/**
 * Model tier registry.
 *
 * Models are grouped into three tiers — small / mid / large — so dispatch can
 * choose a tier per task instead of pinning a throng to one model for life.
 * The gateway rewrites the request's `model` field to the resolved model for
 * the agent's active tier (see directives.ts + proxy.ts).
 */

export type ModelTier = "small" | "mid" | "large";
export type ApiProvider = "openai" | "anthropic";

export const MODEL_TIERS: ModelTier[] = ["small", "mid", "large"];

/**
 * Default tier → model mapping per provider.
 * Override via config (fleet.models) — see resolveModelRegistry().
 */
export const DEFAULT_TIER_MODELS: Record<ApiProvider, Record<ModelTier, string>> = {
  openai: {
    small: "gpt-4o-mini",
    mid: "gpt-4o",
    large: "gpt-4.1",
  },
  anthropic: {
    small: "claude-haiku-4-5-20251001",
    mid: "claude-sonnet-4-6",
    large: "claude-opus-4-8",
  },
};

export interface ModelRegistry {
  tierModels: Record<ApiProvider, Record<ModelTier, string>>;
}

let _registry: ModelRegistry = { tierModels: structuredClone(DEFAULT_TIER_MODELS) };

/**
 * Replace the active registry (e.g. from config). Partial overrides merge
 * onto the defaults so a config only needs to specify what it changes.
 */
export function setModelRegistry(overrides?: Partial<Record<ApiProvider, Partial<Record<ModelTier, string>>>>): ModelRegistry {
  const merged = structuredClone(DEFAULT_TIER_MODELS);
  if (overrides) {
    for (const provider of Object.keys(overrides) as ApiProvider[]) {
      const tiers = overrides[provider];
      if (!tiers) continue;
      for (const tier of Object.keys(tiers) as ModelTier[]) {
        const model = tiers[tier];
        if (model) merged[provider][tier] = model;
      }
    }
  }
  _registry = { tierModels: merged };
  return _registry;
}

export function getModelRegistry(): ModelRegistry {
  return _registry;
}

/** Resolve a tier to a concrete model id for the given provider. */
export function resolveModel(provider: ApiProvider, tier: ModelTier): string {
  return _registry.tierModels[provider][tier];
}

/** Reverse lookup: which tier does a concrete model id belong to (best effort). */
export function classifyModel(provider: ApiProvider, modelId: string): ModelTier | undefined {
  const tiers = _registry.tierModels[provider];
  for (const tier of MODEL_TIERS) {
    if (tiers[tier] === modelId) return tier;
  }
  // Heuristic fallback by family name
  const id = modelId.toLowerCase();
  if (id.includes("mini") || id.includes("haiku")) return "small";
  if (id.includes("sonnet") || id.includes("4o")) return "mid";
  if (id.includes("opus") || id.includes("4.1") || id.includes("o1")) return "large";
  return undefined;
}

export function isValidTier(value: string): value is ModelTier {
  return MODEL_TIERS.includes(value as ModelTier);
}
