# Permission Gate Approval Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce false permission prompts while preserving hard security boundaries, sharing current-session grants across subagents and tools, and improving the approval/status UI.

**Architecture:** Parse each Bash unit into a conservative canonical identity for policy and grants while preserving original display/execution text. Store grants under the parent session, represent external-directory grants as segment-safe canonical roots, and route Bash/edit/write path decisions through the same approval broker. Extend the broker with reactive queue progress, then add the singular `/permission` command, stable status icon, supported timeout configuration, and evidence-backed policy tiers.

**Tech Stack:** TypeScript 5.9, Bun 1.4, OMP Extension API 18.x, `web-tree-sitter`, Zod 4, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-30-permission-gate-approval-identity-design.md`

## Global Constraints

- Grants are in-memory and current-parent-session only; never write grants to disk.
- Hard command/path denies run before and override every grant.
- Normalization or parsing uncertainty asks; it never allows.
- One Bash tool call opens at most one Permission Gate dialog.
- External directory grants include the exact root and descendants, never parents or siblings.
- Bash, edit, and write reuse one external-path grant model; internal device URIs remain outside filesystem gating.
- `/permission` replaces `/permissions`; no compatibility alias.
- Permission status is plain `󰒃 perm:<level>` with no ANSI colors.
- Queue counters are right-aligned, use one `accent` style, update reactively, and hide at `1/1`.
- Configure `extensionHandlers.toolCallTimeoutMs: 600000`; timeout/cancellation fails closed.
- Arbitrary `sed -i` and `perl -i` remain gated.
- No new runtime dependencies.
- Every behavior change follows red-green TDD and ends in a focused commit.

---

## File Structure

**Create**

- `agent/extensions/permission-gate/src/command-identity.ts` — conservative Git/wrapper canonicalization and policy identity types.
- `agent/extensions/permission-gate/src/tool-paths.ts` — write/edit target extraction without policy decisions.
- `agent/extensions/permission-gate/scripts/replay-policy.ts` — public-safe aggregate replay of ignored local session JSONL; never outputs command text.
- `agent/extensions/permission-gate/tests/replay-policy.test.ts` — replay extraction/counting contract.

**Modify**

- `agent/extensions/permission-gate/src/shell.ts` — structured safety floors and command metadata.
- `agent/extensions/permission-gate/src/policy.ts` — canonical identity lookup and grant-pattern creation.
- `agent/extensions/permission-gate/src/paths.ts` — canonical root grants and segment-safe containment.
- `agent/extensions/permission-gate/src/approvals.ts` — parent-session grants, reactive queue accounting, and progress rendering.
- `agent/extensions/permission-gate/src/permission-gate.ts` — integrate identities and edit/write paths; singular command/status lifecycle; remove timeout test seam.
- `agent/extensions/permission-gate/src/config.ts` — evidence-backed default policies.
- `agent/extensions/permission-gate/tests/gate.test.ts` — unit, runtime, UI, and regression coverage.
- `agent/extensions/permission-gate/tsconfig.json` — include replay script in typechecking.
- `agent/permission-gate.json` — sync tracked active profiles with defaults.
- `agent/config.yml` — supported 600,000 ms extension-handler timeout.

---

### Task 1: Canonical Command Identity and Structured Safety Floors

**Files:**
- Create: `agent/extensions/permission-gate/src/command-identity.ts`
- Modify: `agent/extensions/permission-gate/src/shell.ts:5-10, 91-310, 608-665, 753-775`
- Modify: `agent/extensions/permission-gate/src/policy.ts:1-2, 55-79, 100-115`
- Modify: `agent/extensions/permission-gate/src/permission-gate.ts:15-18, 124-197`
- Test: `agent/extensions/permission-gate/tests/gate.test.ts:132-348, 507-546`

**Interfaces:**
- Produces:
  - `CommandSafety { reason: string; minimumLevel?: PermissionLevel; persistable: boolean }`
  - `CommandIdentity { display: string; canonical: string; executable?: string; arguments: string[]; paths: string[]; safety?: CommandSafety }`
  - `canonicalizeCommand(unit: BashCommandUnit): CommandIdentity`
  - `safetyRequiresApproval(safety: CommandSafety | undefined, level: PermissionLevel): boolean`
  - `resolveCommand(config, level, identity: CommandIdentity): GateDecision`
  - `commandGrantPattern(identity: CommandIdentity): string`
- Consumes: existing `BashCommandUnit`, `PermissionLevel`, `LEVEL_ORDER`, and glob policy.

- [ ] **Step 1: Add failing identity and safety tests**

Add imports for `canonicalizeCommand` and write table-driven tests using real `analyzeBash()` output:

```ts
async function identity(command: string) {
  const analysis = await analyzeBash(command);
  return canonicalizeCommand(analysis.commands[0]!);
}

