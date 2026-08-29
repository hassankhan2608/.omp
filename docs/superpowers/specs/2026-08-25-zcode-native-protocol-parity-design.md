# ZCode Native Protocol Parity Design

## Goal

Make `omp-zcode-start-plan` reliably reproduce current ZCode Start Plan client behavior without running a local HTTP relay or delegating the agent/tool loop to ZCode. The plugin remains a native OMP provider while adopting the maintained `TriDefender/zcode-api` implementation's proven upstream protocol behavior where it applies to Start Plan.

## Evidence and root cause

The active plugin at `agent/extensions/omp-zcode-start-plan` includes the three-attempt `3010` admission retry introduced in commit `2cb01d8`. A live GLM-5.3 invocation with debug logging timed out after 90 seconds before sending a model request. The Electron CAPTCHA broker emitted repeated hidden stderr chunks and exhausted its 80-second internal and 90-second external timeouts. No admission response was received; the current root failure is CAPTCHA initialization, not admission retry.

The pinned reference checkout's locked test suite completed with 532 passing tests, zero failures, and 1,470 assertions across 35 files. The relay is the primary maintained implementation reference for its observable behavior, but it is not the authority for behavior it never exercises. In particular, it does not send Start Plan traffic to the native Anthropic endpoint and it has no unified model-response classifier for `3007`, `F001`, `3010`, `3012`, or `1305`; its narrower CAPTCHA utilities do recognize F008 duplicate-token errors. The in-process Aliyun CAPTCHA engine, identity emitters, bounded-pool mechanics, trace headers, and selected wire invariants are applicable; the native endpoint classifier and retry coordinator are new OMP code grounded in live official traffic.

## Audit scope, provenance, and authority

The reference was audited at immutable commit `32d508dd5cc6afddaf091048c737e789769c8555`, not at a moving branch. The audit covered:

- all 155 tracked paths;
- a numbered corpus of all 129 human-authored text, source, test, fixture, workflow, build, Android, and documentation files: 29,514 original lines;
- all 35 test files executed by the locked suite;
- the committed Android `server.cjs` bundle separately as a 118,558-line generated artifact;
- committed Android native libraries by content hash, including duplicate library trees;
- workflows, dependencies, release automation, issue templates, bundled assets, and version synchronization;
- 13 independent production/test/operations line-audit reports;
- an additional full-corpus Model X adversarial audit and independent production and test scout audits.

The durable audit bundle is `/home/laughingman/repos/zcode-api-audit-32d508d`. It contains the numbered source corpus, every line-audit report, the Model X report, both scout reports, and Qwen execution logs. The preserved source checkout is `/home/laughingman/repos/zcode-api-reference`.

Generated artifacts are not treated as additional hand-written protocol authority. Rebuilding the Android bundle succeeded but was not byte-identical to the committed bundle; visible differences include line-ending drift in the embedded web UI and stale bundled configuration values. Duplicate native libraries that occur in both Android trees had matching hashes, but the repository does not provide complete release attestation, provenance, or reproducible-build evidence. The migration therefore derives code from audited TypeScript source and tests, never from the generated bundle or native binaries.

When evidence conflicts, authority is:

1. live request/response behavior captured from the installed official ZCode client;
2. executable contracts in the pinned relay tests;
3. pinned relay production source;
4. relay documentation, comments, generated bundles, and release artifacts.

This order resolves two material conflicts. Live official traffic uses `/api/v1/zcode-plan/anthropic/v1/messages`; the relay sends Start Plan through `/api/v1/zcode-plan/chat/completions` and forces OpenAI format (`src/proxy/upstream.ts:35,71-79`, `src/proxy/handler.ts:128-131`). The native Anthropic path appears only in the relay's signing exemption set (`src/proxy/client-signing.ts:44-48`) and has no relay end-to-end test. Likewise, the relay retries only a response-header CAPTCHA challenge once (`src/proxy/handler.ts:156-165,249-285`). Its F008 utility is reusable, but native endpoint classifications for `3007`, `F001`, `3010`, `3012`, and `1305` must be verified against live fixtures rather than inferred from relay proxy behavior.

## Architectural boundary

The plugin retains this flow:

```text
OMP conversation and native tools
              |
              v
Native ZCode protocol layer
              |
              v
ZCode Start Plan Anthropic endpoint
```

