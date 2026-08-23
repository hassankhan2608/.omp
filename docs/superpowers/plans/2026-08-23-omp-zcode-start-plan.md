# Native OMP ZCode Start Plan Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native OMP provider for ZCode Start Plan with OAuth multi-account storage, automatic Electron verification, native usage reports, and redacted diagnostics.

**Architecture:** A local extension registers `zcode-start-plan` with OMP. It delegates Anthropic message transformation/SSE handling to OMP’s `streamAnthropic`, wrapping only the fetch boundary to add a fresh Electron-minted Aliyun verification parameter and ZCode identity headers. OMP AuthStorage owns accounts, rotation, retry, and usage history.

**Tech Stack:** TypeScript, Bun, OMP extension API, `@oh-my-pi/pi-ai`, Electron 41.0.3, Zod-compatible OMP schemas, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-16-omp-zhipu-start-plan-design.md`

## Global Constraints

- Create the plugin only at `~/.omp/agent/extensions/omp-zcode-start-plan/`.
- Do not modify, import, stop, or remove `/home/laughingman/repos/zcode-relay`.
- Provider ID is exactly `zcode-start-plan`.
- Start Plan endpoint is exactly `https://zcode.z.ai/api/v1/zcode-plan/anthropic` with Anthropic path `/v1/messages`.
- CAPTCHA verification parameters are single-request values and must never be cached or reused.
- Normal verification is automatic and hidden; show Electron only when Aliyun explicitly requires interaction.
- Never log JWTs, OAuth tokens, CAPTCHA values, or full authorization headers.
- Use OMP AuthStorage for identity, persistence, stickiness, blocking, and rotation; no plugin account database.
- The existing `zcode-weekend` relay-backed model remains available until native verification passes.

---

### Task 1: Package skeleton and model contract

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/package.json`
- Create: `agent/extensions/omp-zcode-start-plan/tsconfig.json`
- Create: `agent/extensions/omp-zcode-start-plan/src/constants.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/models.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/models.test.ts`

**Interfaces:**
- Produces: `PROVIDER_ID`, `ZCODE_BASE_URL`, `ZCODE_MESSAGES_URL`, `ZCODE_CLIENT_VERSION`, `ZCODE_MODELS`.
- `ZCODE_MODELS` is `ProviderModelConfig[]` and is consumed by `extension.ts` and transport tests.

- [ ] **Step 1: Write the failing model contract test**

```ts
import { expect, test } from "bun:test";
import { ZCODE_MODELS } from "../src/models";

