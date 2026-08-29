# ZCode Native Protocol Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hanging Electron CAPTCHA broker with the audited relay protocol core while preserving native Anthropic transport, OMP multi-account rotation, isolated persistent account profiles, and exact official retry behavior.

**Architecture:** A private credential descriptor carries OMP's stable account ID and access token into the custom stream without exposing the descriptor upstream. A persistent profile store owns one device MID, cookie jar, CAPTCHA state, token registry, and health record per account. Adapted relay CAPTCHA, pool, governor, identity, trace, and selected wire contracts feed a native response classifier and retry coordinator; the provider continues to call the official Anthropic Start Plan endpoint directly.

**Tech Stack:** TypeScript 5.9, Bun 1.4, `happy-dom@20.11.6`, OMP `pi-ai`/`pi-coding-agent`, native `fetch`, SQLite or OMP protected credential/profile storage as available.

**Spec:** `docs/superpowers/specs/2026-08-25-zcode-native-protocol-parity-design.md`

## Global Constraints

- Pinned donor: `TriDefender/zcode-api` commit `32d508dd5cc6afddaf091048c737e789769c8555`, preserved at `/home/laughingman/repos/zcode-api-reference`.
- Evidence authority: live official native Anthropic traffic, donor executable tests, donor production source, then documentation/comments.
- Preserve `/api/v1/zcode-plan/anthropic/v1/messages`; never import the donor's OpenAI/Responses translators or local HTTP server.
- Preserve OMP OAuth ownership, sibling credential rotation, 98% reserve, native tools, native Anthropic blocks, and model catalog.
- Account-sensitive state is profile-scoped: two ready tokens per profile and four globally; immutable SDK resources alone may be shared.
- Adapted code must type-check without `@ts-nocheck`, process-global dispatchers/listeners/browser aliases, or uncancelled waits.
- Pin `happy-dom` exactly to `20.11.6`; add `undici@8.10.0` only if an adapted, tested code path needs it.
- Substantially adapted donor files retain MIT attribution and a path/commit provenance record.
- Every behavior change follows red-green TDD; do not weaken a donor assertion without documenting why it does not apply to native OMP.
- Remove Electron, broker IPC, broker files, and broker fallback in the same clean cutover.

---

### Task 1: Credential Descriptor and Persistent Profile Store

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/profile/credential.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/profile/store.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/profile/types.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/profile-credential.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/profile-store.test.ts`
- Modify: `agent/extensions/omp-zcode-start-plan/src/extension.ts`

**Interfaces:**
- Produces: `encodeZcodeCredential(credentials: OAuthCredentials): string`
- Produces: `decodeZcodeCredential(value: string): { accountId: string; accessToken: string }`
- Produces: `ZcodeProfileStore.open(path?: string): Promise<ZcodeProfileStore>`
- Produces: `store.getOrCreate(accountId: string): Promise<ZcodeAccountProfile>`
- Produces: `store.transaction<T>(accountId: string, update: (profile: ZcodeAccountProfile) => T | Promise<T>): Promise<T>`
- Produces: `store.delete(accountId: string): Promise<void>` and `store.close(): Promise<void>`
- Profile fields: schema version, account ID, UUIDv4 device MID, cookies, CAPTCHA cache metadata, token records, health state, timestamps.

- [ ] **Step 1: Write descriptor tests** proving two accounts encode differently, decode to exact account/token values, malformed descriptors fail before network use, and descriptor text never equals or prefixes the bearer token.
- [ ] **Step 2: Run `bun test tests/profile-credential.test.ts`** and confirm missing-module failure.
- [ ] **Step 3: Implement a versioned base64url JSON descriptor** (`zcode-profile-v1.<payload>`) with strict schema validation; never accept a raw fallback after cutover.
- [ ] **Step 4: Write profile-store tests** using a temporary path: stable MID across reopen, distinct MIDs/cookies/tokens for two accounts, atomic concurrent updates, `0600` storage, disabled-profile retention, and deletion.
- [ ] **Step 5: Run `bun test tests/profile-store.test.ts`** and confirm missing-store failure.
- [ ] **Step 6: Implement the store** with process-safe transactional persistence. Prefer the existing OMP SQLite/runtime facilities if directly available; otherwise use Bun SQLite in WAL mode with one row per account and JSON columns validated on read. Never store bearer or refresh tokens.
- [ ] **Step 7: Change provider `oauth.getApiKey`** to return `encodeZcodeCredential(credentials)` while usage continues to receive OMP's real OAuth credential object.
- [ ] **Step 8: Run both profile tests and `bun run typecheck`**; confirm all pass.
- [ ] **Step 9: Commit** `feat(zcode): add persistent account profiles`.

### Task 2: Current Identity and Trace Contracts

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/protocol/identity.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/protocol/trace.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/protocol-identity.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/protocol-trace.test.ts`
- Remove after integration: `agent/extensions/omp-zcode-start-plan/src/identity.ts`

