import { lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { PathRules } from "./config";
import { patternMatches } from "./policy";

function expandPath(value: string, cwd: string): string {
  const withoutFileScheme = value.startsWith("file://") ? value.slice("file://".length) : value;
  const expandedHome = withoutFileScheme === "~" || withoutFileScheme.startsWith(`~${sep}`)
    ? resolve(homedir(), withoutFileScheme.slice(2))
    : withoutFileScheme;
  return isAbsolute(expandedHome) ? resolve(expandedHome) : resolve(cwd, expandedHome);
}

function stripGlobSuffix(value: string): string {
  const wildcardIndex = value.search(/[?*[\]{}]/);
  if (wildcardIndex < 0) return value;
  const prefix = value.slice(0, wildcardIndex);
  return prefix.endsWith(sep) ? prefix.slice(0, -1) || sep : dirname(prefix || ".");
}

/** Canonicalize existing components and retain unresolved trailing components. */
export async function canonicalPath(value: string, cwd: string): Promise<string> {
  let absolute = expandPath(stripGlobSuffix(value), cwd);
  let root = parse(absolute).root;
  let resolved = root;
  let pending = absolute.slice(root.length).split(sep).filter(Boolean);
  let symlinkHops = 0;
  while (pending.length > 0) {
    const component = pending.shift()!;
    const candidate = resolve(resolved, component);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isSymbolicLink()) {
        resolved = candidate;
        continue;
      }
      if (++symlinkHops > 40) throw new Error(`Too many symbolic links while resolving ${value}`);
      const target = await readlink(candidate);
      absolute = resolve(dirname(candidate), target, ...pending);
      root = parse(absolute).root;
      resolved = root;
      pending = absolute.slice(root.length).split(sep).filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return resolve(candidate, ...pending);
    }
  }
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

export interface PathAssessment {
  raw: string;
  absolute: string;
  canonical: string;
  external: boolean;
  policy: "allow" | "ask" | "deny";
  reason?: string;
  pattern?: string;
}

function lastMatching(value: string, patterns: readonly string[]): string | undefined {
  for (let index = patterns.length - 1; index >= 0; index--) {
    const pattern = patterns[index]!;
    if (patternMatches(value, pattern)) return pattern;
  }
  return undefined;
}

export type PathAccess = "read" | "write";

export async function assessPath(
  raw: string,
  baseCwd: string,
  projectRoot: string,
  rules: PathRules,
  access: PathAccess = "write",
): Promise<PathAssessment> {
  const absolute = expandPath(raw, baseCwd);
  const [canonical, canonicalProjectRoot] = await Promise.all([
    canonicalPath(raw, baseCwd),
    canonicalPath(projectRoot, projectRoot),
  ]);
  for (const spelling of new Set([raw, absolute, canonical])) {
    if (lastMatching(spelling, rules.allowlist)) continue;
    const denied = lastMatching(spelling, rules.denylist);
    if (denied) {
      return {
        raw, absolute, canonical, external: !isInside(canonicalProjectRoot, canonical), policy: "deny",
        reason: "Sensitive path denylist", pattern: denied,
      };
    }
  }

  const external = !isInside(canonicalProjectRoot, canonical);
  const explicitlyAllowed = lastMatching(canonical, rules.externalAllowlist)
    || access === "read" && lastMatching(canonical, rules.externalReadAllowlist);
  if (!external || explicitlyAllowed) {
    return { raw, absolute, canonical, external, policy: "allow" };
  }
  return {
    raw, absolute, canonical, external, policy: rules.externalDirectory,
    reason: "Path is outside the working directory",
  };
}

export async function externalGrantPattern(canonical: string): Promise<string> {
  const directory = await lstat(canonical)
    .then((info) => info.isDirectory() ? canonical : dirname(canonical))
    .catch(() => dirname(canonical));
  return join(directory, "*").replaceAll("\\", "/");
}
