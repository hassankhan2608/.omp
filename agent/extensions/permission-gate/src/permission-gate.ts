import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  currentLevel,
  hasExactGrant,
  registerSession,
  requestApproval,
  selectCompactOption,
  sessionAllows,
  setLevel,
  unregisterSession,
  type ApprovalItem,
} from "./approvals";
import { canonicalizeCommand, type CommandIdentity } from "./command-identity";
import { LEVEL_ORDER, loadConfig, type PermissionGateConfig, type PermissionLevel } from "./config";
import { assessPath, externalGrantRoot } from "./paths";
import { commandGrantPattern, resolveCommand } from "./policy";
import { analyzeBash, safetyRequiresApproval, warmBashParser, type BashAnalysis } from "./shell";
import { extractToolPaths, type GatedPathTool } from "./tool-paths";

interface ExtensionTimeoutControl {
  testSetExtensionHandlerTimeoutMs(timeoutMs: number): void;
}

interface RuntimeState {
  config?: PermissionGateConfig;
  error?: Error;
}

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_AGENT_DIR = dirname(dirname(EXTENSION_DIR));
const SCHEMA_URL = pathToFileURL(join(EXTENSION_DIR, "config.schema.json")).href;
const STATUS_KEY = "permission-gate-level";
const INTERACTIVE_APPROVAL_TIMEOUT_MS = 2_147_483_647;

function showLevel(ctx: ExtensionContext, level: PermissionLevel): void {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `perm:${level}`);
}

function principal(ctx: ExtensionContext): string {
  return ctx.hasUI ? "main" : "subagent";
}

function deny(reason: string, value: string): { block: true; reason: string } {
  return { block: true, reason: `${reason}: ${value}` };
}