**Interfaces:**
- Consumes: `ZcodeAccountProfile.deviceMid`
- Produces: `buildZcodeIdentityHeaders(profile, runtime?): Array<readonly [string, string]>`
- Produces: `createLogicalRequestIdentity(context?): ZcodeLogicalIdentity`
- Produces: `createAttemptIdentity(logical): ZcodeAttemptIdentity`
- Logical identity: stable trace ID and optional explicit query/session IDs.
- Attempt identity: fresh request ID plus logical fields.

- [ ] **Step 1: Adapt donor `identity.test.ts` assertions** for exact header values/order, ASCII gates, release channel, language/timezone, platform/OS, device MID, and two-profile isolation.
- [ ] **Step 2: Run identity tests** and confirm missing implementation.
- [ ] **Step 3: Adapt donor identity logic** without environment-owned device state; pin client identity to observed current ZCode 3.9.1 and accept injected runtime values for deterministic tests.
- [ ] **Step 4: Adapt trace tests** for donor header names/prefix stripping plus official behavior: trace stable, request ID fresh, explicit OMP query/session forwarded, absent context omitted.
- [ ] **Step 5: Implement trace contracts** using `randomUUID()` and immutable records.
- [ ] **Step 6: Run identity/trace tests and typecheck**.
- [ ] **Step 7: Commit** `feat(zcode): mirror profile identity headers`.

