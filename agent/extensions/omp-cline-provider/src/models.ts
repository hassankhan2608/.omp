import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/**
 * Only the fields this extension consumes from Cline's model catalog. Keeping
 * this local type avoids a static `@cline/llms` reference: OMP's extension
 * scanner follows package specifiers, including type-only imports, before the
 * factory runs.
 */
export interface ClineModelInfo {
  id?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: string[];
  modalities?: { input: string[]; output?: string[] };
  systemRole?: string;
}

interface ClineLlmModule {
  fetchLiveProviderModels(
    url: string,
    fetchImpl?: FetchLike,
  ): Promise<{ cline?: Record<string, ClineModelInfo> }>;
  getModelsForProvider(
    provider: string,
    options: { filter: string },
  ): Record<string, ClineModelInfo>;
}

/**
 * Load Cline's large model package only when model discovery actually runs.
 * `headers.ts` uses the same package-name indirection for the same reason.
 */
async function loadClineLlmModule(): Promise<ClineLlmModule> {
  const packageName = "@cline/llms";
  return import(packageName) as Promise<ClineLlmModule>;
}


export const RECOMMENDED_MODELS_URL =
  "https://api.cline.bot/api/v1/ai/cline/recommended-models";
export const MODELS_DEV_URL = "https://models.dev/api.json";

export const PREFERRED_FREE_MODEL = "z-ai/glm-5.3-flash";

export type ClineProviderModel = ProviderModelConfig & {
  supportsTools?: boolean;
};

/**
 * Immediate startup fallback. It is the same preferred free model selected by
 * the live Cline recommendation endpoint; remote discovery later replaces it
 * with the complete current free catalog.
 */
export const STARTUP_FREE_MODELS: ClineProviderModel[] = [
  {
    id: PREFERRED_FREE_MODEL,
    name: "GLM 5.3 Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    supportsTools: true,
    compat: { supportsDeveloperRole: false },
  },
];
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;


export interface ModelDependencies {
  fetchImpl: FetchLike;
  loadCatalog: () => Promise<Record<string, ClineModelInfo>>;
}

async function loadLiveClineCatalog(): Promise<Record<string, ClineModelInfo>> {
  const { fetchLiveProviderModels, getModelsForProvider } = await loadClineLlmModule();
  try {
    const live = await fetchLiveProviderModels(MODELS_DEV_URL);
    const cline = live.cline;
    if (cline && Object.keys(cline).length > 0) return cline;
  } catch {
    // Fall through to the bundled catalog below.
  }
  return getModelsForProvider("cline", { filter: "chat" });
}

const defaultDependencies: ModelDependencies = {
  fetchImpl: fetch,
  loadCatalog: loadLiveClineCatalog,
};


export async function fetchRecommendedFreeIds(
  fetchImpl: FetchLike = fetch,
): Promise<ReadonlySet<string>> {
  const response = await fetchImpl(RECOMMENDED_MODELS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `Cline recommended model request failed with HTTP ${response.status}`,
    );
  }

  const payload: unknown = await response.json();
  const free =
    typeof payload === "object" && payload !== null && "free" in payload
      ? payload.free
      : undefined;
  if (!Array.isArray(free) || free.length === 0) {
    throw new Error("Cline recommended model response has no free models");
  }
  const ids: string[] = [];
  for (const descriptor of free) {
    const id =
      typeof descriptor === "object" &&
      descriptor !== null &&
      "id" in descriptor &&
      typeof descriptor.id === "string"
        ? descriptor.id.trim()
        : "";
    if (!id) {
      throw new Error("Cline recommended model response has invalid free model ids");
    }
    ids.push(id);
  }

  return new Set(ids);
}

function toProviderModel(id: string, info: ClineModelInfo): ClineProviderModel | undefined {
  const { contextWindow, maxTokens } = info;
  if (
    typeof contextWindow !== "number" ||
    !Number.isInteger(contextWindow) ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0
  ) {
    return undefined;
  }

  const capabilities = new Set(info.capabilities ?? []);
  const input: ("text" | "image")[] = ["text"];
  if (
    info.modalities?.input.includes("image") ||
    capabilities.has("images")
  ) {
    input.push("image");
  }

  return {
    id,
    name: info.name ?? id,
    reasoning: capabilities.has("reasoning") || capabilities.has("reasoning-effort"),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    supportsTools: capabilities.has("tools"),
    compat: {
      supportsDeveloperRole: info.systemRole === "developer",
    },
  };
}

export async function loadFreeClineModels(
  deps: ModelDependencies = defaultDependencies,
): Promise<ClineProviderModel[]> {
  const [freeIds, catalog] = await Promise.all([
    fetchRecommendedFreeIds(deps.fetchImpl),
    deps.loadCatalog(),
  ]);


  const models: ClineProviderModel[] = [];
  for (const id of freeIds) {
    const info = catalog[id];
    if (!info) continue;
    const model = toProviderModel(id, info);
    if (model) models.push(model);
  }

  models.sort((left, right) => {
    if (left.id === PREFERRED_FREE_MODEL) return -1;
    if (right.id === PREFERRED_FREE_MODEL) return 1;
    return left.id.localeCompare(right.id);
  });

  if (models.length === 0) {
    throw new Error("Cline free model catalog is empty");
  }
  return models;
}
