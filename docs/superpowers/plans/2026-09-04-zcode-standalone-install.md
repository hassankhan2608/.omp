# ZCode Standalone Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `omp-zcode-provider` as a standalone public Git repository that OMP can install atomically on a clean device, including pinned Happy DOM runtime dependencies.

**Architecture:** Split the existing provider subtree into an isolated Git worktree and make that standalone branch the new repository's `main`. OMP installs the root package through its native Git PluginManager, which runs Bun dependency installation and validates the TypeScript extension entry; after exact-commit verification, the duplicate nested provider is removed from `.omp`.

**Tech Stack:** TypeScript, Bun 1.4, OMP PluginManager/CLI 18.1.x, Git/GitHub, GitHub Actions, `happy-dom@20.11.6`, `undici`.

**Spec:** `docs/superpowers/specs/2026-09-04-zcode-standalone-install-design.md`

## Global Constraints

- The standalone repository is public by explicit user decision; do not add a license or assert rights absent from upstream `TriDefender/zcode-api`.
- `happy-dom` remains pinned exactly to `20.11.6`; no independent upgrade.
- `undici` remains a runtime dependency.
- `@oh-my-pi/pi-catalog` is a required peer because OMP does not host-rewrite it; `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` are optional peers. All three remain matching development dependencies.
- Keep vendored files and `PINNED_UPSTREAM_REF = "5fcb778"` parity semantics unchanged.
- Native OMP installation only: no copy hook, proxy, daemon, SQLite write, or second protocol layer.
- The standalone repository becomes the sole provider source after cutover; no mirror, alias, submodule, or deprecated nested path remains.
- Do not stage or modify `.omp/agent/config.yml` or `.omp/marketplaces.json`.
- Use a temporary commit-message file with `git commit -F` whenever a message contains backticks.

---

### Task 1: Preserve provider history in an isolated standalone worktree

**Files:**
- Source subtree: `agent/extensions/omp-zcode-provider/**`
- Create worktree: `/tmp/omp-zcode-provider`
- Create branch: `zcode-standalone`

**Interfaces:**
- Consumes: committed provider subtree through `.omp` commit `64eb65b` or later.
- Produces: a standalone Git branch whose repository root is the provider package root.

- [ ] **Step 1: Confirm the current checkout and dirty-file boundary**

Run:

```bash
cd /home/laughingman/.config/omp
git status --short
git log --oneline -3
```

Expected: only user-owned `agent/config.yml` and `marketplaces.json` are dirty; the approved design/plan commits may appear in history.

- [ ] **Step 2: Split provider history**

Run:

```bash
cd /home/laughingman/.config/omp
git subtree split --prefix=agent/extensions/omp-zcode-provider -b zcode-standalone
```

Expected: a new branch SHA. This reads committed history only and does not touch the dirty working tree.

- [ ] **Step 3: Create the isolated worktree**

Run:

```bash
git worktree add /tmp/omp-zcode-provider zcode-standalone
```

Expected: `/tmp/omp-zcode-provider/package.json` exists at worktree root and `git status --short` there is empty.

- [ ] **Step 4: Establish standalone ignores**

Create `/tmp/omp-zcode-provider/.gitignore` with exactly:

```gitignore
node_modules/
coverage/
*.log
.DS_Store
.env
.env.*
```

Rationale: dependency output and local secrets stay out; package metadata, source, tests, probes, and lockfile stay tracked.

- [ ] **Step 5: Verify the pre-change baseline**

Run:

```bash
cd /tmp/omp-zcode-provider
bun install --frozen-lockfile
bun test
bun run typecheck
bun run lint
ZCODE_API_REPO=/home/laughingman/repos/zcode-api bun run parity
```

Expected: 383 tests pass, typecheck/lint clean, and `Parity OK.`

Do not commit yet; `.gitignore` ships with the package-contract change in Task 3.

---

### Task 2: Add a clean-device install smoke and prove RED

