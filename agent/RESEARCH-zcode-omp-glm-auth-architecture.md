# ZCode vs OMP GLM Authentication Architecture — Research Notes

**Date:** 2026-08-16
**Scope:** Local static analysis of two client applications on Linux (`/opt/ZCode`, `@oh-my-pi/pi-coding-agent@17.3.5`) and behavioral observation of their network endpoints. No server-side systems were accessed beyond each client's own documented API surfaces using the local account's own credentials.

---

## 1. Artifacts Analyzed

### ZCode (desktop app, v3.7.7)

| File | Role |
|---|---|
| `/opt/ZCode/resources/app.asar` | Electron main bundle (extracted for analysis) |
| `/opt/ZCode/resources/glm/zcode.cjs` | Agent runtime bundle (13 MB, unminified names partially preserved) |
| `/opt/ZCode/resources/model-providers/models_catalog_china_llm_zcode_2026-06-03.json` | Preset model catalog |
| `~/.zcode/v2/credentials.json` | Encrypted credential store (`enc:v1:` format) |
| `~/.zcode/v2/config.json` | Provider registry (resolved baseURLs, apiKeys, enabled state) |
| `~/.zcode/v2/coding-plan-cache.json` | Entitlement status cache |
| `~/.zcode/v2/setting.json` | Provider family selection state |
| `~/.zcode/v2/telemetry-state.json` | Device MID storage |
| `~/.zcode/v2/logs/YYYY-MM-DD.log` | Main-process log (host stdout relayed as `[host-log]`) |

### OMP (oh-my-pi agent CLI)

| File | Role |
|---|---|
| `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` | Single-file bundled CLI (all provider definitions embedded) |
| `~/.omp/agent/agent.db` | SQLite credential store (table `auth_credentials`) |
| `~/.omp/agent/config.yml` | Model roles / defaults |
| `~/.omp/agent/models.yml` | User-defined custom models |

---

## 2. Provider Identity Model

### 2.1 ZCode provider IDs (from host bundle)

```
V.zai                 "Z.ai - API Key"          → openai/anthropic key auth against api.z.ai
V.zaiCodingPlan       "Z.ai - Coding Plan"      → chat.z.ai OAuth, subscription-gated
V.zaiStartPlan        "Z.ai - Coding Plan"      → free-tier plan via zcode.z.ai relay (distinct provider)
V.bigmodel / V.bigmodelCodingPlan / V.bigmodelStartPlan  → open.bigmodel.cn equivalents
V.zapi                                           → internal test endpoint
```

Notable: the **Start Plan** and **Coding Plan** are *separate providers* with separate credentials and separate endpoints, despite near-identical display names (`"Z.ai - Coding Plan"` in both cases in `config.json`).

### 2.2 OMP provider IDs (from cli.js)

```
zai                  → API-key provider; models use api:"anthropic-messages",
                       baseUrl:"https://api.z.ai/api/anthropic"
zai-coding-plan      → OAuth login flow (storeCredentialsAs:"zai"), callbackPort 54548,
                       device-code flow against chat.z.ai, token exchange yields a
                       Zhipu-format key ({id}.{secret}) stored in agent.db
```

OMP models catalog for `zai` includes glm-4.5 → glm-5.3 family, all pinned to `api.z.ai/api/anthropic` with Anthropic-messages wire format.

---

## 3. Credential Storage

### 3.1 ZCode: `~/.zcode/v2/credentials.json`

- Format: `enc:v1:<iv_b64url>.<tag_b64url>.<ciphertext_b64url>`
- Cipher: **AES-256-GCM**, 12-byte IV, 16-byte tag
- Key: `sha256(secret)` where `secret = env ZCODE_CREDENTIAL_SECRET` or the deterministic fallback
  `zcode-credential-fallback:{platform}:{homedir}:{username}` (all locally available values)
