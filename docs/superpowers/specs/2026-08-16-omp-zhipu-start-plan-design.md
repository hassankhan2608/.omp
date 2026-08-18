# Design — OMP Zhipu Start-Plan Plugin (`omp-zhipu-start-plan`)

**Date:** 2026-08-16
**Status:** Design (pending review)
**Scope:** OMP agent extension that lets the OMP agent consume GLM models through the ZCode Start Plan relay (`zcode.z.ai`) — the only Zhipu/Z.ai plan currently available to the local account (`zai-start-plan: available`; `api.z.ai` key auth and coding-plan OAuth both denied: 429 code 1113 / `coding_plan_not_entitled`).

## 1. Goals & Non-Goals

### Goals
1. Register a `zai-start-plan` provider in OMP that streams GLM-5.3 / GLM-5.2 / GLM-5-Turbo through the Start Plan relay.
2. Obtain the per-request relay requirements (fresh Aliyun captcha param, relay JWT, device fingerprint) **without reproducing captcha generation** — the anti-bot gate (research finding F4) stays intact and runs inside the user's own ZCode app.
3. One-time `/login` imports the existing ZCode session; token rotation is automatic thereafter.
4. Verifiable: a real OMP agent turn must produce a 200/SSE round-trip through the relay (research test matrix row 7 behavior, but via OMP).

### Non-Goals
- No Aliyun captcha generation or interactive-solving automation (research §10 red line; ToS risk). See §7.
- No modification of ZCode's app files, state, or processes beyond the read-only CDP inspector channel already validated by prior research (SIGUSR1 → `ws://127.0.0.1:9229`, main-process `fetch` wrapper, restored on shutdown).
- No support for plans the account does not hold (coding plan, BigModel key today).

## 2. Context Summary (from `RESEARCH-zcode-omp-glm-auth-architecture.md`)

- Relay: `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`, Anthropic-messages wire shape.
- Hard requirement: `Authorization: Bearer <zcodejwttoken>` + `x-api-key` + fingerprint headers + `X-Device-Mid` + **fresh** `X-Aliyun-Captcha-Verify-Param` / `X-Aliyun-Captcha-Verify-Region` per request; without a fresh captcha param every request is rejected 400 code 3007 (test rows 4–6; cookies/HTTP2 irrelevant).
- The captcha param is minted only inside ZCode's renderer (Aliyun SDK; region/prefix server-supplied via `getClientConfigs().configs.captcha`) and merged by the host main process into relay headers. Verified: host `out/host/index.js` has zero `captchaVerifyParam` occurrences; the agent runtime always delegates header minting to the host (`providerRuntimeHeadersPort.refreshBeforeModelRequest` → `interactionRequestProviderRuntimeHeaders` over the internal "ZCode Protocol" `messageSink`, error `-32020` when no host client attached — no external client can mint headers).
- Credentials: `~/.zcode/v2/credentials.json` stores `zcodejwttoken` (HS256 JWT, no `exp` — F2) + `oauth:zai:access_token` under `enc:v1:` AES-256-GCM with a machine-derivable key (`sha256(secret)`, `secret = ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:{platform}:{homedir}:{username}"`) — F1: at-rest protection equals file permissions. All values locally available to the same user.
- Device/OS fingerprint sources: `~/.zcode/v2/telemetry-state.json` (`X-Device-Mid`), `~/.zcode/v2/setting.json` (locale), kernel (`X-Os-Version`).
- Local state today: `zai-start-plan: available` in `coding-plan-cache.json`; `modelProviderFamilySelectedKeys.zai = "coding-plan:builtin:zai-start-plan"` in `setting.json`; ZCode app installed at `/opt/ZCode/zcode`.

## 3. Architecture

```
OMP agent loop
   │  model = zai-start-plan/glm-5.2
   ▼
pi.registerProvider("zai-start-plan", { api:"anthropic-messages", streamSimple, oauth.login/refreshToken/getApiKey, models })
   │
   ▼ streamSimple(model, context, options)
build Anthropic-messages body from context; resolve jwt + fingerprint + captcha pair
   │
   ▼
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
headers: fingerprint set + Authorization + x-api-key + X-Device-Mid + fresh captcha pair
   │
   ▼ SSE
stream wrapper → AssistantMessageEventStream → agent loop
```