It must not introduce a local HTTP proxy, ZCode app-server child process, or second agent/tool loop.

## Components

### Protocol configuration

A focused configuration component loads the current ZCode client configuration and exposes only Start Plan fields:

- CAPTCHA scene, region, prefix, SDK URLs, and expiry metadata
- Start Plan endpoint metadata when explicitly present
- feature gates that directly affect Start Plan requests
- current client version and release channel

Required CAPTCHA configuration fails with a precise typed error. Optional routing metadata fails open. Coding Plan endpoint mappings must not be applied to Start Plan unless the server explicitly marks them applicable.

Configuration and immutable SDK resources use bounded shared caches with explicit expiration and invalidation. Account-sensitive cookies, CAPTCHA state, and tokens belong to the selected account profile and are never reused by another account. A CAPTCHA initialization or challenge response invalidates only the profile state implicated by that response.

### Persistent account profiles

Each OMP credential receives a complete persistent client profile keyed by OMP's stable internal account ID, never by its mutable email, display name, or bearer token. The profile contains:

- one randomly generated, persistent `X-Device-Mid`
- ZCode and Aliyun cookies
- stable CAPTCHA fingerprint state
- account-sensitive CAPTCHA configuration state
- the account's bounded token inventory

Selecting or rotating a credential atomically selects its associated profile. A profile survives process restarts, but no state crosses account boundaries. Sensitive cookies use OMP's protected credential storage when available; any file-backed fallback must be owner-readable only and contain no bearer token.

This design provides deterministic profile continuity, not anonymity. ZCode can still correlate accounts through public IP address, platform characteristics, and network behavior. Identity values must never be randomized per request or per solve.

The protocol layer mirrors current ZCode 3.9.1 identity fields:

- `X-Device-Mid`
- client version, release channel, platform, and architecture
- ZCode user agent and relevant origin/referer fields
- request and trace identifiers, plus query/session identifiers when an explicit OMP conversation context exists

Trace ID and any emitted query/session IDs identify one logical model request and remain stable across its retries. Each wire attempt gets a fresh request ID and CAPTCHA token. Requests without explicit OMP conversation context do not receive synthetic query/session attribution solely to imitate the relay. Authentication and account-profile identity remain stable until OMP deliberately rotates credentials.

### In-process CAPTCHA solver

The Electron broker is replaced completely by a bounded `happy-dom` Aliyun solver adapted from the MIT-licensed reference. Any substantially copied source retains required MIT attribution.

The solver provides:

- the minimum browser APIs required by the official Aliyun SDK
- stable browser/device fingerprinting
- cookie and immutable CDN-resource caching
- abortable initialization and solve operations
- bounded solve concurrency
- fresh, single-use token acquisition
- duplicate-token detection
- deterministic typed failures

Token acquisition is lazy per account. Each active account may retain at most two ready tokens, with a global cap of four across all profiles. Refill runs only while the plugin is active and stops on plugin shutdown. The migration retains the reference pool's leasing, uniqueness, idle-decay, race, and pressure-control contracts but retunes its 20/40–120 public-service defaults to these local caps. The CPU governor remains available as an adapted, tested mechanism but is disabled by default for the tiny local pool.

### Response classifier

A classifier parses raw upstream responses without consuming the caller-visible body and returns one typed outcome:

- success
- CAPTCHA initialization/challenge (`3007` or equivalent)
- fingerprint/risk-control rejection (`F001`)
- duplicate/reused CAPTCHA token (`F008`)
- admission concurrency (`3010`)
- system-prompt or protocol-identity rejection (`3012`)
- upstream model capacity (`1305`)
- credential failure
- quota/reserve failure
- IP or regional rejection
- unrelated upstream response

Unknown responses retain their original status, headers, and body.

### Retry state machine

One coordinator owns independent retry budgets so one failure class cannot consume another class's budget:

1. Serialize and retain one replayable logical Anthropic request.
2. Acquire a fresh CAPTCHA token.
3. Build a wire attempt with stable logical identity and fresh attempt identity.
4. Send the request and classify the response.
5. Apply only the transition assigned to that outcome.

Behavior:

- `F008`: discard the token and acquire a fresh token within the CAPTCHA retry budget.
- `3007`: invalidate CAPTCHA configuration/runtime state, reinitialize, and retry within the CAPTCHA budget.
- `F001`: invalidate fingerprint-sensitive runtime state and retry once; a persistent rejection returns a precise risk-control error rather than looping.
- `3010`: preserve the existing official policy of three same-account attempts with abortable waits of one second and two seconds; after the third failure, expose sibling-rotatable account unavailability.
- `3012`: validate the locally constructed request against the live-required system/identity fixture and return a precise protocol-shape rejection with upstream status, body, and request ID; do not blindly replay an unchanged request.
- quota/reserve and credential failures: delegate account rotation to OMP.
- `1305`: preserve the accurate upstream capacity error unless the server provides an explicit retry delay within the bounded request budget.
- unrelated errors: return immediately without retry.

Every wait and solve operation observes the original request's abort signal.

### Replayable requests

The transport buffers the serialized Anthropic body once and creates a fresh request object per wire attempt. Auth, body, trace ID, and any emitted query/session IDs remain stable. Request ID and CAPTCHA token change per attempt.

Unbounded streaming request bodies are rejected before the first attempt with an explicit unsupported-body error. They must not fail nondeterministically on a later retry.

### Streaming resilience

The native Anthropic stream remains untranslated. The transport must:

- tolerate nullable non-event payloads without crashing
- preserve content encoding only when bytes remain untouched
- remove stale length/encoding headers when synthesizing a response
- report an early-closed HTTP 200 stream as an incomplete upstream stream, not success
- surface structured upstream error messages and request IDs
- preserve Anthropic text, thinking, usage, and tool-use events exactly

OpenAI, Responses API, and Anthropic translation code from the reference must not be imported.

### OMP integration

Existing native behavior remains authoritative:

- OMP OAuth credential storage and account selection
- multi-account rotation
- 98% model-entitlement reserve
- native OMP usage reporting
- native OMP tools and conversation context
- GLM-5.3 and GLM-5-Turbo model definitions

The protocol layer receives the credential selected by OMP and resolves its associated persistent profile. It does not create a second account database or scheduler. Account removal deletes the associated profile secrets and tokens; disabling an account retains its profile for later reactivation.

## Clean cutover

The migration removes, in the same change:

- Electron CAPTCHA broker process
- broker IPC protocol
- broker-specific nested timeouts
- Electron dependency
- obsolete broker tests and diagnostics

There is no fallback to Electron. Keeping two CAPTCHA paths would double the protocol surface and hide failures behind inconsistent behavior.

## Upstream core adaptation

The preserved upstream reference is `TriDefender/zcode-api` commit `32d508dd5cc6afddaf091048c737e789769c8555`. Applicable protocol-core implementation and tests are copied or structurally adapted from that exact revision rather than reconstructed from descriptions.

The migration covers the behavior represented by these upstream modules and their tests:

- `captcha-happy`: browser environment, cookie handling, CDN cache, fingerprint stability, synchronous SDK transport, challenge solving, and failure extraction, with host-global state removed
- `captcha-solver`: lazy solver loading and lifecycle
- `captcha-token`: `certifyId` decoding, duplicate-error discrimination, and IP-block heuristics
- `captcha-pool`: leasing, freshness, replenishment, concurrency, failure backoff, duplicate handling, idle decay, and shutdown
- `captcha-cpu-governor`: bounded background work and resource pressure, retuned for the local pool limits and disabled by default
- `identity` and `trace-headers`: current ZCode identity fields, printable-value gates, header order, prefix normalization, and identifier emission
- `ordered-transport`: header ordering and response framing only if live/native transport evidence requires it; any port must add cancellation and connection timeout
- selected `upstream` fixtures: authentication, identity order, trace emission, compression honesty, and header stripping; its OpenAI Start Plan gateway tests do not cover the native Anthropic endpoint
- applicable configuration fixtures: identity, CAPTCHA, and Start Plan feature gates
- the classifier, replay coordinator, per-account profiles, and native Anthropic endpoint tests are new OMP modules because no corresponding relay implementation or test exists

Tests are carried over with their fixtures and observable assertions whenever the contract applies. Adaptations may change imports, dependency injection, storage, and OMP integration, but must not silently weaken an upstream assertion. Every intentionally excluded upstream test is excluded by module category below, not case by case for convenience.

