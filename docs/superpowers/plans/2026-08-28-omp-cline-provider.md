# OMP Cline Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local OMP provider named `cline` that uses Cline CLI's exact WorkOS device-auth handler, supports OMP-native multiple accounts, and exposes only models in Cline's live authoritative free list.

**Architecture:** An async OMP extension loads Cline's live recommended free IDs at extension startup, intersects them with `@cline/llms` metadata, and registers the resulting models directly to avoid OMP's 24-hour dynamic-model cache. A focused OAuth adapter delegates login, refresh, storage normalization, and request-token formatting to `@cline/core`'s `cline` provider handler while preserving stable account identity for OMP's native credential pool.

**Tech Stack:** TypeScript 5.9, Bun test runner, OMP 18.0.9 extension API, `@cline/core@0.0.81`, `@cline/llms@0.0.81`, OpenAI-compatible chat completions.

**Spec:** `docs/superpowers/specs/2026-08-28-omp-cline-provider-design.md`

## Global Constraints

- Provider ID is exactly `cline`; display name is exactly `Cline`.
- API base URL is exactly `https://api.cline.bot/api/v1`; transport is `openai-completions` with bearer authentication.
- Resolve auth through `getProviderAuthHandler("cline")`; do not reimplement Cline OAuth endpoints.
- Login must use the handler's WorkOS device flow used by `cline auth cline`; never expose callback/manual-code, Codex, OCA, or API-key modes.
- Preserve non-empty Cline `accountId` and optional `email`; OMP owns account persistence, upsert, pinning, stickiness, cooldown, rotation, and refresh locking.
- Storage tokens are normalized through the Cline handler; request tokens are formatted through `formatProviderOAuthApiKey("cline", ...)`.
- Free eligibility comes only from Cline's live `/api/v1/ai/cline/recommended-models` `free` array.
- Model metadata comes only from awaited `getModelsForProvider("cline", { filter: "chat" })`; expose their exact intersection.
- Never infer free eligibility from price or an ID suffix. Never expose a stale or paid fallback.
- Fetch the live free list during each extension load/reload and register `models` directly; do not use OMP's 24-hour-cached `fetchDynamicModels` hook.
- No credential, device response, refresh token, or access token may enter logs, model metadata, fixtures, or assertions.
- Use TDD for each observable contract and commit each independently reviewable task.

## File Structure

- Create `agent/extensions/omp-cline-provider/package.json` — local extension metadata, scripts, and pinned Cline/OMP dependencies.
- Create `agent/extensions/omp-cline-provider/tsconfig.json` — strict Bun/TypeScript configuration.
- Create `agent/extensions/omp-cline-provider/src/models.ts` — live free-ID fetch, validation, catalog intersection, deterministic ordering, and OMP model conversion.
- Create `agent/extensions/omp-cline-provider/src/oauth.ts` — official Cline handler adapter, identity invariants, refresh, and token formatting.
- Create `agent/extensions/omp-cline-provider/src/extension.ts` — async provider registration and dependency-injected factory for tests.
- Create `agent/extensions/omp-cline-provider/tests/models.test.ts` — free-list and metadata conversion contracts.
- Create `agent/extensions/omp-cline-provider/tests/oauth.test.ts` — device-handler, callback adaptation, identity, refresh, and token formatting contracts.
- Create `agent/extensions/omp-cline-provider/tests/extension.test.ts` — exact provider registration and multi-account credential contract.

---

### Task 1: Free Cline Model Catalog

**Files:**
- Create: `agent/extensions/omp-cline-provider/package.json`
- Create: `agent/extensions/omp-cline-provider/tsconfig.json`
- Create: `agent/extensions/omp-cline-provider/src/models.ts`
- Create: `agent/extensions/omp-cline-provider/tests/models.test.ts`

**Interfaces:**
- Consumes: `getModelsForProvider("cline", { filter: "chat" }): Promise<Record<string, ModelInfo>>` from `@cline/llms` and `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`.
- Produces: `loadFreeClineModels(deps?: ModelDependencies): Promise<ClineProviderModel[]>` and `fetchRecommendedFreeIds(fetchImpl?: typeof fetch): Promise<ReadonlySet<string>>`.
- Produces type: `ClineProviderModel = ProviderModelConfig & { supportsTools?: boolean }`.

