import { describe, expect, test } from "bun:test";
import type {
  ProviderAuthHandler,
  ProviderAuthLoginInput,
  ProviderAuthRefreshInput,
  ProviderOAuthCredentials,
} from "@cline/core";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { createClineOAuth } from "../src/oauth.js";

function clineCredentials(accountId = "acct-a"): ProviderOAuthCredentials {
  return {
    access: "workos:access-a",
    refresh: "refresh-a",
    expires: 2_000_000_000_000,
    accountId,
    email: `${accountId}@example.test`,
  };
}

function fakeHandler(
  overrides: Partial<ProviderAuthHandler> = {},
): ProviderAuthHandler {
  return {
    providerId: "cline",
    storageProviderId: "cline",
    getApiKey: () => undefined,
    login: async () => clineCredentials(),
    refresh: async () => clineCredentials(),
    saveCredentials: () => ({}) as never,
    isConfigured: () => true,
    normalizeStoredAccessToken: (token) => token.replace(/^workos:/i, ""),
    ...overrides,
  };
}

function ompCredentials(accountId = "acct-a"): OAuthCredentials {
  return {
    access: "access-a",
    refresh: "refresh-a",
    expires: 2_000_000_000_000,
    accountId,
    email: `${accountId}@example.test`,
  };
}

describe("Cline login", () => {
  test("resolves and delegates to the exact cline auth handler", async () => {
    const resolvedIds: string[] = [];
    let loginInput: ProviderAuthLoginInput | undefined;
    const handler = fakeHandler({
      login: async (input) => {
        loginInput = input;
        input.callbacks.onAuth({
          url: "https://authkit.cline.bot/device?user_code=ABCD-EFGH",
          instructions: "Enter the code",
        });
        const prompt = await input.callbacks.onPrompt({
          message: "Account",
          defaultValue: "cline",
        });
        expect(prompt).toBe("cline");
        input.callbacks.onProgress?.("Waiting for authorization");
        return clineCredentials();
      },
    });
    const oauth = await createClineOAuth({
      resolveHandler: (providerId) => {
        resolvedIds.push(providerId);
        return handler;
      },
      formatApiKey: (_providerId, credentials) =>
        `workos:${credentials.access}`,
    })

    const authEvents: unknown[] = [];
    const progress: string[] = [];
    const result = await oauth.login({
      onAuth: (info) => authEvents.push(info),
      onPrompt: async (prompt) => prompt.placeholder ?? "",
      onProgress: (message) => progress.push(message),
    });

    expect(resolvedIds).toEqual(["cline"]);
    expect(authEvents).toEqual([
      {
        url: "https://authkit.cline.bot/device?user_code=ABCD-EFGH",
        instructions: "Enter the code",
      },
    ]);
    expect(progress).toEqual(["Waiting for authorization"]);
    expect(loginInput?.callbacks).not.toHaveProperty("onManualCodeInput");
    expect(loginInput?.callbacks).not.toHaveProperty("onServerListening");
    expect(loginInput?.callbacks).not.toHaveProperty("onServerClose");
    expect(result).toEqual({
      access: "access-a",
      refresh: "refresh-a",
      expires: 2_000_000_000_000,
      accountId: "acct-a",
      email: "acct-a@example.test",
    });
  });

  test("rejects an unavailable or mismatched auth handler", async () => {
    await expect(
      createClineOAuth({
        resolveHandler: () => undefined,
        formatApiKey: () => "unused",
      }),
    ).rejects.toThrow("Cline auth handler is unavailable");

    await expect(
      createClineOAuth({
        resolveHandler: () =>
          fakeHandler({ providerId: "other", storageProviderId: "other" }),
        formatApiKey: () => "unused",
      }),
    ).rejects.toThrow("Cline auth handler is unavailable");
  });

  test("requires stable account identity and complete credentials", async () => {
    const invalid: ProviderOAuthCredentials[] = [
      { ...clineCredentials(), accountId: undefined },
      { ...clineCredentials(), accountId: "  " },
      { ...clineCredentials(), access: "" },
      { ...clineCredentials(), refresh: "" },
      { ...clineCredentials(), expires: Number.NaN },
    ];

    for (const credentials of invalid) {
      const oauth = await createClineOAuth({
        resolveHandler: () =>
          fakeHandler({ login: async () => credentials }),
        formatApiKey: () => "unused",
      })
      await expect(
        oauth.login({ onAuth: () => {}, onPrompt: async () => "" }),
      ).rejects.toThrow("invalid credentials");
    }
  });

  test("preserves distinct account ids across independent logins", async () => {
    for (const accountId of ["acct-a", "acct-b"]) {
      const oauth = await createClineOAuth({
        resolveHandler: () =>
          fakeHandler({ login: async () => clineCredentials(accountId) }),
        formatApiKey: () => "unused",
      })
      const result = await oauth.login({
        onAuth: () => {},
        onPrompt: async () => "",
      });
      if (typeof result === "string") {
        throw new Error("Expected OAuth credentials");
      }
      expect(result.accountId).toBe(accountId);
    }
  });
});

describe("Cline refresh and request token", () => {
  test("passes Cline settings and preserves omitted identity metadata", async () => {
    let refreshInput: ProviderAuthRefreshInput | undefined;
    const handler = fakeHandler({
      refresh: async (input) => {
        refreshInput = input;
        return {
          access: "workos:access-b",
          refresh: "refresh-b",
          expires: 2_100_000_000_000,
        };
      },
    });
    const oauth = await createClineOAuth({
      resolveHandler: () => handler,
      formatApiKey: (_providerId, credentials) =>
        `workos:${credentials.access}`,
    })

    const result = await oauth.refreshToken?.(ompCredentials());

    expect(refreshInput).toMatchObject({
      settings: {
        provider: "cline",
        auth: {
          accessToken: "access-a",
          refreshToken: "refresh-a",
          expiresAt: 2_000_000_000_000,
          accountId: "acct-a",
        },
      },
      credentials: ompCredentials(),
    });
    expect(result).toEqual({
      access: "access-b",
      refresh: "refresh-b",
      expires: 2_100_000_000_000,
      accountId: "acct-a",
      email: "acct-a@example.test",
    });
  });

  test("rejects missing refresh output and changed account identity", async () => {
    for (const refreshed of [null, clineCredentials("acct-b")]) {
      const oauth = await createClineOAuth({
        resolveHandler: () =>
          fakeHandler({ refresh: async () => refreshed }),
        formatApiKey: () => "unused",
      })
      await expect(oauth.refreshToken?.(ompCredentials())).rejects.toThrow(
        refreshed === null
          ? "Cline refresh returned no credentials"
          : "Cline refresh changed account identity",
      );
    }
  });

  test("formats an outbound request token through Cline core", async () => {
    const calls: Array<{ providerId: string; access: string }> = [];
    const oauth = await createClineOAuth({
      resolveHandler: () => fakeHandler(),
      formatApiKey: (providerId, credentials) => {
        calls.push({ providerId, access: credentials.access });
        return `workos:${credentials.access.replace(/^workos:/i, "")}`;
      },
    });

    expect(oauth.getApiKey?.(ompCredentials())).toBe("workos:access-a");
    expect(calls).toEqual([{ providerId: "cline", access: "access-a" }]);
  });

  test("rejects an empty formatted request token", async () => {
    const oauth = await createClineOAuth({
      resolveHandler: () => fakeHandler(),
      formatApiKey: () => "  ",
    });
    expect(() => oauth.getApiKey?.(ompCredentials())).toThrow(
      "Cline request credential is empty",
    );
  });
});
