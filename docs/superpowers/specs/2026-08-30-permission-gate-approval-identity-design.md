# Permission Gate Approval Identity Design

## Problem

Permission Gate asks too often even after the user grants access. Analysis of 147 OMP session logs found 4,389 Bash calls, 1,305 edit/write calls, and 445 external edit/write targets. The excess prompts are caused primarily by inconsistent approval identity and scope rather than a small allowlist.

Current defects:

1. Command policy and grants use raw command text. Safe global options and wrappers change the apparent command, so `git -C /repo status` does not inherit `git status` policy and can produce an unsafe broad `git -C *` grant.
2. Compound Bash calls may ask separately for multiple command units instead of presenting one approval decision.
3. Main-agent and subagent grants use different session IDs. A grant approved in the parent is not reused by sibling subagents.
4. External directory grants cover descendants but not the directory root itself.
5. Permission Gate intercepts Bash but not edit/write paths, so an approved external directory does not suppress later edit/write prompts.
6. Queued subagent requests hit the host's 30-second extension-handler timeout while waiting behind the visible prompt. Session evidence contained 58 such errors; 57 came from subagents.
7. Common read-only command shapes are missing from the low tier, and bounded mutation commands are missing from medium.

## Goals

- One approval identity for semantically equivalent safe command shapes.
- At most one Permission Gate prompt per Bash tool call.
- Grants shared by the main agent and every subagent in the current parent session.
- External-directory grants cover the exact root and all descendants.
- The same path grant covers Bash, edit, and write.
- Queued subagent approvals remain alive long enough for the user to answer.
- Reduce low/medium false positives without weakening hard-deny classes.
- Keep all grants session-only; a new OMP session starts without prior grants.

- Show serialized approval-queue progress as a stable top-right counter when more than one approval is pending.

## Non-goals

- No RTK-specific policy. RTK was an illustrative example, not a recurring command in the analyzed sessions.
- No cross-session or repository-persisted grants.
- No generic shell-language semantic evaluator.
- No broad trust for interpreters, remote execution, secrets, privileged operations, destructive Git, or destructive filesystem operations.
- No silent approval of external writes without an explicit session grant.

## Architecture

### 1. Canonical command identity

Every parsed Bash command unit retains two representations:

- `display`: the original text shown to the user and used for execution.
- `identity`: a normalized command used only for policy lookup, grant matching, and grant creation.

Normalization is conservative. Failure to prove a transformation safe leaves the command unchanged and therefore gated.

#### Git global options

Recognize global options that do not change the command's security class:

- `git -C <directory> <subcommand> ...`
- `git --git-dir <path> --work-tree <path> <subcommand> ...` only when path assessment separately validates every supplied path.

Canonical identity removes safe global options and begins at the Git subcommand. `git -C /repo status --short` becomes `git status --short`; `/repo` remains a separately assessed path.

Do not normalize configuration or execution-changing options such as `git -c`, `--exec-path`, `--config-env`, or unknown global options.

#### Safe wrappers

Recognize only these wrappers:

- `timeout [safe timeout options] <duration> <command>`
- `time [safe display options] <command>`
- `command -v <name>`

`timeout` and `time` inherit the underlying command's policy only after the wrapper parser identifies one unambiguous child command. Wrapper options, redirections, and paths remain independently assessed. `timeout bash -c ...`, arbitrary interpreters, nested unknown wrappers, and malformed forms remain gated.

`command -v` is itself a low-risk inspection command; it does not grant execution rights for the resolved command.

### 2. Compound-call batching

Permission Gate parses all units in one Bash tool call before showing UI.

Processing order:

1. Analyze shell syntax and extract command units, redirects, and paths.
2. Canonicalize each command identity.
3. Apply hard blocklists and deny rules. Any hard-denied unit blocks the tool call and is never grantable.
4. Remove units already covered by policy, exact grants, command grants, or path grants.
5. Deduplicate equivalent uncovered units by canonical identity plus relevant path scope.
6. Present one approval prompt containing every uncovered grantable item.
7. Commit selected grants atomically before releasing the queued tool call.

A compound call such as `timeout 30 tool --read; git -C /repo status` produces one prompt at most, even if both units require a decision.

### 3. Parent-session grant namespace

All grant operations resolve a canonical grant-session key:

- Main agent: its session ID.
- Subagent: the owning parent session ID already used by permission-level lookup.

The following APIs must use the same canonical key:

- session grant creation
- exact-grant lookup
- command-rule lookup
- path-rule lookup
- grant cleanup

Sibling subagents immediately see grants approved by the parent or another sibling. Grants are removed when the parent session shuts down. No grant is written to disk.

### 4. Root-inclusive external path grants

A directory grant represents a closed subtree:

- exact directory root: allowed
- every descendant: allowed
- sibling and parent paths: not allowed