**Files:**
- Create: `/tmp/omp-zcode-provider/install-smoke.ts`
- Modify: `/tmp/omp-zcode-provider/package.json`

**Interfaces:**
- Consumes: one CLI argument in OMP package-source form, e.g. `github:hassankhan2608/omp-zcode-provider#$SHA`.
- Produces: exit 0 only when OMP installs the target in an isolated HOME and discovers a ZCode model; otherwise surfaces complete install/model stderr and exits non-zero.

- [ ] **Step 1: Write the smoke executable**

Create `install-smoke.ts`:

```ts
/**
 * Clean-device installation smoke.
 *
 * Uses an isolated HOME so no global plugin, provider checkout, credential, or
 * node_modules tree can make a broken package appear healthy. The target must
 * be an immutable Git ref in CI; callers pass it explicitly.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: bun run install-smoke.ts TARGET");

const home = await mkdtemp(join(tmpdir(), "omp-zcode-install-"));
const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
};

async function runOmp(args: string[]): Promise<string> {
  const processHandle = Bun.spawn(["omp", ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`omp ${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
  }
  return stdout;
}

try {
  await runOmp(["install", target, "--json"]);
  const plugins = await runOmp(["plugin", "list", "--json"]);
  if (!plugins.includes("omp-zcode-provider")) {
    throw new Error(`plugin inventory did not identify omp-zcode-provider\n${plugins}`);
  }

  const models = await runOmp(["models", "zcode", "--json"]);
  if (!models.includes("GLM-5.3")) {
    throw new Error(`installed provider exposed no GLM-5.3 model\n${models}`);
  }
  console.log(`clean install passed: ${target}`);
} finally {
  await rm(home, { recursive: true, force: true });
}
```

The named `runOmp` function is justified: three subprocess calls would otherwise duplicate failure capture and environment propagation; its name defines the smoke's process boundary.

- [ ] **Step 2: Add the script command and TypeScript/lint scope**

In `package.json`, add:

```json
"install-smoke": "bun run install-smoke.ts"
```

In `tsconfig.json`, append `"install-smoke.ts"` to `include`.

In `eslint.config.js`, append `"install-smoke.ts"` to the probe/test override's `files` list because Bun subprocess streams and smoke assertions are test-harness behavior.

- [ ] **Step 3: Verify RED against the current Git install target**

Run:

```bash
cd /tmp/omp-zcode-provider
bun run install-smoke.ts github:hassankhan2608/.omp#64eb65b
```

Expected: FAIL before model discovery because the `.omp` repository root is not an extension package and has no root `package.json`. This is the saved behavioral reproduction; a syntax/import error in the smoke is not an acceptable RED.

Do not weaken the smoke to accept a nested package or pre-install dependencies manually.

---

### Task 3: Define the standalone package dependency contract

**Files:**
- Modify: `/tmp/omp-zcode-provider/package.json`
- Modify: `/tmp/omp-zcode-provider/bun.lock`
- Modify: `/tmp/omp-zcode-provider/README.md`
- Modify: `/tmp/omp-zcode-provider/.gitignore`
- Test: `/tmp/omp-zcode-provider/install-smoke.ts`

**Interfaces:**
- Consumes: OMP 18.1.x host APIs and Bun's Git-package installation.
- Produces: root `omp.extensions = ["./src/extension.ts"]`, runtime `happy-dom`/`undici`, required `pi-catalog` peer, and optional `pi-ai`/`pi-coding-agent` peers.

- [ ] **Step 1: Rewrite only dependency ownership and package metadata**

Set the relevant `package.json` fields to:

```json
{
  "name": "omp-zcode-provider",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "files": ["src", "README.md"],
  "omp": {
    "extensions": ["./src/extension.ts"]
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "parity": "bun run upstream-parity.ts",
    "install-smoke": "bun run install-smoke.ts"
  },
  "dependencies": {
    "happy-dom": "20.11.6",
    "undici": "^8.10.0"
  },
  "peerDependencies": {
    "@oh-my-pi/pi-ai": "^18.1.5",
    "@oh-my-pi/pi-catalog": "^18.1.5",
    "@oh-my-pi/pi-coding-agent": "^18.1.5"
  },
  "peerDependenciesMeta": {
    "@oh-my-pi/pi-ai": { "optional": true },
    "@oh-my-pi/pi-coding-agent": { "optional": true }
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@oh-my-pi/pi-ai": "^18.1.5",
    "@oh-my-pi/pi-catalog": "^18.1.5",
    "@oh-my-pi/pi-coding-agent": "^18.1.5",
    "@types/bun": "1.3.14",
    "eslint": "^10.9.1",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.69.0"
  }
}
```

`private: true` prevents accidental npm publication; it does not block OMP's Git installation. `pi-catalog` deliberately has no `peerDependenciesMeta` entry: the exact-SHA RED at `47ee769` proved OMP does not host-rewrite it, while Bun installs a required peer when the plugin store lacks one. Qoder and two other provider packages use this required-peer pattern for runtime `pi-catalog` imports.

- [ ] **Step 2: Regenerate and freeze the lockfile**

Run:

```bash
cd /tmp/omp-zcode-provider
rm -rf node_modules
bun install
bun install --frozen-lockfile
```

Expected: both installs succeed; `happy-dom@20.11.6` and `undici` resolve as runtime dependencies, required peer `pi-catalog` is materialized by Bun, and optional host-rewritten OMP packages remain available for development.

- [ ] **Step 3: Document the supported install command**

Add near the top of `README.md`:

````markdown
## Install

```bash
omp install github:hassankhan2608/omp-zcode-provider
```

OMP's Git PluginManager installs dependencies and validates
`src/extension.ts` before activation. Do not use a local filesystem path as a
clean-device installation method: local paths are development links and do
not install the linked package's dependencies.
````

Also document `bun run install-smoke -- "$TARGET"` in the Commands section.

- [ ] **Step 4: Run local package gates**

Run:

```bash
bun test
bun run typecheck
bun run lint
ZCODE_API_REPO=/home/laughingman/repos/zcode-api bun run parity
```

Expected: all provider tests pass; typecheck and lint emit no findings; parity reports OK.

- [ ] **Step 5: Commit the standalone package contract**

Write a commit message to `/tmp/zcode-standalone-package.txt`, then run:

```bash
git add .gitignore package.json bun.lock tsconfig.json eslint.config.js README.md install-smoke.ts
git commit -F /tmp/zcode-standalone-package.txt
rm /tmp/zcode-standalone-package.txt
```

Commit subject: `fix: make clean-device installation self-contained`.

---

### Task 4: Add continuous exact-commit installation verification

**Files:**
- Create: `/tmp/omp-zcode-provider/.github/workflows/verify.yml`
- Modify: `/tmp/omp-zcode-provider/README.md`

**Interfaces:**
- Consumes: GitHub push SHA, public Git checkout, OMP CLI 18.1.5, pinned upstream zcode-api ref `5fcb778`.
- Produces: CI proof that tests/typecheck/lint/parity pass and the pushed exact SHA installs through OMP in an empty HOME.

- [ ] **Step 1: Create the verification workflow**

Create `.github/workflows/verify.yml`:

```yaml
name: verify

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  provider:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Unit tests
        run: bun test
      - name: Typecheck
        run: bun run typecheck
      - name: Typed lint
        run: bun run lint
      - name: Checkout pinned zcode-api
        uses: actions/checkout@v4
        with:
          repository: TriDefender/zcode-api
          ref: 5fcb778
          path: .upstream/zcode-api
      - name: Vendored parity
        env:
          ZCODE_API_REPO: ${{ github.workspace }}/.upstream/zcode-api
        run: bun run parity
      - name: Install OMP CLI
        if: github.event_name == 'push'
        run: bun add --global @oh-my-pi/pi-coding-agent@18.1.5
      - name: Clean-device exact-SHA install
        if: github.event_name == 'push'
        run: bun run install-smoke.ts "github:${{ github.repository }}#${{ github.sha }}"
