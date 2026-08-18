import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, proxyEnvKey, type RouterConfig } from "./config";
import { LOCAL_ROUTE_LABEL, parseTailscaleStatus } from "./discovery";
import { ExhaustionStore } from "./exhaustion";
import { Router } from "./router";

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUS_KEY = "tailscale-route";

interface Runtime {
  router: Router;
  config: RouterConfig;
  errors: string[];
}

/** Provider whose badge is shown when several are routed. */
function primaryProvider(router: Router): string | undefined {
  const rotating = router.routedProviders.find((provider) => router.policyFor(provider).strategy === "auto-rotate");
  return rotating ?? router.routedProviders[0];
}

function formatDuration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Shared across every session in this process.
 *
 * OMP instantiates the extension per session (subagents included), and each
 * instance would otherwise build its own pool — duplicating one SSH tunnel and
 * one bridge per node per session. The egress IP is a process-wide resource, so
 * the router is too; `sessions` refcounts holders so teardown happens exactly
 * once, when the last session ends.
 */
let sharedRuntime: Promise<Runtime> | undefined;
let sharedTimer: Timer | undefined;
let sessions = 0;

export default function tailscaleRouter(pi: ExtensionAPI, extensionDirectory: string = EXTENSION_DIR): void {
  pi.setLabel("Tailscale Router");

  const initialize = async (): Promise<Runtime> => {
    sharedRuntime ??= (async () => {
      const { config, errors } = await loadConfig(extensionDirectory);
      const store = new ExhaustionStore(ExhaustionStore.defaultPath());
      await store.load();
      const router = new Router(config, store);
      return { router, config, errors };
    })();
    return sharedRuntime;
  };

  /**
   * Enumerate the tailnet, measure the pool and point every routed provider at
   * its selected node. Failures are returned rather than thrown: a broken
   * tailnet must leave OMP on its direct connection, never block a turn.
   */
  const refresh = async (runtime: Runtime): Promise<string[]> => {
    const problems = [...runtime.errors];
    const result = await pi.exec("tailscale", ["status", "--json"], { timeout: runtime.config.probeTimeoutMs });
    if (result.code !== 0) {
      problems.push(`tailscale status failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      return problems;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch (error) {
      problems.push(`tailscale status returned invalid JSON: ${String(error)}`);
      return problems;
    }
    const { nodes, errors } = parseTailscaleStatus(raw);
    problems.push(...errors);
    runtime.router.setNodes(nodes);
    await runtime.router.probeAll();
    await runtime.router.applyAll();
    return problems;
  };

  const showStatus = (ctx: ExtensionContext, runtime: Runtime): void => {
    if (!ctx.hasUI) return;
    const provider = primaryProvider(runtime.router);
    if (provider === undefined) {
      ctx.ui.setStatus(STATUS_KEY, "ts:direct");
      return;
    }
    const active = runtime.router.providerRoutes.find((entry) => entry.provider === provider);
    const health = runtime.router.poolHealth(provider);
    if (active === undefined) {
      ctx.ui.setStatus(STATUS_KEY, `ts:direct ${health.fresh}/${health.total}`);
      return;
    }
    const route = runtime.router.routes.find((entry) => entry.label === active.activeLabel);
    const latency = route?.latencyMs === undefined ? "" : ` ${route.latencyMs}ms`;
    ctx.ui.setStatus(STATUS_KEY, `ts:${active.activeLabel}${latency} ${health.fresh}/${health.total}`);
  };

  pi.on("session_start", async (_event, ctx) => {
    sessions += 1;
    const runtime = await initialize();
    const problems = await refresh(runtime);
    if (problems.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Tailscale Router: ${problems.join("; ")}`, "warning");
    }
    showStatus(ctx, runtime);
    // One timer per process, not per session: the pool it refreshes is shared.
    // `unref` keeps it from holding the process open at exit.
    if (sharedTimer === undefined) {
      sharedTimer = setInterval(() => {
        void initialize()
          .then((current) => refresh(current))
          .catch(() => undefined);
      }, runtime.config.refreshIntervalMinutes * 60_000);
      sharedTimer.unref?.();
    }
  });

  /**
   * A 429 is the only authoritative signal that an egress IP is spent, so the
   * cooldown is recorded here and the whole provider — main agent and every
   * concurrent subagent, which share this bridge — advances together.
   */
  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status !== 429) return;
    const runtime = await initialize();
    for (const provider of runtime.router.routedProviders) {
      const moved = await runtime.router.handleRateLimit(provider, event.headers);
      if (moved === undefined) continue;
      const waited = formatDuration(moved.window.durationMs);
      const message =
        moved.to === undefined
          ? `Tailscale Router: ${moved.from} rate limited for ${waited} (${moved.window.source}); no fresher node available`
          : `Tailscale Router: ${moved.from} rate limited for ${waited} (${moved.window.source}) -> switched to ${moved.to}`;
      if (ctx.hasUI) ctx.ui.notify(message, moved.to === undefined ? "warning" : "info");
    }
    showStatus(ctx, runtime);
  });

  pi.registerCommand("tailscale", {
    description: "Inspect and control Tailscale egress routing (status, rotate, reset, refresh)",
    handler: async (args, ctx) => {
      const runtime = await initialize();
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter((part) => part.length > 0);

      if (action === "reset") {
        runtime.router.store.reset();
        await runtime.router.store.flush();
        await runtime.router.applyAll();
        showStatus(ctx, runtime);
        if (ctx.hasUI) ctx.ui.notify("Tailscale Router: cleared all cooldowns", "info");
        return;
      }

      if (action === "refresh") {
        const problems = await refresh(runtime);
        showStatus(ctx, runtime);
        if (ctx.hasUI) {
          ctx.ui.notify(
            problems.length > 0 ? `Tailscale Router: ${problems.join("; ")}` : "Tailscale Router: pool refreshed",
            problems.length > 0 ? "warning" : "info",
          );
        }
        return;
      }

      if (action === "rotate") {
        const provider = rest[0] ?? primaryProvider(runtime.router);
        if (provider === undefined) {
          if (ctx.hasUI) ctx.ui.notify("Tailscale Router: no routed providers configured", "warning");
          return;
        }
        const moved = await runtime.router.rotate(provider);
        showStatus(ctx, runtime);
        if (ctx.hasUI) {
          ctx.ui.notify(
            moved === undefined
              ? `Tailscale Router: no reachable node to rotate ${provider} onto`
              : `Tailscale Router: ${provider} ${moved.from} -> ${moved.to}`,
            moved === undefined ? "warning" : "info",
          );
        }
        return;
      }

      const lines: string[] = [];
      for (const route of runtime.router.routes) {
        const parts = [route.label === LOCAL_ROUTE_LABEL ? "local (direct)" : route.label];
        parts.push(route.latencyMs === undefined ? "unreachable" : `${route.latencyMs}ms`);
        parts.push(route.publicIp ?? "ip unknown");
        if (route.unreachableReason !== undefined) parts.push(route.unreachableReason);
        else if (route.ipError !== undefined) parts.push("ip lookup failed (still usable)");
        lines.push(`  ${parts.join(" · ")}`);
      }
      const providerLines: string[] = [];
      for (const provider of runtime.router.routedProviders) {
        const policy = runtime.router.policyFor(provider);
        const active = runtime.router.providerRoutes.find((entry) => entry.provider === provider);
        const health = runtime.router.poolHealth(provider);
        const cooldowns = Object.entries(runtime.router.store.activeFor(provider)).map(
          ([ip, entry]) => `${ip} ${formatDuration(entry.expiresAt - Date.now())} (${entry.source})`,
        );
        providerLines.push(
          `  ${provider} [${policy.strategy}${policy.node === undefined ? "" : `:${policy.node}`}] -> ${
            active?.activeLabel ?? "not activated"
          } · fresh ${health.fresh}/${health.total}` + (cooldowns.length > 0 ? `\n    cooling: ${cooldowns.join(", ")}` : ""),
        );
      }
      const report = [
        "Tailscale Router",
        "Pool (ranked):",
        ...(lines.length > 0 ? lines : ["  (no routes discovered)"]),
        "Providers:",
        ...(providerLines.length > 0 ? providerLines : ["  (none routed; all traffic direct)"]),
        `State: ${runtime.router.store.path}`,
      ].join("\n");
      if (ctx.hasUI) ctx.ui.notify(report, "info");
      showStatus(ctx, runtime);
    },
  });

  pi.on("session_shutdown", async () => {
    sessions = Math.max(0, sessions - 1);
    // Another session in this process may still be routing through the pool.
    if (sessions > 0) return;
    if (sharedTimer !== undefined) {
      clearInterval(sharedTimer);
      sharedTimer = undefined;
    }
    const pending = sharedRuntime;
    sharedRuntime = undefined;
    if (pending === undefined) return;
    const runtime = await pending;
    await runtime.router.store.flush();
    await runtime.router.dispose();
  });
}

export { proxyEnvKey };