test("canonicalizes safe Git global options and wrappers without losing paths", async () => {
  expect(await identity("git -C /srv/repo status --short")).toMatchObject({
    display: "git -C /srv/repo status --short",
    canonical: "git status --short",
    paths: ["/srv/repo"],
  });
  expect(await identity("timeout 30 git -C /srv/repo log -1")).toMatchObject({
    canonical: "git log -1",
    paths: ["/srv/repo"],
  });
  expect(await identity("time -p git status --short")).toMatchObject({
    canonical: "git status --short",
  });
  expect(await identity("command -v git")).toMatchObject({
    canonical: "command -v git",
  });
});

test("fails closed for behavior-changing Git options and ambiguous wrappers", async () => {
  expect((await identity("git -c core.pager=evil status")).safety?.reason).toContain("Git global option");
  expect((await identity("timeout 30 bash -c 'git status'")).safety?.reason).toContain("interpreter");
  expect((await identity("time -o timing.txt git status")).safety?.reason).toContain("output");
  expect((await identity("command -v git node")).safety?.reason).toContain("command -v");
});

test("represents bounded formatter writes as a medium floor", async () => {
  const prettier = await identity("prettier --write src");
  expect(prettier.safety).toEqual({
    reason: "Formatter writes files",
    minimumLevel: "medium",
    persistable: true,
  });
  expect((await identity("sed -i 's/x/y/' file.txt")).safety?.minimumLevel).toBeUndefined();
});