Substantially copied source retains the upstream MIT copyright and license notice. A source provenance record maps each adapted local module to the upstream path and pinned commit so future upstream comparisons are mechanical.

### Source-to-plugin disposition

`COPY` means preserve observable logic and upstream tests with only import/licensing changes. `ADAPT` means retain the named contract while changing ownership, concurrency, cancellation, storage, or transport. `EXCLUDE` means neither source nor runtime dependency enters the plugin.

| Upstream source | Decision | Native OMP treatment |
|---|---|---|
| `src/proxy/captcha-token.ts` | COPY | Preserve `certifyId` decoding and precise F008/IP-family predicates. Carry its tests. |
| `src/proxy/captcha-happy.ts` | ADAPT, heavy | Preserve fingerprint constants, official SDK interception, guest browser patches, PE instrumentation, cache-eviction-on-parse-failure, strict verify-param gates, and bounded DOM reuse. Replace every process-global or cross-solve state channel; type the code instead of copying `@ts-nocheck`. Pin the audited deep-import runtime to `happy-dom@20.11.6`. |
| `src/proxy/captcha-solver.ts` | ADAPT, shrink | Preserve lazy dynamic loading. Remove unused backend switches and concurrency-reporting shims; the pool owns concurrency. |
| `src/proxy/captcha-pool.ts` | ADAPT, retune | Preserve freshness, LIFO lease semantics, `CertifyIdRegistry`, empty-pool racing, grace rescue, deduplication, idle decay, and storm detection. Use two ready tokens per profile, four globally, abort-aware waits, one sizing authority, and log-only IP/storm action. |
| `src/proxy/captcha-cpu-governor.ts` | ADAPT, light | Preserve the tested pressure bands and hysteresis. Disable by default for the local pool; fix the inconsistent `-3`/`-4` threshold. |
| `src/proxy/captcha.ts` | ADAPT | Preserve configuration fetch/cache and Aliyun challenge-header recognition. Make cache and invalidation profile-scoped and expose typed outcomes to the native coordinator. |
| `src/proxy/identity.ts` | ADAPT, light | Preserve field values, printable-value gates, release channel, and header order. Supply a persistent identity object from the selected profile instead of process environment variables. |
| `src/proxy/trace-headers.ts` | COPY semantics | Preserve header names and internal-prefix stripping. The coordinator supplies stable logical IDs and a fresh per-attempt request ID. |
| `src/proxy/session-context.ts` policy | ADAPT, extract only | Preserve conditional attribution: forward query/session identifiers only from explicit OMP conversation context and omit synthetic query/session IDs when no context exists. Exclude prompt-hash lineage inference and observe/enforce proxy modes. |
| `src/proxy/upstream.ts` | ADAPT, split | Preserve Start Plan bearer authentication, protected-header stripping, selected `anthropic-beta` passthrough, identity order, and encoding rules. Replace its OpenAI gateway URL and per-call identifier generation with the live native Anthropic endpoint and coordinator-owned lifetimes. |
| `src/proxy/ordered-transport.ts` | CONDITIONAL ADAPT | Port only if a live wire comparison proves header order cannot be reproduced by the host fetch implementation. Add abort, connect timeout, bounded headers/body, strict truncation handling, and safe keep-alive policy. |
| `src/proxy/handler.ts` utilities | ADAPT, extract only | Retain compression-label honesty, bounded gzip inflation, response cancellation before retry, and the pre-commit/post-commit distinction. Do not port the proxy handler. |
| `src/proxy/system-prompt.ts` and `zcode_system.json` | CONDITIONAL ADAPT | Preserve exact blocks and order as fixtures. Inject them into the native Anthropic request only if the live endpoint probe proves they are required; do not inherit OpenAI message-array insertion. |
| `src/runtime/node-fetch-compat.ts` | CONDITIONAL COPY | Use only if OMP's actual host has the Node/Undici 300-second headers/body timeout. Never install a process-global dispatcher from the CAPTCHA module. |

The following modules are new native code because the relay has no equivalent contract: response classifier, retry coordinator, replayable request factory, persistent profile store, per-profile cookie/resource namespaces, and direct native Anthropic Start Plan fixtures.

### Reference defects that must not survive adaptation

