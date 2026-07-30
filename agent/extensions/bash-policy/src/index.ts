import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { analyzeBash, warmBashParser, type BashAnalysis, type BashCommandUnit } from "./bash";
import {
  applyAgentPolicy,
  applyProfile,
  isPermanentDeny,
  loadPolicyConfig,
  PROFILE_ORDER,
  type PolicyConfig,
  type ProfileName,
  type SurfacePolicy,
} from "./config";
import { resolveBashToolSafety, resolveCommandSafety } from "./command-safety";
import { assessPath, extractToolPaths } from "./paths";
import { resolvePolicy, stricterDecision, type PolicyDecision } from "./policy";
import { bashAlwaysPattern, externalAlwaysPattern } from "./patterns";
import { detectPrincipal } from "./principal";
import {
  addExactGrant,
  addSessionRules,
  hasExactGrant,
  registerInteractiveSession,
  requestApproval,
  sessionAllows,
  unregisterSession,
  type ApprovalItem,
} from "./approvals";

// OMP 17.0.7 includes UI wait time in the generic extension-handler watchdog.
// Raising only that watchdog keeps human approval open without changing Bash's
// independent command timeout, which starts after approval.
const INTERACTIVE_APPROVAL_TIMEOUT_MS = 2_147_483_647;
const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUS_KEY = "bash-policy-profile";

interface RuntimeState {
  base?: PolicyConfig;
  config?: PolicyConfig;
  principal: string;
  profile: ProfileName;
  error?: Error;
}

