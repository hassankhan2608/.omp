# OMP ZCode Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native OMP provider `zcode` that ports the coding-plan surface of TriDefender/zcode-api: direct Anthropic-format calls to Z.AI / Bigmodel with exact ZCode identity headers, one-shot OAuth, signing V4, endpoint routing, and the static model catalog.

**Architecture:** OMP extension modules port the repo's auth (oauth/resolver), identity/trace fingerprints, fail-open client signing and endpoint routing, and static models. OMP's native `anthropic` transport and credential store replace the repo's proxy HTTP layer and encrypted store.

**Tech Stack:** TypeScript 5.9, Bun test runner, OMP 18.0.9 extension API, WebCrypto (AES-GCM/HKDF/Ed25519/SHA-256).

**Spec:** `docs/superpowers/specs/2026-08-28-omp-zcode-provider-design.md`

**Reference repo:** `/tmp/zcode-api` (cloned from https://github.com/TriDefender/zcode-api). Port behavior and tests from it; do not read earlier provider attempts in this repo.

## Global Constraints

- Provider id exactly `zcode`; transport `anthropic`; upstream `POST {anthropicBase}/v1/messages` (`https://api.z.ai/api/anthropic` zai, `https://open.bigmodel.cn/api/anthropic` bigmodel).
- Auth header: `x-api-key: {credentialString}` + `anthropic-version: 2023-06-01`. `credentialString` = zai `{apiKey}.{secret}`, bigmodel `{apiKey}`.
- Identity headers exactly as `identity.ts` builds them, order preserved, printable-ASCII gated; installed desktop default `ZCode/3.10.1`; `X-Device-Mid` stable UUIDv4 persisted under OMP's agent directory.
- Trace headers: fresh `x-request-id`/`x-zcode-trace-id` UUIDs per request; `x-zcode-session-type: main`; `x-query-id`/`x-session-id` UUIDs with `x-session-id` stable per OMP conversation.
- Body transforms: ephemeral `cache_control` on last content block of last non-system message (idempotent); `metadata.user_id` merge when OAuth userId present.
- Signing V4 only when `agent/configs` gate enables it; fail-open unsigned on any failure; VERIFY-401 ladder: one re-handshake retry, then permanent bypass per (origin, credential). Unsigned paths: `/api/v1/zcode-plan/*`, `/api/v1/off-peak/*` (not used, but keep the exemption semantics).
- Endpoint routing rewrite fail-open, 5-min TTL, exact URL match from `data.proxyEndpoint.mapping`.
- OAuth (installed ZCode Desktop 3.10.1): random 32-byte polling token; `POST https://zcode.z.ai/api/v1/oauth/cli/init` with bearer poll token + `{provider}`; validate server flow/URL/expiry/interval; rewrite Z.AI `redirect_uri` or Bigmodel `redirect` to `https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback&app_version=3.10.1`; poll `GET /api/v1/oauth/cli/poll/{flowId}` with the same bearer token; pending continues, ready validates token/access_token/user_id, failed/unknown/nonretryable 4xx throws, transient failures retry until expiry.
- Resolver: zai via `Bearer {bizToken}`; bigmodel via raw `Authorization: {accessToken}` (no Bearer), secret folded into apiKey. Org containing `默认机构` else first; project containing `默认项目` else first; api key name `zcode-api-key` reuse-or-create.
- No refresh logic (none exists upstream). No logging of credentials, codes, tokens, or signature inputs.
- TDD: port the repo's test cases for each module before implementing it; commit each task.

## File Structure

- Create `agent/extensions/omp-zcode-provider/package.json` — extension metadata, scripts, deps.
- Create `agent/extensions/omp-zcode-provider/tsconfig.json` — strict Bun/TS config.
- Create `agent/extensions/omp-zcode-provider/src/oauth.ts` — ZCode 3.10.1 CLI OAuth init + poll flow, with injectable fetch/clock/sleep.
- Create `agent/extensions/omp-zcode-provider/src/resolver.ts` — coding-plan key resolution (port of `src/auth/resolver.ts`).
- Create `agent/extensions/omp-zcode-provider/src/credential.ts` — credential type + `credentialString` + apikey split (port of `src/auth/types.ts` + `apikey.ts`).
- Create `agent/extensions/omp-zcode-provider/src/identity.ts` — 12-header fingerprint (port of `src/proxy/identity.ts`).
- Create `agent/extensions/omp-zcode-provider/src/trace.ts` — trace/attribution headers (port of `trace-headers.ts` observe mode).
- Create `agent/extensions/omp-zcode-provider/src/transforms.ts` — cache_control + user_id (port of `body-transformer.ts` subsets).
- Create `agent/extensions/omp-zcode-provider/src/signing.ts` — gate probe, handshake, sign+PoW, retry ladder (port of `client-signing.ts`).
- Create `agent/extensions/omp-zcode-provider/src/routing.ts` — endpoint-routing rewrite (port of `endpoint-routing.ts`).
- Create `agent/extensions/omp-zcode-provider/src/models.ts` — static catalog (port of `provider/models.ts`).
- Create `agent/extensions/omp-zcode-provider/src/extension.ts` — provider registration + OAuth wiring into OMP auth contract.
- Create tests beside implementation under `tests/` mirroring the repo's suites.

---

### Task 1: Credential type and apikey parsing

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/credential.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/credential.test.ts`

**Interfaces:**
- Produces: `type ProviderId = "zai" | "bigmodel"`; `interface Credential { apiKey: string; secret?: string; provider: ProviderId; expiresAt?: number; userId?: string; jwt?: string }`; `credentialString(cred): string` (zai `apiKey.secret` when secret present); `createApiKeyCredential(provider, key): Credential` (first interior dot split); `isExpired(cred, now)`.

- [ ] **Step 1: Failing tests** (port `manager.test.ts` apikey semantics + `types.ts` behavior)

```ts
import { describe, expect, test } from "bun:test";
import { createApiKeyCredential, credentialString } from "../src/credential.js";

test("splits on the first interior dot", () => {
  expect(createApiKeyCredential("zai", "k.s")).toEqual({ apiKey: "k", secret: "s", provider: "zai" });
  expect(createApiKeyCredential("zai", "k.s.t")).toEqual({ apiKey: "k", secret: "s.t", provider: "zai" });
});
test("keeps leading-dot keys whole", () => {
  expect(createApiKeyCredential("zai", ".k")).toEqual({ apiKey: ".k", provider: "zai" });
});
test("throws on empty", () => {
  expect(() => createApiKeyCredential("zai", "  ")).toThrow();
});
test("credentialString joins only when secret exists", () => {
  expect(credentialString({ apiKey: "k", provider: "zai" })).toBe("k");
  expect(credentialString({ apiKey: "k", secret: "s", provider: "zai" })).toBe("k.s");
  expect(credentialString({ apiKey: "k.s", provider: "bigmodel" })).toBe("k.s");
});
```

- [ ] **Step 2: Run** `bun test tests/credential.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** minimal `credential.ts`.
- [ ] **Step 4: Run** tests + `bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: port zcode credential type`.

---

### Task 2: OAuth flow

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/oauth.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/oauth.test.ts`

**Interfaces:**
- Consumes: `credential.ts` provider types.
- Produces: `class ZaiOAuthClient` / `class BigmodelOAuthClient` extending a shared polling client with `start(): Promise<{authorizeUrl, flowId, pollToken, expiresAt, pollIntervalMs}>` and `authorize(onAuthorizeUrl?, timeoutMs?, signal?): Promise<OAuthResult>`; `OAuthResult { accessToken: string; provider: ProviderId; userId: string; jwt: string; refreshToken?: string }`.

- [ ] **Step 1: Failing tests** (installed ZCode Desktop 3.10.1):

Cover exact init URL/header/body; init envelope validation; HTTPS authorize URL + non-empty state; redirect query rewrite through `/app/oauth/login`; poll URL/header; pending→ready; provider access-token field variants; ready requires JWT/userId; failed/unknown status; transient retry vs nonretryable 4xx; expiry; abort; server-provided interval.

- [ ] **Step 2: Run** `bun test tests/oauth.test.ts` — FAIL against the stale localhost callback client.
- [ ] **Step 3: Replace callback server/exchange with the minimal polling client; retain `authorize(onUrl)` as extension wiring API and remove obsolete callback methods/classes cleanly.**
- [ ] **Step 4: Run** tests + typecheck — PASS.
- [ ] **Step 5: Commit** `fix: align zcode oauth with desktop 3.10.1`.

---

### Task 3: Coding-plan key resolver

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/resolver.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/resolver.test.ts`

**Interfaces:**
- Consumes: `credential.ts`, injectable fetch.
- Produces: `class KeyResolver { resolveCodingPlanCredential(accessToken, provider, userId?): Promise<Credential> }`.

- [ ] **Step 1: Failing tests** (port `resolver.test.ts`):

Cover: zai `POST https://api.z.ai/api/auth/z/login {token}` → biz token from `data.access_token ?? data.accessToken ?? data.data?.access_token`; biz envelope `code ?? status` in `{0,200,'0','200'}` else throw `msg`; org selection (`organizationName ?? name` contains `默认机构` else first; `organizationId ?? id ?? orgId`); project selection (`默认项目` else first; `projectId ?? id`); `No organizations found` / `No projects found…` errors; api_keys GET list (swallow errors → create), reuse `name === 'zcode-api-key'` (`.apiKey`), else POST `{name:'zcode-api-key'}`; secret via `GET .../api_keys/copy/{encodeURIComponent(apiKey)}` → `data.secretKey ?? data.secret_key`, swallow → no secret; bigmodel: host `https://bigmodel.cn`, `Authorization: {accessToken}` raw (no Bearer), result `{apiKey: key.secret, provider:'bigmodel'}` with no `secret` field; Authorization header for biz calls is `Bearer {bizToken}` for zai.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests + typecheck — PASS.
- [ ] **Step 5: Commit** `feat: port coding-plan key resolver`.

---

### Task 4: Identity + trace headers

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/identity.ts`, `src/trace.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/identity.test.ts`, `tests/trace.test.ts`

**Interfaces:**
- Produces: `buildIdentityHeaders(ctx: {appVersion?, sourceTitle?, refererOrigin?, platform?, arch?, releaseChannel?, deviceMid?}): Array<[string, string]>` (ordered pairs, ASCII-gated); `buildTraceHeaders(): Array<[string,string]>` fresh UUIDs (`x-request-id`, `x-zcode-session-type: main`, `x-zcode-trace-id`, `x-query-id`, `x-session-id`); `stripSessionPrefixes(value): string` (`query_`, then `sess_`, then `subagent_agent_`); `sessionTypeFor(sessionId): 'main'|'subagent'`.

- [ ] **Step 1: Failing tests** (port `identity.test.ts` + trace expectations): exact header names/order (`HTTP-Referer, User-Agent, X-ZCode-App-Version, X-Title, X-ZCode-Agent: glm, X-Platform: linux-x64, X-Release-Channel: production, X-Client-Language, X-Client-Timezone, X-Os-Category: linux, X-Os-Version, X-Device-Mid`); non-ASCII appVersion drops `X-ZCode-App-Version` but keeps `User-Agent: ZCode/unknown` fallback; `X-Title: Z Code@cli`; deviceMid omitted when unset; fresh UUIDs differ across calls; prefix stripping `query_x→x`, `sess_y→y`, `subagent_agent_z→z`; sessionId starting `subagent_agent_` → type `subagent` else `main`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with injectable clock/locale/platform for determinism.
- [ ] **Step 4: Run** tests + typecheck — PASS.
- [ ] **Step 5: Commit** `feat: port zcode identity and trace headers`.

---

### Task 5: Body transforms

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/transforms.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/transforms.test.ts`

**Interfaces:**
- Produces: `applyAnthropicTransforms(body, opts: {userId?}): body` — ephemeral `cache_control` on last content block of last non-system message (string → `[{type:"text",text,cache_control}]`, idempotent), `metadata.user_id` merge when userId present. No-op on JSON parse failure is N/A (typed object in OMP), but malformed/empty messages arrays must be no-ops.

- [ ] **Step 1: Failing tests** (port body-transformer coverage): string content promoted; array content last block gets cache_control; already-present cache_control not duplicated; system-message last block untouched; empty messages no-op; metadata merge preserves existing fields; no userId → metadata untouched.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests + typecheck — PASS.
- [ ] **Step 5: Commit** `feat: port zcode body transforms`.

---

### Task 6: Client signing V4

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/signing.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/signing.test.ts`

**Interfaces:**
- Produces: `class ClientSigner { constructor(deps: {fetch, appVersion, now?}); async isEnabled(credentialString, origin): Promise<boolean>; async signRequest(credentialString, origin, sessionId): Promise<HeaderPairs | null>; onVerify401(credentialString, origin): Promise<HeaderPairs | null> }` implementing the repo ladder (handshake, cache, bypass).

- [ ] **Step 1: Failing tests** (port `client-signing.test.ts` including the worked example): credential `testkey.testsecret`, appVersion `3.8.1`, sessionId `sess-123` → signed message `testkey\n{ts}\n3.8.1\nsess-123\n{nonce}`; handshake `Authorization: testkey.testsecret` (no Bearer) with `sig = base64(HMAC-SHA256(HKDF-SHA256(secret, salt "WD_CLIENT_SIGN_KDF_SALT", info "getSignKey_hmac", 256bit), "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"))`; privateCipher AES-GCM fixture unwrap (AAD = apiKeyId, key = HKDF info `ed25519_priv`, plaintext utf8 → base64 → PKCS8); gate probe headers (identity minus `X-ZCode-Agent`/`X-Device-Mid`, plus `x-api-key`), enabled iff `code===0 && data.codingPlanSignature.enable===true`; PoW candidate 32 hex with SHA-256 first byte 0, seed `hex(SHA-256("{id}\nzcode\n{sessionId}\n{ts}")).slice(0,32)`; output headers exactly `X-Client-Ts, X-Client-Version, X-Client-Sig, X-Session-Id, X-Client-Nonce, X-App-Id: zcode, X-Client-Pow`; gate off → null (send unsigned); 401 VERIFY → one re-handshake retry then permanent bypass.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with WebCrypto (`crypto.subtle.importKey("ed25519", pkcs8, …)`) and injectable `now`/random.
- [ ] **Step 4: Run** tests + typecheck — PASS.
- [ ] **Step 5: Commit** `feat: port zcode client signing v4`.

---

### Task 7: Endpoint routing

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/routing.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/routing.test.ts`

**Interfaces:**
- Produces: `class EndpointRouter { constructor(deps: {fetch, ttlMs=300_000}); async resolve(url, credentialString): Promise<string> }` — `GET https://zcode.z.ai/api/v1/agent/configs` (identity minus `X-ZCode-Agent`/`X-Device-Mid`, `Accept: application/json`, `x-api-key`), envelope `code===0` → `data.proxyEndpoint.mapping` `from`/`to` exact-match rewrite; any failure → original URL; 5-min TTL cache.

- [ ] **Step 1: Failing tests** (port `endpoint-routing.test.ts`): mapping rewrite applied on exact match; non-matching URL unchanged; network failure fails open; TTL reuse (second call within TTL does not refetch).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests + typecheck — PASS.
- [ ] **Step 5: Commit** `feat: port zcode endpoint routing`.

---

### Task 8: Models + provider registration + OAuth wiring

**Files:**
- Create: `agent/extensions/omp-zcode-provider/src/models.ts`, `src/extension.ts`
- Create: `agent/extensions/omp-zcode-provider/tests/models.test.ts`, `tests/extension.test.ts`

**Interfaces:**
- Produces: `MODELS: ReadonlyArray<{id, name, contextWindow, maxOutputTokens?, reasoning?}>` — the spec's 10-model table verbatim, `glm-4.6` default.
- Produces: `createExtension(deps?)` async factory registering via `pi.registerProvider("zcode", { baseUrl: anthropicBase, api: "anthropic", models, oauth })`, plus a request pipeline (`fetchImpl` injection for tests) that: applies routing rewrite → builds auth/identity/trace headers → applies transforms → signing gate → dispatch → VERIFY-401 ladder.

- [ ] **Step 1: Failing tests** — models table values match spec exactly; registration contract (id `zcode`, base `https://api.z.ai/api/anthropic`, api `anthropic`, oauth present, 10 models); pipeline integration test with mocked upstream asserting: rewritten URL when mapping says so, header presence/order (`x-api-key`, `anthropic-version: 2023-06-01`, identity set, trace set), transformed body (cache_control, user_id), signature headers when gate on, unsigned when off, VERIFY-401 retry then bypass; `x-session-id` stable across two calls with the same conversation key.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** extension + pipeline; OAuth wiring maps `oauth.login` to the selected polling client `authorize()` + resolver + OMP credential return (`accountId: userId`, email unset); the far-future expiry prevents nonexistent refresh calls.
- [ ] **Step 4: Run** full suite + typecheck — PASS.
- [ ] **Step 5: Commit** `feat: register native zcode provider`.

---

### Task 9: Runtime verification

**Files:**
- Modify only on verified defects: files from Tasks 1–8 + reproducing tests.

- [ ] **Step 1:** `omp plugin list --json` shows linked, enabled `omp-zcode-provider`; actual `/login` search for `ZCode` shows `ZCode (Z.AI / Bigmodel coding plan)`.
- [ ] **Step 2:** `/login` → `ZCode` → choose Z.AI; current init/authorize/poll flow completes; confirm credential stored with identity_key `account:{userId}` if present.
- [ ] **Step 3:** Select `zcode/glm-4.6`; send `Reply with exactly: zcode-ok`; confirm streamed completion.
- [ ] **Step 4:** Verify signing path live: if the gate is enabled, confirm signed headers present and response OK; if off, confirm unsigned success.
- [ ] **Step 5:** `bun test && bun run typecheck` — PASS.
- [ ] **Step 6:** Commit any runtime-driven fixes with reproducing tests (`fix: align zcode provider runtime behavior`), else no empty commit.
