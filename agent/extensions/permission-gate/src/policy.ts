import type { CommandIdentity } from "./command-identity";
import { LEVEL_ORDER, type PermissionGateConfig, type PermissionLevel } from "./config";

export type GatePolicy = "allow" | "ask" | "deny";

export interface GateDecision {
  policy: GatePolicy;
  reason: string;
  pattern?: string;
  persistable: boolean;
}

/** OpenCode/Droid-style glob: `*` crosses separators and `?` matches one character. */
export function globMatches(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starValueIndex = 0;
  while (valueIndex < value.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === "*") {
      starIndex = patternIndex++;
      starValueIndex = valueIndex;
      continue;
    }
    if (patternCharacter === "?" || patternCharacter === value[valueIndex]) {
      valueIndex++;
      patternIndex++;
      continue;
    }
    if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      valueIndex = ++starValueIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

export function patternMatches(value: string, pattern: string): boolean {
  if (globMatches(value, pattern)) return true;
  return pattern.endsWith(" *") && value === pattern.slice(0, -2);
}

function lastMatch(value: string, patterns: readonly string[]): string | undefined {
  for (let index = patterns.length - 1; index >= 0; index--) {
    const pattern = patterns[index]!;
    if (patternMatches(value, pattern)) return pattern;
  }
  return undefined;
}

export function resolveCommand(
  config: PermissionGateConfig,
  level: PermissionLevel,
  identity: CommandIdentity,
): GateDecision {
  const command = identity.canonical;
  const blocked = lastMatch(command, config.commandBlocklist);
  if (blocked) {
    return { policy: "deny", reason: "Command blocklist", pattern: blocked, persistable: false };
  }

  const denied = lastMatch(command, config.profiles[level].denylist);
  if (denied) {
    return { policy: "ask", reason: `${level} denylist`, pattern: denied, persistable: true };
  }

  const activeIndex = LEVEL_ORDER.indexOf(level);
  for (let index = activeIndex; index >= 0; index--) {
    const candidateLevel = LEVEL_ORDER[index]!;
    const allowed = lastMatch(command, config.profiles[candidateLevel].allowlist);
    if (allowed) {
      return { policy: "allow", reason: `${candidateLevel} allowlist`, pattern: allowed, persistable: true };
    }
  }
  return { policy: "ask", reason: `Command exceeds ${level} autonomy`, persistable: true };
}

const ONE_TOKEN_COMMANDS: Record<string, true> = {
  cat: true, cd: true, chmod: true, chown: true, cp: true, echo: true, env: true, export: true, grep: true,
  kill: true, killall: true, ln: true, ls: true, mkdir: true, mv: true, ps: true, pwd: true, rm: true,
  rmdir: true, sleep: true, source: true, tail: true, touch: true, unset: true, which: true,
};
const THREE_TOKEN_COMMANDS: Record<string, true> = { aws: true, az: true, doctl: true, gcloud: true, gh: true, sfdx: true };
const THREE_TOKEN_PREFIXES: Record<string, true> = {
  "bun run": true, "bun x": true, "cargo add": true, "cargo run": true, "docker compose": true,
  "git config": true, "git remote": true, "git stash": true, "npm exec": true, "npm init": true,
  "npm run": true, "pnpm dlx": true, "pnpm exec": true, "pnpm run": true, "pulumi stack": true,
  "terraform workspace": true, "yarn dlx": true, "yarn run": true,
};
const TWO_TOKEN_COMMANDS: Record<string, true> = {
  bazel: true, brew: true, bun: true, cargo: true, cmake: true, composer: true, deno: true, docker: true,
  git: true, go: true, gradle: true, helm: true, kubectl: true, make: true, npm: true, npx: true,
  openssl: true, pip: true, pnpm: true, poetry: true, podman: true, pulumi: true, python: true,
  rustup: true, systemctl: true, terraform: true, tmux: true, uv: true, vault: true, yarn: true,
};

/** Human command prefix stored for a session grant, following OpenCode's arity model. */
export function commandGrantPattern(identity: CommandIdentity): string {
  if (!identity.executable) return identity.canonical;
  const tokens = [identity.executable, ...identity.arguments];
  const firstTwo = tokens.slice(0, 2).join(" ");
  const arity = THREE_TOKEN_PREFIXES[firstTwo]
    ? 3
    : ONE_TOKEN_COMMANDS[identity.executable]
      ? 1
      : THREE_TOKEN_COMMANDS[identity.executable]
        ? 3
        : TWO_TOKEN_COMMANDS[identity.executable]
          ? 2
          : 1;
  return `${tokens.slice(0, Math.min(arity, tokens.length)).join(" ")} *`;
}
