import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchImpl, OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import {
  ZCODE_OAUTH_AUTHORIZE_URL,
  ZCODE_OAUTH_CLIENT_ID,
  ZCODE_OAUTH_TOKEN_URL,
} from "./constants";

const CREDENTIAL_EXPIRY = 8.64e15;
const CALLBACK_PATH = "/oauth/callback/zai";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface TokenExchangeInput {
  code: string;
  state: string;
  redirectUri: string;
}

interface ZcodeTokenPayload {
  code?: number;
  message?: string;
  data?: {
    token?: string;
    zai?: { access_token?: string };
    user?: { id?: string | number; email?: string };
  };
}

export async function exchangeZcodeToken(
  input: TokenExchangeInput,
  fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
  const response = await fetchImpl(ZCODE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "zai",
      code: input.code,
      redirect_uri: input.redirectUri,
      state: input.state,
    }),
  });

  let payload: ZcodeTokenPayload;
  try {
    payload = await response.json() as ZcodeTokenPayload;
  } catch {
    throw new Error(`ZCode OAuth token exchange returned invalid JSON (${response.status})`);
  }

  if (!response.ok || payload.code !== 0) {
    throw new Error(`ZCode OAuth token exchange failed (${response.status}): ${payload.message ?? "unknown error"}`);
  }

  const access = payload.data?.token;
  if (!access) throw new Error("ZCode OAuth response did not include the Start Plan JWT");
  const refresh = payload.data?.zai?.access_token;
  if (!refresh) throw new Error("ZCode OAuth response did not include the provider access token");
  const accountId = payload.data?.user?.id;
  if (accountId === undefined || accountId === null || String(accountId).length === 0) {
    throw new Error("ZCode OAuth response did not include an account identity");
  }

  return {
    access,
    refresh,
    expires: CREDENTIAL_EXPIRY,
    accountId: String(accountId),
    email: payload.data?.user?.email,
  };
}

function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

export async function loginZcodeStartPlan(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const state = randomBytes(32).toString("hex");
  let authorizeUrl = "";
  const codeResult = Promise.withResolvers<string>();

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/") {
      response.writeHead(302, { location: authorizeUrl });
      response.end();
      return;
    }
    if (requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (requestUrl.searchParams.get("state") !== state) {
      response.writeHead(400).end("OAuth state mismatch");
      codeResult.reject(new Error("ZCode OAuth callback state mismatch"));
      return;
    }
    const code = requestUrl.searchParams.get("authCode") ?? requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400).end("Missing authorization code");
      codeResult.reject(new Error("ZCode OAuth callback omitted the authorization code"));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>ZCode login complete</title><p>Login complete. You can close this tab.</p>");
    codeResult.resolve(code);
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const port = await listen(server);
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const authorize = new URL(ZCODE_OAUTH_AUTHORIZE_URL);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", ZCODE_OAUTH_CLIENT_ID);
    authorize.searchParams.set("state", state);
    authorizeUrl = authorize.toString();

    callbacks.onAuth({
      url: authorizeUrl,
      launchUrl: `http://127.0.0.1:${port}/`,
      instructions: "Sign in to Z.ai and authorize ZCode Start Plan access.",
    });

    timeout = setTimeout(() => codeResult.reject(new Error("ZCode OAuth login timed out")), LOGIN_TIMEOUT_MS);
    if (callbacks.signal) {
      abortHandler = () => codeResult.reject(new Error("ZCode OAuth login was cancelled"));
      callbacks.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const code = await codeResult.promise;
    return await exchangeZcodeToken({ code, state, redirectUri }, callbacks.fetch ?? fetch);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) callbacks.signal?.removeEventListener("abort", abortHandler);
    await closeServer(server);
  }
}
