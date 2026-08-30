/**
 * Filesystem targets for the non-Bash tools Permission Gate guards.
 *
 * Extraction is pure: it never assesses policy, touches the filesystem, or
 * reports file contents. `complete` is false when a payload clearly intends a
 * filesystem write whose target could not be identified, so the caller can ask
 * without offering a reusable grant.
 */
export interface ToolPathExtraction {
  paths: string[];
  complete: boolean;
  preview: string;
}

export type GatedPathTool = "edit" | "write";

/** `[relative/path.ts#A1B2]` snapshot headers used by hashline edits. */
const HASHLINE_HEADER = /^\s*\[([^#\]\r\n]+)(?:#[0-9A-Za-z]*)?\]\s*$/;
/** `*** Update File: path` markers used by apply-patch payloads. */
const PATCH_FILE_MARKER = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/;

/** Device and remote URIs are routed by OMP itself, not by filesystem policy. */
export function isInternalToolUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith("file://");
}

function unwrapHashlinePath(value: string): string {
  const match = HASHLINE_HEADER.exec(value.trimEnd());
  return match?.[1] ?? value;
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectEditListPaths(input: Record<string, unknown>): string[] {
  const edits = input.edits;
  if (!Array.isArray(edits)) return [];
  const paths: string[] = [];
  for (const entry of edits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const candidate = readString(record, "path") ?? readString(record, "filePath");
    if (candidate) paths.push(candidate);
  }
  return paths;
}

function collectTextPaths(payload: string): string[] {
  const paths: string[] = [];
  for (const line of payload.split("\n")) {
    const header = HASHLINE_HEADER.exec(line);
    if (header?.[1]) {
      paths.push(header[1]);
      continue;
    }
    const marker = PATCH_FILE_MARKER.exec(line.trim());
    if (marker?.[1]) paths.push(marker[1]);
  }
  return paths;
}

export function extractToolPaths(toolName: GatedPathTool, input: unknown): ToolPathExtraction {
  if (!input || typeof input !== "object") {
    return { paths: [], complete: false, preview: `${toolName} payload is not an object` };
  }
  const record = input as Record<string, unknown>;

  if (toolName === "write") {
    const target = readString(record, "path");
    if (!target) return { paths: [], complete: false, preview: "write target is missing" };
    if (isInternalToolUri(target)) return { paths: [], complete: true, preview: target };
    const unwrapped = unwrapHashlinePath(target);
    return { paths: [unwrapped], complete: true, preview: unwrapped };
  }

  const candidates = [
    ...(readString(record, "path") ? [readString(record, "path")!] : []),
    ...collectEditListPaths(record),
    ...collectTextPaths(readString(record, "input") ?? ""),
    ...collectTextPaths(readString(record, "patch") ?? ""),
  ];
  const paths: string[] = [];
  for (const candidate of candidates) {
    const unwrapped = unwrapHashlinePath(candidate);
    if (isInternalToolUri(unwrapped) || paths.includes(unwrapped)) continue;
    paths.push(unwrapped);
  }

  const payloadPresent = (readString(record, "input") ?? readString(record, "patch") ?? "").trim().length > 0
    || Array.isArray(record.edits)
    || readString(record, "path") !== undefined;
  const routedInternally = candidates.length > 0 && paths.length === 0;
  return {
    paths,
    complete: paths.length > 0 || routedInternally || !payloadPresent,
    preview: paths.length > 0 ? paths.join(", ") : "unrecognized edit target",
  };
}
