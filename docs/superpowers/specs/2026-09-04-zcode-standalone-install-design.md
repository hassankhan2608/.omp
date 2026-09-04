# ZCode Provider Standalone Installation Design

Date: 2026-09-04
Status: Approved for implementation review

## Problem

`omp-zcode-provider` currently lives at
`agent/extensions/omp-zcode-provider` inside the broader `.omp` configuration
repository. That layout works on this workstation only because the provider's
`node_modules` already exists.

It is not a valid portable installation target:

- `omp install <local-path>` intentionally creates a source symlink and does
  not install that source package's dependencies.
- `omp install github:hassankhan2608/.omp` expects the extension package
  manifest at the repository root, but this provider's `package.json` is
  nested.
- A clean checkout therefore cannot resolve `happy-dom` (or the OMP host
  packages) until someone manually enters the nested directory and runs
  `bun install`.

The observed Happy DOM error is a packaging failure, not a Happy DOM runtime
bug. A fresh clone at commit `64eb65b` reproduced missing
`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-ai/error`, and `happy-dom`; running
`bun install --frozen-lockfile` in the nested provider made all tests pass.

## Decision

Create the public repository
`github.com/hassankhan2608/omp-zcode-provider` and make it the only source of
truth for the provider.

The package lives at repository root and is installed through OMP's supported
Git source:

```text
omp install github:hassankhan2608/omp-zcode-provider
```

After exact-commit installation succeeds in an isolated HOME and in the real
OMP plugin store, remove the nested tracked provider from `.omp`. Do not retain
a mirror, synchronization script, compatibility copy, or submodule.

## Repository Layout

```text
omp-zcode-provider/
├── package.json
├── bun.lock
├── tsconfig.json
├── eslint.config.js
├── README.md
├── src/
├── tests/
├── upstream-parity.ts
├── solve-probe.ts
├── live-zcode.ts
└── rate-limit-probe.ts
```

`.gitignore` excludes installed dependencies, local credentials, generated
outputs, and editor artifacts. It does not exclude package metadata or test
configuration.

The extension entry remains TypeScript. `package.json` declares
`src/extension.ts` through `omp.extensions`; there is no duplicate compiled
artifact for source and build output to drift apart.

## Dependency Contract

True third-party runtime dependencies stay under `dependencies`:

- `happy-dom` pinned exactly to `20.11.6`, matching upstream ZCode.
- `undici`, used by the runtime boundary.

OMP packages stay under `peerDependencies`, but their optionality follows the
actual loader boundary rather than treating every host package alike:

- `@oh-my-pi/pi-catalog` is a **required peer**. The extension value-imports
  `buildModel`, and OMP's legacy compatibility loader does not host-rewrite
  `pi-catalog`. Bun therefore must materialize this peer in the plugin store.
- `@oh-my-pi/pi-ai` is an optional peer. The extension value-imports
  `streamAnthropic` and `ProviderHttpError`, but OMP explicitly host-rewrites
  `pi-ai` during extension validation/loading.
- `@oh-my-pi/pi-coding-agent` is an optional peer and development dependency.
  Its extension API imports are type-only, and OMP also host-rewrites it.

All three remain matching development dependencies for local typechecking and
tests. This is the minimum standalone graph: it follows the working
`guyijie1211/omp-qoder-extension` required-peer pattern for `pi-catalog`
without making the entire coding-agent/native graph required.

The exact-SHA RED at standalone commit `47ee769` proved this distinction:
marking `pi-catalog` optional caused PluginManager validation to fail with
`Cannot find package '@oh-my-pi/pi-catalog'`. A direct Bun Git install likewise
omitted every optional peer. Removing only `pi-catalog` from
`peerDependenciesMeta` is the corrective change.

## Install Data Flow

1. OMP resolves `github:hassankhan2608/omp-zcode-provider[#ref]`.
2. PluginManager materializes the Git source in OMP's plugin store.
3. PluginManager runs Bun dependency installation at package root.
4. Bun installs pinned `happy-dom` and `undici`, plus the required
   `pi-catalog` peer; OMP supplies the optional host-rewritten packages.
5. PluginManager imports `src/extension.ts` to validate it.
6. Only after successful import does the installed plugin become active.
7. Any failure rolls back rather than leaving a half-installed extension.

No install hook copies files into `agent/extensions`, writes OMP SQLite, or
modifies user configuration directly.

## Clean Cutover

The cutover order is intentionally failure-safe:

1. Create and push the standalone repository.
2. Install an exact standalone commit in an isolated HOME.
3. Exercise provider import and model discovery there.
4. Install the same commit through the real OMP plugin manager.
5. Confirm the installed provider loads.
6. Remove the nested provider directory from `.omp` and commit that removal.

If any step before step 6 fails, the current nested provider remains untouched.
The unrelated local modifications to `agent/config.yml` and
`marketplaces.json` are never staged or rewritten.

## Regression Tests

### Package contract test

A permanent test validates consumer-visible install requirements:

- package manifest is at repository root;
- `omp.extensions` names the actual TypeScript entry;
- runtime dependencies contain exact `happy-dom@20.11.6` and `undici`;
- OMP host packages are optional peers rather than runtime dependencies;
- every declared extension entry imports successfully after a frozen install.

The test must fail against the current nested/distribution shape before the
standalone package is assembled.

### Clean-install smoke

A script uses a fresh temporary HOME and the exact Git commit under test. It
runs OMP's supported Git install path, then invokes provider discovery/model
listing. It asserts behavior, not `node_modules` contents.

CI runs the smoke after unit tests, typecheck, typed ESLint, and vendored parity.
The exact commit ref avoids accidentally testing an older default branch.

### Live probes

Existing live probes remain manual because they consume real credentials and
network services. CI never requires a ZCode JWT or captcha service.

## Failure Handling

- Dependency installation failure: PluginManager rollback is authoritative;
  no fallback to global modules.
- Extension import failure: installation fails before activation.
- Missing OMP peer: import validation reports the missing host package; no
  hidden vendored host runtime masks it.
- Upstream captcha changes: parity tooling remains pinned and reports drift.
- Clean-install regression: package-contract and exact-SHA smoke fail before a
  release/cutover.

## Repository Visibility and Licensing Risk

The new repository is public by explicit user decision. The upstream
`TriDefender/zcode-api` repository has no LICENSE file. This design therefore:

- does not add a fabricated license;
- does not claim redistribution rights;
- records that a standalone public repository increases discoverability even
  though copied code is already present in the public `.omp` repository.

This is a distribution-risk decision, not a technical assertion about license
permission.

## Non-Goals

- No Happy DOM upgrade or runtime rewrite.
- No proxy, daemon, or duplicate protocol layer.
- No npm publication requirement; Git installation is sufficient.
- No mirrored nested provider after cutover.
- No changes to user credentials, OMP SQLite, `agent/config.yml`, or
  `marketplaces.json`.
