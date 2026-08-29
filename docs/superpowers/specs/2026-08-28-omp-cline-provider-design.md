# OMP Cline Provider Design

## Goal

Add a local OMP provider named `cline` that uses Cline's official OAuth and model-catalog libraries, supports OMP's native multi-account credential pool, and exposes only models that Cline identifies unambiguously as free.

The resulting user flow is:

1. Run `/login cline`.
2. Authenticate through Cline's WorkOS device-code flow.
3. Repeat `/login cline` to add further Cline accounts.
4. Select a free Cline model through `/model`.
5. Send normal OMP requests through Cline's OpenAI-compatible API.

## Evidence and root cause

The installed Cline CLI is version 3.0.60. Its package includes `@cline/core` and `@cline/llms` version 0.0.81.

`@cline/core` publicly exports Cline's provider-auth registry and OAuth implementation, including `getProviderAuthHandler`, `loginClineOAuth`, `refreshClineToken`, `formatAccessToken`, and `normalizeStoredAccessToken`. Runtime inspection shows `getProviderAuthHandler("cline").login` calls `loginClineOAuth` with `useWorkOSDeviceAuth: true`.

`@cline/llms` publicly exports `getModelsForProvider("cline")`. This returns the model metadata used by Cline's usage-billing provider.

Cline's live `/api/v1/ai/cline/recommended-models` response contains an authoritative `free` array. At design time it contains `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-flash`, and `poolside/laguna-s-2.1:free`. Availability is dynamic; the extension must consume the array rather than embed these observations.

The existing `pi-clinepass-provider` authenticates against the same Cline service but registers the `clinepass` provider and paid `cline-pass/*` model identifiers. A free Cline account therefore authenticates successfully but cannot use those paid subscription model IDs.

The user-supplied `@maxpaulus/pi-cline` package confirms relevant Cline endpoints but is reference material only. It reimplements OAuth, omits stable `accountId` and `email` fields, exposes paid catalog models, treats missing prices as zero, and targets older Pi package APIs. Copying it would break OMP-native multi-account identity and the free-only guarantee.

OMP extension providers with an `oauth` definition automatically participate in `/login`. OAuth credentials that preserve stable `accountId` and `email` fields automatically participate in OMP's multi-account upsert, account selection, session stickiness, cooldown, rotation, pinning, and refresh coordination.

## Authority and compatibility boundary

Behavioral authority, in order:

1. exported APIs from the installed Cline packages;
2. observable behavior of Cline CLI 3.0.60;
3. OMP 18.0.8 extension and credential contracts;
4. local compatibility code in this extension.

The extension must call Cline's exported auth and catalog functions rather than copy minified Cline implementation code. It may adapt types and field names at the OMP boundary, but it must not independently recreate Cline's OAuth protocol while supported exports exist.

The extension pins compatible `@cline/core` and `@cline/llms` versions. Dependency upgrades are deliberate compatibility changes and require the same auth, catalog, and live smoke verification described below.

## Scope

### Included

- OMP provider registration under the exact ID `cline`
- `/login cline` WorkOS device-code OAuth
- OAuth refresh
- multiple Cline accounts in OMP's credential pool
- Cline's OpenAI-compatible chat-completions transport
- Cline's catalog converted to OMP model records
- fail-closed free-model filtering
- provider-specific error classification where OMP does not already supply it
- behavioral tests and an actual OMP smoke test

### Excluded

- ClinePass subscription model aliases
- paid Cline models
- copying credentials automatically from `~/.cline`
- a separate plugin-owned account database or rotation algorithm
- a local HTTP relay
- a second agent or tool loop
- Cline task, team, cron, MCP, or editor features
- API-key login
- extension/browser callback OAuth and its manual-code fallback
- `openai-codex` and `oca` provider authentication

## Architectural boundary

```text
OMP conversation and native tools
              |
              v
omp-cline-provider extension
  | OAuth adapter -> @cline/core
  | catalog adapter -> @cline/llms
  | free-model policy
              |
              v
https://api.cline.bot/api/v1
```

The extension owns only provider integration. OMP remains responsible for conversation state, tools, credential persistence, account selection, request retries, and the agent loop.

