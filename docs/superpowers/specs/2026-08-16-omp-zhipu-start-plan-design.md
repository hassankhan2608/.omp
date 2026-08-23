# Design — Native OMP ZCode Start Plan Provider

**Revised:** 2026-08-23  
**Status:** Approved for implementation  
**Target:** `~/.omp/agent/extensions/omp-zcode-start-plan/`

## Goal

Provide ZCode Start Plan models directly inside Oh My Pi without a localhost HTTP relay. The extension must support GLM-5.3 and GLM-5-Turbo, repeated OAuth login for multiple accounts, native OMP usage reporting, automatic per-request Aliyun verification, and redacted endpoint diagnostics.

The existing checkout at `/home/laughingman/repos/zcode-relay` is an independent fallback and must not be modified, imported, stopped, or removed by this work.

## Proven upstream contract

Installed ZCode 3.8.1 uses:

- Provider: `builtin:zai-start-plan`
- Endpoint: `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`
- Wire format: Anthropic Messages with SSE streaming
- Authentication: `Authorization: Bearer <zcode plan JWT>`
- Verification: fresh `X-Aliyun-Captcha-Verify-Param` and `X-Aliyun-Captcha-Verify-Region` on every model request
- Identity headers matching ZCode 3.8.1

The installed app consumed Weekend Build quota successfully. An Electron 41.0.3 probe using the official Aliyun SDK and ZCode inputs produced a valid 280-character verification parameter automatically. The former jsdom approach is rejected because it produces Aliyun `F001`, caches one-use parameters, and does not match ZCode’s Electron renderer.

## Architecture

```text
OMP provider zcode-start-plan
  │
  ├─ OAuth login → OMP AuthStorage account rows
  ├─ UsageProvider → ZCode billing endpoints
  ├─ Electron verification broker → fresh parameter per request
  └─ streamSimple transport
       │
       └─ ZCode Anthropic endpoint → OMP AssistantMessageEventStream
```

The extension registers one provider through `pi.registerProvider("zcode-start-plan", config)`. It uses a custom API identifier and `streamSimple`, so OMP owns model selection, session state, retries, credential choice, usage history, and account rotation while the extension owns only the ZCode-specific wire contract.

## Components

### `src/extension.ts`

Extension entry point. Registers:

- provider `zcode-start-plan`
- models `glm-5.3` and `glm-5-turbo`
- OAuth login and credential mapping
- normalized usage provider
- `/zcode-status` and `/zcode-probe`
- session shutdown cleanup for the Electron broker

### `src/oauth.ts`

Runs ZCode’s browser authorization-code flow:

1. Start a loopback callback on an OS-assigned port.
2. Open `chat.z.ai/api/oauth/authorize` with ZCode’s registered client ID.
3. Validate callback state.
4. Exchange the code at `zcode.z.ai/api/v1/oauth/token`.
5. Persist the returned Start Plan JWT as OAuth `access`, the provider access token as `refresh`, and returned `email`/`accountId` identity fields.

Repeated `/login zcode-start-plan` adds or updates accounts through OMP’s standard identity-key upsert. No plugin-owned account database.

### `src/captcha/client.ts` and Electron broker assets

A persistent Electron 41.0.3 subprocess communicates with the extension over newline-delimited JSON on stdio.

For every model request it:

1. Loads a clean local renderer page.
2. Sets the ZCode 3.8.1 user agent.
3. Loads the official Aliyun CAPTCHA SDK.
4. Calls `startTracelessVerification()` with live `sceneId`, `region`, and `prefix` from ZCode client configuration.
5. Returns one verification parameter to exactly one waiting request.

Parameters are never cached or reused. The BrowserWindow remains hidden for successful traceless verification. It becomes visible only when Aliyun’s SDK requires interactive verification. Broker crashes reject pending calls, and the next request starts a fresh broker. Session shutdown closes it.

### `src/transport.ts`

Implements OMP `streamSimple`:

- uses the credential selected by OMP in `SimpleStreamOptions`
- obtains a fresh verification parameter
- converts OMP context into Anthropic Messages format
- sends ZCode identity, trace, auth, and CAPTCHA headers
- parses batch/SSE responses into `AssistantMessageEventStream`
- preserves reasoning, tool calls/results, usage, cancellation, and stop reasons

