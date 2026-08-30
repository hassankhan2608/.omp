/**
 * Replay recorded Bash tool calls through the current Permission Gate policy
 * and report aggregate counts only.
 *
 * Session transcripts contain private prompts, paths, and credentials, so this
 * script never emits command text, file paths, session identifiers, or any
 * other transcript content — only integers.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeCommand } from "../src/command-identity";
import { defaultConfig, LEVEL_ORDER, type PermissionLevel } from "../src/config";
import { resolveCommand } from "../src/policy";
import { analyzeBash, safetyRequiresApproval } from "../src/shell";

export interface LevelCounts {
  allow: number;
  ask: number;
  deny: number;
}

export interface ReplayCounts {
  files: number;
  bashCalls: number;
  commandUnits: number;
  parseErrors: number;
  byLevel: Record<PermissionLevel, LevelCounts>;
}

interface ToolCallRecord {
  name: string;
  command: string;
}

function readCommand(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const args = record.arguments ?? record.input ?? record.parameters;
  if (!args || typeof args !== "object") return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
}

function collectToolCalls(node: unknown, found: ToolCallRecord[], depth = 0): void {
  if (depth > 6 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolCalls(item, found, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : typeof record.toolName === "string" ? record.toolName : undefined;
  if (name === "bash") {
    const command = readCommand(record);
    if (command) found.push({ name, command });
  }
  for (const value of Object.values(record)) collectToolCalls(value, found, depth + 1);
}

async function listSessionFiles(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return target.endsWith(".jsonl") ? [target] : [];
  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) files.push(...await listSessionFiles(child));
    else if (entry.name.endsWith(".jsonl")) files.push(child);
  }
  return files;
}

export async function replaySessionFiles(targets: readonly string[]): Promise<ReplayCounts> {
  const config = defaultConfig();
  const counts: ReplayCounts = {
    files: 0,
    bashCalls: 0,
    commandUnits: 0,
    parseErrors: 0,
    byLevel: {
      low: { allow: 0, ask: 0, deny: 0 },
      medium: { allow: 0, ask: 0, deny: 0 },
      high: { allow: 0, ask: 0, deny: 0 },
    },
  };

  const files: string[] = [];
  for (const target of targets) {
    try {
      files.push(...await listSessionFiles(target));
    } catch {
      counts.parseErrors++;
    }
  }

  for (const file of files) {
    counts.files++;
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      counts.parseErrors++;
      continue;
    }
    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        counts.parseErrors++;
        continue;
      }
      const calls: ToolCallRecord[] = [];
      collectToolCalls(parsed, calls);
      for (const call of calls) {
        counts.bashCalls++;
        let units;
        try {
          units = (await analyzeBash(call.command)).commands;
        } catch {
          counts.parseErrors++;
          continue;
        }
        for (const unit of units) {
          const identity = canonicalizeCommand(unit);
          counts.commandUnits++;
          for (const level of LEVEL_ORDER) {
            const decision = resolveCommand(config, level, identity);
            if (decision.policy === "deny") counts.byLevel[level].deny++;
            else if (decision.policy === "ask" || safetyRequiresApproval(identity.safety, level)) {
              counts.byLevel[level].ask++;
            } else counts.byLevel[level].allow++;
          }
        }
      }
    }
  }
  return counts;
}

if (import.meta.main) {
  const targets = Bun.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: bun scripts/replay-policy.ts <session-file-or-directory>...");
    process.exit(2);
  }
  console.log(JSON.stringify(await replaySessionFiles(targets), null, 2));
}
