import { ConnectBridge, type BridgeUpstream } from "./bridge";
import { DIRECT_POLICY, proxyEnvKey, type ProviderPolicy, type RouterConfig } from "./config";
import {
  egressCandidates,
  LOCAL_ROUTE_LABEL,
  type NodeCandidate,
  probeLatencyMs,
  resolvePublicIp,
} from "./discovery";
import { type CooldownWindow, ExhaustionStore, parseCooldown } from "./exhaustion";
import { TunnelManager, type TunnelProvider } from "./tunnel";

/** A candidate egress path with its most recent measurements. */
export interface RouteState {
  label: string;
  /** Absent for the local route, which needs no tunnel. */
  host?: string;
  /** Round-trip to the node's SSH port; `0` for local. */
  latencyMs?: number;
  /** Public egress IP last observed for this route. */
  publicIp?: string;
  /** Why the node itself cannot carry traffic, if it cannot. */
  unreachableReason?: string;
  /**
   * Why the egress IP could not be identified, while the node still works.
   * Kept separate from {@link unreachableReason}: a blocked IP-lookup service
   * says nothing about the node's ability to proxy, so treating it as
   * unreachable would silently shrink the pool.
   */
  ipError?: string;
  lastProbedAt?: number;
}

export interface ProviderRoute {
  provider: string;
  bridge: ConnectBridge;
  /** Label of the shared active node backing this provider right now. */
  activeLabel: string;
}

/**
 * Ranked pool ordering: reachable routes by ascending latency, unreachable
 * last. Local sorts first at equal latency because it costs no tunnel hop.
 */
export function rankRoutes(routes: readonly RouteState[]): RouteState[] {
  return [...routes].sort((left, right) => {
    const leftDown = left.unreachableReason !== undefined || left.latencyMs === undefined;
    const rightDown = right.unreachableReason !== undefined || right.latencyMs === undefined;
    if (leftDown !== rightDown) return leftDown ? 1 : -1;
    const byLatency = (left.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? Number.MAX_SAFE_INTEGER);
    if (byLatency !== 0) return byLatency;
    if (left.label === LOCAL_ROUTE_LABEL) return -1;
    if (right.label === LOCAL_ROUTE_LABEL) return 1;
    return left.label.localeCompare(right.label);
  });
}

/**
 * First route whose public IP is not on cooldown for this provider.
 *
 * A route whose IP is still unknown is treated as eligible: refusing to use it
 * would strand the pool on a cold start, and a wrong guess only costs one 429
 * which immediately records the real cooldown.
 */
export function firstEligible(
  ranked: readonly RouteState[],
  provider: string,
  store: ExhaustionStore,
  now: number = Date.now(),
): RouteState | undefined {
  for (const route of ranked) {
    if (route.unreachableReason !== undefined || route.latencyMs === undefined) continue;
    if (route.publicIp === undefined) return route;
    if (store.remainingMs(provider, route.publicIp, now) === 0) return route;
  }
  return undefined;
}

/**
 * Owns the egress pool, the per-provider bridges and the rotation policy.
 *
 * Every provider gets one bridge on a stable loopback port published once as
 * `PI_PROXY_<PROVIDER>`. Rotation swaps that bridge's upstream, so all traffic
 * for a provider — main agent and every concurrent subagent — always shares a
 * single active egress IP and only advances when that IP is exhausted.
 */
export class Router {
  #config: RouterConfig;
  #store: ExhaustionStore;
  #tunnels: TunnelProvider;
  #routes = new Map<string, RouteState>();
  #providers = new Map<string, ProviderRoute>();

  constructor(config: RouterConfig, store: ExhaustionStore, tunnels?: TunnelProvider) {
    this.#config = config;
    this.#store = store;
    this.#tunnels = tunnels ?? new TunnelManager(config.sshUsers, config.probeTimeoutMs, config.sshPort);
  }

  get config(): RouterConfig {
    return this.#config;
  }

  get store(): ExhaustionStore {
    return this.#store;
  }