Provider errors retain HTTP status and ZCode business code so OMP’s core auth retry can distinguish quota, rate-limit, and invalid-credential outcomes.

### `src/usage.ts`

Implements the standard `UsageProvider` supplied in `registerProvider`.

Per credential it calls:

- `GET https://zcode.z.ai/api/v1/zcode-plan/billing/current`
- `GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance`

It emits normalized limits for every entitlement bucket, including separate GLM-5.3 Weekend Build, GLM-5.3 trial, and GLM-5-Turbo balances. Reports include account identity, reset/expiry timestamps, endpoint metadata, and status. Native `/usage`, `omp usage`, history, and usage-aware credential selection consume these reports.

### `src/diagnostics.ts`

Maintains redacted process-local state:

- endpoint and model
- broker running/stopped
- last verification duration and outcome
- last HTTP status and request ID
- last usage fetch status and timestamp
- selected account email/account ID when available

`/zcode-status` displays state without network use. `/zcode-probe` explicitly performs one minimal GLM-5.3 request and therefore consumes quota. `ZCODE_START_PLAN_DEBUG=1` logs URL, header names, timing, status, business code, and request ID through `pi.logger`; it never logs JWTs, OAuth tokens, CAPTCHA values, or complete authorization headers.

## Multi-account behavior

OMP AuthStorage remains authoritative:

- OAuth credentials are keyed by `email`/`accountId`.
- Session credentials remain sticky for cache locality.
- Usage reports let OMP avoid exhausted accounts.
- Recognized auth/rate-limit/quota failures block the affected credential and rotate to a sibling.
- `/logout` and credential health use normal OMP surfaces.

The extension must not duplicate round-robin, block state, or credential persistence.

## Models

| Model | Context | Max output | Reasoning |
|---|---:|---:|---|
| `zcode-start-plan/glm-5.3` | 1,000,000 | 131,072 | low/high/max; always enabled |
| `zcode-start-plan/glm-5-turbo` | 200,000 | 131,072 | enabled |

Both are text-only for this integration. Costs are zero in model metadata because consumption is entitlement-based; actual balance is represented by the usage provider.

## Error policy

| Condition | Behavior |
|---|---|
| CAPTCHA automatic failure | Allow SDK interactive fallback; otherwise return `captcha_verification_failed` without crashing OMP |
| CAPTCHA broker exit | Reject pending request; restart broker on the next request |
| HTTP 401 | Surface invalid credential so OMP rotates or requests login |
| HTTP 429 / code 1113 | Surface quota/rate-limit semantics; no 30-minute blind retry |
| ZCode business quota exhausted | Mark the selected credential unavailable through OMP’s normal retry path |
| Upstream 5xx | Bounded retry through OMP; preserve request ID |
| Usage endpoint failure | Return no report for that account; do not block model calls |
| Client abort | Abort fetch and broker wait promptly |

## Installation and isolation

The package lives entirely under:

```text
~/.omp/agent/extensions/omp-zcode-start-plan/
```

It follows existing local extension layout with `package.json`, `src/`, `tests/`, `tsconfig.json`, and Bun lockfile. It is registered through OMP’s extension loading configuration. The existing relay provider `zcode-weekend` stays available during verification as a fallback.

## Verification

1. Unit: OAuth callback/state and token response validation.
2. Unit: Electron broker request correlation, restart, timeout, and per-request non-reuse.
3. Unit: Anthropic body conversion for text, thinking, tools, and tool results.
4. Unit: SSE conversion and usage accumulation.
5. Unit: billing payload normalization with multiple entitlement buckets and account identity.
6. Unit: diagnostics redact all credential and CAPTCHA material.
7. Type-check the extension.
8. Run `/login zcode-start-plan` and verify the account appears in OMP auth storage.
9. Run native `/usage` and verify Weekend Build/trial/Turbo buckets.
10. Run two consecutive direct OMP turns through `zcode-start-plan/glm-5.3`; both must succeed, proving fresh verification per request.
11. Run `omp -p --no-tools --no-session --model zcode-start-plan/glm-5.3 --thinking low 'Reply with exactly OMP_PLUGIN_OK.'` and observe `OMP_PLUGIN_OK`.
12. Run `/zcode-status` and confirm diagnostics contain no secrets.