- **Finding F1:** the at-rest encryption is obfuscation, not secrecy — no KDF secret, no OS keyring binding. Any local process running as the same user can derive the key. (Desktop also runs a gnome-keyring daemon; it is not used for this store.)
- Stored keys observed (names): `oauth:zai:access_token` (HS512 JWT, `user_type:PERSONAL`), `zcodejwttoken` (HS256 JWT, claims `user_id`, `sub`, `iat` — **no `exp` claim**), `oauth:zai:user_info`, `oauth:active_provider`.
- **Finding F2:** the relay JWT carries no expiry claim; revocation must therefore be server-side.

### 3.2 OMP: `~/.omp/agent/agent.db`

- SQLite, plaintext JSON in `auth_credentials.data` (tokens unencrypted at rest)
- `zai` provider row: `{"access":"<zhipu-format-key>","refresh":"","expires":<far-future>,"email":...}`
- **Finding F3:** OMP stores OAuth-derived keys in plaintext SQLite, in contrast to ZCode's encrypted store.

---

## 4. Endpoints

### 4.1 Observed on the wire / in bundles

| Client | Base | Path | Purpose |
|---|---|---|---|
| OMP | `https://api.z.ai` | `/api/anthropic/v1/messages` | model calls (anthropic-messages) |
| OMP (key validation) | `https://api.z.ai` | `/api/coding/paas/v4/chat/completions` | login-time key validation |
| OMP (usage poll) | `https://api.z.ai` | `/api/monitor/usage/quota/limit` | quota read (`Authorization: <raw key>`, no Bearer) |
| ZCode | `https://zcode.z.ai` | `/api/v1/zcode-plan/anthropic` (+ `/v1/messages`) | model calls (Start Plan relay) |
| ZCode | `https://zcode.z.ai` | `/api/v1/zcode-plan/billing/current`, `/billing/balance` | plan billing |
| ZCode | `https://api.z.ai` | `/api/biz/subscription/list` | coding-plan entitlement check |
| shared | `https://chat.z.ai` | `/api/oauth/authorize` | OAuth |

Confirmed by live TCP observation: ZCode processes held ESTAB connections only to the `zcode.z.ai` subnet (43.109.2.0/24 via `zcode.z.ai.a1.initaa.com` CNAME) plus Alibaba edge IPs — **not** to `api.z.ai` during normal chat traffic.

Edge infrastructure in front of `zcode.z.ai`: Alibaba **ESA** (headers `Server: ESA`, `Set-Cookie: acw_tc=...`, `cdn_sec_tc`, `visitor_id`, `EagleId`).

### 4.2 Resolved provider registry (ZCode `config.json`)

```
builtin:zai             baseURL https://api.z.ai/api/anthropic            (key auth)
builtin:zai-start-plan  baseURL https://zcode.z.ai/api/v1/zcode-plan/anthropic
                        apiKey = zcodejwttoken (JWT)
builtin:bigmodel        baseURL https://open.bigmodel.cn/api/anthropic
```

---

## 5. Request Construction

### 5.1 OMP outbound model request

```
POST https://api.z.ai/api/anthropic/v1/messages
Authorization: Bearer <zhipu-format key>
anthropic-version: 2023-06-01
Content-Type: application/json

{"model":"glm-5.3","max_tokens":...,"messages":[...]}   # Anthropic messages shape
```

### 5.2 ZCode outbound model request (reconstructed from bundles)

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
Authorization: Bearer <zcodejwttoken>
x-api-key: <zcodejwttoken>
X-Aliyun-Captcha-Verify-Param: <per-request param>
X-Aliyun-Captcha-Verify-Region: <region>
User-Agent: ZCode/3.7.7
HTTP-Referer: https://zcode.z.ai
X-Title: Z Code@electron
X-ZCode-App-Version: 3.7.7
X-Platform: linux-x64            # platform-arch
X-Os-Category: linux
X-Os-Version: <kernel>
X-Client-Language / X-Client-Timezone
X-Device-Mid: <uuid from telemetry-state.json>
x-request-id: <uuid>
anthropic-version / Content-Type

