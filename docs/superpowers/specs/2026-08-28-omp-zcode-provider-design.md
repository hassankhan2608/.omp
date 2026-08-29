# OMP ZCode Provider Design

## Goal

Port the essential coding-plan capability of [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) to a native OMP provider. Instead of running the repo's local HTTP reverse proxy, an OMP extension registers a `zcode` provider that sends Anthropic-format requests directly to the Z.AI / Bigmodel coding-plan upstream, using the same auth flow, identity headers, signing, and model catalog as the repo.

Per explicit user direction, the zcode-api repository is the sole reference. The repo was cloned to `/tmp/zcode-api`; nothing from any earlier provider attempt in this repository is read or reused.

## Evidence base

All facts below were extracted from the repo source by three read-only investigations (auth, proxy/upstream, server surface) and are quoted from code, not the README.

### Upstream contract (coding-plan, the default plan)

- Z.AI: `POST https://api.z.ai/api/anthropic/v1/messages`
- Bigmodel: `POST https://open.bigmodel.cn/api/anthropic/v1/messages`
- Upstream format is **always Anthropic** for coding-plan since repo v2.3 (`handler.ts`: `upstreamFormat = startPlan ? 'openai' : 'anthropic'`). The repo's OpenAI endpoints exist only to translate client bodies; a direct provider targeting Anthropic format needs no translation.
- Auth header: `x-api-key: {credentialString}` + `anthropic-version: 2023-06-01` (`upstream.ts buildAuthHeaders`).
- `credentialString` (`auth/types.ts`): Z.AI = `{apiKey}.{secret}`; Bigmodel = `{apiKey}`.
- `content-type: application/json`, `accept-encoding: gzip` (client value or gzip); `anthropic-beta` passthrough.

### Identity headers (`proxy/identity.ts`, every upstream request, exact order)

1. `HTTP-Referer: https://zcode.z.ai`
2. `User-Agent: ZCode/{appVersion}` (installed desktop default `3.10.1`; fallback `ZCode/unknown`)
3. `X-ZCode-App-Version: {appVersion}` — only if printable ASCII `/^[\x20-\x7e]+$/`
4. `X-Title: Z Code@{sourceTitle}` (default `cli`)
5. `X-ZCode-Agent: glm`
6. `X-Platform: {platform}-{arch}` (e.g. `linux-x64`)
7. `X-Release-Channel: production` (or `test` when `ZCODE_ENV=test`)
8. `X-Client-Language:` Intl locale
9. `X-Client-Timezone:` Intl timeZone
10. `X-Os-Category:` macos|windows|linux
11. `X-Os-Version:` os.release()
12. `X-Device-Mid:` stable UUIDv4, persisted once, never per-request random

All values gated by the same printable-ASCII check.

### Trace/attribution headers (`upstream.ts buildTraceHeaders` + `trace-headers.ts`)

Fresh per request (observe mode): `x-request-id`, `x-zcode-trace-id` (UUIDs); `x-zcode-session-type: main`; `x-query-id`, `x-session-id` (UUIDs). `x-session-id` is also the signing input, so it must be kept stable per conversation for cache affinity. Prefix stripping rules apply to explicit values: `query_`, `sess_`, `subagent_agent_`.

### Body transforms (`proxy/body-transformer.ts`)

1. OpenAI + `stream:true` → `stream_options.include_usage=true` (not needed when sending Anthropic format natively).
2. Anthropic → `cache_control:{type:"ephemeral"}` on the last content block of the last non-system message (idempotent; string content promoted to `[{type:"text",text,cache_control}]`).
3. Anthropic + OAuth `userId` → `metadata.user_id = {userId}` (merge, preserving other metadata).

### Client signing V4 (`proxy/client-signing.ts`) — gate-driven, fail-open