- [ ] **Step 1: Create the extension package and strict TypeScript configuration**

Create `package.json`:

```json
{
  "name": "omp-cline-provider",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "omp": {
    "extensions": ["./src/extension.ts"]
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cline/core": "0.0.81",
    "@cline/llms": "0.0.81",
    "@oh-my-pi/pi-ai": "^18.0.9",
    "@oh-my-pi/pi-coding-agent": "^18.0.9"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "typescript": "5.9.3"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["bun"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Run:

```bash
cd agent/extensions/omp-cline-provider
bun install
```

Expected: dependencies install and `bun.lock` is created without peer-resolution errors.

- [ ] **Step 2: Write failing free-list validation and intersection tests**

Create `tests/models.test.ts` with injected fetch/catalog fixtures. Include these exact contracts:

```ts
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@cline/llms";
import { fetchRecommendedFreeIds, loadFreeClineModels } from "../src/models.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const catalog: Record<string, ModelInfo> = {
  "z-ai/glm-5.3-flash": {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 200_000,
    maxTokens: 32_000,
    capabilities: ["tools", "reasoning", "images"],
    modalities: { input: ["text", "image"], output: ["text"] },
    systemRole: "system",
    pricing: { input: 1.25, output: 4.5 },
  },
  "paid/model": {
    id: "paid/model",
    name: "Paid",
    contextWindow: 128_000,
    maxTokens: 8_192,
    capabilities: ["tools"],
    pricing: { input: 0, output: 0 },
  },
  "suffix/model:free": {
    id: "suffix/model:free",
    name: "Suffix only",
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

test("accepts only a non-empty free string array", async () => {
  const ids = await fetchRecommendedFreeIds(async () =>
    response({ free: ["z-ai/glm-5.3-flash"] }),
  );
  expect([...ids]).toEqual(["z-ai/glm-5.3-flash"]);

  for (const payload of [{}, { free: [] }, { free: [1] }, { free: [""] }]) {
    await expect(
      fetchRecommendedFreeIds(async () => response(payload)),
    ).rejects.toThrow();
  }
});

test("intersects exact live free ids with valid Cline chat metadata", async () => {
  const models = await loadFreeClineModels({
    fetchImpl: async () =>
      response({ free: ["z-ai/glm-5.3-flash", "unknown/model"] }),
    loadCatalog: async () => ({ ...catalog }),
  });

  expect(models.map((model) => model.id)).toEqual(["z-ai/glm-5.3-flash"]);
  expect(models[0]).toMatchObject({
    reasoning: true,
    input: ["text", "image"],
    supportsTools: true,
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  });
});

test("does not infer free status from price or suffix", async () => {
  const models = await loadFreeClineModels({
    fetchImpl: async () => response({ free: ["z-ai/glm-5.3-flash"] }),
    loadCatalog: async () => ({ ...catalog }),
  });
  expect(models.some(({ id }) => id === "paid/model")).toBeFalse();
  expect(models.some(({ id }) => id === "suffix/model:free")).toBeFalse();
});
```

Also test:

- HTTP non-2xx includes the status but not response secrets in the error;
- duplicate free IDs are deduplicated;
- missing/invalid `contextWindow` or `maxTokens` omits that catalog entry;
- `systemRole: "developer"` maps to `supportsDeveloperRole: true`;
- missing `systemRole` defaults to `false`;
- `z-ai/glm-5.3-flash` sorts first when eligible;
- remaining IDs sort lexicographically;
- an empty valid intersection throws instead of registering a fallback.

- [ ] **Step 3: Run model tests to verify they fail**

Run:

```bash
cd agent/extensions/omp-cline-provider
bun test tests/models.test.ts
```

Expected: FAIL because `src/models.ts` and its exports do not exist.

- [ ] **Step 4: Implement strict free-list loading and model conversion**

Create `src/models.ts` with these public boundaries:

```ts
import { getModelsForProvider, type ModelInfo } from "@cline/llms";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const RECOMMENDED_MODELS_URL =
  "https://api.cline.bot/api/v1/ai/cline/recommended-models";
export const PREFERRED_FREE_MODEL = "z-ai/glm-5.3-flash";

export type ClineProviderModel = ProviderModelConfig & {
  supportsTools?: boolean;
};

export interface ModelDependencies {
  fetchImpl: typeof fetch;
  loadCatalog: () => Promise<Record<string, ModelInfo>>;
}

const defaultDependencies: ModelDependencies = {
  fetchImpl: fetch,
  loadCatalog: () => getModelsForProvider("cline", { filter: "chat" }),
};

export async function fetchRecommendedFreeIds(
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlySet<string>>;

export async function loadFreeClineModels(
  deps: ModelDependencies = defaultDependencies,
): Promise<ClineProviderModel[]>;
```

Implementation requirements:

- fetch `RECOMMENDED_MODELS_URL` with `Accept: application/json` and a 10-second abort timeout;
- require an object payload whose `free` field is a non-empty array of non-empty strings;
- deduplicate exact IDs with `Set`;
- await `deps.loadCatalog()` and select only exact IDs in the free set;
- require positive finite integer `contextWindow` and `maxTokens` before conversion;
- use `info.name ?? id` for display only;
- map images from `modalities.input` and tools/reasoning from `capabilities`;
- set every required OMP cost field to zero after authoritative free-list membership is established; do not copy upstream routing prices into user-facing Cline cost;
- set `compat.supportsDeveloperRole` to `info.systemRole === "developer"`;
- sort the preferred ID first, then all remaining IDs by `id.localeCompare`;
- throw `Cline free model catalog is empty` when no valid intersection remains;
- never log response bodies or add price/suffix eligibility branches.

- [ ] **Step 5: Run model tests and typecheck**

Run:

```bash
bun test tests/models.test.ts
bun run typecheck
```

Expected: all model tests PASS; typecheck PASS.

- [ ] **Step 6: Commit the catalog component**

```bash
git add agent/extensions/omp-cline-provider/package.json \
  agent/extensions/omp-cline-provider/bun.lock \
  agent/extensions/omp-cline-provider/tsconfig.json \
  agent/extensions/omp-cline-provider/src/models.ts \
  agent/extensions/omp-cline-provider/tests/models.test.ts
git commit -m "feat: load authoritative free Cline models"
```

---

### Task 2: Exact Cline OAuth Handler Adapter

**Files:**
- Create: `agent/extensions/omp-cline-provider/src/oauth.ts`
- Create: `agent/extensions/omp-cline-provider/tests/oauth.test.ts`

**Interfaces:**
- Consumes: `getProviderAuthHandler("cline")`, `formatProviderOAuthApiKey("cline", credentials)`, `ProviderAuthHandler`, OMP `OAuthCredentials`, and OMP `OAuthLoginCallbacks`.
- Produces: `createClineOAuth(deps?: AuthDependencies): ProviderConfig["oauth"]`.
- Produces: `normalizeLoginCredentials(...)` and `mergeRefreshCredentials(...)` as testable pure identity boundaries.

- [ ] **Step 1: Write failing handler-selection and login tests**

Create `tests/oauth.test.ts`. Use a fake `ProviderAuthHandler`; do not mock Cline network endpoints.

```ts
import { describe, expect, test } from "bun:test";
import { createClineOAuth } from "../src/oauth.js";

function credentials(accountId = "acct-a") {
  return {
    access: "workos:access-a",
    refresh: "refresh-a",
    expires: 2_000_000_000_000,
    accountId,
    email: `${accountId}@example.test`,
  };
}

test("delegates login to the exact cline auth handler", async () => {
  let receivedPrompt: unknown;
  const handler = {
    providerId: "cline",
    storageProviderId: "cline",
    getApiKey: () => undefined,
    login: async ({ callbacks }: any) => {
      callbacks.onAuth({
        url: "https://authkit.cline.bot/device?user_code=ABCD-EFGH",
        instructions: "Enter the code",
      });
      receivedPrompt = await callbacks.onPrompt({
        message: "Account",
        defaultValue: "cline",
      });
      return credentials();
    },
    refresh: async () => credentials(),
    saveCredentials: () => ({}),
    isConfigured: () => true,
    normalizeStoredAccessToken: (token: string) =>
      token.replace(/^workos:/i, ""),
  };

  const authEvents: unknown[] = [];
  const oauth = createClineOAuth({
    resolveHandler: () => handler as any,
    formatApiKey: (_provider, value) => `workos:${value.access}`,
  });

  const result = await oauth.login({
    onAuth: (info) => authEvents.push(info),
    onPrompt: async (prompt) => prompt.placeholder ?? "",
  });

  expect(authEvents).toEqual([{
    url: "https://authkit.cline.bot/device?user_code=ABCD-EFGH",
    instructions: "Enter the code",
  }]);
  expect(receivedPrompt).toBe("cline");
  expect(result).toMatchObject({
    access: "access-a",
    accountId: "acct-a",
    email: "acct-a@example.test",
  });
});
```

Add contracts proving:

- handler resolution is called with exact provider ID `cline`;
- missing handler throws `Cline auth handler is unavailable`;
- login rejects missing/blank `accountId`, access, refresh, or invalid expiry;
- Cline `defaultValue` maps to OMP `placeholder`;
- `onProgress` passes through;
- no callback-server or manual-code callback is supplied by the adapter;
- two login results with `acct-a` and `acct-b` preserve distinct identities.

- [ ] **Step 2: Write failing refresh and request-token tests**

Add tests that assert the handler receives this refresh input shape:

```ts
{
  settings: {
    provider: "cline",
    auth: {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: 2_000_000_000_000,
      accountId: "acct-a",
    },
  },
  credentials: {
    access: "access-a",
    refresh: "refresh-a",
    expires: 2_000_000_000_000,
    accountId: "acct-a",
    email: "acct-a@example.test",
  },
}
```

Assert:

- a refresh result omitting `accountId` and `email` inherits both original fields;
- a refresh result changing `accountId` throws `Cline refresh changed account identity`;
- a `null` refresh result throws `Cline refresh returned no credentials`;
- `getApiKey({ access: "access-a", ... })` calls `formatProviderOAuthApiKey("cline", { access: "access-a" })` and returns exactly one `workos:` marker;
- an empty formatted key throws before request dispatch.

- [ ] **Step 3: Run OAuth tests to verify they fail**

Run:

```bash
bun test tests/oauth.test.ts
```

Expected: FAIL because `src/oauth.ts` does not exist.

- [ ] **Step 4: Implement the official-handler adapter**

Create `src/oauth.ts` with dependency injection restricted to tests:

```ts
import {
  formatProviderOAuthApiKey,
  getProviderAuthHandler,
  type ProviderAuthHandler,
  type ProviderOAuthCredentials,
} from "@cline/core";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@oh-my-pi/pi-ai";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";

export interface AuthDependencies {
  resolveHandler: (providerId: string) => ProviderAuthHandler | undefined;
  formatApiKey: (
    providerId: string,
    credentials: Pick<ProviderOAuthCredentials, "access">,
  ) => string;
}

const defaultDependencies: AuthDependencies = {
  resolveHandler: getProviderAuthHandler,
  formatApiKey: formatProviderOAuthApiKey,
};

export function createClineOAuth(
  deps: AuthDependencies = defaultDependencies,
): NonNullable<ProviderConfig["oauth"]>;
```

Implementation requirements:

- resolve and validate the handler once per `createClineOAuth` call;
- require `handler.providerId === "cline"` and `handler.storageProviderId === "cline"`;
- adapt only `onAuth`, `onPrompt`, and optional `onProgress`; map `defaultValue` to `placeholder`;
- do not pass `onManualCodeInput`, `onServerListening`, or `onServerClose`;
- login through `handler.login({ callbacks })`;
- normalize returned access through `handler.normalizeStoredAccessToken` when present;
- require non-empty access, refresh, account ID, finite positive expiry; trim only identity/display fields, not opaque token bytes;
- preserve optional email;
- refresh through `handler.refresh({ settings, credentials })` using provider `cline` and Cline's `auth` field names;
- normalize refreshed access and merge missing identity/display metadata from the original credential;
- reject a changed non-empty account ID;
- format outbound request keys only through `deps.formatApiKey("cline", { access })`;
- reject an empty formatted key;
- never catch and replace Cline's denial, expiry, polling, registration, or refresh errors unless enforcing one of these adapter invariants.

- [ ] **Step 5: Run OAuth tests and typecheck**

Run:

```bash
bun test tests/oauth.test.ts
bun run typecheck
```

Expected: all OAuth tests PASS; typecheck PASS.

- [ ] **Step 6: Commit the OAuth adapter**

```bash
git add agent/extensions/omp-cline-provider/src/oauth.ts \
  agent/extensions/omp-cline-provider/tests/oauth.test.ts
git commit -m "feat: adapt Cline device OAuth for OMP"
```

---

### Task 3: OMP Provider Registration

**Files:**
- Create: `agent/extensions/omp-cline-provider/src/extension.ts`
- Create: `agent/extensions/omp-cline-provider/tests/extension.test.ts`

**Interfaces:**
- Consumes: `loadFreeClineModels(): Promise<ClineProviderModel[]>` and `createClineOAuth(): NonNullable<ProviderConfig["oauth"]>`.
- Produces: default async OMP extension factory and `createExtension(deps?: ExtensionDependencies)` for deterministic tests.

- [ ] **Step 1: Write the failing provider-registration test**

Create `tests/extension.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createExtension } from "../src/extension.js";

const freeModel = {
  id: "z-ai/glm-5.3-flash",
  name: "GLM 5.3 Flash",
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
  supportsTools: true,
  compat: { supportsDeveloperRole: false },
};

test("registers the exact Cline provider with startup-fresh free models", async () => {
  const registrations: Array<{ name: string; config: any }> = [];
  const oauth = {
    name: "Cline",
    login: async () => ({
      access: "access",
      refresh: "refresh",
      expires: 2_000_000_000_000,
      accountId: "acct-a",
    }),
    refreshToken: async (value: any) => value,
    getApiKey: () => "workos:access",
  };

  const extension = createExtension({
    loadModels: async () => [freeModel],
    createOAuth: () => oauth,
  });

  await extension({
    registerProvider: (name: string, config: any) =>
      registrations.push({ name, config }),
  } as any);

  expect(registrations).toHaveLength(1);
  expect(registrations[0]).toMatchObject({
    name: "cline",
    config: {
      baseUrl: "https://api.cline.bot/api/v1",
      api: "openai-completions",
      authHeader: true,
      models: [freeModel],
      oauth,
    },
  });
  expect(registrations[0].config.fetchDynamicModels).toBeUndefined();
});
```

Add tests proving:

- model loading completes before registration;
- model-loading failure rejects extension initialization and does not register a provider;
- empty models do not register;
- `supportsTools` survives into the registered model object;
- OAuth object is registered under the same provider, enabling `/login cline`;
- no `apiKey`, paid fallback model, or `fetchDynamicModels` is present.

- [ ] **Step 2: Run registration tests to verify they fail**

Run:

```bash
bun test tests/extension.test.ts
```

Expected: FAIL because `src/extension.ts` does not exist.

- [ ] **Step 3: Implement the async extension factory**

Create `src/extension.ts`:

```ts
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { loadFreeClineModels, type ClineProviderModel } from "./models.js";
import { createClineOAuth } from "./oauth.js";

export const CLINE_PROVIDER_ID = "cline";
export const CLINE_API_BASE = "https://api.cline.bot/api/v1";

export interface ExtensionDependencies {
  loadModels: () => Promise<ClineProviderModel[]>;
  createOAuth: () => NonNullable<ProviderConfig["oauth"]>;
}

const defaultDependencies: ExtensionDependencies = {
  loadModels: loadFreeClineModels,
  createOAuth: createClineOAuth,
};

export function createExtension(deps: ExtensionDependencies = defaultDependencies) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const models = await deps.loadModels();
    if (models.length === 0) {
      throw new Error("Cline free model catalog is empty");
    }
    pi.registerProvider(CLINE_PROVIDER_ID, {
      baseUrl: CLINE_API_BASE,
      api: "openai-completions",
      authHeader: true,
      models,
      oauth: deps.createOAuth(),
    });
  };
}