## Package layout

The local extension lives at `agent/extensions/omp-cline-provider` and contains focused modules:

- `index.ts`: extension entry point and provider registration
- `oauth.ts`: OMP-to-Cline OAuth adapter and token normalization
- `models.ts`: Cline catalog conversion and free-model filtering
- `errors.ts`: narrow Cline response classification, only where needed
- `package.json`: pinned runtime dependencies and extension metadata
- tests beside the implementation or under the extension's existing test convention

No module may read or write credentials except through values supplied to and returned from OMP's OAuth contract.

## Provider registration

The extension registers:

- provider ID: `cline`
- display name: `Cline`
- base URL: `https://api.cline.bot/api/v1`
- wire API: `openai-completions`
- authorization header: enabled
- OAuth login, refresh, and API-key conversion callbacks
- dynamically derived free models

The provider must appear in `/login` as `Cline`. Models must appear under `cline/<model-id>`.

Registration fails with an actionable message if the Cline catalog contains no safely classified free model. It must never recover by exposing a paid model.

## OAuth flow

### Supported modes and selected mode

Cline core contains several authentication paths, but they are not interchangeable:

- `cline` provider handler with `useWorkOSDeviceAuth: true`: WorkOS device authorization used by `cline auth cline`;
- `loginClineOAuth` with `useWorkOSDeviceAuth: false`: extension/browser OAuth using a localhost callback, with manual code input as a fallback;
- `openai-codex` provider handler: separate Codex OAuth credentials and endpoints;
- `oca` provider handler: separate Oracle Code Assist OAuth credentials and endpoints;
- API-key authentication: non-OAuth provider configuration.

This extension implements only the first path. It must obtain the `cline` handler through Cline core's provider-auth registry and preserve that handler's login, refresh, credential-normalization, and request-key semantics. It must not expose a mode selector or fall through to callback, manual-code, Codex, OCA, or API-key authentication.

Behavioral verification of the installed CLI produced a device code and an `https://authkit.cline.bot/device?...` verification URL without opening a localhost callback listener. The OMP flow must exhibit the same behavior.

### Login

`/login cline` invokes the login operation from Cline core's `cline` provider auth handler. That handler selects `loginClineOAuth` with `useWorkOSDeviceAuth: true`, matching `cline auth cline` in Cline CLI 3.0.60.

The login path:

1. asks Cline core to begin WorkOS device authorization;
2. reports the verification URL and user code through OMP's OAuth progress/auth callbacks;
3. opens the verification URL when the active OMP surface supports it;
4. lets Cline core poll WorkOS for authorization completion;
5. lets Cline core register the resulting tokens with Cline;
6. converts the returned credentials to OMP's OAuth credential shape.

The adapter preserves:

- access token
- refresh token
- expiry timestamp
- stable Cline account ID
- account email

Cline-specific metadata not required by OMP is not persisted. Tokens and device authorization responses must not be logged. The short-lived user code may be displayed only through the interactive auth flow.

Cancellation, device-code expiry, polling timeout, authorization denial, and Cline registration failure remain distinct actionable errors. The adapter must not turn those cases into a generic missing-token error.

### Existing Cline CLI credentials

The extension does not automatically import `~/.cline/data/settings/providers.json`.

Automatic import would cause repeated `/login cline` calls to upsert the same externally selected CLI account, obstructing predictable enrollment of additional OMP accounts. OMP receives its own OAuth grants and owns its credential pool independently. Each `/login cline` run starts Cline's device flow for the account the user authorizes.

### Refresh

Refresh invokes the refresh operation from Cline core's `cline` provider auth handler, which delegates to Cline's official refresh implementation.

A refresh result must retain the original `accountId` and `email` when Cline omits either field. A changed non-empty account ID is rejected because refresh must not mutate one stored credential into another account.

Invalid or revoked refresh credentials disable only the affected OMP account through OMP's normal credential failure path. Transient refresh failures remain retryable and must not erase working credentials.

### Access-token formatting

Cline core distinguishes storage and request formats. The `cline` provider handler normalizes stored credentials by removing the `workos:` marker and formats request credentials by adding the marker required by Cline API requests.

