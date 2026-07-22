import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { PermissionConfig } from "./config";
import { resolvePolicy, stricterDecision, type PolicyDecision } from "./policy";

const PATH_KEYS: Record<string, true> = {
  cwd: true,
  dir: true,
  directory: true,
  file: true,
  filename: true,
  path: true,
  paths: true,
  root: true,
  target: true,
  workdir: true,
};

function isVirtualPath(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*):\/\//i.test(value) && !value.startsWith("file://");
}

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

/** Resolve every encountered symlink, including a final symlink whose target does not exist yet. */
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

      symlinkHops++;
      if (symlinkHops > 40) throw new Error(`Too many symbolic links while resolving ${value}`);
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

function collectPathValues(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === "string") {
    if (key && PATH_KEYS[key.toLowerCase()] && value.trim()) output.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, key, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [nestedKey, nestedValue] of Object.entries(value)) collectPathValues(nestedValue, nestedKey, output);
}

/** Extract filesystem targets from regular tool inputs and free-form edit patches. */
export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  collectPathValues(input, undefined, paths);

  if (toolName === "edit") {
    const patch = String(input.input ?? input.patch ?? "");
    for (const match of patch.matchAll(/^\[([^#\]\r\n]+)#[0-9A-F]{4}\]$/gm)) paths.push(match[1]!.trim());
  }

  return [...new Set(paths.filter((path) => !isVirtualPath(path)))];
}

export interface PathAssessment {
  decision: PolicyDecision;
  raw: string;
  absolute: string;
  canonical: string;
  external: boolean;
}

/** Apply sensitive-path rules to raw, absolute, and canonical spellings, then the project-boundary gate. */
export async function assessPath(
  raw: string,
  baseCwd: string,
  projectRoot: string,
  permission: PermissionConfig,
): Promise<PathAssessment> {
  const absolute = expandPath(raw, baseCwd);
  const [canonical, canonicalProjectRoot] = await Promise.all([
    canonicalPath(raw, baseCwd),
    canonicalPath(projectRoot, projectRoot),
  ]);
  const spellings = [...new Set([raw, absolute, canonical])];
  let decision = resolvePolicy(permission, "path", spellings[0]!);
  for (const spelling of spellings.slice(1)) {
    decision = stricterDecision(decision, resolvePolicy(permission, "path", spelling));
  }

  const external = !isInside(canonicalProjectRoot, canonical);
  if (external) decision = stricterDecision(decision, resolvePolicy(permission, "external_directory", canonical));
  return { decision, raw, absolute, canonical, external };
}