- Applies only to coding-plan https; unsigned paths: `/api/v1/zcode-plan/anthropic/v1/messages`, `/api/v1/zcode-plan/chat/completions`, `/api/v1/off-peak/anthropic/v1/messages`.
- Gate: `GET https://zcode.z.ai/api/v1/agent/configs` (identity headers minus `X-ZCode-Agent` and `X-Device-Mid`, plus `x-api-key: {credential}`); enabled iff `code===0 && data.codingPlanSignature.enable===true`. Cache 1 h; negative cache 60 s (network) / 30 s (unavailable).
- Handshake per upstream origin: `POST {origin}/api/paas/c1f3a7e2/v2/client`, headers `Authorization: {apiKeyId}.{apiKeySecret}` (no Bearer), body `{apiKey, nonce (32 hex), ts, sig}` where `sig = base64(HMAC-SHA256(key=HKDF-SHA256(ikm=secret, salt="WD_CLIENT_SIGN_KDF_SALT", info="getSignKey_hmac", 256bit), msg="get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"))`. Response `{code:200, data:{privateCipher}}`; `privateCipher = base64(iv[12] || AES-256-GCM ct)`, AAD = apiKeyId, key = HKDF(secret, salt, info="ed25519_priv"); plaintext utf8 → base64-decode → PKCS8 Ed25519 private key. Key cached per (origin, credential).
- Per request: `ts=Date.now()`, 32-hex nonce, message `{apiKeyId}\n{ts}\n{appVersion}\n{sessionId}\n{nonce}`, `sig = base64(Ed25519Sign(pkcs8, message))`. PoW: `seed = hex(SHA-256("{apiKeyId}\nzcode\n{sessionId}\n{ts}")).slice(0,32)`; find `candidate = {24-hex}{counter:08x}` with `SHA-256("{seed}\n{candidate}")` first byte 0. Headers appended: `X-Client-Ts`, `X-Client-Version`, `X-Client-Sig`, `X-Session-Id` (canonical case), `X-Client-Nonce`, `X-App-Id: zcode`, `X-Client-Pow`.
- Retry ladder: on 401 with `VERIFY_SIGNATURE_INVALID`/`VERIFY_APIKEY_EXPIRED` (in msg/reason/data.reason/error.reason/error.message): invalidate key, re-handshake, re-sign, retry once; second VERIFY 401 → permanent unsigned bypass for (origin, credential). Any failure → send unsigned.

### Endpoint routing (`proxy/endpoint-routing.ts`) — default ON, fail-open

`GET https://zcode.z.ai/api/v1/agent/configs` returns `data.proxyEndpoint.mapping` (`from`/`to` exact URL match; currently rewrites `api.z.ai/api/anthropic/v1/messages` → `zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`). 5-min TTL, fail-open to the direct URL.

### Auth (`src/auth/*`)

Installed ZCode Desktop 3.10.1 uses a server-coordinated CLI polling flow for both providers. The older 3.1.x localhost authorization-code callback is historical and rejected by the currently registered client.

1. Generate a random 32-byte polling token (64 lowercase hex).
2. `POST https://zcode.z.ai/api/v1/oauth/cli/init` with `Authorization: Bearer {pollToken}`, `Content-Type: application/json`, body `{provider:'zai'|'bigmodel'}`.
3. Validate envelope `code === 0` and `data.flow_id`, `data.authorize_url`, `data.expires_at` (epoch seconds), `data.poll_interval_sec`.
4. Parse the HTTPS `authorize_url`; require a non-empty `state`. Set Z.AI `redirect_uri` or Bigmodel `redirect` to `https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback&app_version=3.10.1`.
5. Open/display the authorization URL. Poll `GET https://zcode.z.ai/api/v1/oauth/cli/poll/{encodeURIComponent(flow_id)}` using the same bearer polling token at the server-provided interval until expiry.
6. Poll status `pending` continues; `failed` throws; unknown status/envelope throws; retry transient network, 408, 429, and 5xx failures; fail immediately on other 4xx responses.
7. Status `ready` requires `data.token`, provider `access_token` (`accessToken` fallback for Bigmodel), and `data.user.user_id`; Bigmodel may additionally supply `refresh_token`, but coding-plan key resolution remains the stored request credential.
8. Key resolution (`auth/resolver.ts`):
   - Z.AI: `POST https://api.z.ai/api/auth/z/login {token}` → biz token; then `Authorization: Bearer {bizToken}`: `GET /api/biz/customer/getCustomerInfo` (pick org containing `默认机构` else first; project containing `默认项目` else first), `GET|POST /api/biz/v1/organization/{org}/projects/{proj}/api_keys` (reuse/create name `zcode-api-key`), `GET .../api_keys/copy/{apiKey}` → `secretKey`. Result `{apiKey, secret?, provider:'zai', userId?}`.
   - Bigmodel: same sequence on `https://bigmodel.cn` with raw `Authorization: {accessToken}` (no Bearer); result `{apiKey: apiKey + '.' + secret, provider:'bigmodel'}` (secret folded in).
