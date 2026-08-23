import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import { exchangeZcodeToken, loginZcodeStartPlan } from "../src/oauth";

const tokenPayload = {
  code: 0,
  data: {
    token: "plan-jwt",
    zai: { access_token: "provider-oauth-token" },
    user: { id: "acct-1", email: "one@example.com" },
  },
};

function jsonFetch(payload: unknown, status = 200): FetchImpl {
  return async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("maps the Start Plan token response to a stable account identity", async () => {
  const credential = await exchangeZcodeToken(
    { code: "code", state: "state", redirectUri: "http://127.0.0.1/callback" },
    jsonFetch(tokenPayload),
  );

  expect(credential).toEqual({
    access: "plan-jwt",
    refresh: "provider-oauth-token",
    expires: 8.64e15,
    accountId: "acct-1",
    email: "one@example.com",
  });
});

test("rejects a token response without the Start Plan JWT", async () => {
  await expect(exchangeZcodeToken(
    { code: "code", state: "state", redirectUri: "http://127.0.0.1/callback" },
    jsonFetch({ code: 0, data: { zai: { access_token: "oauth" }, user: { id: "acct" } } }),
  )).rejects.toThrow("Start Plan JWT");
});

test("completes browser OAuth through the loopback callback", async () => {
  let postedBody: Record<string, unknown> | undefined;
  const fetchImpl: FetchImpl = async (_input, init) => {
    postedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(tokenPayload), { status: 200 });
  };

  const credential = await loginZcodeStartPlan({
    fetch: fetchImpl,
    onPrompt: async () => "",
    onAuth: ({ url }) => {
      const authorize = new URL(url);
      const redirectUri = authorize.searchParams.get("redirect_uri")!;
      const state = authorize.searchParams.get("state")!;
      queueMicrotask(() => void fetch(`${redirectUri}?authCode=browser-code&state=${state}`));
    },
  });

  expect(credential.accountId).toBe("acct-1");
  expect(postedBody).toMatchObject({
    provider: "zai",
    code: "browser-code",
    state: expect.any(String),
  });
});
