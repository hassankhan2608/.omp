import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import { ZcodeDiagnostics } from "../src/diagnostics";
import {
  createZcodeFetch,
  normalizeZcodePayload,
  resolveZcodeThinking,
} from "../src/transport";

const captchaConfig = {
  code: 0,
  data: { configs: { captcha: { sceneId: "scene", region: "sgp", prefix: "prefix" } } },
};

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
    max_tokens: 128_000,
    thinking: { type: "enabled", budget_tokens: 32_000, display: "summarized" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "max" },
    stream: true,
  }, "GLM-5.3")).toEqual({
    model: "GLM-5.3",
    max_tokens: 128_000,
    thinking: { type: "enabled", budget_tokens: 32_000 },
    output_config: { effort: "max" },
    stream: true,
  });
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
  };
  await wrapped("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", { method: "POST", headers });
  await wrapped("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", { method: "POST", headers });

  expect(captured.map((value) => value.get("x-aliyun-captcha-verify-param"))).toEqual(["captcha-1", "captcha-2"]);
  expect(captured[0]?.get("x-aliyun-captcha-verify-region")).toBe("sgp");
  expect(captured[0]?.get("user-agent")).toBe("ZCode/3.8.1");
  expect(captured[0]?.get("x-zcode-agent")).toBe("glm");
  expect(captured[0]?.has("x-api-key")).toBe(false);
  expect(captured[0]?.has("anthropic-beta")).toBe(false);
  expect(captured[0]?.has("x-device-mid")).toBe(false);
  expect(configFetches).toBe(1);
});