9. OMP stores the resolved credential; no separate encrypted credential file. Apikey mode still splits on the first interior dot. Z.AI supplies no refresh flow; expiration recovery is re-login.

### Model catalog (`src/provider/models.ts`) — static

| id | name | ctx | maxOut | notes |
|---|---|---|---|---|
| glm-4.5-air | GLM 4.5 Air | 200000 | 128000 | reasoning |
| glm-4.6 | GLM 4.6 | 200000 | 128000 | reasoning (default) |
| glm-4.6v | GLM 4.6V | 200000 | 128000 | vision |
| glm-4.7 | GLM 4.7 | 200000 | 128000 | reasoning |
| glm-5 | GLM 5 | 200000 | 128000 | reasoning |
| glm-5-turbo | GLM 5 Turbo | 200000 | 128000 | reasoning |
| glm-5v-turbo | GLM 5V Turbo | 200000 | 128000 | vision |
| glm-5.1 | GLM 5.1 | 200000 | 128000 | reasoning |
| glm-5.2 | GLM 5.2 | 1000000 | 128000 | reasoning |
| glm-5.3 | GLM 5.3 | 1000000 | 128000 | reasoning |

## Scope

### Included (faithful port of repo behavior, native in OMP)

- Provider id `zcode`, direct Anthropic-format transport to `{anthropicBase}/v1/messages` (zai and bigmodel selectable).
- One-shot OAuth login (`/login zcode`) using ZCode 3.10.1's browser + CLI polling flow, followed by coding-plan key resolution (zai and bigmodel variants), plus apikey entry path.
- Credential persistence via OMP's own credential store (replaces the repo's encrypted file; no separate secret file). No refresh hook (none exists upstream).
- Full ZCode identity header fingerprint with stable `X-Device-Mid`; fresh trace UUIDs; stable `x-session-id` per conversation.
- Body transforms: last-block ephemeral `cache_control`; `metadata.user_id` for OAuth credentials.
- Client signing V4: gate probe, handshake, per-request sign + PoW, VERIFY-401 retry ladder, fail-open unsigned bypass.
- Endpoint routing rewrite via `agent/configs` (fail-open, 5-min TTL).
- Static 10-model catalog with the repo's metadata; `glm-4.6` default.
- All ported behavior covered by tests mirroring the repo's own test cases.

### Excluded (proxy-only subsystems, confirmed by research)

- Local HTTP server, proxy API-key gate, CORS.
- `/v1/responses` translation + ResponseStore (OMP speaks Anthropic/OpenAI natively).
- Web UI, Android control listener, MCP interception.
- Async off-peak pool and claim scheduler (oauth-only, proxy-oriented; ticket queue is a per-request long-poll bridge — defer).
- Start-plan gateway path (JWT + captcha + zcode_system.json injection) — proxy-specific plan; coding-plan is the ported surface.
- Client-session lineage inference (hash-based session guessing) — OMP owns sessions; provider keeps `x-session-id` stable per OMP conversation.

## Architecture

```text
OMP session (native agent loop, tools, streaming)
        |
        v
omp-zcode-provider extension
  ├─ oauth.ts      `/oauth/cli/init` + server-driven browser authorization + `/oauth/cli/poll/{flowId}`
  ├─ resolver.ts   zai/bigmodel coding-plan key resolution (repo 1:1)
  ├─ identity.ts   12-header ZCode fingerprint + stable X-Device-Mid
  ├─ trace.ts      fresh x-request-id/x-zcode-trace-id, stable x-session-id
  ├─ signing.ts    gate probe → Ed25519 handshake → sign + PoW → retry ladder
  ├─ routing.ts    endpoint-routing rewrite (agent/configs, fail-open)
  ├─ models.ts     static 10-model catalog (repo values)
  └─ extension.ts  pi.registerProvider("zcode", {...})
        |
        v
POST https://api.z.ai/api/anthropic/v1/messages   (or open.bigmodel.cn / ultra remap)
x-api-key: {apiKey}.{secret} | {apiKey}
```

