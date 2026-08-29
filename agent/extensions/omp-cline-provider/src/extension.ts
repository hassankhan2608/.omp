import type {
  ExtensionAPI,
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent";
import { buildClineRequestHeaders } from "./headers.js";
import { createClineOAuth } from "./oauth.js";
import {
  loadFreeClineModels,
  STARTUP_FREE_MODELS,
  type ClineProviderModel,
} from "./models.js";


export const CLINE_PROVIDER_ID = "cline";
export const CLINE_API_BASE = "https://api.cline.bot/api/v1";
export interface ExtensionDependencies {
  /** Synchronous startup catalog; must not perform network I/O. */
  loadModels: () => ClineProviderModel[];
  /** Live catalog refresh, called through OMP's model-cache path. */
  discoverModels: () => Promise<ClineProviderModel[]>;
  createOAuth: () => Promise<NonNullable<ProviderConfig["oauth"]>>;
  /** May be synchronous; async test/consumer implementations are also valid. */
  buildHeaders: () => MaybePromise<Record<string, string>>;
}

type MaybePromise<T> = T | Promise<T>;

const defaultDependencies: ExtensionDependencies = {
  loadModels: () => STARTUP_FREE_MODELS,
  discoverModels: loadFreeClineModels,
  createOAuth: createClineOAuth,
  buildHeaders: () => buildClineRequestHeaders(),
};

export function createExtension(
  deps: ExtensionDependencies = defaultDependencies,
) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const models = deps.loadModels();
    if (models.length === 0) {
      throw new Error("Cline free model catalog is empty");
    }

    const [oauth, headers] = await Promise.all([
      deps.createOAuth(),
      deps.buildHeaders(),
    ]);

    pi.registerProvider(CLINE_PROVIDER_ID, {
      baseUrl: CLINE_API_BASE,
      api: "openai-completions",
      authHeader: true,
      headers,
      models,
      fetchDynamicModels: async () => deps.discoverModels(),
      oauth,
    });
  };
}

export default createExtension();