```

The install smoke runs on push, not `pull_request`, because a PR merge SHA is not guaranteed to be fetchable as a commit from the package repository.

- [ ] **Step 2: Document CI's network boundary**

In `README.md`, state that normal unit tests are offline; parity checks the pinned public upstream checkout; exact-SHA install smoke runs only on pushes and needs no ZCode credentials.

- [ ] **Step 3: Validate the workflow syntax locally**

Run:

```bash
bunx prettier@3.6.2 --check .github/workflows/verify.yml
bun run typecheck
bun run lint
```

Expected: workflow parses/formats cleanly and TypeScript gates remain clean. Do not run a project-wide formatter that rewrites vendored files.

- [ ] **Step 4: Commit CI**

Write a commit message to `/tmp/zcode-standalone-ci.txt`, then run:

```bash
git add .github/workflows/verify.yml README.md
git commit -F /tmp/zcode-standalone-ci.txt
rm /tmp/zcode-standalone-ci.txt
```

Commit subject: `ci: verify exact-sha OMP installation`.

---

### Task 5: Create the public repository and prove GREEN at an exact SHA

**Files:**
- GitHub repository: `hassankhan2608/omp-zcode-provider`
- Local worktree: `/tmp/omp-zcode-provider`

**Interfaces:**
- Consumes: standalone branch commits from Tasks 1-4.
- Produces: public `main` branch and an exact commit SHA installable by OMP.

- [ ] **Step 1: Confirm the repository name is unused**

Run:

```bash
gh repo view hassankhan2608/omp-zcode-provider
```

Expected before creation: not found. If it already exists, inspect it; never overwrite unrelated history.

- [ ] **Step 2: Create the public repository without a generated license/README**

Run:

```bash
gh repo create hassankhan2608/omp-zcode-provider \
  --public \
  --description "Native Oh My Pi provider for the ZCode Start Plan"