OMP's `anthropic` wire API natively streams Anthropic `/v1/messages`, so no translation layer is required — the repo's OpenAI→Anthropic translator exists only because the proxy accepted OpenAI clients.

### Device identity

`X-Device-Mid` is a UUIDv4 generated once and persisted (repo: config file `identity.deviceMid`). ExtensionAPI does not expose settings during factory binding, so the extension persists it under OMP's agent directory; it survives restarts and stays stable across requests.

### Credential storage

OMP's `auth` contract stores the credential after login. Stored fields mirror `Credential`: `apiKey`, `secret?`, `provider`, `userId?`, `jwt?`. The extension resolves that envelope before invoking the native Anthropic transport, which receives `credentialString` = Z.AI `apiKey.secret`, Bigmodel `apiKey`.

## Error handling

- OAuth: malformed init/poll envelopes, invalid authorize URL/state, flow expiry, terminal `failed`, nonretryable 4xx, missing ready token/user — distinct actionable errors; transient failures retry only until the server expiry.
- Resolver: empty orgs/projects, failed key creation — surfaced, matching repo messages (`No organizations found`, etc.).
- Signing: all failures fail-open to unsigned; VERIFY-401 ladder bounded to one retry then permanent bypass per (origin, credential).
- Endpoint routing: network failure → direct URL (fail-open).
- Upstream 401: surfaces through OMP's credential handling; no silent retry beyond the signing ladder.

## Verification

### Automated tests (mirroring the repo's own test suites)

1. OAuth: exact init URL/header/body, authorize redirect rewrite, server interval/expiry validation, poll Authorization/path, pending→ready, failed/unknown status, transient retry vs nonretryable 4xx, expiry, abort, and ready token/user parsing. Tests derive from installed ZCode Desktop 3.10.1.
2. Resolver: `z/login` shape, 默认机构/默认项目 selection and fallbacks, api_keys reuse-vs-create, `copy/{apiKey}` secret retrieval, full `resolveCodingPlanCredential` for zai; bigmodel no-Bearer and key-folding variants. (Port of `resolver.test.ts`.)
3. Identity: all 12 headers, exact order, ASCII gating, appVersion fallback. (Port of `identity.test.ts`.)
4. Trace headers: fresh UUIDs per request, prefix stripping, session-type resolution. (Port of `trace-headers`/`session-context` tests.)
5. Body transforms: cache_control idempotency, string-content promotion, `metadata.user_id` merge. (Port of `body-transformer` coverage.)
6. Signing: handshake HMAC construction, privateCipher AES-GCM unwrap fixture (plaintext = base64(PKCS8)), signed message format, PoW verification, VERIFY-401 retry ladder, fail-open. (Port of `client-signing.test.ts` + the worked example `testkey.testsecret`.)
7. Endpoint routing: mapping rewrite, exact-match semantics, fail-open. (Port of `endpoint-routing.test.ts`.)
8. Models: catalog values match the repo table exactly.
9. Provider registration: exact provider id, base URL, OAuth callbacks, static models.

### Runtime smoke verification

1. Extension loads without diagnostics; `omp models zcode` lists the 10 models.
2. `/login` → search `ZCode`; choose Z.AI or Bigmodel; current server-driven authorization URL opens; polling completes; coding-plan key resolves.
3. `/model` → select `zcode/glm-4.6`; send a minimal prompt; streamed completion succeeds.
4. Log inspection: identity + trace headers present; no credential material logged.

## Acceptance criteria

- `omp models zcode` lists exactly the repo's 10-model catalog.
- `/login zcode` completes installed ZCode 3.10.1's init/authorize/poll flow and stores the resolved credential in OMP.
- Requests hit `{anthropicBase}/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`, the full identity fingerprint, trace headers, cache_control transform, and `metadata.user_id`.
- Signing V4 activates only when the server gate enables it and fails open; VERIFY-401 ladder behaves exactly as the repo's.
- Endpoint routing rewrites when the server table says so and fails open.
- Ported test suites for oauth, resolver, identity, trace, transforms, signing, routing, and models all pass.
- A real streamed completion from `zcode/glm-4.6` works through OMP.