{"model":"GLM-5.2|GLM-5-Turbo|...","messages":[...]}     # same Anthropic messages shape
```

Header set cross-verified in three places: host bundle `buildZCodeSourceHeadersFromContext()`, agent bundle diagnostics (`outboundHeaderKeys`, `hasCaptchaVerifyParam`), and the redaction allowlist (`gM()`).

### 5.3 Agent↔host header negotiation (ZCode-specific)

The agent runtime does **not** own its auth material. Per model request it emits a
`providerRuntimeHeaders.request` (`{requestId, sessionId, modelRef, providerId, reason}` where
`reason ∈ {"model-request","captcha-retry"}`) to the desktop host, which responds with
`{headersApplied, errorMessage, providerRevision}`. The captcha param therefore originates in the
desktop process, not the agent bundle.

---

## 6. The Anti-Bot Gate (key finding)

Renderer bundle (`styles-OqUHW1P0.js`) loads the Aliyun captcha SDK:

```
https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
window.initAliyunCaptcha({ region, prefix })   // config from host getClientConfigs().configs.captcha
```

Two modes, distinguished in code: `traceless_passed` (invisible) and `interactive_displayed`
(popup shown to user; error class `CAPTCHA_INTERACTIVE_REQUIRED` if headless). The SDK produces
`captchaVerifyParam` + `captchaRegion`, attached as `X-Aliyun-Captcha-Verify-Param/-Region` on the
model request via the host header-negotiation channel above.

**Finding F4:** the Start Plan relay's *only* client-discrimination layer beyond the JWT is this
per-request Aliyun captcha param. The JWT itself is long-lived (F2) and requests replaying it with
the full fingerprint header set but without a fresh captcha param are rejected with business code
`3007` (`captcha verify failed`) — verified from curl and Node fetch, with and without ESA cookies
(`acw_tc` etc.) and over HTTP/2. I.e., the CDN cookies are not the gate; the app-level captcha is.

---

## 7. Error-Code Taxonomy (renderer i18n strings)

| Code | Meaning |
|---|---|
| 1113 (HTTP 429, z.ai open platform) | insufficient balance / no resource package |
| 1005 | daily free-plan quota exhausted |
| 3001 | bad request params |
| 3002 | rate limited |
| 3006 | model not in allowed set |
| 3007 | captcha verification failed |
| 3008/3009/3010 | upstream busy |

Entitlement state observed for the test account (from `coding-plan-cache.json`):
`zai-start-plan: available`; `zai-coding-plan: coding_plan_not_entitled`; and
`GET /api/biz/subscription/list → data: []` with the OMP-issued key, while
`GET /api/monitor/usage/quota/limit → "当前用户不存在coding plan"`.

---

## 8. Test Matrix (own account, own machine)

| # | Client / transport | Target | Result |
|---|---|---|---|
| 1 | OMP (native) | api.z.ai `/api/anthropic/v1/messages` | 429 code 1113 |
| 2 | curl, same request | api.z.ai `/api/anthropic/v1/messages` | 429 code 1113 (reproduced) |
| 3 | curl | api.z.ai `/api/coding/paas/v4/chat/completions` | 429 code 1113 |
| 4 | curl + JWT + fingerprint headers | zcode.z.ai `/api/v1/zcode-plan/anthropic/v1/messages` | 400 code 3007 |
| 5 | Node fetch (undici) + same | same | 400 code 3007 |
| 6 | curl + ESA cookies + HTTP/2 | same | 400 code 3007 |
| 7 | ZCode app (live) | same | 200, streams |

Delta between rows 4–6 and 7 is the captcha param (F4). Delta between rows 2 and 7 is endpoint +
token + captcha — i.e., two different trust domains.

---

## 9. Findings Summary

- **F1** ZCode credential encryption uses a deterministic machine-derivable key → at-rest
  protection is equivalent to file permissions, not cryptography. Recommend OS keyring
  (secret-service) or a user-provided passphrase KDF.
- **F2** Relay JWT has no `exp`; compromise requires server-side revocation.
- **F3** OMP stores OAuth tokens plaintext in SQLite (weaker than ZCode's scheme).
- **F4** Start-Plan free quota is enforced by client-side captcha generation + app-bound JWT at a
  dedicated relay host; the account-level API surface (`api.z.ai`) has no entitlement for the same
  quota. Anti-bot strength therefore rests entirely on Aliyun traceless captcha integrity.
- **F5** Provider naming collision: two distinct providers both render as "Z.ai - Coding Plan",
  which fuels user confusion between the app-bound free tier and the account-level paid coding plan
  (the original 1113 mystery in this investigation).

## 10. Responsible Disclosure

Findings F1/F2/F4 would be appropriate to report to Z.AI (security contact / responsible-disclosure
channel) before any publication. This document intentionally omits runnable decryption tooling and
any captcha-parameter reproduction steps; it documents the architecture and the observed behavior only.

---

## Appendix A — Complete list of local paths accessed during research

### A.1 ZCode application files (read-only analysis)

```
/opt/ZCode/resources/app.asar                                  # extracted → /tmp/zcode-extracted/
/opt/ZCode/resources/glm/zcode.cjs                             # agent runtime bundle (13 MB)
/opt/ZCode/resources/model-providers/models_catalog_china_llm_zcode_2026-06-03.json
/opt/ZCode/resources/tools/{bfs,ripgrep,ugrep}/                # bundled search tools (env-referenced)
```

### A.2 Extracted asar chunks actually grepped

```
/tmp/zcode-extracted/out/host/index.js                         # host service bundle (auth, providers, billing)
/tmp/zcode-extracted/out/host/chunk-XRHTBW6U.js                # shared chunk (URL constants, header builder)
/tmp/zcode-extracted/out/main/index.js                         # Electron main
/tmp/zcode-extracted/out/main/chunk-L5EAZUIY.js
/tmp/zcode-extracted/out/renderer/assets/styles-OqUHW1P0.js    # Aliyun captcha SDK integration
/tmp/zcode-extracted/out/renderer/assets/IntlProvider-C321H7m8.js  # error-code i18n strings
/tmp/zcode-extracted/out/renderer/assets/src-HCld2afU.js
```

### A.3 ZCode user-state files read

```
~/.zcode/v2/credentials.json          # enc:v1 store — jwt/oauth tokens (findings F1/F2)
~/.zcode/v2/config.json               # resolved provider registry, baseURLs, zai-start-plan apiKey
~/.zcode/v2/coding-plan-cache.json    # entitlement status cache
~/.zcode/v2/setting.json              # provider family selection
~/.zcode/v2/telemetry-state.json      # deviceMid used in X-Device-Mid header
~/.zcode/v2/logs/2026-08-16.log       # main log ([host-log] relay, env provenance lines)
~/.zcode/cli/db/db.sqlite             # located; not needed for findings
```

### A.4 OMP files read

```
~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js   # all provider defs
~/.omp/agent/agent.db                 # SQLite — table auth_credentials (finding F3)
~/.omp/agent/config.yml               # model roles
~/.omp/agent/models.yml               # custom models
~/.omp/agent/models.db                # located; catalog is embedded in cli.js instead
```

### A.5 Runtime inspection points

```
/proc/<zcode-cli-pid>/environ         # ELECTRON_RUN_AS_NODE=1 confirmed
/proc/<zcode-cli-pid>/cmdline         # argv = "zcode-cli", exe = /opt/ZCode/zcode
ss -tnp                                # live TCP → 43.109.2.x (zcode.z.ai) + 8.130.222.x (Alibaba edge)
ws://127.0.0.1:9229 (CDP inspector)   # activated on host pid via SIGUSR1; fetch hooked to buffer
                                      # outbound requests; restored after capture
```

### A.6 Temporary files created during research (all deleted in cleanup)

```
/tmp/ztk/jwt.txt                      # decrypted relay JWT (deleted)
/tmp/ztk/oauth.txt                    # decrypted oauth token (deleted)
/tmp/zck.txt                          # ESA cookie jar (deleted)
/tmp/zcode_req_dump.jsonl             # request dump target (unused; deleted)
/tmp/hook_dump.mjs / hook_dump2..4.mjs / read_dump.mjs / unhook.mjs   # CDP scripts (deleted)
```

Note: `/tmp/zcode-extracted/` (A.2) still exists on disk if further analysis is wanted; remove it
with `rm -rf /tmp/zcode-extracted` when done.
