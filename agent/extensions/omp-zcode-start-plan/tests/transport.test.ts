import { Effort, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { isUsageLimit } from "@oh-my-pi/pi-ai/error";
import { expect, test } from "bun:test";
import { ZcodeDiagnostics } from "../src/diagnostics";
import {
  buildZcodeAnthropicModel,
  createZcodeFetch,
  normalizeZcodePayload,
  resolveZcodeThinking,
} from "../src/transport";
import { ZCODE_MODELS } from "../src/models";
import { checkZcodeUsageReserve } from "../src/reserve";

const captchaConfig = {
  code: 0,
  data: { configs: { captcha: { sceneId: "scene", region: "sgp", prefix: "prefix" } } },
};

test("materializes Anthropic compatibility before native streaming", () => {
  const model = {
    ...ZCODE_MODELS[0]!,
    provider: "zcode-start-plan",
    api: "zcode-start-plan-anthropic",
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
  } as unknown as Model<string>;

  expect(buildZcodeAnthropicModel(model).compat).toMatchObject({
    officialEndpoint: false,
    supportsEagerToolInputStreaming: false,
  });
});

test("maps OMP thinking levels to the exact ZCode budgets", () => {
  expect(resolveZcodeThinking("glm-5.3", Effort.Low, false)).toEqual({
    requestModelId: "GLM-5.3",
    thinkingEnabled: true,
    thinkingBudgetTokens: 8_000,
    effort: "low",
  });
  expect(resolveZcodeThinking("glm-5.3", Effort.Max, false).thinkingBudgetTokens).toBe(32_000);
  expect(resolveZcodeThinking("glm-5-turbo", undefined, false)).toEqual({
    requestModelId: "GLM-5-Turbo",
    thinkingEnabled: true,
    thinkingBudgetTokens: 1_024,
  });
  expect(resolveZcodeThinking("glm-5-turbo", Effort.Low, true)).toEqual({
    requestModelId: "GLM-5-Turbo",
    thinkingEnabled: false,
  });
});


test("normalizes the Anthropic payload to ZCode desktop parity", () => {
  expect(normalizeZcodePayload({
    model: "glm-5.3",
    metadata: { trace: "keep" },
    system: [{ type: "text", text: "User system" }],
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128_000,
    thinking: { type: "enabled", budget_tokens: 32_000, display: "summarized" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "max" },
    stream: true,
  }, "GLM-5.3")).toEqual({
    model: "GLM-5.3",
    metadata: { trace: "keep" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    system: [
      { type: "text", text: "You are ZCode, an interactive coding agent", cache_control: { type: "ephemeral" } },
      { type: "text", text: expect.stringContaining("# Harness"), cache_control: { type: "ephemeral" } },
      { type: "text", text: expect.stringContaining("# Environment"), cache_control: { type: "ephemeral" } },
      { type: "text", text: "- You are powered by the model named GLM-5.3.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "User system" },
    ],
    max_tokens: 128_000,
    thinking: { type: "enabled", budget_tokens: 32_000 },
    output_config: { effort: "max" },
    stream: true,
  });
});

test("checks the selected account reserve before minting CAPTCHA or sending the model request", async () => {
  let solveCalls = 0;
  let messageCalls = 0;
  const baseFetch: FetchImpl = async (input) => {
    if (String(input).includes("/billing/balance")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          balances: [{
            entitlement_id: "trial",
            show_name: "GLM-5.3",
            total_units: 100_000,
            used_units: 98_000,
            remaining_units: 2_000,
            expires_at: 2_000,
          }],
        },
      }), { status: 200 });
    }
    messageCalls += 1;
    return new Response("unexpected", { status: 200 });
  };
  const wrapped = createZcodeFetch(
    baseFetch,
    new ZcodeDiagnostics(),
    async () => {
      solveCalls += 1;
      return "captcha";
    },
    checkZcodeUsageReserve,
    "glm-5.3",
  );

  let caught: unknown;
  try {
    await wrapped("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer plan-jwt" },
    });
  } catch (error) {
    caught = error;
  }

  expect(isUsageLimit(caught)).toBe(true);
  expect(solveCalls).toBe(0);
  expect(messageCalls).toBe(0);
});

test("adds fresh verification and exact ZCode identity headers per model request", async () => {
  const captured: Headers[] = [];
  let configFetches = 0;
  const baseFetch: FetchImpl = async (input, init) => {
    const url = String(input);
    if (url.includes("/client/configs")) {
      configFetches += 1;
      return new Response(JSON.stringify(captchaConfig), { status: 200 });
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    captured.push(headers);
    return new Response("ok", { status: 200, headers: { "request-id": "req-1" } });
  };
  const tokens = ["captcha-1", "captcha-2"];
  const wrapped = createZcodeFetch(baseFetch, new ZcodeDiagnostics(), async () => tokens.shift()!);

  const headers = {
    authorization: "Bearer plan-jwt",
    "x-api-key": "plan-jwt",
    "anthropic-beta": "effort-2025-11-24",
    "x-device-mid": "must-not-survive",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
  };
  await wrapped("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", { method: "POST", headers });
  await wrapped("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", { method: "POST", headers });

  expect(captured.map((value) => value.get("x-aliyun-captcha-verify-param"))).toEqual(["captcha-1", "captcha-2"]);
  expect(captured[0]?.get("x-aliyun-captcha-verify-region")).toBe("sgp");
  expect(captured[0]?.get("x-release-channel")).toBe("production");
  expect(captured[0]?.get("x-zcode-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(captured[0]?.has("x-trace-id")).toBe(false);
  expect(captured[0]?.get("x-query-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(captured[0]?.get("x-session-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(captured[0]?.has("anthropic-dangerous-direct-browser-access")).toBe(false);
  expect(captured[0]?.has("x-app")).toBe(false);
  expect(captured[0]?.get("user-agent")).toBe("ZCode/3.8.1");
  expect(captured[0]?.get("x-zcode-agent")).toBe("glm");
  expect(captured[0]?.has("x-api-key")).toBe(false);
  expect(captured[0]?.has("anthropic-beta")).toBe(false);
  expect(captured[0]?.has("x-device-mid")).toBe(false);
  expect(configFetches).toBe(1);
});
