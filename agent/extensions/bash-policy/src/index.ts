import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { analyzeBash, warmBashParser } from "./bash";
import { applyAgentPolicy, loadPolicyConfig, type PolicyConfig, type SurfacePolicy } from "./config";
import { resolveBashToolSafety, resolveCommandSafety } from "./command-safety";
import { assessPath, extractToolPaths } from "./paths";
import { resolvePolicy, stricterDecision, type PolicyDecision } from "./policy";
import { detectPrincipal } from "./principal";
import {
  hasSessionGrant,
  registerInteractiveSession,
  requestApproval,
  unregisterSession,
} from "./approvals";

// OMP 17.0.7 includes UI wait time in the generic extension-handler watchdog.
// Raising only that watchdog keeps human approval open without changing Bash's
// independent command timeout, which starts after approval.
const INTERACTIVE_APPROVAL_TIMEOUT_MS = 2_147_483_647;
const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

interface RuntimeState {
  config?: PolicyConfig;
  principal: string;
  error?: Error;
}

interface ExtensionTimeoutControl {
  testSetExtensionHandlerTimeoutMs(timeoutMs: number): void;
}

function permanentlyDenied(policy: SurfacePolicy | undefined): boolean {
  return policy === "deny" || (typeof policy === "object" && policy !== null && "deny" in policy);
}

function toolValue(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return String(input.command ?? "").trim();
  for (const key of ["path", "file", "query", "pattern", "url"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return JSON.stringify(input);
}

function askDecision(surface: string, value: string, reason: string): PolicyDecision {
  return { policy: "ask", surface, value, reason };
}

function denyDecision(surface: string, value: string, reason: string): PolicyDecision {
  return { policy: "deny", surface, value, reason };
}

export default function bashPolicy(pi: ExtensionAPI): void {
  // OMP's root declaration has a circular-export omission; the runtime barrel exposes this control.
  const timeoutControl = pi.pi as typeof pi.pi & ExtensionTimeoutControl;
  timeoutControl.testSetExtensionHandlerTimeoutMs(INTERACTIVE_APPROVAL_TIMEOUT_MS);
  pi.setLabel("Bash and tool permission policy");

  let runtimePromise: Promise<RuntimeState> | undefined;
  let errorNotified = false;

  const initialize = async (ctx: ExtensionContext): Promise<RuntimeState> => {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
      try {
        const loaded = await loadPolicyConfig(EXTENSION_DIR, ctx.cwd);
        const principal = await detectPrincipal(ctx, Object.keys(loaded.config.agents));
        return { config: applyAgentPolicy(loaded.config, principal), principal };
      } catch (error) {
        return { principal: ctx.hasUI ? "main" : "subagent", error: error as Error };
      }
    })();
    return runtimePromise;
  };

  pi.on("session_start", async (_event, ctx) => {
    registerInteractiveSession(ctx);
    const runtime = await initialize(ctx);
    if (runtime.error && ctx.hasUI && !errorNotified) {
      errorNotified = true;
      ctx.ui.notify(runtime.error.message, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unregisterSession(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const runtime = await initialize(ctx);
    await warmBashParser().catch(() => undefined);
    if (!runtime.config?.hideDeniedTools) return;

    const globalPolicy = runtime.config.permission["*"];
    const active = pi.getActiveTools().filter((toolName) => {
      const exact = runtime.config!.permission[toolName];
      if (exact !== undefined) return !permanentlyDenied(exact);
      return !permanentlyDenied(globalPolicy);
    });
    await pi.setActiveTools(active);
  });

  pi.on("tool_call", async (event, ctx) => {
    const runtime = await initialize(ctx);
    if (runtime.error || !runtime.config) {
      return {
        block: true,
        reason: runtime.error?.message ?? "Bash policy failed to initialize",
      };
    }

    const input = event.input as Record<string, unknown>;
    const value = toolValue(event.toolName, input);
    let decision: PolicyDecision = { policy: "allow", surface: event.toolName, value };
    let bashPaths: string[] = [];

    if (event.toolName === "bash") {
      for (const toolSafety of resolveBashToolSafety(runtime.config.bashSafety, input)) {
        decision = stricterDecision(decision, {
          policy: toolSafety.policy,
          surface: "bashSafety",
          value,
          reason: toolSafety.reason,
        });
      }
      try {
        const analysis = await analyzeBash(value);
        bashPaths = analysis.paths;
        if (analysis.catastrophicReason) {
          decision = denyDecision("bash", value, analysis.catastrophicReason);
        } else if (analysis.malformed) {
          decision = askDecision("bash", value, "Malformed or incomplete Bash syntax");
        }

        if (analysis.commands.length === 0 && value) {
          decision = stricterDecision(decision, askDecision("bash", value, "No executable command could be resolved"));
        }
        for (const command of analysis.commands) {
          let commandDecision = resolvePolicy(runtime.config.permission, "bash", command.text);
          if (command.forceAskReason && commandDecision.policy === "allow") {
            commandDecision = askDecision("bash", command.text, command.forceAskReason);
          }
          const configuredSafety = resolveCommandSafety(runtime.config.bashSafety, command);
          if (configuredSafety) {
            commandDecision = stricterDecision(commandDecision, {
              policy: configuredSafety.policy,
              surface: "bashSafety",
              value: command.text,
              reason: configuredSafety.reason,
            });
          }
          decision = stricterDecision(decision, commandDecision);
        }
      } catch (error) {
        decision = askDecision("bash", value, `Bash parser unavailable: ${(error as Error).message}`);
      }
    } else {
      decision = resolvePolicy(runtime.config.permission, event.toolName, value);
    }

    const baseCwd = event.toolName === "bash" && typeof input.cwd === "string" ? input.cwd : ctx.cwd;
    const paths = [...new Set([...bashPaths, ...extractToolPaths(event.toolName, input)])];
    const pathContexts: string[] = [];
    for (const path of paths) {
      try {
        const assessment = await assessPath(path, baseCwd, ctx.cwd, runtime.config.permission);
        pathContexts.push(`${path}=>${assessment.canonical}`);
        decision = stricterDecision(decision, assessment.decision);
      } catch (error) {
        pathContexts.push(`${path}=>unresolved`);
        decision = stricterDecision(
          decision,
          askDecision("path", path, `Path could not be canonicalized safely: ${(error as Error).message}`),
        );
      }
    }

    if (decision.policy === "allow") return;
    if (decision.policy === "deny") {
      const reason = decision.reason ?? `Denied by ${decision.surface} policy`;
      return { block: true, reason: `${reason}: ${decision.value}` };
    }

    const approvalKey = `${ctx.cwd}\u0000${baseCwd}\u0000${event.toolName}\u0000${JSON.stringify(input)}\u0000${pathContexts.sort().join("\u0000")}`;
    if (hasSessionGrant(ctx, approvalKey)) return;

    const details = [
      decision.reason,
      decision.pattern ? `Matched ${decision.surface} rule: ${decision.pattern}` : undefined,
      value,
    ].filter(Boolean).join("\n");
    const approved = await requestApproval(ctx, {
      key: approvalKey,
      title: `Allow ${event.toolName}?`,
      description: details,
      principal: runtime.principal,
    });
    if (approved === "deny") return { block: true, reason: `Denied by user: ${value}` };
  });
}