export default function permissionGate(pi: ExtensionAPI, agentDirectory: string = DEFAULT_AGENT_DIR): void {
  const timeoutControl = pi.pi as typeof pi.pi & ExtensionTimeoutControl;
  timeoutControl.testSetExtensionHandlerTimeoutMs(INTERACTIVE_APPROVAL_TIMEOUT_MS);
  pi.setLabel("Permission Gate");

  let runtimePromise: Promise<RuntimeState> | undefined;
  let errorNotified = false;
  const initialize = async (): Promise<RuntimeState> => {
    runtimePromise ??= loadConfig(agentDirectory, SCHEMA_URL)
      .then((config) => ({ config }))
      .catch((error) => ({ error: error as Error }));
    return runtimePromise;
  };

  pi.registerCommand("permissions", {
    description: "Switch Permission Gate autonomy (low, medium, high)",
    handler: async (_args, ctx) => {
      const runtime = await initialize();
      if (!runtime.config || !ctx.hasUI) return;
      const active = currentLevel(ctx, runtime.config.defaultLevel);
      const options = LEVEL_ORDER.map((level) => ({
        label: level === active ? `${level} (active)` : level,
        description: level === "low"
          ? "File edits and known low-risk/read-only commands"
          : level === "medium"
            ? "Reversible workspace changes, installs, builds, tests, and local Git"
            : "All commands except blocklist and explicit high-level denylist asks",
      }));
      const choice = await selectCompactOption(ctx.ui, {
        title: "Permission Gate",
        heading: `Autonomy  ·  Current: ${active}`,
        options,
        inlineDescriptions: true,
        initialIndex: LEVEL_ORDER.indexOf(active),
        helpText: "↑/↓ move  ·  Enter select  ·  Esc cancel",
      });
      if (choice === undefined) return;
      const selected = LEVEL_ORDER.find((level) => choice.startsWith(level));
      if (!selected) return;
      setLevel(ctx, selected);
      showLevel(ctx, selected);
      ctx.ui.notify(`Permission Gate: ${selected}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const runtime = await initialize();
    if (!runtime.config) {
      if (ctx.hasUI && !errorNotified) {
        errorNotified = true;
        ctx.ui.notify(runtime.error?.message ?? "Permission Gate failed to initialize", "error");
      }
      return;
    }
    registerSession(ctx, runtime.config.defaultLevel);
    showLevel(ctx, currentLevel(ctx, runtime.config.defaultLevel));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unregisterSession(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", async () => {
    await initialize();
    await warmBashParser().catch(() => undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    const gatedPathTool: GatedPathTool | undefined = event.toolName === "edit" || event.toolName === "write"
      ? event.toolName
      : undefined;
    if (event.toolName !== "bash" && gatedPathTool === undefined) return;
    const runtime = await initialize();
    if (!runtime.config) {
      return deny(runtime.error?.message ?? "Permission Gate failed to initialize", event.toolName);
    }
    const config = runtime.config;
    const input = event.input as Record<string, unknown>;
    const level = currentLevel(ctx, config.defaultLevel);
    const extraction = gatedPathTool ? extractToolPaths(gatedPathTool, input) : undefined;
    const summary = extraction ? extraction.preview : String(input.command ?? "").trim();
    const items: ApprovalItem[] = [];
    const reasons: string[] = [];
    const pathContexts: string[] = [];
    let persistable = true;
    let analysis: BashAnalysis | undefined;
    let bashPaths: string[] = [];
    let needsApproval = false;

    const environmentPresent = input.env !== undefined && input.env !== null
      && typeof input.env === "object" && Object.keys(input.env).length > 0;
    if (environmentPresent && config.customEnvironment === "deny") return deny("Custom environment denied", summary);
    if (environmentPresent && config.customEnvironment === "ask") {
      needsApproval = true;
      persistable = false;
      reasons.push("Custom environment variables can change command behavior");
    }
    if (input.pty === true && config.pty === "deny") return deny("PTY execution denied", summary);
    if (input.pty === true && config.pty === "ask") {
      needsApproval = true;
      persistable = false;
      reasons.push("PTY execution can expose interactive shell behavior");
    }

    if (extraction) {
      bashPaths = extraction.paths;
      if (!extraction.complete) {
        needsApproval = true;
        persistable = false;
        reasons.push(`Could not identify every ${event.toolName} target`);
      }
    } else {
      try {
        analysis = await analyzeBash(String(input.command ?? ""));
        bashPaths = analysis.paths;
      } catch (error) {
        needsApproval = true;
        persistable = false;
        reasons.push(`Bash parser unavailable: ${(error as Error).message}`);
      }
      if (analysis?.catastrophicReason) return deny(analysis.catastrophicReason, summary);
      if (analysis?.malformed) {
        needsApproval = true;
        persistable = false;
        reasons.push("Malformed or incomplete Bash syntax");
      }
      if (analysis && analysis.commands.length === 0 && summary) {
        needsApproval = true;
        persistable = false;
        reasons.push("No executable command could be resolved");
      }
    }

    const identities: CommandIdentity[] = (analysis?.commands ?? []).map(canonicalizeCommand);
    const seenItems = new Set<string>();
    for (const identity of identities) {
      const commandDecision = resolveCommand(config, level, identity);
      if (commandDecision.policy === "deny") return deny(commandDecision.reason, identity.display);
      bashPaths.push(...identity.paths);
      const floorAsks = safetyRequiresApproval(identity.safety, level);
      const commandPersistable = commandDecision.persistable && (identity.safety?.persistable ?? true);
      const granted = commandPersistable && sessionAllows(ctx, "bash", identity.canonical);
      const asks = commandDecision.policy === "ask" || floorAsks;
      if (!asks || granted) {
        items.push({ label: identity.display, value: identity.canonical, allowed: true });
        continue;
      }
      needsApproval = true;
      persistable &&= commandPersistable;
      reasons.push(floorAsks && identity.safety ? identity.safety.reason : commandDecision.reason);
      const rule = commandPersistable
        ? { surface: "bash", pattern: commandGrantPattern(identity) }
        : undefined;
      // One tool call must not raise the same decision twice.
      const fingerprint = `${identity.canonical}\0${rule?.pattern ?? ""}`;
      if (seenItems.has(fingerprint)) continue;
      seenItems.add(fingerprint);
      items.push({
        label: identity.display,
        description: commandDecision.pattern,
        value: identity.canonical,
        allowed: false,
        ...(rule ? { rule } : {}),
      });
    }

    const baseCwd = typeof input.cwd === "string" ? input.cwd : ctx.cwd;
    const readOnlyPaths = analysis !== undefined && !analysis.malformed && identities.length > 0
      && identities.every((identity) =>
        !safetyRequiresApproval(identity.safety, "low") && resolveCommand(config, "low", identity).policy === "allow"
      );
    const pathAccess = readOnlyPaths ? "read" : "write";
    const paths = [...new Set(bashPaths)];
    for (const path of paths) {
      let assessment;
      try {
        assessment = await assessPath(path, baseCwd, ctx.cwd, config.paths, pathAccess);
      } catch (error) {
        needsApproval = true;
        persistable = false;
        pathContexts.push(`${path}=>unresolved`);
        reasons.push(`Path could not be resolved safely: ${(error as Error).message}`);
        continue;
      }
      pathContexts.push(`${path}=>${assessment.canonical}`);
      if (assessment.policy === "deny") return deny(assessment.reason ?? "Path denied", path);
      if (assessment.policy !== "ask") continue;
      const root = await externalGrantRoot(assessment.canonical);
      const granted = sessionAllows(ctx, "external_directory", assessment.canonical);
      items.push({
        label: path,
        description: `${root} and everything inside it`,
        value: assessment.canonical,
        allowed: granted,
        ...(!granted ? { rule: { surface: "external_directory", pattern: root } } : {}),
      });
      if (!granted) {
        needsApproval = true;
        reasons.push(assessment.reason ?? "External path");
      }
    }

    if (!needsApproval) return;
    if (items.length === 0) items.push({ label: summary, allowed: false });
    const approvalKey = [ctx.cwd, baseCwd, event.toolName, JSON.stringify(input), ...pathContexts.sort()].join("\0");
    if (persistable && hasExactGrant(ctx, approvalKey)) return;
    const description = [...new Set(reasons)].join("; ");
    const approved = await requestApproval(ctx, {
      key: approvalKey,
      title: `Allow ${event.toolName}?`,
      description,
      preview: summary,
      principal: principal(ctx),
      items,
      requiresExact: items.every((item) => item.rule === undefined),
      persistable,
    });
    if (approved.kind === "deny") return deny("Denied by user", summary);
  });
}