export default createExtension();
```

Do not add startup credential-file imports, commands, custom account state, response-stream wrappers, or global request hooks.

- [ ] **Step 4: Run focused and complete extension tests**

Run:

```bash
bun test tests/extension.test.ts
bun test
bun run typecheck
```

Expected: registration tests PASS; complete extension test suite PASS; typecheck PASS.

- [ ] **Step 5: Commit provider registration**

```bash
git add agent/extensions/omp-cline-provider/src/extension.ts \
  agent/extensions/omp-cline-provider/tests/extension.test.ts
git commit -m "feat: register free multi-account Cline provider"
```

---

### Task 4: Actual OMP and Cline Runtime Verification

**Files:**
- Modify only if verification reveals a contract defect: files created in Tasks 1–3 and the corresponding behavioral test.
- No new documentation or compatibility shim is planned.

**Interfaces:**
- Consumes: completed local extension and real installed OMP/Cline services.
- Produces: evidence that the actual `/login`, `/model`, OAuth, account, and streaming surfaces work end to end.

- [ ] **Step 1: Verify static model loading through the actual OMP CLI**

Run from `/home/laughingman/.config/omp`:

```bash
omp models cline \
  -e agent/extensions/omp-cline-provider/src/extension.ts \
  --json
```

Expected:

- command exits successfully;
- output contains `cline/z-ai/glm-5.3-flash` while it remains in Cline's live free array;
- every returned `cline` ID is in the current `/api/v1/ai/cline/recommended-models` `free` array;
- no ClinePass or paid-only model appears.

If the command fails, add a behavioral test reproducing the real contract mismatch before changing implementation.

- [ ] **Step 2: Launch the actual OMP TUI and verify login discovery**

Launch OMP with the extension explicitly enabled:

```bash
omp -e agent/extensions/omp-cline-provider/src/extension.ts
```

In the TUI:

1. run `/login` and confirm `Cline` appears;
2. run `/login cline`;
3. confirm the UI displays an `https://authkit.cline.bot/device?...` URL and a device code;
4. confirm no localhost callback-port message appears;
5. complete authorization in the browser.