Config switch `mode`:
- `bridge` (default, implements Goal 2): live capture of headers from the running ZCode app.
- `static`: passthrough when a real Zhipu/Z.ai API key or coding-plan entitlement exists (`ZHIPU_BIGMODEL_API_KEY` env / auth-store key) — routes to `open.bigmodel.cn/api/anthropic` or `api.z.ai/api/anthropic` as a plain key provider. Selected automatically when such a key is present; otherwise disabled. (Future-proofing; not usable today.)

## 4. Components

Location: `~/.omp/agent/extensions/omp-zhipu-start-plan/` (TypeScript, `@oh-my-pi/pi-coding-agent` type surface, zod for config — same pattern as existing extensions). Registered in `~/.omp/agent/config.yml` `extensions:`.

| File | Responsibility |
|---|---|
| `src/extension.ts` | Entry; loads config; calls `pi.registerProvider("zai-start-plan", …)`; installs `session_start`/`session_shutdown` lifecycle for capture cleanup; `/login` wiring via `oauth`. |
| `src/config.ts` | Zod schema: `mode: "bridge"\|"static"` (default `bridge`), `autoLaunch` (default true), `captureTtlMs` (default 240000), `maxWaitForCaptureMs` (default 8000), `probeOnMiss` (default false), `relayBaseUrl`, `modelPins`. |
| `src/credentials.ts` | Read-only access to `~/.zcode/v2/credentials.json`: parse `enc:v1:<iv>.<tag>.<ct>` (base64url), derive key per F1, AES-256-GCM decrypt, extract `zcodejwttoken`. Reads `telemetry-state.json` for `X-Device-Mid`, `setting.json` for locale. Static fingerprint assembly: `User-Agent: ZCode/3.7.7`, `HTTP-Referer: https://zcode.z.ai`, `X-Title: Z Code@electron`, `X-ZCode-App-Version: 3.7.7`, `X-Platform: linux-x64`, `X-Os-Category: linux`, `X-Os-Version: <uname -r>`, `X-Client-Language`, `X-Client-Timezone`. Result cached with `captureTtlMs`; re-read on 401. |
| `src/capture.ts` | CDP bridge (Approach 1 core): (1) find ZCode main process (`pgrep -f /opt/ZCode/zcode`); if absent and `autoLaunch`, spawn `/opt/ZCode/zcode` detached; (2) `SIGUSR1` → main pid → debugger at `ws://127.0.0.1:9229`; (3) main-process `Runtime.evaluate` installs a `fetch` wrapper that records `(url, headers)` of requests to `zcode.z.ai` into a process-global ring buffer (idempotent: a marker variable prevents double-install); (4) poll buffer for a relay request carrying `X-Aliyun-Captcha-Verify-Param`; (5) cache captcha pair + current `Authorization` with `captureTtlMs`; (6) cleanup: restore original `fetch` and `SIGUSR1`/socket state on `session_shutdown`. Handles 9229-in-use race with backoff and a clear error. |
| `src/proxy.ts` | Implements `streamSimple`: resolves jwt (credentials cache) + fingerprint + captcha pair (capture cache; wait up to `maxWaitForCaptureMs`, return retryable error on miss), builds the relay request (Anthropic-messages body with `model`, `max_tokens`, `messages`), streams SSE, maps relay business codes (see §6), emits `AssistantMessageEventStream` events. |
| `src/models.ts` | GLM model catalog pinned to relay IDs (from ZCode catalog): GLM-5.3 (context 1M, out 128k, reasoning high/low/max), GLM-5.2 (context 1M, out 128k), GLM-5-Turbo (context 200k, out 128k). No cost fields (plan-billed). |

## 5. Auth lifecycle