Login and refresh return the handler-normalized token to OMP. The provider's API-key conversion uses the same handler semantics before dispatch. It must add exactly one marker, preserve the remaining token bytes, and reject an empty normalized credential.

## Multi-account behavior

The extension does not implement its own account collection.

Each OAuth login returns stable `accountId` and `email` fields to OMP:

- matching account ID: update the existing credential;
- different account ID: add a separate credential;
- mutable email: display metadata only, never identity;
- refresh: update only the selected credential.

OMP owns:

- credential persistence
- account listing and pinning
- per-session account stickiness
- rotation among eligible accounts
- per-account cooldown and backoff
- concurrent refresh ownership
- disabled-credential state

No plugin state, token, cooldown, or refresh result may cross account boundaries.

## Model catalog and free-only policy

Free eligibility comes only from Cline's live `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` response. The extension validates the response and extracts exact IDs from its non-empty `free` array of model descriptors (`{ id, name, description, tags }`).

Model metadata comes from `getModelsForProvider("cline")`. The exposed catalog is the intersection of:

1. descriptor IDs present in the live Cline `free` array; and
2. IDs with valid metadata in Cline's own `cline` catalog.

Catalog pricing is not an eligibility signal and may describe upstream routing cost rather than the user's Cline charge. The extension must not infer free eligibility from zero, missing, stale, or malformed pricing and must not treat an upstream `:free` suffix as sufficient when Cline's authoritative free array omits that ID.

Paid and non-recommended models are removed before OMP sees the model list. The extension must not expose a configuration flag that disables this filter.

Converted model records preserve, where supplied:

- ID
- display name
- context window
- maximum output tokens
- input modalities
- tool capability
- image capability
- reasoning capability
- release/family metadata supported by OMP
- zero effective OMP cost fields, derived from Cline's authoritative free classification rather than copied upstream pricing

Unsupported metadata is discarded rather than encoded into unrelated OMP fields. A free ID missing valid Cline catalog metadata is omitted with a safe diagnostic; metadata is never invented.

`z-ai/glm-5.3-flash` is the preferred default while Cline includes it in the live `free` array and its catalog supplies valid metadata. Otherwise the first eligible model in deterministic catalog order becomes the default. Failure to fetch or validate the free array, or an empty intersection, fails provider registration closed. There is no paid, price-inferred, or stale fallback.

## Request compatibility

Requests use OMP's native `openai-completions` transport. The extension supplies model compatibility metadata required by Cline's endpoint, including classic system-role behavior when Cline rejects the OpenAI developer role.

Cline-specific maximum-token behavior should use OMP's model compatibility fields when available. A provider-scoped request hook is acceptable only when no native compatibility field represents Cline's transformation. No global request mutation is permitted.

The extension must preserve OMP tool calls, streaming, usage accounting, abort signals, and error propagation. It must not proxy, buffer, or reconstruct the response stream.

## Error handling

Error handling remains narrow:

- OAuth denial, cancellation, device-code expiry, and polling timeout: actionable login messages
- invalid/revoked refresh: disable only the implicated account
- HTTP 401 after credential resolution: allow OMP's normal refresh/credential path
- HTTP 429 or provider rate limit: allow OMP's per-account cooldown and rotation
- HTTP 403 model entitlement failure: state that the selected model is unavailable to that Cline account; do not substitute another model silently
- unavailable or malformed recommended-model response: fail provider registration closed
- malformed catalog entry: omit that entry and continue if other eligible models remain
- network or 5xx failure: preserve retryable provider semantics

The plugin must not hide status codes, request IDs, or safe provider messages that help diagnose an upstream failure. It must redact tokens, authorization codes, and credential-bearing URLs.

## Security and privacy

- OAuth credentials are stored only through OMP's credential storage.
- No credential is copied into extension configuration, model metadata, logs, exceptions, snapshots, or tests.
- OAuth state, device authorization, polling, and registration remain owned by Cline core.
- Device authorization polling stops after success, failure, cancellation, or timeout.
- Model catalog data is treated as untrusted input and validated before conversion.
- Account identity is the stable account ID, not email or bearer token.
- The extension performs no telemetry beyond OMP and Cline's existing behavior.