interface ExtensionTimeoutControl {
  testSetExtensionHandlerTimeoutMs(timeoutMs: number): void;
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
        const base = applyAgentPolicy(loaded.config, principal);
        const profile = base.defaultProfile;
        return { base, config: applyProfile(base, profile), principal, profile };
      } catch (error) {
        return { principal: ctx.hasUI ? "main" : "subagent", profile: "low" as ProfileName, error: error as Error };
      }
    })();
    return runtimePromise;
  };

  const showProfile = (ctx: ExtensionContext, runtime: RuntimeState): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, `perm:${runtime.profile}`);
  };

  const setProfile = async (ctx: ExtensionContext, profile: ProfileName): Promise<void> => {
    const runtime = await initialize(ctx);
    if (!runtime.base) return;
    runtime.profile = profile;
    runtime.config = applyProfile(runtime.base, profile);
    showProfile(ctx, runtime);
    if (!ctx.hasUI) return;
    const description = runtime.base.profiles[profile]?.description;
    ctx.ui.notify(`Permission profile: ${profile}${description ? ` — ${description}` : ""}`, "info");
  };

  pi.registerCommand("permissions", {
    description: "Switch the bash-policy autonomy profile (low, medium, high)",
    handler: async (_args, ctx) => {
      const runtime = await initialize(ctx);
      if (!runtime.base || !ctx.hasUI) return;
      const labels = PROFILE_ORDER.map((name) => ({
        label: name === runtime.profile ? `${name} (active)` : name,
        description: runtime.base!.profiles[name]?.description,
      }));
      const choice = await ctx.ui.select("Permission profile", labels, {
        outline: true,
        selectionMarker: "radio",
        markableCount: labels.length,
        initialIndex: PROFILE_ORDER.indexOf(runtime.profile),
        helpText: "up/down navigate  enter select  esc cancel",
      });
      if (choice === undefined) return;
      const picked = PROFILE_ORDER.find((name) => choice.startsWith(name));
      if (picked) await setProfile(ctx, picked);
    },
  });

  pi.registerShortcut("shift+tab", {
    description: "Cycle bash-policy autonomy profile",
    handler: async (ctx) => {
      const runtime = await initialize(ctx);
      const next = PROFILE_ORDER[(PROFILE_ORDER.indexOf(runtime.profile) + 1) % PROFILE_ORDER.length]!;
      await setProfile(ctx, next);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    registerInteractiveSession(ctx);
    const runtime = await initialize(ctx);
    if (runtime.error && ctx.hasUI && !errorNotified) {
      errorNotified = true;
      ctx.ui.notify(runtime.error.message, "error");
      return;
    }
    showProfile(ctx, runtime);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unregisterSession(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const runtime = await initialize(ctx);
    await warmBashParser().catch(() => undefined);
    if (!runtime.config?.hideDeniedTools) return;

    const globalPolicy = runtime.config.permission["*"];
    const active = pi.getActiveTools().filter((toolName) => {
      const exact = runtime.config!.permission[toolName];
      if (exact !== undefined) return !isPermanentDeny(exact);
      return !isPermanentDeny(globalPolicy);
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
    const config = runtime.config;

    const input = event.input as Record<string, unknown>;
    const value = toolValue(event.toolName, input);
    let decision: PolicyDecision = { policy: "allow", surface: event.toolName, value };
    let bashPaths: string[] = [];
    const isBash = event.toolName === "bash";
    let analysis: BashAnalysis | undefined;
    /** Per-command approval rows, in parse order, for the session-scope picker. */
    const commandItems: { unit: BashCommandUnit; allowed: boolean }[] = [];

    if (isBash) {
      for (const toolSafety of resolveBashToolSafety(config.bashSafety, input)) {
        decision = stricterDecision(decision, {
          policy: toolSafety.policy,
          surface: "bashSafety",
          value,
          reason: toolSafety.reason,
        });
      }
      try {
        analysis = await analyzeBash(value);
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
          // Safety floors are evaluated independently of session grants: a grant may lift a
          // permission `ask`, but it must never silence a command safety rule or an
          // indirection. A configured `deny` still outranks an `ask` floor.
          const configuredSafety = resolveCommandSafety(config.bashSafety, command);
          const floor = configuredSafety
            ? {
                policy: configuredSafety.policy,
                surface: "bashSafety",
                value: command.text,
                reason: configuredSafety.reason,
              } satisfies PolicyDecision
            : command.forceAskReason
              ? askDecision("bash", command.text, command.forceAskReason)
              : undefined;

          // A grant substitutes only for the permission verdict, never for the floor.
          const granted = floor === undefined && sessionAllows(ctx, "bash", command.text);
          const permissionDecision = granted
            ? ({ policy: "allow", surface: "bash", value: command.text } satisfies PolicyDecision)
            : resolvePolicy(config.permission, "bash", command.text);
          const commandDecision = floor ? stricterDecision(permissionDecision, floor) : permissionDecision;

          commandItems.push({ unit: command, allowed: commandDecision.policy === "allow" });
          decision = stricterDecision(decision, commandDecision);
        }
      } catch (error) {
        decision = askDecision("bash", value, `Bash parser unavailable: ${(error as Error).message}`);
      }
    } else {
      decision = resolvePolicy(config.permission, event.toolName, value);
    }

    const baseCwd = isBash && typeof input.cwd === "string" ? input.cwd : ctx.cwd;
    const paths = [...new Set([...bashPaths, ...extractToolPaths(event.toolName, input)])];
    const pathContexts: string[] = [];
    /** External path rows carrying an OpenCode-style `dir/*` session scope. */
    const externalItems: ApprovalItem[] = [];
    for (const path of paths) {
      try {
        const assessment = await assessPath(path, baseCwd, ctx.cwd, config.permission);
        pathContexts.push(`${path}=>${assessment.canonical}`);
        if (assessment.external && assessment.decision.policy === "ask") {
          const pattern = await externalAlwaysPattern(assessment.canonical);
          if (sessionAllows(ctx, "external_directory", assessment.canonical)) {
            externalItems.push({ label: path, description: pattern, allowed: true });
            continue;
          }
          externalItems.push({
            label: path,
            description: pattern,
            allowed: false,
            rule: { surface: "external_directory", pattern },
          });
        }
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
    if (hasExactGrant(ctx, approvalKey)) return;

    const items: ApprovalItem[] = [
      ...commandItems.map(({ unit, allowed }) => {
        const pattern = bashAlwaysPattern(unit);
        return {
          label: unit.text,
          description: allowed ? undefined : pattern,
          allowed,
          ...(allowed ? {} : { rule: { surface: "bash", pattern } }),
        } satisfies ApprovalItem;
      }),
      ...externalItems,
    ];
    if (items.length === 0) items.push({ label: value, allowed: false });

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
      items,
      requiresExact: items.every((item) => item.rule === undefined),
    });

    if (approved.kind === "once") return;
    if (approved.kind === "deny") return { block: true, reason: `Denied by user: ${value}` };
    if (approved.kind === "exact") {
      addExactGrant(ctx, approvalKey);
      return;
    }
    addSessionRules(ctx, approved.rules);
    if (approved.exact) addExactGrant(ctx, approvalKey);
  });
}