```

Expected: empty public repository. Do not pass `--license`, `--readme`, or `--gitignore` templates.

- [ ] **Step 3: Push standalone history as main**

Run:

```bash
cd /tmp/omp-zcode-provider
git push git@github.com:hassankhan2608/omp-zcode-provider.git zcode-standalone:main
gh repo edit hassankhan2608/omp-zcode-provider --default-branch main
SHA=$(git rev-parse HEAD)
printf '%s\n' "$SHA"
```

Expected: public `main` points to the printed exact SHA.

- [ ] **Step 4: Verify GREEN through the supported installer**

Run:

```bash
bun run install-smoke.ts "github:hassankhan2608/omp-zcode-provider#$SHA"
```

Expected: exit 0 and output `clean install passed` for the exact SHA. This is GREEN for the RED captured in Task 2.

- [ ] **Step 5: Watch GitHub verification**

Run:

```bash
gh run watch --repo hassankhan2608/omp-zcode-provider --exit-status
```

Expected: unit tests, typecheck, lint, pinned parity, and exact-SHA install pass. If the workflow fails, inspect its complete log and fix the cause before cutover.

---

### Task 6: Cut the real workstation over without duplicate providers

**Files:**
- Remove after successful installation: `/home/laughingman/.config/omp/agent/extensions/omp-zcode-provider/**`
- Preserve untouched: `/home/laughingman/.config/omp/agent/config.yml`
- Preserve untouched: `/home/laughingman/.config/omp/marketplaces.json`

**Interfaces:**
- Consumes: verified standalone exact SHA from Task 5.
- Produces: OMP loads one Git-managed ZCode provider; `.omp` no longer tracks a duplicate nested copy.

- [ ] **Step 1: Record the verified SHA and working-tree boundary**

Run:

```bash
cd /tmp/omp-zcode-provider
SHA=$(git rev-parse HEAD)
cd /home/laughingman/.config/omp
git status --short
```

Expected: only user-owned config files are dirty in `.omp` before cutover.

- [ ] **Step 2: Install the exact standalone revision through real OMP**

Run:

```bash
omp install "github:hassankhan2608/omp-zcode-provider#$SHA" --json
omp plugin list --json
```

Expected: install succeeds and `omp-zcode-provider` appears in plugin inventory. PluginManager performs its own import validation and rollback on failure.

- [ ] **Step 3: Remove the nested provider only after installation succeeds**

Run:

```bash
cd /home/laughingman/.config/omp
git rm -r agent/extensions/omp-zcode-provider
```

Expected: only the provider subtree is staged for deletion; user-owned config files remain unstaged.

- [ ] **Step 4: Verify one active provider and model discovery**

Run:

```bash
omp plugin doctor --json
omp models zcode --json
```

Expected: plugin doctor reports no ZCode install/import fault, and model output contains `GLM-5.3` and `GLM-5.3-Flash`. There must be no duplicate-provider registration warning.

- [ ] **Step 5: Run a real noninteractive provider smoke**

Run:

```bash
omp -p --model zcode/GLM-5.3-Flash "Reply with exactly: zcode-install-ok"
```

Expected: streamed/final response is exactly `zcode-install-ok`. An upstream model-concurrency response may be retried once after the server's stated window; package/import failures are not retryable evidence.

- [ ] **Step 6: Commit and push the `.omp` clean cutover**

Write a commit message to `/tmp/zcode-cutover.txt`, then run:

```bash
cd /home/laughingman/.config/omp
git diff --cached --name-only
git commit -F /tmp/zcode-cutover.txt
git push origin main
rm /tmp/zcode-cutover.txt
```

Commit subject: `refactor: install zcode provider from standalone repository`.

Expected staged names: only `agent/extensions/omp-zcode-provider/**`. Re-run `git status --short`; `agent/config.yml` and `marketplaces.json` remain as the only local modifications.

---

### Task 7: Final cross-repository verification and cleanup

**Files:**
- Standalone repository: `/tmp/omp-zcode-provider`
- Configuration repository: `/home/laughingman/.config/omp`
- Remove worktree after all verification: `/tmp/omp-zcode-provider`

**Interfaces:**
- Consumes: pushed standalone and `.omp` cutover commits.
- Produces: reproducible installation evidence and no temporary branch/worktree state.

- [ ] **Step 1: Reinstall from public main in a second empty HOME**

From the standalone worktree, run:

```bash
SHA=$(git rev-parse HEAD)
bun run install-smoke.ts "github:hassankhan2608/omp-zcode-provider#$SHA"
```

Expected: a second independent exact-SHA install passes.

- [ ] **Step 2: Confirm public repository contents and actions**

Run:

```bash
gh repo view hassankhan2608/omp-zcode-provider
gh run list --repo hassankhan2608/omp-zcode-provider --limit 3
```

Expected: repository is public, default branch is `main`, and latest verification is successful.

- [ ] **Step 3: Confirm local OMP remains healthy**

Run:

```bash
omp plugin doctor --json
omp models zcode --json
```

Expected: installed Git source is healthy and both ZCode models remain discoverable.

- [ ] **Step 4: Remove temporary worktree and split branch**

Run:

```bash
cd /home/laughingman/.config/omp
git worktree remove /tmp/omp-zcode-provider
git branch -D zcode-standalone
```

Expected: standalone code remains safely pushed to its own repository; `.omp` has no temporary branch/worktree.

- [ ] **Step 5: Record final evidence**

Report exact SHAs for both repositories, install-smoke output, test count, typecheck/lint/parity status, GitHub Actions result, model discovery, and live `zcode-install-ok` response. State explicitly that `agent/config.yml` and `marketplaces.json` were not included in either commit.