Expected: OMP reports successful Cline login and stores the returned Cline account identity.

- [ ] **Step 3: Verify native multi-account enrollment**

Run `/login cline` again and authorize a different Cline account.

Expected:

- OMP retains both stable account IDs under provider `cline`;
- the second login does not overwrite the first account;
- account listing/pinning uses OMP's existing UI rather than plugin-owned state.

If only one real Cline account is available, record live verification as single-account only. Do not claim live two-account proof; the distinct-account automated tests remain the evidence for coexistence.

- [ ] **Step 4: Verify model selection and a free streamed completion**

In the same OMP session:

1. run `/model`;
2. select `cline/z-ai/glm-5.3-flash` if still listed, otherwise select another model from Cline's current free array;
3. send `Reply with exactly: cline-free-ok`;
4. observe the streamed response.

Expected:

- response completes without a paid entitlement error;
- provider/model attribution is `cline/<selected-free-id>`;
- response is streamed through OMP's native OpenAI-compatible transport;
- no token or device code appears in logs/errors.

- [ ] **Step 5: Run final verification once**

Run:

```bash
cd agent/extensions/omp-cline-provider
bun test
bun run typecheck
```

Expected: all tests PASS and typecheck PASS after any runtime-driven correction.

- [ ] **Step 6: Commit only runtime-driven corrections, if any**

If verification required a source correction, commit the changed source and its reproducing test together:

```bash
git add agent/extensions/omp-cline-provider/src \
  agent/extensions/omp-cline-provider/tests
git commit -m "fix: align Cline provider runtime behavior"
```

If no correction was needed, do not create an empty commit.