## Verification

### Automated behavioral tests

Tests cover observable contracts:

1. resolution of Cline core's exact `cline` provider auth handler;
2. login selecting WorkOS device authorization rather than callback/manual-code mode;
3. device authorization reporting an `authkit.cline.bot/device` URL and user code without opening a callback listener;
4. inclusion only when an ID is present in a valid descriptor from Cline's live `free` array;
5. exclusion of zero-priced, `:free`, paid, or missing-price IDs absent from that array;
6. exclusion of free IDs missing valid Cline catalog metadata;
7. malformed recommended-model responses failing closed;
8. deterministic ordering and default selection;
9. Cline-to-OMP model capability conversion;
10. storage normalization removing exactly one leading `workos:` marker;
11. request formatting adding exactly one leading `workos:` marker;
12. rejection of an empty normalized token;
13. login credential conversion preserving `accountId` and `email`;
14. refresh preserving missing identity metadata;
15. refresh rejecting a changed account ID;
16. two distinct login account IDs remaining distinct through the OMP registration contract;
17. provider registration using the exact ID, base URL, API, and OAuth callbacks;
18. exposed catalog IDs exactly matching the validated free/catalog intersection.

OAuth network behavior is tested at the adapter boundary with injected or mocked Cline exports. Tests must not copy Cline core's own protocol tests.

### Runtime smoke verification

Verification uses the actual OMP surface:

1. load the local extension without diagnostics;
2. open `/login` and confirm `Cline` appears;
3. start `/login cline` and observe the WorkOS verification URL and device code;
4. complete device authorization with a Cline account;
5. repeat login with a second account and confirm both distinct account identities are retained by OMP;
6. open `/model` and confirm every `cline` model belongs to the current live Cline `free` array;
7. select `cline/z-ai/glm-5.3-flash` when available;
8. send a minimal prompt and observe a successful streamed completion;
9. verify the request is attributed to the selected OMP account and no non-free model appears.

If a second real Cline account is unavailable, the automated distinct-account contract test supplies proof for account coexistence, while the runtime report explicitly limits its live evidence to one account. No claim of live two-account verification is made without completing both logins.

## Acceptance criteria

The change is complete when:

- `/login` lists `Cline`;
- `/login cline` completes Cline's official WorkOS device-code flow;
- OAuth refresh works through Cline's official refresh implementation;
- distinct Cline account IDs coexist in OMP's native account pool;
- stored access tokens are normalized and request tokens carry exactly one `workos:` marker;
- `/model` exposes exactly the valid intersection of Cline's live `free` array and Cline catalog;
- `z-ai/glm-5.3-flash` is selected as default when still recommended free and available;
- a free Cline model produces a streamed OMP completion with native tools intact;
- every exposed model ID is present in Cline's current authoritative `free` array;
- automated tests pass;
- the actual OMP login, model-selection, and completion paths are smoke-tested.

## Feasibility result

The live completion endpoint initially returned HTTP 403 (`... is only available via Cline product surfaces`) because Cline enforces product-surface identity via request headers.

The user explicitly directed full behavioral mimicry of the Cline CLI. The provider now sends the exact request-identity headers produced by Cline's own `resolveProviderRequestHeaders` (`X-CLIENT-TYPE: cline-cli`, `User-Agent: Cline/<version>`, `X-CLIENT-VERSION`, `X-PLATFORM`, `X-CORE-VERSION`, `HTTP-Referer`, `X-Title`, `X-Task-ID`), which clears the 403. A live authenticated completion succeeded.

Model metadata is sourced from Cline's live catalog (`https://models.dev/api.json`, provider key `cline`) via `fetchLiveProviderModels`, with the bundled `@cline/llms` catalog as fallback. This exposes the current authoritative free set, including `z-ai/glm-5.3-flash`, which the stale bundled catalog omitted.

Status: working. `/login cline` completes WorkOS device auth, `/model` lists the live free models, and free-model completions stream through OMP's native OpenAI-compatible transport.

Note: this relies on presenting Cline CLI identity headers. If Cline tightens product-surface enforcement (e.g. signature or attestation checks), this path may stop working and would need re-evaluation.
