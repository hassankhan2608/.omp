import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

function agentBody(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown.trim();
  const closing = markdown.indexOf("\n---", 3);
  return closing < 0 ? markdown.trim() : markdown.slice(closing + 4).trim();
}

const BUILTIN_FINGERPRINTS: Record<string, string> = {
  designer: "Implement and review UI designs. Edit files, create components, run commands when needed.",
  reviewer: "Identify bugs the author would want fixed before merge.",
  scout: "Investigate the codebase rapidly. Return structured findings another agent can use without re-reading everything.",
  task: "You are a worker agent for delegated tasks.",
};

/** Match configured agent names against the exact role text embedded in OMP's subagent prompt. */
export async function detectPrincipal(
  ctx: ExtensionContext,
  configuredNames: readonly string[],
): Promise<string> {
  if (ctx.hasUI) return "main";
  const prompt = ctx.getSystemPrompt().join("\n");
  const directories = [
    join(ctx.cwd, ".omp", "agents"),
    join(homedir(), ".omp", "agent", "agents"),
  ];

  for (const name of configuredNames) {
    if (name === "main" || name === "subagent") continue;
    for (const directory of directories) {
      try {
        const body = agentBody(await readFile(join(directory, `${name}.md`), "utf8"));
        const fingerprint = body.slice(0, Math.min(body.length, 500));
        if (fingerprint.length >= 40 && prompt.includes(fingerprint)) return name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const builtInFingerprint = BUILTIN_FINGERPRINTS[name];
    if (builtInFingerprint && prompt.includes(builtInFingerprint)) return name;
  }
  return "subagent";
}