### Task 3: CAPTCHA Token and Error Primitives

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/token.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/errors.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-token.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-errors.test.ts`

**Interfaces:**
- Produces: `decodeCertifyId(verifyParam: string): string | undefined`
- Produces: `isDuplicateCaptchaError(error: unknown): boolean`
- Produces: `classifyCaptchaFailure(error: unknown): CaptchaFailure`
- `CaptchaFailure.kind`: `duplicate | risk-control | initialization | ip-blocked | network | timeout | aborted | unknown`.

- [ ] **Step 1: Copy donor token fixtures and assertions** for certify ID extraction, malformed tokens, F008 discrimination, and IP-family errors; retain source provenance comments.
- [ ] **Step 2: Add native assertions** for `3007`, `F001`, abort, timeout, and unknown-error preservation.
- [ ] **Step 3: Run focused tests** and confirm missing modules.
- [ ] **Step 4: Copy/adapt donor token logic** exactly where applicable and implement typed error normalization without string-only loss.
- [ ] **Step 5: Run tests and typecheck**.
- [ ] **Step 6: Commit** `feat(zcode): classify captcha failures`.

### Task 4: Isolated Happy-DOM Solver Engine

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/environment.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/resource-cache.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/solver.ts`
- Create: `agent/extensions/omp-zcode-start-plan/tests/fixtures/captcha/` (controlled SDK/config/network fixtures)
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-environment.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-solver.test.ts`
- Modify: `agent/extensions/omp-zcode-start-plan/package.json`
- Modify: `agent/extensions/omp-zcode-start-plan/bun.lock`

**Interfaces:**
- Consumes: account profile identity/cookie state and `CaptchaSolveConfig`.
- Produces: `CaptchaSolver.solve(profileContext, config, signal): Promise<SolvedCaptchaToken>`
- Produces: `CaptchaSolver.invalidate(accountId, scope): Promise<void>`
- Produces: `CaptchaSolver.close(): Promise<void>`
- No global dispatcher, process listener, console hook, browser alias, cookie jar, request journal, or shared teardown.

- [ ] **Step 1: Pin `happy-dom@20.11.6`** and install from the plugin directory; do not add Undici yet.
- [ ] **Step 2: Copy controlled donor SDK fixtures** needed to execute initialization without live network dependence.
- [ ] **Step 3: Write host-safety red tests** recording dispatcher identity, process exception-listener counts, global keys, active workers, and cross-profile cookies before and after import/solve/close.
- [ ] **Step 4: Write solver red tests** for synchronous/asynchronous SDK fetch, cookie continuity, cache hit/expiry/corruption, short-write repair, strict token length/securityToken gates, mutable-resource rejection, worker failure, timeout, abort, concurrent profile solves, and teardown.
- [ ] **Step 5: Run solver tests** and confirm expected failures.
- [ ] **Step 6: Structurally adapt donor `captcha-happy.ts`** into typed focused modules. Preserve fingerprint constants, native-function masking, browser patches, official SDK interception, PE instrumentation, parse-failure eviction, and verify-param gates. Replace host globals with owned state; move blocking fetch to owned abortable worker execution with byte/time bounds.
- [ ] **Step 7: Implement bounded shared immutable-resource cache** keyed by approved URL/content identity; profile-scope cookies and mutable state.
- [ ] **Step 8: Run solver and host-safety tests repeatedly** (`bun test ... --rerun-each 10`) to expose teardown/race leaks, then typecheck.
- [ ] **Step 9: Commit** `feat(zcode): port isolated captcha solver`.

### Task 5: Token Pool and CPU Governor

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/pool.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/governor.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-pool.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-governor.test.ts`

**Interfaces:**
- Produces: `CaptchaPool.acquire(accountId, signal): Promise<CaptchaLease>`
- Lease transitions: `ready -> leased -> consumed | discarded`; sent or aborted leases never return to ready.
- Produces: `pool.invalidate(accountId, reason)`, `pool.snapshot(accountId?)`, and `pool.close()`.
- Caps: two ready per profile, four global; governor disabled by default.

- [ ] **Step 1: Adapt every applicable donor pool test**: LIFO, TTL, dedupe, deep idle, bank-one, empty-pool race, grace rescue, all-failure, storm cooldown, refill decay, and shutdown.
- [ ] **Step 2: Add red tests** for abort-aware deadlines/races, loser cancellation, two-profile isolation, per-profile/global caps, atomic single-use leasing, and consumed-on-network-failure semantics.
- [ ] **Step 3: Run pool tests** and confirm missing implementation.
- [ ] **Step 4: Adapt donor pool implementation** with injected solver/profile store, one sizing authority, account-partitioned registries, and abort-aware waits.
- [ ] **Step 5: Adapt donor governor tests** for pressure bands/hysteresis; add disabled-default, cap clamp, and corrected threshold tests.
- [ ] **Step 6: Implement governor** without changing pool caps or owning account state.
- [ ] **Step 7: Run pool/governor tests ten reruns and typecheck**.
- [ ] **Step 8: Commit** `feat(zcode): add isolated captcha token pool`.