The relay remains the strongest maintained donor, but copying these defects would make the native plugin less reliable than the relay:

| Defect in pinned reference | Evidence | Required correction |
|---|---|---|
| CAPTCHA implementation bypasses type checking. | `src/proxy/captcha-happy.ts:1` | Native adapted code must type-check without `@ts-nocheck`. |
| Importing CAPTCHA can replace Undici's process-wide dispatcher from `HTTP_PROXY`/`HTTPS_PROXY`. | `captcha-happy.ts:131-136` | Use scoped request dispatch; importing the provider must not alter other OMP traffic. |
| Solver installs a process-wide `uncaughtException` handler that swallows unrelated host failures. | `captcha-happy.ts:1582-1603` | Catch at the solve boundary; install no process listeners. |
| Concurrent solves share frame, cookie container, request journal, stall state, and worker lifecycle. Destroying one DOM terminates the shared sync-fetch worker. | `captcha-happy.ts:118-121,139-165,1633-1638,1850-1864,1993-2006` | Per-profile/per-solve state, ref-counted or dedicated workers, and no sibling teardown. |
| Global aliases are installed on `globalThis` and cleanup does not reliably cover prototype-only aliases. | `captcha-happy.ts:1743-1848` | Prefer isolated execution; otherwise record and remove the exact installed key set. |
| Request log and memory/disk CDN caches are unbounded and remote SDK code has no content-integrity verification. | `captcha-happy.ts:123-126,185-260,342,417,1979-2004` | Bound by entry count, bytes, age, ownership, and known resource identity; fail explicitly on unapproved drift. |
| Main-thread synchronous fetch uses a fixed 8 MiB shared buffer and 30-second `Atomics.wait`; timeout does not cancel work. | `captcha-happy.ts:33,78-115` | Move blocking work off the host path, enforce bounds, and propagate abort through worker and network work. |
| Pool boot defaults disagree and target public-service volume. | `captcha.ts:81-82`, `captcha-pool.ts:80-98` | One local sizing configuration with hard per-profile/global caps. |
| Pool deadline, grace polling, refill staggering, and solve retry waits ignore request cancellation. | `captcha-pool.ts:254-283,621-655` | Every wait accepts the original `AbortSignal` and cleans up losers. |
| Raw ordered transport lacks request abort and connect timeout and always closes the connection. | `ordered-transport.ts:5-12,133-159` | Conditional port must destroy sockets on abort/timeout and prove framing completion. |
| Body transformer overwrites metadata, mutates cache breakpoints, and prepends non-idempotent OpenAI system messages. | `body-transformer.ts:92-157` | Exclude transformer; construct the native Anthropic body once without proxy mutations. |
| Client-session inference and CAPTCHA state are process-global, not account-partitioned. | `client-session.ts:123`, `captcha-happy.ts:125-148` | OMP conversation IDs and persistent account profiles are the only owners. |
| Android import script commits a credential seed. | `Android-APP/scripts/run-import.sh:3` | Never copy the script or secret; profile storage uses OMP protection. |
| Release inputs use floating action/runtime versions and provide no complete SBOM, attestation, or reproducible-build proof. | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, generated bundle rebuild result | Pin copied runtime dependencies and record source provenance; do not trust release binaries as source. |

Correct upstream invariants are retained: strict verify-param length/security-token validation (`captcha-happy.ts:1866-1902`), cache eviction on parse/evaluation failure (`captcha-happy.ts:518-569,700-745`), short-write repair (`captcha-happy.ts:243-250`), header name/value validation (`ordered-transport.ts:166-170`), chunk truncation failure (`ordered-transport.ts:48-55`), and auto-decompression header honesty (`handler.ts:342-369,393-401`).

### Complete exclusion map

Every audited file not assigned above belongs to one of these excluded groups:

- `src/server/**`, Android control/server code, and web UI: local proxy, authentication gate, wildcard CORS, console capture, and control plane are outside the native provider boundary.
- `src/translator/**`, `responses-handler`, and `src/responses/**`: OpenAI/Responses translation can lose or synthesize thinking signatures, image blocks, tool IDs, tool errors, and event ordering. OMP already provides native Anthropic messages and tools.
- `src/async/**`: off-peak ticket transport is not Start Plan. Only its tested pre-commit/post-commit retry concept is reused.
- `src/mcp/**`: relay web-UI MCP proxying is unrelated to native OMP tools.
- `body-transformer.ts`: proxy-only cache, metadata, stream-option, and system-message mutations.
- `client-session.ts` and the inference/mode portions of `session-context.ts`: prompt-hash lineage and proxy observe/enforce modes duplicate OMP conversations and are not partitioned by account. The explicit-context forwarding policy is adapted above.
- `client-signing.ts` and `endpoint-routing.ts`: the native Start Plan paths are explicitly signing-exempt, and arbitrary server-directed URL rewriting would expose credentials. Revisit only on new live Start Plan evidence.
- `dump.ts`: synchronous unredacted body dumping is not production protocol.
- `src/auth/**`: OMP owns OAuth, credential encryption, rotation, and stable account IDs; the relay store's machine-derived key is not adopted.
- `src/config/**`, `src/provider/**`, `src/index.ts`, and CLI tests: OMP owns provider registration and configuration. Model catalog numbers may be compared as data, not copied as another registry.
- all Android Gradle/Kotlin/native libraries/scripts/assets, GitHub workflows/templates, root proxy configs, README, and PROMPT: packaging, maintenance evidence, or provenance only.

No excluded module may be reintroduced as a transitive runtime dependency of an adapted donor file.

### Upstream maintenance procedure

Future relay updates are consumed deliberately:

1. Fetch a new candidate commit into the preserved checkout without moving the recorded baseline.
2. Diff only donor modules, their direct dependencies, applicable tests, and fixtures against `32d508dd5cc6afddaf091048c737e789769c8555`.
3. Run the candidate's complete locked suite before interpreting a change.
4. Re-run live native Anthropic endpoint probes for auth, challenge signaling, identity, and system-block requirements.
5. Classify each upstream change as applicable contract, proxy-only behavior, defect fix, or new defect.
6. Port the smallest applicable change with its upstream assertion; add a native test where the relay still lacks coverage.
7. Update the per-file provenance record to the exact new source commit. Never bulk-copy a moving branch or generated bundle.

## Explicit exclusions

The implementation must not add:

- local HTTP proxy or proxy API key
- OpenAI, Anthropic, or Responses API translators
- admin UI or web chat
- Docker runtime
- off-peak ticket gateway
- ZCode app-server session relay
- large public-service CAPTCHA pool; the pool and CPU-governor mechanics remain, but use the bounded local limits
- Coding Plan V4 signing or endpoint rewriting unless live Start Plan configuration explicitly enables it

## Testing strategy

Applicable reference tests and fixtures are copied comprehensively, then adapted to the native OMP boundary. Tests concerning proxy translation, admin APIs, web UI, Android packaging, off-peak queues, MCP proxying, or Coding Plan-only behavior are excluded because their production modules are excluded.

Reference-test disposition:

| Test source | Treatment |
|---|---|
| `captcha-token.test.ts` | Carry the pure token/error contracts directly. |
| `captcha-pool.test.ts` | Adapt all LIFO, TTL, dedupe, deep-idle, bank-one, empty-pool race, grace-rescue, all-failure, and storm-cooldown cases to local caps; add cancellation and cross-profile cases. |
| `captcha-cpu-governor.test.ts` | Carry pressure-band and hysteresis cases; add disabled-default and tiny-cap clamping. |
| `identity.test.ts` | Carry exact key order, value, environment precedence, and printable fallback; replace global environment ownership with two-profile isolation. |
| selected `upstream.test.ts` cases | Extract trace-prefix, identity-order, protected-header stripping, auth scheme, encoding, wire order, and truncation contracts. Exclude Start Plan OpenAI gateway URL/body cases. |
| selected `session-context.test.ts` cases | Extract explicit-context forwarding and no-context omission; exclude prompt-hash lineage and observe/enforce proxy-mode cases. |
| `body-transformer.test.ts` | Preserve the exact system-block fixture only. Exclude mutations of messages, metadata, `cache_control`, and `stream_options`. |
| `captcha-happy.ts` and `captcha.ts` | Write new direct tests: upstream supplies no direct solver/facade suite, so copied pool mocks are insufficient evidence. |
| translator, server, responses, async, MCP, signing, routing, client-session inference, auth-store, config-loader, Android, and CLI tests | Exclude with their production modules. Do not count them toward native parity coverage. |