  /** Current pool in ranked order. */
  get routes(): RouteState[] {
    return rankRoutes([...this.#routes.values()]);
  }

  get providerRoutes(): ProviderRoute[] {
    return [...this.#providers.values()];
  }

  policyFor(provider: string): ProviderPolicy {
    return this.#config.providers[provider] ?? DIRECT_POLICY;
  }

  /** Providers configured to route through the pool rather than straight out. */
  get routedProviders(): string[] {
    return Object.entries(this.#config.providers)
      .filter(([, policy]) => policy.strategy !== "direct")
      .map(([provider]) => provider);
  }

  /** Replace the node inventory, preserving prior measurements by label. */
  setNodes(nodes: readonly NodeCandidate[]): void {
    const next = new Map<string, RouteState>();
    if (this.#config.includeLocalRoute) {
      const previous = this.#routes.get(LOCAL_ROUTE_LABEL);
      next.set(LOCAL_ROUTE_LABEL, { ...previous, label: LOCAL_ROUTE_LABEL, latencyMs: 0 });
    }
    for (const node of egressCandidates(nodes)) {
      const previous = this.#routes.get(node.label);
      next.set(node.label, { ...previous, label: node.label, host: node.tailscaleIp });
    }
    this.#routes = next;
  }

  /**
   * Refresh latency and public IP for every route.
   *
   * Each node gets its own short-lived bridge on a fresh port. That isolation
   * is required for correctness, not tidiness: HTTP clients pool connections
   * per proxy URL, so probing several nodes through one reused port makes every
   * later probe ride the first node's pooled tunnel and report that node's IP
   * for the whole pool. Probing serially also keeps only one SSH tunnel and one
   * listener alive at a time.
   */
  async probeAll(): Promise<void> {
    const now = Date.now();
    for (const route of this.#routes.values()) {
      if (route.host === undefined) {
        route.latencyMs = 0;
        route.unreachableReason = undefined;
        const local = await resolvePublicIp(this.#config.publicIpUrls, this.#config.probeTimeoutMs);
        route.publicIp = local.ip ?? route.publicIp;
        route.ipError = local.ip === undefined ? local.error : undefined;
        route.lastProbedAt = now;
        continue;
      }
      const latency = await probeLatencyMs(route.host, this.#config.probeTimeoutMs, this.#config.sshPort);
      route.latencyMs = latency;
      route.lastProbedAt = now;
      if (latency === undefined) {
        route.unreachableReason = `SSH port ${this.#config.sshPort} unreachable`;
        continue;
      }
      route.unreachableReason = undefined;
      let bridge: ConnectBridge | undefined;
      try {
        const tunnel = await this.#tunnels.ensure(route.label, route.host);
        bridge = new ConnectBridge({ kind: "socks5", port: tunnel.socksPort, label: route.label }, this.#config.probeTimeoutMs);
        const port = await bridge.listen();
        const resolved = await resolvePublicIp(
          this.#config.publicIpUrls,
          this.#config.probeTimeoutMs,
          `http://127.0.0.1:${port}`,
        );
        route.publicIp = resolved.ip ?? route.publicIp;
        route.ipError = resolved.ip === undefined ? resolved.error : undefined;
      } catch (error) {
        // Failing to build the tunnel does mean the node cannot carry traffic.
        route.unreachableReason = error instanceof Error ? error.message : String(error);
      } finally {
        await bridge?.close();
        // A probe needs the tunnel only to read the node's egress IP. Keeping
        // one open per node would hold N idle SSH sessions between refreshes,
        // so every tunnel no provider is actually routing through is released.
        const inUse = new Set([...this.#providers.values()].map((entry) => entry.activeLabel));
        if (!inUse.has(route.label)) this.#tunnels.close(route.label);
      }
    }
  }

  /**
   * Resolve which route a provider should use right now.
   *
   * `pinned` deliberately ignores exhaustion: the user asked for that exact
   * node, so silently moving elsewhere would violate the pin. `auto-rotate`
   * takes the fastest eligible route and falls back to the fastest reachable
   * one when every IP is cooling down — a likely-429 attempt beats refusing to
   * make the request at all.
   */
  select(provider: string, now: number = Date.now()): RouteState | undefined {
    const policy = this.policyFor(provider);
    if (policy.strategy === "direct") return undefined;
    if (policy.strategy === "pinned") return this.#routes.get(policy.node ?? "");
    const ranked = this.routes;
    return (
      firstEligible(ranked, provider, this.#store, now) ??
      ranked.find((route) => route.unreachableReason === undefined && route.latencyMs !== undefined)
    );
  }

  /**
   * Point a provider's bridge at the given route, creating the bridge and any
   * required tunnel on first use. Returns the label now serving the provider.
   */
  async activate(provider: string, route: RouteState): Promise<ProviderRoute> {
    let upstream: BridgeUpstream = { kind: "direct" };
    if (route.host !== undefined) {
      const tunnel = await this.#tunnels.ensure(route.label, route.host);
      upstream = { kind: "socks5", port: tunnel.socksPort, label: route.label };
    }

    const existing = this.#providers.get(provider);
    if (existing !== undefined) {
      existing.bridge.setUpstream(upstream);
      existing.activeLabel = route.label;
      return existing;
    }
    const bridge = new ConnectBridge(upstream, this.#config.probeTimeoutMs);
    const port = await bridge.listen();
    // Published once and never mutated: pi-ai memoizes this lookup per
    // provider, so a changing value would be ignored after the first request.
    process.env[proxyEnvKey(provider)] = `http://127.0.0.1:${port}`;
    const entry: ProviderRoute = { provider, bridge, activeLabel: route.label };
    this.#providers.set(provider, entry);
    return entry;
  }

  /** Apply the selected route for every routed provider. */
  async applyAll(now: number = Date.now()): Promise<void> {
    for (const provider of this.routedProviders) {
      const route = this.select(provider, now);
      if (route === undefined) continue;
      await this.activate(provider, route);
    }
  }

  /**
   * Record a 429 against the provider's active IP and move the whole provider
   * to the next eligible route. Returns the label now in use, or `undefined`
   * when no rotation happened.
   */
  async handleRateLimit(
    provider: string,
    headers: Record<string, string>,
    now: number = Date.now(),
  ): Promise<{ from: string; to?: string; window: CooldownWindow } | undefined> {
    const active = this.#providers.get(provider);
    if (active === undefined) return undefined;
    // `activate` mutates this same ProviderRoute, so the outgoing label must be
    // captured now or the report would name the node we just moved to.
    const from = active.activeLabel;
    const policy = this.policyFor(provider);
    const window = parseCooldown(headers, policy.cooldownMinutes ?? this.#config.defaultCooldownMinutes, now);
    const route = this.#routes.get(from);
    if (route?.publicIp !== undefined) this.#store.markExhausted(provider, route.publicIp, window, now);
    // A pin is an explicit instruction to stay put, so the cooldown is
    // recorded for visibility but the route is left alone.
    if (policy.strategy === "pinned") return { from, window };
    const next = this.select(provider, now);
    if (next === undefined || next.label === from) return { from, window };
    await this.activate(provider, next);
    return { from, to: next.label, window };
  }

  /** Force a provider onto the next eligible route, skipping the current one. */
  async rotate(provider: string, now: number = Date.now()): Promise<{ from: string; to: string } | undefined> {
    const active = this.#providers.get(provider);
    const ranked = this.routes.filter(
      (route) => route.unreachableReason === undefined && route.latencyMs !== undefined,
    );
    if (ranked.length === 0) return undefined;
    const currentIndex = ranked.findIndex((route) => route.label === active?.activeLabel);
    const eligible = ranked.filter((route, index) => {
      if (index === currentIndex) return false;
      if (route.publicIp === undefined) return true;
      return this.#store.remainingMs(provider, route.publicIp, now) === 0;
    });
    const target = eligible[0] ?? ranked[(currentIndex + 1) % ranked.length];
    if (target === undefined) return undefined;
    const from = active?.activeLabel ?? "none";
    await this.activate(provider, target);
    return { from, to: target.label };
  }

  /** Counts for the status badge: fresh vs total known public IPs. */
  poolHealth(provider: string, now: number = Date.now()): { fresh: number; total: number } {
    let fresh = 0;
    let total = 0;
    for (const route of this.#routes.values()) {
      if (route.unreachableReason !== undefined || route.latencyMs === undefined) continue;
      total += 1;
      if (route.publicIp === undefined || this.#store.remainingMs(provider, route.publicIp, now) === 0) fresh += 1;
    }
    return { fresh, total };
  }

  /** Tear down bridges, tunnels and published env vars. */
  async dispose(): Promise<void> {
    for (const [provider, entry] of this.#providers) {
      delete process.env[proxyEnvKey(provider)];
      await entry.bridge.close();
    }
    this.#providers.clear();
    this.#tunnels.disposeAll();
  }
}
