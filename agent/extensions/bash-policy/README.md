# OMP Bash and tool permission policy

A local Oh My Pi (OMP) extension that adds OpenCode-style permission rules without installing a separate permission plugin.

The extension is a security gate in front of OMP tool execution. It can:

- auto-allow known read-only Bash commands such as `ls`;
- ask before commands such as `git commit`;
- permanently deny catastrophic shell operations;
- remember an exact approval for the current session;
- parse compound Bash with tree-sitter;
- protect sensitive files and paths outside the current project;
- resolve symlinks before making path decisions;
- apply permissions to Bash and non-Bash tools;
- hide tools that are denied as a whole;
- apply main, subagent, and named-agent overrides;
- forward an in-process subagent approval request to the parent OMP UI.

This directory is self-contained. `@gotgenes/pi-permission-system` was used as a design reference only; it is not installed or loaded.

## Files

```text
~/.omp/agent/extensions/bash-policy/
├── src/
│   ├── index.ts            # OMP event handlers and decision pipeline
│   ├── config.ts           # strict config parsing and scope merging
│   ├── policy.ts           # wildcard matching and decision precedence
│   ├── command-safety.ts   # structured Bash argument safety rules
│   ├── bash.ts             # tree-sitter Bash analysis and hard safety rules
│   ├── paths.ts            # path extraction and canonicalization
│   ├── approvals.ts        # session grants and parent approval forwarding
│   └── principal.ts        # main/subagent/named-agent detection
├── tests/
│   └── policy.test.ts      # behavior and integration tests
├── config.json             # global policy
├── config.schema.json      # editor schema for policy files
├── package.json            # extension manifest and dependencies
├── bun.lock                # reproducible dependency versions
├── tsconfig.json           # strict typecheck configuration
└── README.md
```

## How it works

```text
Model requests a tool
        |
        v
Load global + project + agent policy
        |
        v
Resolve tool rule -------------------------> deny -> block
        |
        +-- Bash: parse every executable command
        |      +-- catastrophic operation -> deny
        |      +-- opaque wrapper/indirection -> at least ask
        |
        +-- Extract filesystem paths
               +-- sensitive path rule -> allow/ask/deny
               +-- canonical path outside project -> external_directory rule
        |
        v
Most restrictive result wins
        |
        +-- allow -> execute
        +-- ask  -> approve once / allow exact for session / deny
        +-- deny -> block
```

`deny` outranks `ask`; `ask` outranks `allow`. A safe-looking command cannot hide a denied or approval-requiring command later in a pipeline, list, substitution, redirect, or wrapper.

## Fresh-machine installation

### 1. Copy the extension directory

Place the complete directory at:

```text
~/.omp/agent/extensions/bash-policy/
```

Runtime requires `src/`, `config.json`, `package.json`, and the installed dependencies. Keep `bun.lock` for reproducible installation. The schema, tests, TypeScript configuration, and this README are development and maintenance files.

### 2. Install local dependencies

```bash
cd ~/.omp/agent/extensions/bash-policy
bun install
```

This installs only the local parser/runtime dependencies declared in `package.json`:

- `tree-sitter-bash`
- `web-tree-sitter`
- `zod`

It does not install another OMP permission plugin.

### 3. Restart OMP

Extensions are loaded when an OMP session starts. Fully exit and start OMP again:

```bash
omp
```

A session that was already running before the extension was installed still has the old module instance.

### 4. Avoid duplicate policy prompts

OMP's native tool approval system runs independently. If native `tools.approval.bash` is set to `prompt`, OMP may prompt before this extension also evaluates the command.

Use the extension as the Bash command-level gate while leaving OMP's session mode at its normal `yolo` default, or explicitly allow the Bash tool at OMP's coarse tool level. Do not load this extension and another Bash permission extension simultaneously.

## Configuration files

### Global policy

```text
~/.omp/agent/extensions/bash-policy/config.json
```

This file is required.

### Project policy

```text
<project>/.omp/bash-policy.json
```

This file is optional. The project file uses the same schema and overrides the global policy for that project.

### Validation

Both files are parsed as strict JSON:

- unknown top-level fields are rejected;
- decisions must be `allow`, `ask`, `deny`, or `{ "deny": "reason" }`;
- permission surfaces and patterns must have non-empty names;
- malformed JSON is rejected;
- invalid configuration fails closed, so tool calls are blocked instead of silently using a permissive fallback.

Point an editor at `config.schema.json` using the `$schema` field:

```json
{
  "$schema": "./config.schema.json"
}
```

A project file can reference the global schema with an absolute `file://` URL or a copied schema.

## Permission format

A complete configuration has this shape:

```json
{
  "$schema": "./config.schema.json",
  "hideDeniedTools": true,
  "bashSafety": {
    "customEnvironment": "ask",
    "pty": "ask",
    "commands": {
      "find": [
        {
          "policy": "ask",
          "reason": "find can write result data or delete matching paths",
          "arguments": ["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]
        }
      ]
    }
  },
  "permission": {
    "*": "allow",
    "bash": {
      "*": "ask",
      "ls": "allow",
      "ls *": "allow",
      "git status": "allow",
      "git status *": "allow",
      "git commit *": "ask",
      "git push *": { "deny": "Pushing is disabled in this environment" }
    },
    "path": {
      "*": "allow",
      "**/.env": { "deny": "Environment secrets are protected" }
    },
    "external_directory": "ask"
  },
  "agents": {
    "main": {},
    "subagent": {},
    "scout": {
      "permission": {
        "bash": {
          "*": "ask",
          "git status *": "allow"
        }
      }
    }
  }
}
```

### Decisions

| Value | Effect |
|---|---|
| `"allow"` | Let the tool call continue without this extension prompting. |
| `"ask"` | Ask interactively, forward to the parent, or block when no interactive parent exists. |
| `"deny"` | Block permanently with a generic reason. |
| `{ "deny": "reason" }` | Block permanently and show the supplied reason. |

### Wildcards

Patterns use OpenCode-style matching:

- `*` matches any number of characters, including `/`;
- `?` matches exactly one character;
- later matching rules win within the same rule map.

Use command-boundary pairs instead of unsafe raw prefixes:

```json
{
  "ls": "allow",
  "ls *": "allow"
}
```

Avoid `"ls*": "allow"`, because it also matches unrelated executable names beginning with `ls`.

### Structured Bash safety

`permission.bash` remains the readable command-pattern policy. `bashSafety` adds argument-aware safety floors for commands whose read-only and mutating forms share the same prefix. A safety rule may only raise a decision to `ask` or `deny`; it cannot turn an inherited `ask` or `deny` into `allow`.

Command rules support:

- `subcommands`: exact first-argument scope, such as `git branch`;
- `arguments`: exact option matches; long options also match `--option=value`;
- `argumentPrefixes`: explicit attached-value forms such as `-mod=`;
- `shortFlags`: single-character flags, including clustered forms such as `curl -ILo`;
- `always: true`: match every invocation in the selected command/subcommand scope;
- `unlessArguments`: skip the rule when an exact exception is present.

Within one rule, argument, prefix, and short-flag matchers are alternatives. `subcommands` narrows those matchers. Any matching `deny` wins; otherwise a matching `ask` raises the command to approval.

Project command rules append to the global safety rules. Project `customEnvironment` and `pty` values merge by `deny` > `ask` > `allow`, so a project can tighten but cannot weaken the global safety floor. With the supplied defaults, any non-empty Bash `env` object or `pty: true` asks even when the command itself is auto-allowed.

### Scope precedence

Configuration is applied in this order:

1. global `config.json`;
2. project `<project>/.omp/bash-policy.json`;
3. generic `agents.subagent` policy for headless child agents;
4. exact named-agent policy, such as `agents.scout`.

Later scopes override or append rules from earlier scopes. Within a rule map, the last matching pattern wins.

## Current default Bash behavior

The supplied `config.json` defaults unknown Bash commands to `ask`.

Representative auto-allowed commands include:

- file readers/listing: `ls`, `cat`, `head`, `tail`, `less`, `file`, `stat`, `wc`, `tree`, `pwd`;
- lookup/search: `which`, `whereis`, `type`, `rg`, `grep`, `find`, `fd`, `ag`, `ack`, `locate`;
- Git reads: `git status`, `git diff`, `git log`, `git show`, `git blame`, `git rev-parse`, `git ls-files`, `git ls-tree`, selected read-only branch/tag forms;
- environment/process reads: `env`, `printenv`, `ps`, `pgrep`;
- network reads: HEAD-only `curl`, bounded `ping`, `host`, `dig`, `nslookup`;
- package metadata: selected `npm`, `yarn`, `pip`, `cargo`, and `go list` forms.

A command such as `git commit -m "fix"` is not auto-allowed and therefore asks.

Read-only prefixes are hardened against mutating or executing options. Examples forced to at least `ask` include:

- `find ... -delete`, `-exec`, `-execdir`, `-ok`, or `-okdir`;
- `fd -x`, `fd -X`, `--exec`, or `--exec-batch`;
- `git diff/log/show --output` or `--ext-diff`;
- mutating `git branch` and `git tag` options;
- `curl` output, upload, request, data, or config options;
- output-writing options for `tree` and `less`;
- execution or overlay options for `go list`.

## Tree-sitter Bash parsing

Every Bash call is parsed with `tree-sitter-bash`. The policy evaluates each executable command unit rather than matching only the beginning of the raw string.

Examples:

```bash
ls; git commit -m "fix"
git status && git push
cat file | head
printf '%s\n' "$(git status)"
echo hi > output.txt
```

If any executable unit asks, the entire Bash call asks. If any unit denies, the entire call is denied.

Malformed or incomplete Bash fails safe to `ask`.

### Indirection and opaque execution

The extension forces wrappers to at least `ask` when the real execution cannot be trusted from an allowed prefix. Covered forms include:

- `bash -c`, `sh -c`, and other shell `-c` programs;
- `sudo`, `doas`, `su`, `env`, `command`, `eval`, `exec`;
- `xargs`, GNU `parallel`, `watch`, `timeout`, `nice`, `nohup`, `setsid`, `chroot`;
- output redirection and background execution.

## Permanent catastrophic denies

The parser applies non-configurable hard stops for operations that should never be approved accidentally:

- recursive forced deletion of `/`, `/*`, the home root, or the home tree;
- the same deletion hidden behind wrappers such as `sudo`;
- `mkfs` filesystem formatting;
- machine shutdown/reboot commands;
- `dd` writes to device paths other than `/dev/null`;
- recursive `chmod` or `chown` of `/`;
- remote content piped directly into a shell;
- the standard shell fork bomb.

These checks run before interactive approval. There is no approval button for a catastrophic deny.

## Session approvals

For an `ask` decision, the dialog offers:

1. **Approve once** — allow this call only;
2. **Allow this exact request for this session** — remember the exact tool input under the current session ID;
3. **Deny** — block it.

A session grant is exact. Approving `git commit -m "one"` does not approve a different commit command. Filesystem grants are also bound to the current working directory and canonical targets, so retargeting a symlink asks again. Grants are removed on session shutdown and are not written to disk.

## Sensitive paths

The default policy permanently denies common secret locations, including:

- `.env` and `.env.*`, with `.env.example` and `.env.sample` allowed later;
- `.ssh/**`;
- `.gnupg/**`;
- `.aws/credentials`;
- token-bearing files beneath `.config`;
- `.netrc`, `.npmrc`, and `.pypirc`.

Path rules are checked against:

1. the raw spelling supplied by the model;
2. the absolute path;
3. the canonical path after resolving symlinks.

The most restrictive result wins.

## External-directory protection

`external_directory` applies when a canonical path falls outside the OMP session's current working directory.

The default is:

```json
{
  "external_directory": "ask"
}
```

This protects both existing paths and new write targets. The resolver walks every existing component, follows symlinks—including a final symlink whose target file does not exist yet—and then appends only the genuinely missing suffix. A symlinked directory or write target therefore cannot disguise an outside-project path.

Example:

```text
project/link -> /outside
project/link/new.txt
```

The canonical target is `/outside/new.txt`, so it is treated as external.

## Cross-tool enforcement

Path protection is not limited to Bash. The extension inspects path-like fields on tool calls such as:

- `read`, `write`, and free-form `edit` patches;
- `glob` and `grep`;
- LSP file operations;
- other tools using `path`, `paths`, `file`, `filename`, `cwd`, `workdir`, `directory`, `root`, or `target` fields.

Internal URL schemes such as `xd://`, `omp://`, and `artifact://` are not treated as filesystem paths.

Tool-specific policies can also be configured directly:

```json
{
  "permission": {
    "read": {
      "*": "allow",
      "**/secrets/**": "deny"
    },
    "write": "ask",
    "browser": "deny"
  }
}
```

## Tool hiding

When `hideDeniedTools` is `true`, a tool denied by a scalar surface rule is removed from the model's active tool list before the turn starts:

```json
{
  "hideDeniedTools": true,
  "permission": {
    "browser": "deny"
  }
}
```

A tool with a pattern map is not hidden because some patterns may still be allowed.

## Per-agent policies

Reserved principal names:

- `main` — the interactive parent OMP session;
- `subagent` — generic fallback for a headless child.

The extension also detects configured OMP built-ins (`scout`, `reviewer`, `designer`, and `task`) from their role prompt and supports custom agents whose Markdown files are available at:

```text
<project>/.omp/agents/<name>.md
~/.omp/agent/agents/<name>.md
```

Example read-only scout policy:

```json
{
  "agents": {
    "scout": {
      "permission": {
        "bash": "deny",
        "write": "deny",
        "edit": "deny",
        "read": "allow",
        "grep": "allow",
        "glob": "allow"
      }
    }
  }
}
```

With `hideDeniedTools: true`, Bash, write, and edit are also hidden from that scout.

## Subagent approval forwarding

OMP task subagents run headless, so they cannot display their own approval dialog. Extension instances share an in-process approval broker:

1. the interactive main session registers its UI;
2. a child reaches an `ask` decision;
3. the child serializes the request through the broker;
4. the parent UI displays `Subagent <principal>: Allow <tool>?`;
5. the parent's choice resolves the child tool call.

Concurrent requests are serialized so dialogs do not overlap. If no interactive parent is registered, the child fails closed and the request is denied.

Forwarding covers OMP's in-process `task` subagents. It does not forward across unrelated OMP processes or remote machines.

## Approval timeout versus Bash timeout

OMP 17.0.7 counts time spent in an extension UI dialog against its generic 30-second handler watchdog. This extension raises that process-wide watchdog to JavaScript's maximum safe timer delay, approximately 24.8 days.

This affects the time available to answer the approval dialog. It does **not** grant the shell command a 24.8-day runtime.

Bash keeps its independent execution timeout:

- default Bash timeout: 300 seconds;
- explicit nonzero timeout: clamped by OMP between 1 and 3600 seconds;
- `timeout: 0`: no Bash execution deadline.

The Bash timer starts after approval, when command execution begins.

## Editing the policy

1. Edit global `config.json`, or create `<project>/.omp/bash-policy.json`.
2. Validate JSON and rule values.
3. Restart OMP so the session loads a fresh extension instance.

No configuration-reload command is installed.

## Verification

From the extension directory:

```bash
cd ~/.omp/agent/extensions/bash-policy
bun test
bun x tsc --noEmit
bun build src/index.ts --outdir=/tmp/bash-policy-build --target=bun
```

The tests cover:

- wildcard precedence and custom deny reasons;
- strict config validation and global/project/agent merging;
- named built-in principal detection;
- compound commands and substitutions;
- wrappers, redirections, and indirection;
- catastrophic denies, including wrapped deletion;
- sensitive paths, external directories, and symlink escapes;
- path extraction across tools;
- real extension registration, safe allow, session approval, and denial;
- denied-tool hiding;
- parent forwarding and session grants.

Manual smoke checks after restarting OMP:

| Request | Expected result |
|---|---|
| `ls -la` | Runs without this extension prompting. |
| `git status` | Runs without this extension prompting. |
| `git commit --allow-empty -m "permission test"` | Asks. |
| Repeat after choosing session approval | Runs without a second prompt. |
| `cat ~/.ssh/id_rsa` | Denied. |
| `find . -delete` | Asks. |
| `sudo rm -rf /` | Denied with no approval option. |
| `ls; git commit -m "test"` | Asks for the whole Bash call. |

Use a disposable Git repository for commit tests.

## Security boundaries and limitations

- This is an OMP extension, not an operating-system sandbox. Commands run outside OMP are unaffected.
- OMP native tool approval remains an independent earlier gate; this extension cannot weaken a native deny or skipped native approval.
- The Bash AST parser is real tree-sitter parsing, but filesystem argument extraction is intentionally conservative and command-aware rather than a complete semantic model of every Unix executable.
- Dynamic execution that cannot be resolved confidently is raised to `ask`; it is never silently auto-allowed.
- Cross-tool path extraction covers standard OMP path fields and free-form edit headers. A third-party tool using an unrelated field name needs an explicit surface rule until its path field is added.
- The approval-timeout workaround changes the generic extension watchdog process-wide because OMP 17.0.7 exposes no per-handler pause API. The README calls this out because it affects other extension handlers in the same process.
- Global and project configuration files are trusted local policy. Protect them with normal filesystem permissions.

## Removal

Delete or move the extension directory, then restart OMP:

```bash
rm -rf ~/.omp/agent/extensions/bash-policy
```

Back up `config.json` first if it contains custom rules.