The solver tests must exercise official SDK initialization with controlled immutable fixtures, synchronous and asynchronous SDK fetch paths, strict token gates, cookie continuity, cache corruption/expiry, worker failure, concurrent solves, teardown, and abort. They must also prove importing and using the provider adds no process exception listeners, replaces no global dispatcher, leaves no global browser aliases, and does not cross profile boundaries.

Required tests:

- successful solver initialization and token acquisition
- configuration, cookie, and immutable-resource cache expiry
- bounded concurrency and unique token delivery
- abort during initialization, solving, and retry waits
- `3007`, `F001`, `F008`, and `3012` classification and assigned transitions, including no unchanged-request retry for `3012`
- independent CAPTCHA and admission retry budgets
- exact `3010` one-second/two-second three-attempt behavior
- stable logical identity and fresh per-attempt identity, with explicit-context query/session forwarding and no-context omission
- stable profile selection for each account across process restarts
- strict isolation of device MID, cookies, CAPTCHA state, and tokens between accounts
- atomic credential/profile switching during account rotation
- replayable request body across every retry class
- unknown response preservation
- null SSE payload tolerance
- incomplete HTTP 200 stream detection
- native Anthropic thinking, text, usage, and tool-use preservation
- account reserve and rotation integration

The test suite must demonstrate red-green behavior for each changed observable contract and remain traceable to the pinned upstream test where one exists.

## Runtime verification

Completion requires:

1. A live probe captures the native Anthropic endpoint, bearer form, required identity/system fields, and challenge signaling without exposing credentials in logs.
2. Focused plugin tests pass for solver, classifier, retry state, request replay, profile isolation, host safety, and streaming.
3. Full plugin tests pass with zero failures.
4. TypeScript type checking completes with zero diagnostics and no `@ts-nocheck` in adapted protocol code.
5. A host-safety smoke proves provider import/solve does not change the Undici dispatcher, add process exception listeners, leave browser aliases, or block the host beyond the bounded solve operation.
6. A two-account concurrent smoke proves distinct persistent device MIDs, cookies, token registries, and solver state before and after restart.
7. A real GLM-5.3 OMP invocation returns exactly `ok`.
8. A real GLM-5-Turbo OMP invocation returns exactly `ok`.
9. Debug evidence shows the native Anthropic model endpoint was reached, retry identifiers followed their lifetimes, and no Electron broker or local relay started.
10. The targeted diff is reviewed against the provenance matrix, committed once, and pushed to `origin/main` without unrelated workspace changes.

## Risks and controls

- Mutable Aliyun SDK resources: isolate browser shims and resource loading behind tested interfaces; bound caches and record accepted resource identity so drift fails explicitly instead of executing arbitrary stale code.
- Host contamination: no process-global dispatcher, exception listener, console hijack, browser alias, cookie container, request journal, or solver worker teardown may escape its owner.
- Anti-bot sensitivity: keep every account profile stable, classify risk failures precisely, serialize unsafe solver operations, and never randomize identity per request.
- Cross-account correlation: document that profiles isolate local state but cannot conceal a shared IP or machine; do not claim anonymity.
- Evidence gaps: native Anthropic endpoint and body-code behavior require live fixtures because the relay does not exercise them; no relay proxy assertion may substitute for that probe.
- Reference drift: pin revisions, retain the durable full audit, update per-file provenance, and keep Start Plan-specific tests independent of reference internals.
- Resource consumption: cap tokens per account and globally, bound caches/logs/workers, cancel losing races, and stop background work when inactive.
- Credential exposure: never copy the Android seed, write bearer tokens or full bodies to diagnostics, or inherit the relay's weak machine-derived credential-store key.
- Supply chain: pin the audited deep-import runtime to `happy-dom@20.11.6` rather than the relay's `^20.11.6` range. If adapted code actually requires Undici, pin the audited `undici@8.10.0`; otherwise omit it. Record lockfile integrity, and treat generated bundles and release binaries as non-authoritative.
- Licensing: retain MIT attribution for substantially adapted source and avoid copying unrelated code.
- Protocol regressions: preserve raw native Anthropic blocks and SSE event order; exclude translation/body-shaping layers implicated in upstream defects and closed issues.
