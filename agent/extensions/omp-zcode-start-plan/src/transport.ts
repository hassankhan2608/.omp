import { randomUUID } from "node:crypto";
import { release } from "node:os";
import {
  Effort,
  type AssistantMessageEventStream,
  type Context,
  type FetchImpl,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import {
  streamAnthropic,
  type AnthropicEffort,
  type AnthropicOptions,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { solveCaptcha, type CaptchaSolveConfig } from "./captcha/client";
import {
  ZCODE_BASE_URL,
  ZCODE_CLIENT_VERSION,
  ZCODE_CONFIG_URL,
  ZCODE_MESSAGES_URL,
} from "./constants";
import { diagnostics, type ZcodeDiagnostics } from "./diagnostics";
import { isRecord } from "./type-guards";

const CONFIG_TTL_MS = 60_000;
const configCache = new WeakMap<FetchImpl, { expiresAt: number; value: Promise<CaptchaSolveConfig> }>();

interface ZcodeThinkingOptions {
  requestModelId: "GLM-5.3" | "GLM-5-Turbo";
  thinkingEnabled: boolean;
  thinkingBudgetTokens?: number;
  effort?: AnthropicEffort;
}

const GLM_53_BUDGETS: Partial<Record<Effort, number>> = {
  [Effort.Low]: 8_000,
  [Effort.High]: 16_000,
  [Effort.Max]: 32_000,
};


export function resolveZcodeThinking(
  modelId: string,
  reasoning: Effort | undefined,
  disabled: boolean,
): ZcodeThinkingOptions {
  const turbo = modelId.toLowerCase() === "glm-5-turbo";
  const requestModelId = turbo ? "GLM-5-Turbo" : "GLM-5.3";
  if (disabled) return { requestModelId, thinkingEnabled: false };
  if (turbo) {
    return { requestModelId, thinkingEnabled: true, thinkingBudgetTokens: 1_024 };
  }
  const level = reasoning ?? Effort.Max;
  const budget = GLM_53_BUDGETS[level] ?? GLM_53_BUDGETS[Effort.Max]!;
  const effort = level === Effort.Low ? "low" : level === Effort.High ? "high" : "max";
  return { requestModelId, thinkingEnabled: true, thinkingBudgetTokens: budget, effort };
}

export function normalizeZcodePayload(payload: unknown, requestModelId: string): unknown {
  if (!isRecord(payload)) return payload;
  const normalized: Record<string, unknown> = { ...payload, model: requestModelId };
  delete normalized.context_management;

  if (isRecord(normalized.thinking)) {
    const thinking: Record<string, unknown> = { ...normalized.thinking };
    delete thinking.display;
    if (thinking.type === "disabled") delete normalized.thinking;
    else normalized.thinking = thinking;
  }
  return normalized;
}

export function zcodeIdentityHeaders(): Record<string, string> {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    "User-Agent": `ZCode/${ZCODE_CLIENT_VERSION}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": ZCODE_CLIENT_VERSION,
    "X-ZCode-Release-Channel": "production",
    "X-ZCode-Client-Language": locale,
    "X-ZCode-Client-Timezone": timeZone,
    "X-Platform": "linux-x64",
    "X-Os-Category": "linux",
    "X-Os-Version": release(),
    "X-ZCode-Agent": "glm",
  };
}

function requestIdentityHeaders(): Record<string, string> {
  return {
    "X-Request-Id": randomUUID(),
    "X-Trace-Id": randomUUID(),
    "X-Query-Id": randomUUID(),
    "X-Session-Id": randomUUID(),
  };
}

function parseCaptchaConfig(payload: unknown): CaptchaSolveConfig {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.configs)) {
    throw new Error("ZCode client config omitted CAPTCHA settings");
  }
  const captcha = payload.data.configs.captcha;
  if (!isRecord(captcha)) throw new Error("ZCode client config omitted CAPTCHA settings");
  if (typeof captcha.sceneId !== "string" || typeof captcha.region !== "string" || typeof captcha.prefix !== "string") {
    throw new Error("ZCode client config returned malformed CAPTCHA settings");
  }
  return { sceneId: captcha.sceneId, region: captcha.region, prefix: captcha.prefix };
}

async function loadCaptchaConfig(baseFetch: FetchImpl): Promise<CaptchaSolveConfig> {
  const now = Date.now();
  const cached = configCache.get(baseFetch);
  if (cached && cached.expiresAt > now) return cached.value;

  const url = new URL(ZCODE_CONFIG_URL);
  url.searchParams.set("app_version", ZCODE_CLIENT_VERSION);
  url.searchParams.set("platform", "linux-x64");
  const value = baseFetch(url, { headers: zcodeIdentityHeaders() }).then(async (response) => {
    if (!response.ok) throw new Error(`ZCode client config failed (${response.status})`);
    return parseCaptchaConfig(await response.json());
  });
  configCache.set(baseFetch, { expiresAt: now + CONFIG_TTL_MS, value });
  try {
    return await value;
  } catch (error) {
    configCache.delete(baseFetch);
    throw error;
  }
}

export function createZcodeFetch(
  baseFetch: FetchImpl,
  requestDiagnostics: ZcodeDiagnostics = diagnostics,
  solve: (config: CaptchaSolveConfig, appVersion: string) => Promise<string> = solveCaptcha,
): FetchImpl {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ZCODE_MESSAGES_URL && !url.endsWith("/v1/messages")) return baseFetch(input, init);

    const startedAt = performance.now();
    const config = await loadCaptchaConfig(baseFetch);
    const verifyParam = await solve(config, ZCODE_CLIENT_VERSION);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete("x-api-key");
    headers.delete("anthropic-beta");
    headers.delete("x-device-mid");
    for (const [key, value] of Object.entries(zcodeIdentityHeaders())) headers.set(key, value);
    for (const [key, value] of Object.entries(requestIdentityHeaders())) headers.set(key, value);
    headers.set("X-Aliyun-Captcha-Verify-Param", verifyParam);
    headers.set("X-Aliyun-Captcha-Verify-Region", config.region);

    try {
      const response = await baseFetch(input, { ...init, headers });
      const durationMs = performance.now() - startedAt;
      requestDiagnostics.recordRequest({
        endpoint: url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers,
        durationMs,
        status: response.status,
        requestId: response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined,
      });
      if (globalThis.process.env.ZCODE_START_PLAN_DEBUG === "1") {
        console.error(`[zcode-start-plan] ${response.status} ${Math.round(durationMs)}ms headers=${[...headers.keys()].join(",")}`);
      }
      return response;
    } catch (error) {
      requestDiagnostics.recordRequest({
        endpoint: url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  };
}

function mapToolChoice(choice: SimpleStreamOptions["toolChoice"]): AnthropicOptions["toolChoice"] {
  if (choice === undefined || choice === "auto" || choice === "any" || choice === "none") return choice;
  if (choice === "required") return "any";
  if (typeof choice !== "object") return "auto";
  if ("name" in choice && typeof choice.name === "string") return { type: "tool", name: choice.name };
  if ("function" in choice && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { type: "tool", name: choice.function.name };
  }
  return "auto";
}

export function streamZcodeStartPlan(
  model: Model<string>,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  if (typeof options.apiKey !== "string" || !options.apiKey) {
    throw new Error("ZCode Start Plan requires an authenticated account");
  }

  const thinking = resolveZcodeThinking(
    model.id,
    options.reasoning,
    Boolean(options.disableReasoning || options.forceReasoningOff),
  );
  const anthropicModelShape = {
    ...model,
    api: "anthropic-messages" as const,
    baseUrl: ZCODE_BASE_URL,
  };
  // Extension models are runtime-normalized before dispatch; the public generic does not retain that fact.
  const anthropicModel = anthropicModelShape as unknown as Model<"anthropic-messages">;
  const userPayloadHook = options.onPayload;
  const anthropicOptions: AnthropicOptions = {
    ...options,
    toolChoice: mapToolChoice(options.toolChoice),
    apiKey: options.apiKey,
    isOAuth: false,
    requestModelId: thinking.requestModelId,
    thinkingEnabled: thinking.thinkingEnabled,
    thinkingBudgetTokens: thinking.thinkingBudgetTokens,
    effort: thinking.effort,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${options.apiKey}`,
    },
    fetch: createZcodeFetch(options.fetch ?? fetch),
    onPayload: async (payload) => {
      const normalized = normalizeZcodePayload(payload, thinking.requestModelId);
      return (await userPayloadHook?.(normalized, model)) ?? normalized;
    },
  };
  return streamAnthropic(anthropicModel, context, anthropicOptions);
}