test("publishes the Start Plan model limits", () => {
  expect(ZCODE_MODELS.map(model => [model.id, model.contextWindow, model.maxTokens])).toEqual([
    ["glm-5.3", 1_000_000, 128_000],
    ["glm-5-turbo", 200_000, 128_000],
  ]);
  expect(ZCODE_MODELS[0]?.thinking).toEqual({
    mode: "anthropic-budget-effort",
    efforts: [Effort.Low, Effort.High, Effort.Max],
    defaultLevel: Effort.Max,
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `bun test tests/models.test.ts`  
Expected: FAIL because `src/models.ts` does not exist.

- [ ] **Step 3: Add the package and model constants**

Use this manifest shape:

```json
{
  "name": "omp-zcode-start-plan",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "omp": { "extensions": ["./src/extension.ts"] },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@oh-my-pi/pi-ai": "^18.0.1",
    "@oh-my-pi/pi-coding-agent": "^18.0.1"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "electron": "41.0.3",
    "typescript": "5.9.3"
  }
}
```

`constants.ts` exports:

```ts
export const PROVIDER_ID = "zcode-start-plan";
export const ZCODE_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
export const ZCODE_MESSAGES_URL = `${ZCODE_BASE_URL}/v1/messages`;
export const ZCODE_CLIENT_VERSION = "3.8.1";
export const ZCODE_CONFIG_URL = "https://zcode.z.ai/api/v1/client/configs";
export const ZCODE_BILLING_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
```

`models.ts` exports two text-only, zero-cost entitlement models with the exact limits in the test.

- [ ] **Step 4: Install dependencies and verify GREEN**

Run: `bun install && bun test tests/models.test.ts && bun x tsc --noEmit`  
Expected: one passing test and no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/omp-zcode-start-plan
git commit -m "feat(zcode): scaffold native Start Plan provider"
```

---

### Task 2: OAuth login and multi-account identity

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/oauth.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/oauth.test.ts`

**Interfaces:**
- Produces: `loginZcodeStartPlan(callbacks): Promise<OAuthCredentials>`.
- Produces: `exchangeZcodeToken(input, fetchImpl): Promise<OAuthCredentials>` for deterministic tests.
- Credentials use the Start Plan JWT as `access`, provider OAuth access token as `refresh`, and include `email` and `accountId`.

- [ ] **Step 1: Write token-exchange identity tests**

```ts
import { expect, test } from "bun:test";
import { exchangeZcodeToken } from "../src/oauth";

test("maps ZCode token response to an identity-bearing OMP credential", async () => {
  const fetchImpl: typeof fetch = Object.assign(async () => new Response(JSON.stringify({
    code: 0,
    data: {
      token: "plan-jwt",
      zai: { access_token: "provider-oauth-token" },
      user: { id: "acct-1", email: "one@example.com" },
    },
  }), { status: 200 }), { preconnect: fetch.preconnect });

  const credential = await exchangeZcodeToken({ code: "code", state: "state", redirectUri: "http://127.0.0.1/callback" }, fetchImpl);
  expect(credential).toMatchObject({
    access: "plan-jwt",
    refresh: "provider-oauth-token",
    accountId: "acct-1",
    email: "one@example.com",
  });
});

test("rejects a response without the Start Plan JWT", async () => {
  // Return code:0 without data.token and assert a clear validation error.
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `bun test tests/oauth.test.ts`  
Expected: FAIL because OAuth functions do not exist.

- [ ] **Step 3: Implement the loopback OAuth flow**

Use `node:http` with an OS-assigned localhost port and a random 32-byte hex state. Build:

```text
https://chat.z.ai/api/oauth/authorize
  ?redirect_uri=http://127.0.0.1:<port>/oauth/callback/zai
  &response_type=code
  &client_id=client_P8X5CMWmlaRO9gyO-KSqtg
  &state=<state>
```

Call `callbacks.onAuth({ url, instructions })`, validate callback `state`, exchange at `https://zcode.z.ai/api/v1/oauth/token`, and return:

```ts
{
  access: data.token,
  refresh: data.zai.access_token,
  expires: 8.64e15,
  email: data.user.email,
  accountId: String(data.user.id),
}
```

Always close the callback server in `finally`. Do not mint an API key; the plugin needs `data.token`, not Z.ai PAYG credentials.

- [ ] **Step 4: Verify OAuth tests and types**

Run: `bun test tests/oauth.test.ts && bun x tsc --noEmit`  
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/omp-zcode-start-plan/src/oauth.ts agent/extensions/omp-zcode-start-plan/tests/oauth.test.ts
git commit -m "feat(zcode): add multi-account Start Plan OAuth"
```

---

### Task 3: Persistent Electron verification broker

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/client.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/broker.cjs`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/index.html`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/logo.txt`
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-client.test.ts`

**Interfaces:**
- Produces: `ElectronCaptchaBroker.solve(config, appVersion): Promise<string>`.
- Produces: `solveCaptcha(config, appVersion): Promise<string>` and `closeCaptchaBroker(): void`.
- Broker protocol: one NDJSON request `{id, appVersion, config}` and response `{id, ok, verifyParam?, error?}`.

- [ ] **Step 1: Write failing broker lifecycle tests**

Use `PassThrough` streams and a fake `BrokerProcess` to assert:

```ts
test("reuses one process but mints a distinct parameter per request", async () => {
  const first = await broker.solve(config, "3.8.1");
  const second = await broker.solve(config, "3.8.1");
  expect([first, second]).toEqual(["token-1", "token-2"]);
  expect(launchCount).toBe(1);
});

test("rejects pending work and relaunches after broker exit", async () => {
  // Exit fake process while request is pending, assert rejection, then assert next solve launches process 2.
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `bun test tests/captcha-client.test.ts`  
Expected: FAIL because the broker client does not exist.

- [ ] **Step 3: Implement the typed NDJSON client**

Use `child_process.spawn` and `createRequire(import.meta.url)("electron")` to locate Electron. Correlate replies by numeric ID, reject on timeout/exit, and restart lazily. `close()` ends stdin, waits briefly, then force-kills only if Electron did not exit.

- [ ] **Step 4: Implement the Electron renderer broker**

Match installed ZCode 3.8.1:

- hidden `BrowserWindow`, 990×640
- `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`
- ZCode/Electron 41 user agent
- official `AliyunCaptcha.js`
- `startTracelessVerification()` first
- visible `instance.show()` only after automatic failure
- fresh page and SDK instance for every request
- no token cache

The successful callback must return only the parameter over stdout. SDK and Chromium logs go to stderr. The official logo data URI is copied into `logo.txt` from the installed ZCode asset/proven probe.

- [ ] **Step 5: Verify unit and real broker smoke tests**

Run:

```bash
bun test tests/captcha-client.test.ts
bun -e 'import {solveCaptcha,closeCaptchaBroker} from "./src/captcha/client.ts"; const token=await solveCaptcha({sceneId:"11xygtvd",region:"sgp",prefix:"no8xfe"},"3.8.1"); console.log(token.length); closeCaptchaBroker();'
```

Expected: unit tests pass; smoke prints `280`; process exits without lingering Electron children.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/omp-zcode-start-plan/src/captcha agent/extensions/omp-zcode-start-plan/tests/captcha-client.test.ts
git commit -m "feat(zcode): add automatic Electron verification broker"
```

---

### Task 4: Native Anthropic transport

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/transport.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/diagnostics.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/transport.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/diagnostics.test.ts`

**Interfaces:**
- Produces: `streamZcodeStartPlan(model, context, options): AssistantMessageEventStream`.
- Produces: `createZcodeFetch(baseFetch, diagnostics): typeof fetch`.
- Consumes: `solveCaptcha`, ZCode constants, and OMP `streamAnthropic`.

- [ ] **Step 1: Write failing fetch-wrapper tests**

```ts
test("adds one fresh verification parameter to each model request", async () => {
  const tokens = ["captcha-1", "captcha-2"];
  const wrapped = createZcodeFetch(fetchMock, diagnostics, async () => tokens.shift()!);
  await wrapped(messagesRequest(), {});
  await wrapped(messagesRequest(), {});
  expect(capturedHeaders.map(h => h.get("x-aliyun-captcha-verify-param"))).toEqual(["captcha-1", "captcha-2"]);
});

test("diagnostics redact authorization and CAPTCHA values", () => {
  diagnostics.recordRequest({ headers: secretHeaders, status: 200, requestId: "req-1" });
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain("plan-jwt");
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain("captcha-secret");
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `bun test tests/transport.test.ts tests/diagnostics.test.ts`  
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the fetch wrapper**

Before every `/v1/messages` call:

1. Fetch live CAPTCHA config from `ZCODE_CONFIG_URL` with a 60-second configuration-only cache.
2. Call `solveCaptcha` without caching its returned parameter.
3. Merge these headers into the outbound request:

```ts
{
  "Authorization": `Bearer ${options.apiKey}`,
  "User-Agent": zcodeUserAgent,
  "HTTP-Referer": "https://zcode.z.ai",
  "X-Title": "Z Code@electron",
  "X-ZCode-App-Version": "3.8.1",
  "X-Platform": "linux-x64",
  "X-Os-Category": "linux",
  "X-Device-Mid": deviceMid,
  "X-Aliyun-Captcha-Verify-Param": verifyParam,
  "X-Aliyun-Captcha-Verify-Region": region,
}
```

Preserve caller headers and signal. Record only names/timing/status/request ID in diagnostics.

- [ ] **Step 4: Delegate message/SSE handling to OMP**

Implement:

```ts
export function streamZcodeStartPlan(model, context, options) {
  return streamAnthropic(model, context, {
    ...options,
    fetch: createZcodeFetch(options?.fetch ?? fetch, diagnostics),
    headers: { ...options?.headers, ...staticZcodeHeaders() },
  });
}
```

Import `streamAnthropic` from `@oh-my-pi/pi-ai/providers/anthropic`. This preserves OMP’s native text, thinking, tools, tool results, SSE, usage, abort, error classification, and retry integration instead of duplicating wire parsing.

- [ ] **Step 5: Verify transport tests and types**

Run: `bun test tests/transport.test.ts tests/diagnostics.test.ts && bun x tsc --noEmit`  
Expected: all tests pass and diagnostics contain no secrets.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/omp-zcode-start-plan/src/transport.ts agent/extensions/omp-zcode-start-plan/src/diagnostics.ts agent/extensions/omp-zcode-start-plan/tests
git commit -m "feat(zcode): add native Start Plan transport"
```

---

### Task 5: Native usage and account-aware quota

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/usage.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/reserve.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/identity.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/usage.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/reserve.test.ts`

**Interfaces:**
- Produces: `zcodeUsageProvider: UsageProvider`.
- Produces: `parseBalanceReport(payload, identity, fetchedAt): UsageReport | null`.
- Consumes JWT from `UsageFetchParams.credential` and returns separate entitlement limits.
- Produces: `checkZcodeUsageReserve(fetch, accessToken, modelId)`; throws OMP's recognized `UsageLimit` when every relevant entitlement is at least 98% used.

- [ ] **Step 1: Write failing multi-bucket usage tests**

Fixture payload contains:

```json
{
  "code": 0,
  "data": {
    "balances": [
      {"entitlement_id":"ent_wk","show_name":"GLM-5.3","total_units":100000000,"used_units":316,"available_units":99999684},
      {"entitlement_id":"ent_trial","show_name":"GLM-5.3","total_units":3000000,"used_units":0,"available_units":3000000},
      {"entitlement_id":"ent_turbo","show_name":"GLM-5-Turbo","total_units":2000000,"used_units":0,"available_units":2000000}
    ]
  }
}
```

Assert three limits, token units, fractions, account scope, and stable IDs based on `entitlement_id`.

- [ ] **Step 2: Run usage tests and confirm RED**

Run: `bun test tests/usage.test.ts`  
Expected: FAIL because `usage.ts` does not exist.

- [ ] **Step 3: Implement normalized usage reports**

`fetchUsage` must:

- accept only OAuth credentials for provider `zcode-start-plan`
- send `Authorization: Bearer <credential.accessToken>`
- fetch `billing/balance?app_version=3.8.1`, matching ZCode 3.8.1
- return `null` on endpoint failure without blocking model calls
- include `email`, `accountId`, endpoint, active plan name, and expiry in metadata
- set `status` to `warning` at ≥90% and `exhausted` at 100%

Every limit scope includes provider, accountId, and `shared: true` so OMP displays each account correctly. The plugin relies on core sticky/round-robin selection. Before CAPTCHA/model dispatch, a fail-open reserve check evaluates the selected credential's requested-model entitlements; when every relevant bucket is ≥98% used, it emits HTTP 429 `UsageLimit` with `retry-after`, allowing OMP to cool down that credential and rotate a sibling. This is reactive eligibility checking, not proactive headroom ranking, because OMP 18.0.1 exposes no extension ranking-strategy registration.

- [ ] **Step 4: Verify usage tests and types**

Run: `bun test tests/usage.test.ts tests/reserve.test.ts && bun x tsc --noEmit`  
Expected: usage tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/omp-zcode-start-plan
git commit -m "feat(zcode): add account-aware Start Plan usage"
```

---

### Task 6: Extension registration and diagnostics commands

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/extension.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/extension.test.ts`
- Link: `omp plugin link ~/.omp/agent/extensions/omp-zcode-start-plan --scope user`

**Interfaces:**
- Registers provider `zcode-start-plan` with models, OAuth, `streamSimple`, and usage.
- Registers `/zcode-status` and `/zcode-probe`.
- Closes the Electron broker on `session_shutdown`.

- [ ] **Step 1: Write a failing registration test**

Use a minimal fake `ExtensionAPI` registration recorder and assert:

```ts
expect(providerName).toBe("zcode-start-plan");
expect(providerConfig.api).toBe("zcode-start-plan-anthropic");
expect(providerConfig.models).toHaveLength(2);
expect(providerConfig.oauth?.name).toBe("ZCode Start Plan");
expect(providerConfig.usage?.id).toBe("zcode-start-plan");
expect(commands).toEqual(["zcode-status", "zcode-probe"]);
```

- [ ] **Step 2: Run the registration test and confirm RED**

Run: `bun test tests/extension.test.ts`  
Expected: FAIL because `extension.ts` does not exist.

- [ ] **Step 3: Register the provider and commands**

Provider configuration:

```ts
pi.registerProvider(PROVIDER_ID, {
  baseUrl: ZCODE_BASE_URL,
  api: "zcode-start-plan-anthropic",
  streamSimple: streamZcodeStartPlan,
  authHeader: true,
  models: ZCODE_MODELS,
  usage: zcodeUsageProvider,
  oauth: {
    name: "ZCode Start Plan",
    login: loginZcodeStartPlan,
    getApiKey: credentials => credentials.access,
  },
});
```

`/zcode-status` renders `diagnostics.snapshot()` plus instructions for `/login`, `/usage`, and model selection. `/zcode-probe` uses the registered model/transport path for one minimal request and labels that it consumes quota. `session_shutdown` calls `closeCaptchaBroker()`.

- [ ] **Step 4: Link the plugin**

Run:

```bash
omp plugin link ~/.omp/agent/extensions/omp-zcode-start-plan --scope user
```

Do not also add the extension entry file to `agent/config.yml`; duplicate registration loads the same commands and provider twice.

- [ ] **Step 5: Verify registration tests and OMP discovery**

Run:

```bash
bun test tests/extension.test.ts
bun x tsc --noEmit
omp models find zcode-start-plan
```

Expected: tests and typecheck pass; both models appear after authentication requirements are satisfied.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/omp-zcode-start-plan
git commit -m "feat(zcode): register native Start Plan extension"
```

---

### Task 7: End-to-end multi-account, usage, and model verification

**Files:**
- No new source files unless verification reveals a tested defect.

**Interfaces:**
- Verifies all spec acceptance criteria through actual OMP surfaces.

- [ ] **Step 1: Run the extension test suite once**

Run: `bun test` from `~/.omp/agent/extensions/omp-zcode-start-plan`  
Expected: all tests pass.

- [ ] **Step 2: Run typecheck once**

Run: `bun x tsc --noEmit`  
Expected: no diagnostics.

- [ ] **Step 3: Add the first account**

Inside OMP:

```text
/login zcode-start-plan
```

Complete browser OAuth. Confirm the provider becomes authenticated and `zcode-start-plan/glm-5.3` is selectable.

- [ ] **Step 4: Verify native usage**

Inside OMP run `/usage`.

Expected: a `zcode-start-plan` section with the current account identity and separate Weekend Build, GLM-5.3 trial, and GLM-5-Turbo entitlement buckets. OMP 18.0.1's standalone `omp usage` command does not load extension providers; supporting that CLI requires a separate OMP core fix.

- [ ] **Step 5: Verify consecutive native requests**

Run twice:

```bash
omp -p --no-tools --no-session --model zcode-start-plan/glm-5.3 --thinking low 'Reply with exactly OMP_PLUGIN_OK.'
```

Expected both times: `OMP_PLUGIN_OK`. Two successes prove verification parameters are minted per request rather than reused.

- [ ] **Step 6: Verify diagnostics redaction**

Inside OMP run:

```text
/zcode-status
```

Expected: endpoint, account identity, broker state, verification latency, HTTP status/request ID, and usage timestamp; no token or CAPTCHA bytes.

- [ ] **Step 7: Verify multi-account identity behavior**

Run `/login zcode-start-plan` with a second account if available, then interactive `/usage`. Expected: both accounts appear as separate credential reports. If no second account is available, unit identity/upsert coverage remains the proof and this live check is recorded as unavailable, not simulated.

- [ ] **Step 8: Confirm relay isolation**

Verify `/home/laughingman/repos/zcode-relay` has no changes from this task and the existing `zcode-weekend` model remains selectable as fallback.

- [ ] **Step 9: Final commit if verification required fixes**

Commit only tested fixes and generated lockfile changes with:

```bash
git add agent/extensions/omp-zcode-start-plan
git commit -m "fix(zcode): complete native provider verification"
```