test("batches canonically duplicate compound units into one grant item", async () => {
  const cwd = await temporaryDirectory();
  let approvalEvents = 0;
  let sessionRuleOptions: string[] = [];
  const listener = () => { approvalEvents++; };
  process.on("omp:approval-requested", listener);
  try {
    const ctx = context("canonical-batch", cwd, true, async (_prompt, options) => {
      if (options.includes("Choose commands for this session…")) return "Choose commands for this session…";
      sessionRuleOptions = options;
      return "Allow all patterns";
    });
    const fake = fakeExtension();
    extension(fake.api, join(cwd, "agent"));
    await fake.handlers.get("session_start")!({ type: "session_start" }, ctx);
    await fake.handlers.get("tool_call")!({
      toolName: "bash",
      input: { command: "git push origin main && timeout 30 git push origin main" },
    }, ctx);
    await fake.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  } finally {
    process.off("omp:approval-requested", listener);
  }
  expect(approvalEvents).toBe(1);
  expect(sessionRuleOptions.filter((option) => option === "git push *")).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts --test-name-pattern "canonicalizes|fails closed|bounded formatter|canonically duplicate"
```

Expected: FAIL because `command-identity.ts`, structured safety, and identity-aware policy signatures do not exist.

- [ ] **Step 3: Introduce structured command safety in `shell.ts`**

Replace `forceAskReason?: string` with a structured field while preserving always-ask behavior:

```ts
export interface CommandSafety {
  reason: string;
  minimumLevel?: PermissionLevel;
  persistable: boolean;
}

export interface BashCommandUnit {
  text: string;
  executable?: string;
  arguments: string[];
  safety?: CommandSafety;
}
```

Return `{ reason, persistable: false }` for redirection, backgrounding, arbitrary interpreters, external scripts, unsafe Git options, `sed -i`, `perl -i`, and other existing semantic floors. Return `{ reason: "Formatter writes files", minimumLevel: "medium", persistable: true }` only for explicitly recognized Prettier/Biome write forms. Keep catastrophic detection unchanged.

Implement:

```ts
export function safetyRequiresApproval(
  safety: CommandSafety | undefined,
  level: PermissionLevel,
): boolean {
  if (!safety) return false;
  if (!safety.minimumLevel) return true;
  return LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(safety.minimumLevel);
}
```

- [ ] **Step 4: Implement conservative identity canonicalization**

In `command-identity.ts`, parse only known safe shapes:

```ts
export interface CommandIdentity {
  display: string;
  canonical: string;
  executable?: string;
  arguments: string[];
  paths: string[];
  safety?: CommandSafety;
}

export function canonicalizeCommand(unit: BashCommandUnit): CommandIdentity {
  // Preserve unit.text by default.
  // Peel only recognized timeout/time wrappers.
  // Strip only Git -C, --git-dir, and --work-tree while recording their values as paths.
  // Keep command -v only when it has exactly one non-option name.
  // On unknown or malformed options, return the original display/canonical text with an always-ask safety reason.
}
```

Use a deterministic shell-token renderer for reconstructed canonical strings: leave `[A-Za-z0-9_./:@%+=,-]+` unquoted and single-quote every other token, escaping embedded single quotes as `'\''`. Limit recursive wrapper peeling to four levels and fail closed beyond that depth.

- [ ] **Step 5: Move policy and grants to canonical values**

Change `resolveCommand` and `commandGrantPattern` to consume `CommandIdentity`. In `permission-gate.ts`:

```ts
const identity = canonicalizeCommand(command);
const commandDecision = resolveCommand(config, level, identity);
const floorAsks = safetyRequiresApproval(identity.safety, level);
const commandPersistable = commandDecision.persistable && (identity.safety?.persistable ?? true);
const granted = commandPersistable && sessionAllows(ctx, "bash", identity.canonical);
const asks = commandDecision.policy === "ask" || floorAsks;
bashPaths.push(...identity.paths);
```

Keep `label` and `preview` from `identity.display`; store `value`, exact-key context, and Bash rules using `identity.canonical`. Deduplicate request items by `surface + canonical value + rule pattern` before one `requestApproval()` call.

- [ ] **Step 6: Run Task 1 tests and typecheck**

Run:

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts
bun x tsc --noEmit
```

Expected: all existing and new tests PASS; no type errors.

- [ ] **Step 7: Commit Task 1**

```bash
git add agent/extensions/permission-gate/src/command-identity.ts \
  agent/extensions/permission-gate/src/shell.ts \
  agent/extensions/permission-gate/src/policy.ts \
  agent/extensions/permission-gate/src/permission-gate.ts \
  agent/extensions/permission-gate/tests/gate.test.ts
git commit -m "fix(permission-gate): canonicalize command approval identity"
```

---

### Task 2: Parent-Session Grants and Root-Inclusive Path Scope

**Files:**
- Modify: `agent/extensions/permission-gate/src/approvals.ts:36-132, 370-388`
- Modify: `agent/extensions/permission-gate/src/paths.ts:22-55, 77-117`
- Modify: `agent/extensions/permission-gate/src/permission-gate.ts:191-230`
- Test: `agent/extensions/permission-gate/tests/gate.test.ts:323-348, 350-400, 462-488, 548-581`

**Interfaces:**
- Produces:
  - `grantSessionId(ctx: ExtensionContext): string`
  - `isPathWithin(root: string, candidate: string): boolean`
  - `externalGrantRoot(canonical: string): Promise<string>`
- Changes `SessionRule.pattern` semantics for `surface === "external_directory"`: it stores a canonical directory root, not a `dir/*` glob.
- Consumes: Task 1 canonical Bash values.

- [ ] **Step 1: Add failing parent/sibling and path-root tests**

```ts
test("shares levels, exact grants, command rules, and path roots across siblings", async () => {
  const cwd = await temporaryDirectory();
  const parent = context("parent-shared", cwd, true);
  const childA = context("child-a", cwd, false);
  const childB = context("child-b", cwd, false);
  registerSession(parent, "low");
  registerSession(childA, "low");
  registerSession(childB, "low");

  addSessionRules(childA, [
    { surface: "bash", pattern: "git push *" },
    { surface: "external_directory", pattern: "/srv/shared" },
  ]);
  addExactGrant(childA, "exact-key");

  expect(sessionAllows(childB, "bash", "git push --tags")).toBe(true);
  expect(sessionAllows(parent, "external_directory", "/srv/shared")).toBe(true);
  expect(sessionAllows(childB, "external_directory", "/srv/shared/nested/file")).toBe(true);
  expect(sessionAllows(childB, "external_directory", "/srv/shared-other")).toBe(false);
  expect(hasExactGrant(parent, "exact-key")).toBe(true);
});

test("external grant roots include the directory itself but not siblings", async () => {
  const root = await temporaryDirectory();
  const directory = join(root, "outside");
  await mkdir(directory);
  expect(await externalGrantRoot(directory)).toBe(directory);
  expect(isPathWithin(directory, directory)).toBe(true);
  expect(isPathWithin(directory, join(directory, "child"))).toBe(true);
  expect(isPathWithin(directory, `${directory}-other`)).toBe(false);
});
```

Also assert that unregistering a child does not erase the parent grant and unregistering the parent clears the shared namespace.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts --test-name-pattern "shares levels|external grant roots"
```

Expected: FAIL because grants are keyed by child session IDs and external rules use `dir/*` glob semantics.

- [ ] **Step 3: Implement one canonical parent-session key**

Add:

```ts
export function grantSessionId(ctx: ExtensionContext): string {
  const own = ctx.sessionManager.getSessionId();
  return ctx.hasUI ? own : broker().parentSessionId ?? own;
}
```

Use it in `sessionGrants`, `currentLevel`, `setLevel`, `hasExactGrant`, `sessionAllows`, `addSessionRules`, and `addExactGrant`. Headless `registerSession` must not overwrite the parent level. Headless `unregisterSession` must not delete parent state. Parent shutdown deletes shared grants/level and clears `parentSessionId`/`parentUi`.

For `sessionAllows`, dispatch matching by surface:

```ts
if (rule.surface === "external_directory") {
  return isPathWithin(rule.pattern, value);
}
return patternMatches(value, rule.pattern);
```

- [ ] **Step 4: Implement canonical root grants**

Export segment-safe containment from `paths.ts`:

```ts
export function isPathWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

export async function externalGrantRoot(canonical: string): Promise<string> {
  return lstat(canonical)
    .then((info) => info.isDirectory() ? canonical : dirname(canonical))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return dirname(canonical);
      throw error;
    });
}
```

Replace `externalGrantPattern` callers. Show `Allow <root> and everything inside it for this session` in approval descriptions. Sensitive path assessment continues before grant lookup.

- [ ] **Step 5: Run Task 2 tests and typecheck**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts
bun x tsc --noEmit
```

Expected: PASS; parent/sibling grants share, unrelated sessions remain isolated, and root/sibling boundaries are correct.

- [ ] **Step 6: Commit Task 2**

```bash
git add agent/extensions/permission-gate/src/approvals.ts \
  agent/extensions/permission-gate/src/paths.ts \
  agent/extensions/permission-gate/src/permission-gate.ts \
  agent/extensions/permission-gate/tests/gate.test.ts
git commit -m "fix(permission-gate): share session grants across subagents"
```

---

### Task 3: External Edit and Write Path Gating

**Files:**
- Create: `agent/extensions/permission-gate/src/tool-paths.ts`
- Modify: `agent/extensions/permission-gate/src/permission-gate.ts:115-243`
- Test: `agent/extensions/permission-gate/tests/gate.test.ts:490-505, 507-581`

**Interfaces:**
- Produces:
  - `ToolPathExtraction { paths: string[]; complete: boolean; preview: string }`
  - `extractToolPaths(toolName: "edit" | "write", input: unknown): ToolPathExtraction`
  - `isInternalToolUri(path: string): boolean`
- Consumes: Task 2 `assessPath`, `externalGrantRoot`, and shared `sessionAllows`.

- [ ] **Step 1: Add failing path-extraction and runtime tests**

```ts
test("extracts write and all supported edit target shapes", () => {
  expect(extractToolPaths("write", { path: "/srv/out.txt", content: "x" }).paths).toEqual(["/srv/out.txt"]);
  expect(extractToolPaths("edit", { input: "[src/a.ts#ABCD]\nCUT 1.=1\n" }).paths).toEqual(["src/a.ts"]);
  expect(extractToolPaths("edit", { patch: "*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch\n" }).paths).toEqual(["src/b.ts"]);
  expect(extractToolPaths("edit", { path: "src/c.ts", edits: [] }).paths).toEqual(["src/c.ts"]);
  expect(extractToolPaths("edit", { edits: [{ path: "src/d.ts" }, { filePath: "src/e.ts" }] }).paths)
    .toEqual(["src/d.ts", "src/e.ts"]);
  expect(extractToolPaths("write", { path: "xd://browser", content: "{}" }).paths).toEqual([]);
});

test("reuses one external directory grant across Bash write and edit", async () => {
  // Create project and outside directories, approve the outside root once,
  // then call write and multi-file edit in that root.
  // Assert one prompt total and no block results.
});

test("fails closed for an unparseable nonempty edit payload", async () => {
  // Assert exactly one nonpersistable prompt and no reusable path rule.
});
```

Replace the old “bypasses every non-Bash tool” and “path rules only to Bash” expectations: `ask`, `task`, and internal `xd://` writes still bypass; filesystem `edit`/`write` now gate external and sensitive targets.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts --test-name-pattern "extracts write|reuses one external|unparseable nonempty"
```

Expected: FAIL because `tool-paths.ts` does not exist and non-Bash filesystem tools bypass Permission Gate.

- [ ] **Step 3: Implement pure target extraction**

```ts
export interface ToolPathExtraction {
  paths: string[];
  complete: boolean;
  preview: string;
}

export function isInternalToolUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith("file://");
}

export function extractToolPaths(
  toolName: "edit" | "write",
  input: unknown,
): ToolPathExtraction {
  // write: object.path
  // edit string/object.input: [path#HASH] headers
  // edit object.patch: *** Update/Add/Delete File markers
  // edit object.path and object.edits[].path/filePath
  // unique paths in first-seen order
  // complete=false when a nonempty filesystem edit payload has no recognized target
}
```

Sanitize preview text and cap it to a short target list; never include file contents.

- [ ] **Step 4: Route Bash/edit/write through one path approval helper**

In `tool_call`, return early only for tools outside `bash`, `edit`, and `write`. For edit/write:

1. extract targets;
2. bypass empty internal-URI-only results;
3. assess each target as `write`;
4. hard-deny sensitive targets;
5. reuse root grants;
6. batch uncovered roots into one `ApprovalRequest`;
7. use `{ persistable: false, requiresExact: true }` when extraction is incomplete.

Keep the exact request key deterministic from `ctx.cwd`, tool name, normalized input, and sorted canonical path contexts. Do not place file content in the user-visible preview.

- [ ] **Step 5: Run Task 3 tests and typecheck**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts
bun x tsc --noEmit
```

Expected: PASS; external Bash/edit/write share one root grant, sensitive paths deny, internal device writes bypass, and unrelated tools remain unaffected.

- [ ] **Step 6: Commit Task 3**

```bash
git add agent/extensions/permission-gate/src/tool-paths.ts \
  agent/extensions/permission-gate/src/permission-gate.ts \
  agent/extensions/permission-gate/tests/gate.test.ts
git commit -m "feat(permission-gate): reuse path grants for edit and write"
```

---

### Task 4: Reactive Approval Queue Counter

**Files:**
- Modify: `agent/extensions/permission-gate/src/approvals.ts:41-66, 151-306, 308-323, 390-481`
- Test: `agent/extensions/permission-gate/tests/gate.test.ts:55-110, 350-461`

**Interfaces:**
- Produces:
  - `ApprovalProgressSnapshot { ordinal: number; total: number }`
  - `ApprovalProgressSource { snapshot(): ApprovalProgressSnapshot; subscribe(listener: () => void): () => void }`
  - optional `CompactSelectRequest.progress: ApprovalProgressSource`
- Consumes: existing serialized `requestApproval` queue and custom TUI component API.

- [ ] **Step 1: Add failing queue-state and renderer tests**

Use `Promise.withResolvers()` to hold the first dialog open while two more requests enqueue:

```ts
test("renders reactive right-aligned queue progress and resets after drain", async () => {
  const firstChoice = Promise.withResolvers<string | undefined>();
  // Queue request A, then B and C before resolving A.
  // Render A and expect "1/3" at the right border.
  // Resolve A, render B and expect "2/3".
  // Resolve B, render C and expect "3/3".
  // After C, queue D and assert no counter for hidden 1/1.
});

test("recomputes total when a queued request becomes covered", async () => {
  // A grants a rule covering B; C remains.
  // A shows 1/3, B opens no dialog, C shows 2/2.
});

test("keeps the counter visible at narrow widths without overlapping content", async () => {
  // Render at widths 80, 32, and the minimum supported width.
  // Assert the top line ends with " 1/3 ─╮", the body retains command/options,
  // and the counter uses one <fg:accent><b> style span.
});
```

Also test fallback `ui.select` title contains `[1/3]` and denial/cancellation removes stale entries.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts --test-name-pattern "queue progress|recomputes total|narrow widths"
```

Expected: FAIL because broker queue accounting and `CompactSelectRequest.progress` do not exist.

- [ ] **Step 3: Add queue-cycle accounting**

Extend broker state:

```ts
interface ApprovalQueueEntry {
  id: number;
  displayed: boolean;
}

interface ApprovalQueueCycle {
  nextId: number;
  completed: number;
  entries: ApprovalQueueEntry[];
  subscribers: Set<() => void>;
}
```

Keep the Promise tail for serialization. Enqueue before awaiting the previous tail. Compute the visible ordinal as `completed + 1` and total as `completed + entries.length`. A covered-before-display entry is removed without incrementing `completed`; a displayed entry increments it. Reset the cycle when no entries remain. Notify subscribers on enqueue, removal, completion, denial, and reset.

Expose a per-entry progress source whose `snapshot()` reads current broker state and whose `subscribe()` returns an unsubscribe function.

- [ ] **Step 4: Render the progress chip and clean subscriptions**

Add `progress?: ApprovalProgressSource` to `CompactSelectRequest`. In `selectCompactOption`:

```ts
const snapshot = request.progress?.snapshot();
const counter = snapshot && snapshot.total > 1
  ? ` ${snapshot.ordinal}/${snapshot.total} `
  : "";
```

Build the unstyled title/counter lengths first, then apply `theme.bold(theme.fg("accent", counter))`. Reserve the right chip before fitting the left title; at narrow width omit/truncate the left title first. Add:

```ts
const unsubscribe = request.progress?.subscribe(() => tui.requestRender());
// component.dispose(): unsubscribe?.()
```

For the non-custom fallback, append ` [ordinal/total]` only when total is greater than one.

Pass the active entry's progress source from `requestApproval` to both the stage-one dialog and the secondary rule selector so the counter remains stable throughout one request.

- [ ] **Step 5: Run Task 4 tests and typecheck**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts
bun x tsc --noEmit
```

Expected: PASS; progress updates without reopening the dialog, does not leak subscriptions, and resets after drain.

- [ ] **Step 6: Commit Task 4**

```bash
git add agent/extensions/permission-gate/src/approvals.ts \
  agent/extensions/permission-gate/tests/gate.test.ts
git commit -m "feat(permission-gate): show serialized approval progress"
```

---

### Task 5: Singular Permission Command, Stable Status Icon, and Supported Timeout

**Files:**
- Modify: `agent/extensions/permission-gate/src/permission-gate.ts:20-49, 61-108`
- Modify: `agent/config.yml`
- Test: `agent/extensions/permission-gate/tests/gate.test.ts:436-460, 507-546`

**Interfaces:**
- Produces command registration `permission` with `getArgumentCompletions` and one shared level-update path.
- Removes command registration `permissions` and the `ExtensionTimeoutControl`/`INTERACTIVE_APPROVAL_TIMEOUT_MS` test seam.
- Produces status strings `󰒃 perm:low|medium|high`.

- [ ] **Step 1: Add failing command/status/timeout tests**

```ts
test("supports interactive and direct singular permission changes", async () => {
  const fake = fakeExtension();
  extension(fake.api, agentDirectory);
  expect(fake.commands.has("permissions")).toBe(false);
  const command = fake.commands.get("permission")!;

  expect(command.getArgumentCompletions?.("m")).toEqual([{
    value: "medium",
    label: "medium",
    description: "Reversible workspace changes, installs, builds, tests, and local Git",
  }]);

  await command.handler(" medium ", ctx);
  expect(currentLevel(ctx, "low")).toBe("medium");
  expect(statuses.at(-1)).toEqual(["permission-gate-level", "󰒃 perm:medium"]);

  await command.handler("high extra", ctx);
  expect(currentLevel(ctx, "low")).toBe("medium");
  expect(notifications.at(-1)).toEqual(["Usage: /permission [low|medium|high]", "error"]);
});
```

Keep the existing custom-panel test, but invoke `fake.commands.get("permission")!.handler("", ctx)` and assert interactive selection still works. Add a test that `session_shutdown` clears `permission-gate-level`.

Add tests proving fake extension setup no longer needs or calls `testSetExtensionHandlerTimeoutMs`. Verify the real host setting behavior in Step 4 through OMP's config command rather than adding a YAML parser dependency.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts --test-name-pattern "singular permission|permissions command|timeout"
```

Expected: FAIL because only `/permissions` exists, status has no icon, and the test-only timeout seam remains.

- [ ] **Step 3: Implement one shared level update function and singular command**

```ts
const LEVEL_DESCRIPTIONS: Record<PermissionLevel, string> = {
  low: "File edits and known low-risk/read-only commands",
  medium: "Reversible workspace changes, installs, builds, tests, and local Git",
  high: "All commands except blocklist and explicit high-level denylist asks",
};

function showLevel(ctx: ExtensionContext, level: PermissionLevel): void {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `󰒃 perm:${level}`);
}

function applyLevel(ctx: ExtensionContext, level: PermissionLevel): void {
  setLevel(ctx, level);
  showLevel(ctx, level);
  if (ctx.hasUI) ctx.ui.notify(`Permission Gate: ${level}`, "info");
}
```

Register `permission`. Empty trimmed args open the current panel. A single case-insensitive level calls `applyLevel` directly. Any other tokenization reports exact usage and returns without state mutation. `getArgumentCompletions` returns `{ value, label, description }` for filtered `LEVEL_ORDER` values.

- [ ] **Step 4: Replace timeout seam with supported config**

Delete `ExtensionTimeoutControl`, `INTERACTIVE_APPROVAL_TIMEOUT_MS`, and `testSetExtensionHandlerTimeoutMs`. Add to top-level `agent/config.yml`:

```yaml
extensionHandlers:
  toolCallTimeoutMs: 600000
```

Verify the active host reads the exact value:

```bash
omp config get extensionHandlers.toolCallTimeoutMs
```

Expected: `600000`.

Do not add timeout configuration to `permission-gate.json`; this is an OMP host setting.

- [ ] **Step 5: Run Task 5 tests and typecheck**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts
bun x tsc --noEmit
```

Expected: PASS; singular command, completions, direct/interactive parity, icon lifecycle, and supported timeout are verified.

- [ ] **Step 6: Commit Task 5**

```bash
git add agent/extensions/permission-gate/src/permission-gate.ts \
  agent/extensions/permission-gate/tests/gate.test.ts \
  agent/config.yml
git commit -m "feat(permission-gate): streamline autonomy controls"
```

---

### Task 6: Evidence-Backed Low and Medium Policies

**Files:**
- Modify: `agent/extensions/permission-gate/src/config.ts:56-109`
- Modify: `agent/extensions/permission-gate/src/shell.ts:101-310, 446-502, 608-642, 715-728`
- Modify: `agent/permission-gate.json`
- Test: `agent/extensions/permission-gate/tests/gate.test.ts:132-310`

**Interfaces:**
- Consumes Task 1 `CommandSafety.minimumLevel` and canonical identities.
- Produces synchronized default and tracked active profile rules.

- [ ] **Step 1: Add failing positive and negative policy matrices**

```ts
test("admits evidenced read-only commands at low without wrapper bypasses", async () => {
  const allowLow = [
    "grep -r needle src",
    "strings binary",
    "qmllint Main.qml",
    "tailscale status",
    "tailscale ping host",
    "omp --version",
    "omp models find glm",
    "omp plugin list --json",
    "openssl rand -hex 16",
    "unzip -l archive.zip",
    "fold -w 80 file.txt",
    "od -An -tx1 file.bin",
    "journalctl -u sshd --since today",
  ];
  for (const command of allowLow) {
    const unit = (await analyzeBash(command)).commands[0]!;
    const identity = canonicalizeCommand(unit);
    expect(safetyRequiresApproval(identity.safety, "low"), command).toBe(false);
    expect(resolveCommand(defaultConfig(), "low", identity).policy, command).toBe("allow");
  }
});

test("keeps mutating and ambiguous variants gated", async () => {
  const ask = [
    "grep -R needle .",
    "omp models refresh",
    "omp models --extension ./evil.ts",
    "journalctl --vacuum-time=1d",
    "openssl rand -out secret.bin 32",
    "openssl rand -writerand seed 32",
    "timeout 30 bash -c 'touch /tmp/pwn'",
    "sed -i 'e touch /tmp/pwn' file.txt",
    "perl -i -e 'system q(id)' file.txt",
    "gh pr merge 42",
  ];
  for (const command of ask) {
    const identity = canonicalizeCommand((await analyzeBash(command)).commands[0]!);
    const decision = resolveCommand(defaultConfig(), "medium", identity);
    expect(decision.policy === "ask" || safetyRequiresApproval(identity.safety, "medium"), command).toBe(true);
  }
});

test("admits only bounded mutation forms at medium", async () => {
  const allowMedium = [
    "prettier --write src",
    "biome format --write src",
    "unzip archive.zip -d build",
    "truncate -s 0 build/log.txt",
    "gh issue comment 42 --body fixed",
    "gh pr review 42 --approve",
  ];
  // Assert low asks and medium allows after path assessment.
});
```

- [ ] **Step 2: Run policy tests and verify RED**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts --test-name-pattern "evidenced read-only|mutating and ambiguous|bounded mutation"
```

Expected: FAIL because defaults and semantic floors do not yet encode these exact forms.

- [ ] **Step 3: Add exact low rules and semantic negatives**

Add low patterns for `command -v`, `strings`, `qmllint`, Tailscale status/ping, OMP inspection, stdout-only OpenSSL rand, `unzip -l`, `fold`, `od`, and journal inspection. Permit `grep -r`/`--recursive`; keep `-R`/`--dereference-recursive` as an always-ask safety floor.

Add shell safety rules that always ask for:

- `omp models refresh`, `--extension`, and `--config`;
- OMP plugin actions other than exact `list`;
- `journalctl --vacuum-*`, `--rotate`, `--sync`, and `--flush`;
- OpenSSL `-out`, `-writerand`, and equivalent file-writing forms.

Broad allowlist patterns are acceptable only when these semantic negative checks run first.

- [ ] **Step 4: Add bounded medium rules**

Add exact medium patterns for Prettier/Biome write forms, archive extraction, truncate, GitHub issue `create|edit|comment|close|reopen`, and PR `create|edit|comment|review|close|reopen`. Keep PR merge, admin, release, credential, secret, and workflow privilege operations gated. Keep arbitrary sed/perl in-place programs as always-ask/nonpersistable.

Update both `defaultConfig()` arrays and `agent/permission-gate.json`; do not rely on default merging because existing config files are parsed as complete configurations.

- [ ] **Step 5: Assert active JSON and defaults stay synchronized**

Add a test that loads tracked `agent/permission-gate.json` and compares its profile arrays and deny lists with `defaultConfig()` after removing `$schema`. This prevents future default/config drift.

- [ ] **Step 6: Run Task 6 tests and typecheck**

```bash
cd agent/extensions/permission-gate
bun test tests/gate.test.ts
bun x tsc --noEmit
```

Expected: PASS; every newly allowed class has a mutating negative, hard-deny tests remain unchanged.

- [ ] **Step 7: Commit Task 6**

```bash
git add agent/extensions/permission-gate/src/config.ts \
  agent/extensions/permission-gate/src/shell.ts \
  agent/extensions/permission-gate/tests/gate.test.ts \
  agent/permission-gate.json
git commit -m "feat(permission-gate): tune autonomy from session evidence"
```

---

### Task 7: Public-Safe Corpus Replay and End-to-End Verification

**Files:**
- Create: `agent/extensions/permission-gate/scripts/replay-policy.ts`
- Create: `agent/extensions/permission-gate/tests/replay-policy.test.ts`
- Modify: `agent/extensions/permission-gate/tsconfig.json`
- Verify: all Task 1-6 files and live OMP behavior.

**Interfaces:**
- Produces:
  - `ReplayCounts { bashCalls: number; commandUnits: number; byLevel: Record<PermissionLevel, { allow: number; ask: number; deny: number }> }`
  - `replaySessionFiles(paths: readonly string[]): Promise<ReplayCounts>`
- Consumes Task 1 identity/policy and Task 6 profiles.

- [ ] **Step 1: Add a failing replay test with synthetic JSONL**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replaySessionFiles } from "../scripts/replay-policy";

test("replays Bash calls as aggregate counts without retaining command text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-replay-"));
  try {
    const session = join(directory, "session.jsonl");
    await writeFile(session, [
      JSON.stringify({ type: "message", message: { role: "assistant", toolCalls: [
        { name: "bash", arguments: { command: "git -C /repo status" } },
      ] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", toolCalls: [
        { name: "bash", arguments: { command: "mkfs.ext4 /dev/sda1" } },
      ] } }),
    ].join("\n"));

    const result = await replaySessionFiles([session]);
    expect(result.bashCalls).toBe(2);
    expect(result.commandUnits).toBe(2);
    expect(JSON.stringify(result)).not.toContain("/repo");
    expect(JSON.stringify(result)).not.toContain("mkfs");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run replay test and verify RED**

```bash
cd agent/extensions/permission-gate
bun test tests/replay-policy.test.ts
```

Expected: FAIL because replay script/API does not exist.

- [ ] **Step 3: Implement aggregate-only replay**

The script must:

1. accept file or directory arguments;
2. enumerate `.jsonl` files deterministically;
3. parse lines independently and skip malformed records with an aggregate `parseErrors` count;
4. find Bash tool calls in known OMP message shapes;
5. call `analyzeBash`, `canonicalizeCommand`, and `resolveCommand` for low/medium/high;
6. count allow/ask/deny, treating active safety floors as ask;
7. output JSON counts only—never commands, paths, prompts, messages, emails, or session IDs.

Expose `replaySessionFiles` for tests and guard CLI output with `if (import.meta.main)`.

- [ ] **Step 4: Include scripts in typechecking and run the corpus**

Update `tsconfig.json` include to:

```json
["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
```

Run against ignored local sessions:

```bash
cd agent/extensions/permission-gate
bun scripts/replay-policy.ts ../../sessions > /tmp/permission-gate-replay.json
cat /tmp/permission-gate-replay.json
```

Acceptance: low ask count is below 3,560; medium below 2,178; and high below 1,157. The complete hard-deny regression matrix from `gate.test.ts` must remain green. If the local session directory layout differs, pass the actual ignored `agent/sessions` path explicitly; never copy session data into the repository.

- [ ] **Step 5: Run full automated verification**

```bash
cd agent/extensions/permission-gate
bun test
bun x tsc --noEmit
```

Expected: all tests PASS, zero type errors.

- [ ] **Step 6: Run live OMP smoke verification**

Start a fresh OMP process and exercise the spec checklist:

1. `/permission medium` changes directly and shows `󰒃 perm:medium`.
2. `/permission` opens the picker; choose high and observe `󰒃 perm:high`.
3. Invalid `/permission high extra` reports usage and preserves high.
4. At low, approve one external test directory once; Bash, edit, and write at the exact root and descendant do not ask again.
5. Two subagents reuse the same parent grant.
6. A compound `timeout 30 <safe-read>; git -C <repo> status` opens no more than one dialog.
7. Three queued approvals show right-aligned `1/3`, `2/3`, `3/3`; enqueueing a fourth updates the denominator live.
8. Leave the first prompt open for more than 30 seconds; queued subagents remain pending and do not auto-approve.
9. Start another OMP process; the external directory asks again.

Use a temporary directory only; delete it after verification. Do not use real secrets or destructive commands.

- [ ] **Step 7: Commit replay tooling**

```bash
git add agent/extensions/permission-gate/scripts/replay-policy.ts \
  agent/extensions/permission-gate/tests/replay-policy.test.ts \
  agent/extensions/permission-gate/tsconfig.json
git commit -m "test(permission-gate): replay approval policy safely"
```

- [ ] **Step 8: Final repository and remote checks**

```bash
git status --short
git log --oneline -10
```

Expected: clean working tree and seven focused implementation commits. Push only after requesting-code-review finds no Critical/Important issues and the full verification commands above remain green.