- `oauth.login(callbacks)`: no interactive prompt. Detects a live ZCode session (credentials store present with `zcodejwttoken` + `zai-start-plan: available` in entitlement cache), imports it, returns `{ jwt, deviceMid, capturedAt }`; OMP persists via its standard auth store (`agent.db`), `storeCredentialsAs`-style semantics. Errors (store missing/unreadable) surface a clear message: "Start Plan session not found — log in to ZCode first."
- `refreshToken(credentials)`: re-decrypt the store; return fresh creds when the stored JWT is younger than `captureTtlMs`, else error → re-login.
- `getApiKey(credentials)`: current `zcodejwttoken`.
- Static fingerprint parts are invariant; only JWT and captcha pair rotate with TTL.

## 6. Error handling & retry

Relay business codes (research §7):

| Code | Handling |
|---|---|
| 3007 captcha failed | Force capture refresh (clear cache; wait for next captured param up to `maxWaitForCaptureMs`); single retry; then fail with "captcha stale — open/use ZCode to refresh" (or `probeOnMiss` triggers a hint). |
| 3002 rate limited | Respect `Retry-After` header if present, else exponential backoff respecting OMP stream idle/first-event timeouts; surface `rate_limited`. |
| 1113 (HTTP 429) / 1005 | Fail fast with quota-exhausted message (insufficient balance / daily free-plan exhausted); **no** retry. |
| 3001/3006/3008–3010 | Surface provider error with relay message; no retry for 3001/3006, backoff for upstream-busy. |
| 401 on JWT | Invalidate credential cache → `refreshToken` → single retry. |
| Capture miss (ZCode idle) | Wait up to `maxWaitForCaptureMs`; on timeout return retryable error (OMP's own retry loop re-attempts after user activity in ZCode). |

Retries are bounded (max 1 explicit retry per classified cause) to respect the free-plan quota.

## 7. Security & policy decisions

- **No captcha bypass.** The plugin never generates, solves, or forges Aliyun captcha params; it only reuses the header set minted by the user's own running ZCode app for the user's own session. The F4 gate remains fully in force against third parties.
- **Read-only app interaction.** `capture.ts` uses only the SIGUSR1 inspector (opened by Electron, not by us) and a reversible `fetch` wrapper on the main process; original `fetch` restored on shutdown. No app-state mutation, no credential writes into ZCode stores.
- **Credential handling.** `credentials.ts` decrypts the user's own store on the user's own machine using the documented F1 scheme (machine-derivable key — same trust boundary as file permissions). Requires no external secret.
- **Disclosed residual risk:** using the app-bound Start Plan outside the ZCode UI may violate Z.Code's terms for the free tier; quota remains the account's own. The F1/F2/F4 findings remain appropriate for responsible disclosure per research §10 — this plugin does not publish or weaponize them beyond the account owner's own use.

## 8. Verification plan

1. **Unit — `credentials.ts`:** decrypt a fixture `enc:v1` blob → correct `zcodejwttoken`; TTL cache invalidation; missing-store error.
2. **Unit — `capture.ts`:** hook install idempotency (marker variable prevents double-install); restore-on-cleanup restores original `fetch`.
3. **Unit — `config.ts`:** schema defaults and validation errors.
4. **Unit — `proxy.ts`:** body construction (Anthropic messages shape), header assembly (fingerprint + captcha pair present), code mapping table.
5. **E2E (the "verify thing"):** OMP CLI one-shot with `modelRoles.default: zai-start-plan/glm-5.2` (temp config overlay), ZCode app running; prompt "reply with the word OK only"; assert 200 + SSE events + `stopReason: end_turn` + usage tokens through the relay; then capture-disabled negative run → assert mapped 3007-style error, not a hang.

## 9. Out of scope today

- Approach 2 (standalone header source) — rejected; would defeat F4 and was flagged to the user. Can be revisited only on explicit user instruction.
- BigModel / coding-plan consumption until the account actually holds them (`mode: static` is the intended cutover path).
- Windows/macOS host support (fingerprint constants are linux-x64 today; platform fields are config-driven so they can be extended without structural change).