### Task 6: CAPTCHA Configuration and Facade

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/config.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/captcha/client.ts` (replace existing content)
- Test: `agent/extensions/omp-zcode-start-plan/tests/captcha-config.test.ts`
- Replace: `agent/extensions/omp-zcode-start-plan/tests/captcha-client.test.ts`

**Interfaces:**
- Produces: `ZcodeCaptchaClient.acquire(profile, signal): Promise<CaptchaLease>`
- Produces: `client.handleChallenge(accountId, outcome): Promise<void>`
- Produces: `client.snapshot(accountId?): RedactedCaptchaSnapshot`
- Produces: `client.close(): Promise<void>`
- Configuration fetch uses profile identity, correct cookies, bounded shared immutable data, and explicit expiry.

- [ ] **Step 1: Adapt donor configuration/challenge tests** for config query fields, identity headers, cache TTL, parse failure, response-header challenge, and invalidation.
- [ ] **Step 2: Add red tests** proving config/cookies do not cross accounts and snapshots expose no token, cookie, bearer, or full MID.
- [ ] **Step 3: Run focused tests** and confirm expected failures.
- [ ] **Step 4: Implement the facade** over profile store, solver, and pool; retain exact challenge-header recognition and typed outcomes.
- [ ] **Step 5: Run tests and typecheck**.
- [ ] **Step 6: Commit** `feat(zcode): coordinate captcha profiles`.

### Task 7: Native Response Classifier

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/protocol/classifier.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/protocol-classifier.test.ts`
- Modify later/remove: `agent/extensions/omp-zcode-start-plan/src/admission.ts`

**Interfaces:**
- Produces: `classifyZcodeResponse(response: Response): Promise<ZcodeOutcome>` without consuming the returned body.
- Outcomes include success, `3007`, `F001`, `F008`, `3010`, `3012`, `1305`, credential, quota, IP/region, challenge header, and unrelated.
- Produces response synthesizers only for OMP rotation or precise typed terminal errors; all include upstream status/code/request ID and honest framing headers.

- [ ] **Step 1: Write table-driven red tests** using captured/sanitized official fixtures and audited issue shapes for every outcome, malformed JSON, non-JSON, unknown code, challenge header, and body preservation.
- [ ] **Step 2: Add `3012` tests** proving the unchanged request is never retried and the original request ID/body evidence survives redacted diagnostics.
- [ ] **Step 3: Run classifier tests** and confirm missing implementation.
- [ ] **Step 4: Implement strict schema-based classification** using response clones and bounded body reads; preserve unknown responses exactly.
- [ ] **Step 5: Implement honest synthetic responses** by deleting stale length/encoding/transfer headers and retaining upstream metadata.
- [ ] **Step 6: Run tests and typecheck**.
- [ ] **Step 7: Commit** `feat(zcode): classify native endpoint responses`.

### Task 8: Replayable Request and Retry Coordinator

**Files:**
- Create: `agent/extensions/omp-zcode-start-plan/src/protocol/request.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/protocol/retry.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/protocol-request.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/protocol-retry.test.ts`

**Interfaces:**
- Produces: `createReplayableRequest(input, init): Promise<ReplayableZcodeRequest>`.
- Produces: `executeZcodeRequest(deps, logicalRequest, profile, signal): Promise<Response>`.
- Independent budgets: CAPTCHA initialization/challenge, duplicate token, risk control, admission, and sibling rotation ownership.
- Exact admission delays: one second then two seconds; three wire attempts total per credential.

- [ ] **Step 1: Write request red tests** for string, bytes, URLSearchParams, Request, consumed body, and unsupported streaming body; assert byte-identical replay.
- [ ] **Step 2: Implement replay factory** that buffers once, rejects unbounded streams before send, and creates fresh Request/init material per attempt.
- [ ] **Step 3: Write retry red tests** for each classifier outcome, independent budgets, response cancellation before retry, abort during solve/wait/fetch, fresh token/request ID, stable auth/trace/query/session/body, and no retry for unrelated/3012.
- [ ] **Step 4: Add exact official `3010` test** for attempts at t=0/1s/3s and success/final-rotation variants.
- [ ] **Step 5: Implement retry coordinator** with an explicit transition table rather than nested generic retry loops.
- [ ] **Step 6: Run request/retry tests ten reruns and typecheck**.
- [ ] **Step 7: Commit** `feat(zcode): coordinate replay-safe retries`.