Path comparison uses normalized absolute paths with path-segment boundaries; string-prefix comparison is prohibited. Existing targets are compared by real path. For a not-yet-created write target, resolve the nearest existing ancestor by real path and append the remaining normalized path segments. If real-path resolution fails for reasons other than a missing target, ask rather than allow. A lexical in-project path must never hide an external symlink target.

The approval UI describes the scope explicitly: `Allow /path and everything inside it for this session`.

### 5. Bash, edit, and write path coverage

Permission Gate becomes the single policy layer for external write paths handled by these tools:

- Bash paths extracted from commands and redirections
- edit target paths parsed from the edit patch
- write target path

For edit/write:

1. Resolve every target relative to the tool-call working directory.
2. Apply sensitive-path deny rules before session grants.
3. Allow project-contained targets.
4. Reuse root-inclusive external session grants.
5. Batch all uncovered edit targets into one prompt.
6. On approval, create the selected path grants before the tool executes.

Read remains outside this change unless it already passes through Permission Gate; this design does not add a second read gate.

Sensitive paths such as `.env`, SSH keys, credential files, and token paths remain denied regardless of a broad external-directory grant.

### 6. Approval queue progress indicator

When more than one approval request is active or waiting in the serialized broker queue, the custom Permission Gate frame displays a progress chip at the extreme right of the top border:

```text
╭─ Permission Gate ─────────────────────────────────────────── 1/3 ─╮
│ Allow bash?  ·  Command exceeds low autonomy                       │
│ $ git -C /repo status                                              │
╰─────────────────────────────────────────────────────────────────────╯
```

The counter represents queued approval requests, not grantable items inside the current batched prompt.

Queue behavior:

1. Enqueuing a request increments the active queue cycle's total.
2. The visible request displays its one-based ordinal over the current total.
3. New arrivals update the denominator while the dialog is open.
4. Requests that become covered by a grant before display leave the queue without opening another dialog; the remaining counter is recomputed.
5. When the queue drains, the cycle and ordinal reset. A later independent approval starts a new cycle at `1/1`, which is hidden.
6. Denial or cancellation still releases queued requests according to the existing denial-epoch behavior; the counter must not keep stale entries.

The broker exposes queue progress to `selectCompactOption` through immutable render state plus a subscription that calls `tui.requestRender()` when the total changes. Subscribers are removed when the dialog closes.

Rendering rules:

- Hide the chip for a single request; show it only when the total is greater than one.
- Right-align the complete `current/total` chip immediately before the top-right corner.
- Style the entire chip with one stable theme color and bold weight for every state. Use the existing `accent` theme color; do not mix colors inside the counter.
- Measure unstyled visible text before applying theme escape sequences.
- Reserve border space for the counter so it never overlays or wraps the heading, preview, options, or help text.
- At narrow widths, keep the counter at the right edge and omit or truncate the left `Permission Gate` chip before dropping the counter.
- The non-custom `ui.select` fallback appends `[current/total]` to its title because it cannot right-align border content.

### 7. Prompt queue timeout


Replace the test-only module-global timeout seam with OMP's supported extension configuration:

```yaml
extensionHandlers:
  toolCallTimeoutMs: 600000
```

Permission Gate continues to serialize visible prompts. Ten minutes applies to the total extension handler wait, including time queued behind another prompt. A timeout still denies/fails closed; it never auto-approves.

### 8. Tier policy additions

#### Low: read-only and non-mutating

Add or recognize these evidenced classes:

- Canonicalized read-only Git forms: `status`, `log`, `diff`, `show`, non-mutating `branch` inspection, `rev-parse`, and `ls-files`.
- `timeout` and `time` around an independently low-risk command.
- `command -v`.
- Recursive `grep` inspection forms, subject to sensitive-path denies.
- `strings`, `qmllint`, `fold`, and `od`.
- `tailscale status` and `tailscale ping`.
- Exact OMP inspection forms: `omp --help`, `omp --version`, `omp models` list/search forms, and `omp plugin list`. Refresh, install, link, enable, disable, and uninstall forms remain gated.
- `openssl rand` to standard output; `-out` remains a write assessed at its target path.
- `unzip -l`.
- `journalctl` inspection forms excluding `--vacuum-*`, `--rotate`, `--sync`, `--flush`, and other mutating options.

Options that make a normally read-only command mutate state must not inherit the low rule.

#### Medium: bounded mutation

Add narrowly matched forms:

- Prettier `--write`.
- Biome format/write and safe fix forms. Other formatters remain gated until individually added with positive and mutating negative tests.
- `sed -i` and `perl -i` only with project-contained or session-granted target paths.
- Archive extraction with project-contained or session-granted destinations.
- `truncate` with project-contained or session-granted targets.
- GitHub issue `create`, `edit`, `comment`, `close`, and `reopen`; and PR `create`, `edit`, `comment`, `review`, `close`, and `reopen`. Merge, repository administration, release, credential, secret, and workflow-privilege operations remain gated.

#### Always gated or denied

Retain strict handling for:

- arbitrary interpreters, `eval`, and shell-string execution
- SSH and remote execution
- secret-tool, keychain, and credential access
- curl uploads and mutating requests
- sudo and system/service operations
- destructive Git operations
- destructive filesystem operations
- writes outside project without a current-session grant
- unknown or ambiguous wrappers

## Data and API changes

Introduce explicit internal types rather than passing raw strings:

```ts
interface CommandIdentity {
  display: string;
  canonical: string;
  paths: AssessedPath[];
}

interface SessionScope {
  parentSessionId: string;
}

interface PathGrant {
  root: string;
  includeRoot: true;
  includeDescendants: true;
}

interface ApprovalQueueProgress {
  cycleId: number;
  ordinal: number;
  total: number;
  subscribe(listener: () => void): () => void;
}
```

These interfaces are conceptual contracts; implementation names may follow existing project conventions, but each representation and scope must remain distinct.

Existing public slash-command behavior and configuration keys remain compatible except for the new supported timeout setting. Existing session grants need no migration because grants are in-memory and session-scoped.

## Error handling and security invariants

- Normalization failure means ask, never allow.
- Parsing failure means ask or deny according to the current fail-closed behavior.
- Hard deny rules run before and override all grants.
- Path grants never override sensitive-path denies.
- Compound batching never converts a denied unit into a grantable item.
- Grant persistence failure is impossible because grants remain memory-only.
- Parent-session resolution failure falls back to the current session ID; it never creates a global grant.
- Timeout or UI cancellation denies the pending request and releases the queue.

## Testing

### Unit and regression tests

- Git global-option normalization and rejection of unsafe global options.
- Wrapper normalization for valid forms and fail-closed behavior for interpreters, unknown options, and malformed commands.
- Canonically equivalent commands matching the same policy and grant.
- Compound calls producing one prompt with deduplicated grant items.
- Parent, child, and sibling sessions sharing one grant namespace; unrelated parent sessions remain isolated.
- Path grants covering exact root and descendants but not parents, siblings, or similarly prefixed paths.
- Sensitive paths overriding directory grants.
- Edit/write targets reusing Bash-created path grants and vice versa.
- One prompt for multi-file external edits.
- Queue progress rendering for `1/3`, `2/3`, and `3/3`, including a request that arrives while the first dialog is open.
- Queue-total recomputation when a waiting request becomes covered, denial/cancellation cleanup, and reset after the queue drains.
- Header rendering at normal and narrow terminal widths: right alignment, no body overlap, one consistent accent style, and correct visible-width accounting.
- Fallback `ui.select` title formatting when the custom renderer is unavailable.
- Supported 600,000 ms extension-handler timeout configuration.
- Every new low/medium pattern has a mutating or ambiguous negative case.

### Corpus replay

Replay the anonymized 147-session command corpus through the classifier.

Record before/after ask counts for low, medium, and high. Acceptance requires:

- measurable reduction from the baselines of 3,560 low, 2,178 medium, and 1,157 high weighted asks
- no newly allowed command in hard-deny classes
- no broad wrapper grant such as `git -C *` or `timeout *`
- normalized commands retain every independently relevant path assessment

### Live OMP smoke test

1. Start a fresh OMP session at low autonomy.
2. Approve one external directory.
3. Exercise the exact root and a descendant through Bash, edit, and write; observe no repeat prompt.
4. Start two subagents using the same approved scope; observe no sibling repeat prompt.
5. Run a compound safe-wrapper and `git -C` command; observe no more than one prompt.
6. While the first of three serialized subagent approvals is visible, observe `1/3` at the extreme right; then observe `2/3` and `3/3` as the queue advances without covering body text.
7. Enqueue another approval while the first dialog is open and confirm the denominator updates without reopening the dialog.
8. Queue subagent requests behind a visible prompt for longer than 30 seconds; observe no timeout and no auto-approval.
9. Start a new OMP session and confirm the external directory asks again and a single request shows no counter.

## Rollout

1. Land canonical identity and tests without broad policy additions.
2. Land parent-session and path-grant semantics together with reactive queue accounting and the top-right progress chip.
3. Add edit/write interception and timeout configuration.
4. Add low and medium tier patterns with negative tests.
5. Replay the corpus and run live OMP smoke tests.
6. Remove obsolete raw-text grant paths and the test-only timeout seam in the same clean cutover; no compatibility alias remains.

## Acceptance criteria

- A single logical permission decision produces at most one prompt per Bash tool call.
- Approving an external directory once covers its root and descendants for Bash, edit, and write across the parent and all subagents in that session.
- The same grant does not survive a new OMP session.
- `git -C` and safe wrappers inherit underlying policy without generating broad wrapper grants.
- Queued subagents do not fail at 30 seconds while waiting for approval.
- Multiple serialized approvals show a right-aligned, consistently styled `current/total` counter that updates as the queue changes, never overlaps dialog content, and disappears for a single request.
- Low/medium ask counts decrease against the recorded corpus without weakening hard denies.
