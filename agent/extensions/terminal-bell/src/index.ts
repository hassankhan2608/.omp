import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, type BellEvent } from "./config";
import { TerminalNotifier } from "./notifier";

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

interface AgentEndLike {
  messages: unknown[];
  willContinue?: boolean;
}

function assistantStopReason(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { role?: unknown; stopReason?: unknown };
  return candidate.role === "assistant" && typeof candidate.stopReason === "string"
    ? candidate.stopReason
    : undefined;
}

export function classifyAgentEnd(event: AgentEndLike): BellEvent | undefined {
  if (event.willContinue) return undefined;
  let reason: string | undefined;
  for (let index = event.messages.length - 1; index >= 0; index--) {
    reason = assistantStopReason(event.messages[index]);
    if (reason !== undefined) break;
  }
  if (reason === "aborted") return undefined;
  return reason === "error" ? "agent.error" : "agent.complete";
}

export default function terminalBell(pi: ExtensionAPI): void {
  const notifier = loadConfig(EXTENSION_DIR)
    .then((config) => new TerminalNotifier(config, EXTENSION_DIR))
    .catch((error: unknown) => {
      pi.logger.error("Terminal bell config failed to load", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    const bellEvent = classifyAgentEnd(event);
    if (bellEvent) await (await notifier)?.notify(bellEvent);
  });

  pi.on("tool_approval_requested", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    await (await notifier)?.notify("approval.requested");
  });
}