### Task 9: Native Transport Integration and Stream Integrity

**Files:**
- Modify: `agent/extensions/omp-zcode-start-plan/src/transport.ts`
- Create: `agent/extensions/omp-zcode-start-plan/src/protocol/stream.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/transport.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/protocol-stream.test.ts`

**Interfaces:**
- `streamZcodeStartPlan` decodes the credential descriptor, loads the matching profile, checks reserve with the real access token, and delegates every model attempt to the coordinator.
- Stream guard preserves native Anthropic thinking/text/tool/usage events and detects incomplete HTTP 200 streams.

- [ ] **Step 1: Adapt selected donor upstream assertions** for protected-header stripping, bearer form, identity order, trace order, allowed `anthropic-beta`, encoding honesty, and truncation.
- [ ] **Step 2: Add native endpoint red tests** asserting exact URL, raw Anthropic body, no OpenAI translation, no descriptor leakage, stable profile binding, and correct reserve token.
- [ ] **Step 3: Add stream red tests** for null/non-event SSE data, native thinking/text/tool/usage ordering, structured errors, gzip framing, early close before message completion, and downstream cancellation.
- [ ] **Step 4: Integrate classifier/retry/CAPTCHA/profile modules** into a smaller transport coordinator; delete superseded inline identity/config/retry code.
- [ ] **Step 5: Implement stream completeness guard** only at observable Anthropic event boundaries; do not transform valid event payloads.
- [ ] **Step 6: Run transport/stream/admission/reserve tests ten reruns and typecheck**.
- [ ] **Step 7: Commit** `feat(zcode): integrate native protocol core`.

### Task 10: Multi-Account Rotation and Lifecycle Integration

**Files:**
- Modify: `agent/extensions/omp-zcode-start-plan/src/extension.ts`
- Modify: `agent/extensions/omp-zcode-start-plan/src/usage.ts`
- Modify: `agent/extensions/omp-zcode-start-plan/src/diagnostics.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/extension.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/usage.test.ts`
- Test: `agent/extensions/omp-zcode-start-plan/tests/diagnostics.test.ts`
- Create: `agent/extensions/omp-zcode-start-plan/tests/multi-account.test.ts`

**Interfaces:**
- One OMP-selected credential always maps to one profile for reserve, CAPTCHA, request, health, and diagnostics.
- Rotation changes credential and profile atomically; OMP remains the only scheduler.
- Shutdown closes pool, workers, profile store, caches, and waits.

- [ ] **Step 1: Write two-account red tests** for distinct descriptors/MIDs/cookies/tokens, rotation after reserve/credential/final-3010 outcomes, disabled-account retention, deleted-account cleanup hook where OMP exposes it, and persistence after reopen.
- [ ] **Step 2: Add concurrent tests** proving simultaneous requests never exchange profile state or leases.
- [ ] **Step 3: Update lifecycle integration** to initialize lazily, close deterministically, and report redacted per-account health/pool state.
- [ ] **Step 4: Ensure usage calls use actual OAuth tokens and account IDs**, never credential descriptors or CAPTCHA profile secrets.
- [ ] **Step 5: Run account/extension/usage/diagnostics tests ten reruns and typecheck**.
- [ ] **Step 6: Commit** `feat(zcode): isolate multi-account protocol state`.

### Task 11: Clean Electron Cutover and Provenance

