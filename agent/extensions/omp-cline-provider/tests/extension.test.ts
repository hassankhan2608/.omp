import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { createExtension } from "../src/extension.js";
import type { ClineProviderModel } from "../src/models.js";

const freeModel: ClineProviderModel = {
  id: "z-ai/glm-5.3-flash",
  name: "GLM 5.3 Flash",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
  supportsTools: true,
  compat: { supportsDeveloperRole: false },
};

const fakeHeaders = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
  "X-CLIENT-TYPE": "cline-cli",
  "User-Agent": "Cline/3.0.60",
};

function fakeOAuth(): NonNullable<ProviderConfig["oauth"]> {
  return {
    name: "Cline",
    login: async (): Promise<OAuthCredentials> => ({
      access: "access",
      refresh: "refresh",
      expires: 2_000_000_000_000,
      accountId: "acct-a",
    }),
    refreshToken: async (value) => value,
    getApiKey: () => "workos:access",
  };
}

describe("Cline extension registration", () => {
  test("registers exact transport, OAuth, headers, and startup fallback models", async () => {
    const registrations: Array<{ name: string; config: ProviderConfig }> = [];
    const oauth = fakeOAuth();
    const extension = createExtension({
      loadModels: () => [freeModel],
      discoverModels: async () => [freeModel],
      createOAuth: async () => oauth,
      buildHeaders: async () => fakeHeaders,
    });

    await extension({
      registerProvider: (name: string, config: ProviderConfig) =>
        registrations.push({ name, config }),
    } as never);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      name: "cline",
      config: {
        baseUrl: "https://api.cline.bot/api/v1",
        api: "openai-completions",
        authHeader: true,
        headers: fakeHeaders,
        models: [freeModel],
        oauth,
      },
    });
    expect(registrations[0]?.config).not.toHaveProperty("apiKey");
    expect(registrations[0]?.config.fetchDynamicModels).toBeFunction();
    expect(registrations[0]?.config.models?.[0]).toHaveProperty(
      "supportsTools",
      true,
    );
  });

  test("registers immediately without awaiting live model discovery", async () => {
    const events: string[] = [];
    let resolveDiscovery: ((models: ClineProviderModel[]) => void) | undefined;
    const discovery = new Promise<ClineProviderModel[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    const extension = createExtension({
      loadModels: () => {
        events.push("models");
        return [freeModel];
      },
      discoverModels: () => discovery,
      createOAuth: async () => {
        events.push("oauth");
        return fakeOAuth();
      },
      buildHeaders: async () => {
        events.push("headers");
        return fakeHeaders;
      },
    });

    const completed = extension({
      registerProvider: () => events.push("register"),
    } as never);
    await completed;

    expect(events[0]).toBe("models");
    expect(events).toContain("oauth");
    expect(events).toContain("headers");
    expect(events[events.length - 1]).toBe("register");
    resolveDiscovery!([freeModel]);
  });

  test("fails closed when the synchronous startup catalog is empty", async () => {
    let registered = false;
    const extension = createExtension({
      loadModels: () => [],
      discoverModels: async () => [freeModel],
      createOAuth: async () => fakeOAuth(),
      buildHeaders: async () => fakeHeaders,
    });
    await expect(
      extension({
        registerProvider: () => {
          registered = true;
        },
      } as never),
    ).rejects.toThrow(/catalog is empty/);
    expect(registered).toBe(false);
  });


});