**Files:**
- Remove: `agent/extensions/omp-zcode-start-plan/src/captcha/broker.cjs`
- Remove: `agent/extensions/omp-zcode-start-plan/src/captcha/index.html`
- Remove: `agent/extensions/omp-zcode-start-plan/src/captcha/logo.txt`
- Remove: obsolete broker-specific test cases from `tests/captcha-client.test.ts`
- Modify: `agent/extensions/omp-zcode-start-plan/package.json`
- Modify: `agent/extensions/omp-zcode-start-plan/bun.lock`
- Create: `agent/extensions/omp-zcode-start-plan/UPSTREAM-NOTICES.md`
- Create: `agent/extensions/omp-zcode-start-plan/src/provenance.ts`

**Interfaces:**
- No runtime import, dependency, file lookup, process spawn, or diagnostic field refers to Electron/broker.
- Provenance maps local donor-derived files to exact upstream paths and commit.

- [ ] **Step 1: Add a red source/runtime test** asserting no Electron dependency, broker files, spawn path, or broker status remains and importing the extension creates no child process.
- [ ] **Step 2: Remove Electron and broker artifacts**; reinstall locked dependencies.
- [ ] **Step 3: Add MIT notice and provenance mapping** for every substantially copied/adapted donor module and test family.
- [ ] **Step 4: Run dependency/source test, complete plugin tests, and typecheck**.
- [ ] **Step 5: Commit** `refactor(zcode): remove electron captcha broker`.

### Task 12: Documentation and Maintenance Procedure

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-zcode-native-protocol-parity-design.md` only if implementation evidence changes a stated contract.
- Modify: `agent/extensions/omp-zcode-start-plan/UPSTREAM-NOTICES.md`
- Modify existing operator-facing provider documentation if present; do not add unrelated guides.

**Interfaces:**
- Documents pinned donor revision, local mapping, update procedure, profile persistence/security, reset behavior, error classes, and verification commands.

- [ ] **Step 1: Compare implemented files against the source-to-plugin disposition table** and record exact local paths and deviations.
- [ ] **Step 2: Document update mechanics**: fetch candidate, run donor locked suite, diff donor paths/tests, rerun live native probe, port assertion plus code, update provenance commit.
- [ ] **Step 3: Document redacted profile diagnostics and state-reset behavior** without exposing cookies/tokens/full MIDs.
- [ ] **Step 4: Run markdown/source consistency checks available in the repo and `git diff --check` on targeted paths**.
- [ ] **Step 5: Commit** `docs(zcode): document upstream parity maintenance`.

### Task 13: Behavioral Verification and Review

**Files:**
- No new production files unless a verified failure requires a test-first correction.

**Interfaces:**
- Completion evidence must cover both models, two accounts, restart persistence, host safety, and no relay/Electron process.

- [ ] **Step 1: Run focused suites** for profile, identity/trace, CAPTCHA engine, pool/governor, classifier/retry, transport/stream, and multi-account integration.
- [ ] **Step 2: Run the complete plugin suite ten times** with deterministic reruns and report aggregate pass/failure counts.
- [ ] **Step 3: Run `bun run typecheck`** and scan adapted protocol code for `@ts-nocheck`.
- [ ] **Step 4: Run host-safety smoke**: compare dispatcher/listeners/globals/children before import, after solve, and after shutdown.
- [ ] **Step 5: Run two-account concurrent restart smoke** and prove distinct stable profile IDs, cookies, registries, and solver state using redacted hashes.
- [ ] **Step 6: Run live GLM-5.3 probe** with debug logs and require exact `ok`, native Anthropic endpoint evidence, and bounded completion.
- [ ] **Step 7: Run live GLM-5-Turbo probe** with the same acceptance criteria.
- [ ] **Step 8: Inspect process state** and prove no Electron broker or local relay started.
- [ ] **Step 9: Request targeted code review** against the spec, donor provenance, OMP multi-account invariants, and verification evidence; fix every Critical/Important finding test-first.
- [ ] **Step 10: Run final complete plugin suite and typecheck once more after review fixes**.
- [ ] **Step 11: Commit any review fixes**, then push only targeted ZCode/spec commits to `origin/main`; do not include unrelated config changes.
