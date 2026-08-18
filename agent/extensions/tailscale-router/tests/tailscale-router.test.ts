import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BridgeUpstream, ConnectBridge, socks5Connect } from "../src/bridge";
import { DEFAULT_CONFIG, parseConfig, proxyEnvKey, type RouterConfig } from "../src/config";
import { egressCandidates, parseTailscaleStatus } from "../src/discovery";
import { ExhaustionStore, parseCooldown } from "../src/exhaustion";
import { firstEligible, rankRoutes, Router, type RouteState } from "../src/router";
import type { TunnelHandle, TunnelProvider } from "../src/tunnel";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-tailscale-router-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** TCP server that greets every connection with a fixed identity string. */
async function startEchoOrigin(identity: string): Promise<{ port: number }> {
  const server = net.createServer((socket) => {
    socket.on("data", () => socket.write(identity));
    socket.on("error", () => socket.destroy());
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  cleanups.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("origin failed to bind");
  return { port: address.port };
}

/**
 * Minimal SOCKS5 no-auth server that forwards every CONNECT to one fixed
 * origin. Stands in for `ssh -D` so the bridge's SOCKS client is exercised for
 * real without a network hop.
 */
async function startFakeSocks(targetPort: number): Promise<{ port: number; connects: () => number }> {
  let connects = 0;
  const server = net.createServer((client) => {
    let stage: "greeting" | "request" = "greeting";
    client.on("error", () => client.destroy());
    const onData = (chunk: Buffer): void => {
      if (stage === "greeting") {
        stage = "request";
        client.write(Buffer.from([0x05, 0x00]));
        return;
      }
      if (chunk[1] !== 0x01) {
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      connects += 1;
      // Stop parsing before piping: every later byte belongs to the tunnel, and
      // leaving this listener attached would decode payload as a new request.
      client.off("data", onData);
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  return { port: await listenLoopback(server, "fake socks"), connects: () => connects };
}

/** Binds a loopback TCP server and registers its teardown. */
async function listenLoopback(server: net.Server, label: string): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  cleanups.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`${label} failed to bind`);
  return address.port;
}

/** SOCKS5 server that completes the greeting then refuses every CONNECT. */
async function startRefusingSocks(): Promise<{ port: number }> {
  const server = net.createServer((client) => {
    let greeted = false;
    client.on("error", () => client.destroy());
    client.on("data", () => {
      if (!greeted) {
        greeted = true;
        client.write(Buffer.from([0x05, 0x00]));
        return;
      }
      // rep 0x05 = connection refused
      client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });
  });
  return { port: await listenLoopback(server, "refusing socks") };
}

/** Accepts the TCP connection then never speaks, to exercise the handshake deadline. */
async function startSilentSocks(): Promise<{ port: number }> {
  const server = net.createServer((client) => client.on("error", () => client.destroy()));
  return { port: await listenLoopback(server, "silent socks") };
}

/** Issue a raw HTTP CONNECT through a bridge and return status line + body. */
async function connectThrough(
  bridgePort: number,
  target: string,
): Promise<{ statusLine: string; body: string }> {
  const socket = net.connect(bridgePort, "127.0.0.1");
  const { promise, resolve, reject } = Promise.withResolvers<{ statusLine: string; body: string }>();
  let received = "";
  // Watchdog only: fires on failure, so the happy path pays no wall-clock cost.
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error(`CONNECT ${target} timed out; received: ${received}`));
  }, 5_000);
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
    const separator = received.indexOf("\r\n\r\n");
    if (separator === -1) return;
    const statusLine = received.slice(0, received.indexOf("\r\n"));
    const body = received.slice(separator + 4);
    if (statusLine.includes("200") && body.length === 0) {
      socket.write("ping");
      return;
    }
    clearTimeout(timer);
    socket.destroy();
    resolve({ statusLine, body });
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  return promise;
}

async function startBridge(upstream: BridgeUpstream): Promise<ConnectBridge> {
  const bridge = new ConnectBridge(upstream, 3_000);
  await bridge.listen();
  cleanups.push(() => bridge.close());
  return bridge;
}

function routerConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return { ...DEFAULT_CONFIG, probeTimeoutMs: 2_000, ...overrides };
}

/** Tunnel provider that hands out preset SOCKS ports instead of spawning ssh. */
function fakeTunnels(portsByLabel: Record<string, number>): TunnelProvider & {
  closed: string[];
  opened: string[];
} {
  const closed: string[] = [];
  const opened: string[] = [];
  return {
    closed,
    opened,
    async ensure(label: string): Promise<TunnelHandle> {
      const socksPort = portsByLabel[label];
      if (socksPort === undefined) throw new Error(`no fake tunnel for ${label}`);
      opened.push(label);
      return { label, socksPort, user: "root" };
    },
    close(label: string): void {
      closed.push(label);
    },
    disposeAll(): void {
      closed.push("*");
    },
  };
}

describe("config", () => {
  test("normalizes provider ids into the env keys pi-ai looks up", () => {
    expect(proxyEnvKey("opencode-zen")).toBe("PI_PROXY_OPENCODE_ZEN");
    expect(proxyEnvKey("freetheai")).toBe("PI_PROXY_FREETHEAI");
    expect(proxyEnvKey("github-copilot")).toBe("PI_PROXY_GITHUB_COPILOT");
  });

  test("merges partial config over defaults", () => {
    const { config, errors } = parseConfig({ refreshIntervalMinutes: 2, sshUsers: ["root"] });
    expect(errors).toEqual([]);
    expect(config.refreshIntervalMinutes).toBe(2);
    expect(config.sshUsers).toEqual(["root"]);
    expect(config.defaultCooldownMinutes).toBe(DEFAULT_CONFIG.defaultCooldownMinutes);
  });

  test("rejects an unknown strategy instead of silently routing traffic", () => {
    const { config, errors } = parseConfig({ providers: { "opencode-zen": { strategy: "sideways" } } });
    expect(errors.join(" ")).toContain("strategy");
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("rejects a pinned provider with no node", () => {
    const { errors } = parseConfig({ providers: { freetheai: { strategy: "pinned" } } });
    expect(errors.join(" ")).toContain("node is required");
  });

  test("rejects a non-positive refresh interval", () => {
    const { errors } = parseConfig({ refreshIntervalMinutes: 0 });
    expect(errors.join(" ")).toContain("refreshIntervalMinutes");
  });
});

describe("cooldown headers", () => {
  const now = 1_700_000_000_000;

  test("honors retry-after in seconds", () => {
    const window = parseCooldown({ "retry-after": "900" }, 60, now);
    expect(window.source).toBe("retry-after");
    expect(window.durationMs).toBe(900_000 + 5_000);
  });

  test("honors retry-after as an HTTP date", () => {
    const when = new Date(now + 120_000).toUTCString();
    const window = parseCooldown({ "Retry-After": when }, 60, now);
    expect(window.source).toBe("retry-after");
    expect(window.durationMs).toBeGreaterThan(115_000);
    expect(window.durationMs).toBeLessThanOrEqual(126_000);
  });

  test("treats a large ratelimit-reset as epoch seconds", () => {
    const window = parseCooldown({ "x-ratelimit-reset": String(Math.floor(now / 1000) + 300) }, 60, now);
    expect(window.source).toBe("ratelimit-reset");
    expect(window.durationMs).toBe(300_000 + 5_000);
  });

  test("treats a small ratelimit-reset as a relative delta", () => {
    const window = parseCooldown({ "ratelimit-reset": "45" }, 60, now);
    expect(window.source).toBe("ratelimit-reset");
    expect(window.durationMs).toBe(45_000 + 5_000);
  });

  test("falls back to the configured default when headers are absent or junk", () => {
    expect(parseCooldown({}, 30, now)).toEqual({ durationMs: 1_800_000, source: "default" });
    expect(parseCooldown({ "retry-after": "soon" }, 30, now).source).toBe("default");
  });

  test("clamps an absurd header to one day", () => {
    const window = parseCooldown({ "retry-after": "9999999" }, 60, now);
    expect(window.durationMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("exhaustion store", () => {
  test("a 429 on one provider leaves the same IP usable for another", async () => {
    const store = new ExhaustionStore(join(await temporaryDirectory(), "exhaustion.json"));
    await store.load();
    store.markExhausted("opencode-zen", "203.0.113.7", { durationMs: 600_000, source: "retry-after" });
    await store.flush();

    expect(store.remainingMs("opencode-zen", "203.0.113.7")).toBeGreaterThan(0);
    expect(store.remainingMs("freetheai", "203.0.113.7")).toBe(0);
    expect(store.remainingMs("opencode-zen", "198.51.100.4")).toBe(0);
  });

  test("cooldowns survive a restart and expire on their own", async () => {
    const path = join(await temporaryDirectory(), "exhaustion.json");
    const first = new ExhaustionStore(path);
    await first.load();
    const now = Date.now();
    first.markExhausted("opencode-zen", "203.0.113.7", { durationMs: 600_000, source: "default" }, now);
    first.markExhausted("opencode-zen", "203.0.113.8", { durationMs: 1_000, source: "default" }, now);
    await first.flush();

    const resumed = new ExhaustionStore(path);
    await resumed.load();
    expect(resumed.remainingMs("opencode-zen", "203.0.113.7", now)).toBeGreaterThan(0);
    // Past its window: eligible again without any sweep.
    expect(resumed.remainingMs("opencode-zen", "203.0.113.8", now + 2_000)).toBe(0);
    expect(Object.keys(resumed.activeFor("opencode-zen", now + 2_000))).toEqual(["203.0.113.7"]);
  });

  test("reset clears every cooldown", async () => {
    const store = new ExhaustionStore(join(await temporaryDirectory(), "exhaustion.json"));
    await store.load();
    store.markExhausted("opencode-zen", "203.0.113.7", { durationMs: 600_000, source: "default" });
    store.reset();
    await store.flush();
    expect(store.remainingMs("opencode-zen", "203.0.113.7")).toBe(0);
  });

  test("a corrupt state file starts empty rather than throwing", async () => {
    const path = join(await temporaryDirectory(), "exhaustion.json");
    await Bun.write(path, "{not json");
    const store = new ExhaustionStore(path);
    await store.load();
    expect(store.remainingMs("opencode-zen", "203.0.113.7")).toBe(0);
  });
});

describe("discovery", () => {
  const status = {
    Self: { DNSName: "laughingman.zapus-spica.ts.net.", TailscaleIPs: ["100.117.244.102"], Online: true },
    Peer: {
      keyA: {
        DNSName: "coolify.zapus-spica.ts.net.",
        TailscaleIPs: ["100.116.37.68", "fd7a:115c::1"],
        Online: true,
        ExitNodeOption: true,
      },
      keyB: { DNSName: "raspi.zapus-spica.ts.net.", TailscaleIPs: ["100.124.46.123"], Online: false, ExitNodeOption: true },
      keyC: { DNSName: "phone.zapus-spica.ts.net.", TailscaleIPs: ["100.127.236.114"], Online: true, ExitNodeOption: false },
    },
  };

  test("extracts short labels and IPv4 addresses", () => {
    const { nodes, errors } = parseTailscaleStatus(status);
    expect(errors).toEqual([]);
    const coolify = nodes.find((node) => node.label === "coolify");
    expect(coolify?.tailscaleIp).toBe("100.116.37.68");
    expect(coolify?.hostname).toBe("coolify.zapus-spica.ts.net");
    expect(nodes.find((node) => node.label === "laughingman")?.isSelf).toBe(true);
  });

  test("egress candidates exclude self, offline and non-exit peers", () => {
    const { nodes } = parseTailscaleStatus(status);
    expect(egressCandidates(nodes).map((node) => node.label)).toEqual(["coolify"]);
  });

  test("malformed status yields errors instead of throwing", () => {
    const { nodes, errors } = parseTailscaleStatus({ Peer: "nope" });
    expect(nodes).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("route ranking", () => {
  const routes: RouteState[] = [
    { label: "slow", host: "100.0.0.3", latencyMs: 180 },
    { label: "dead", host: "100.0.0.4", unreachableReason: "SSH port unreachable" },
    { label: "fast", host: "100.0.0.2", latencyMs: 24 },
    { label: "local", latencyMs: 0 },
  ];

  test("orders by latency and sinks unreachable routes", () => {
    expect(rankRoutes(routes).map((route) => route.label)).toEqual(["local", "fast", "slow", "dead"]);
  });

  test("skips routes whose IP is cooling down for that provider", async () => {
    const store = new ExhaustionStore(join(await temporaryDirectory(), "exhaustion.json"));
    await store.load();
    const withIps: RouteState[] = [
      { label: "local", latencyMs: 0, publicIp: "203.0.113.1" },
      { label: "fast", host: "100.0.0.2", latencyMs: 24, publicIp: "203.0.113.2" },
    ];
    store.markExhausted("opencode-zen", "203.0.113.1", { durationMs: 600_000, source: "retry-after" });
    expect(firstEligible(rankRoutes(withIps), "opencode-zen", store)?.label).toBe("fast");
    // Untouched for a different provider.
    expect(firstEligible(rankRoutes(withIps), "freetheai", store)?.label).toBe("local");
  });

  test("treats an unknown IP as eligible so a cold pool is still usable", async () => {
    const store = new ExhaustionStore(join(await temporaryDirectory(), "exhaustion.json"));
    await store.load();
    const unknown: RouteState[] = [{ label: "fast", host: "100.0.0.2", latencyMs: 24 }];
    expect(firstEligible(unknown, "opencode-zen", store)?.label).toBe("fast");
  });
});

describe("connect bridge", () => {
  test("tunnels a CONNECT to a direct upstream", async () => {
    const origin = await startEchoOrigin("ORIGIN-DIRECT");
    const bridge = await startBridge({ kind: "direct" });
    const result = await connectThrough(bridge.port, `127.0.0.1:${origin.port}`);
    expect(result.statusLine).toContain("200");
    expect(result.body).toBe("ORIGIN-DIRECT");
  });

  test("tunnels a CONNECT through a SOCKS5 upstream", async () => {
    const origin = await startEchoOrigin("ORIGIN-SOCKS");
    const socks = await startFakeSocks(origin.port);
    const bridge = await startBridge({ kind: "socks5", port: socks.port, label: "coolify" });
    const result = await connectThrough(bridge.port, "example.invalid:443");
    expect(result.body).toBe("ORIGIN-SOCKS");
    expect(socks.connects()).toBe(1);
  });

  test("swapping the upstream redirects subsequent connections", async () => {
    const first = await startEchoOrigin("ORIGIN-A");
    const second = await startEchoOrigin("ORIGIN-B");
    const socksA = await startFakeSocks(first.port);
    const socksB = await startFakeSocks(second.port);
    const bridge = await startBridge({ kind: "socks5", port: socksA.port, label: "node-a" });

    expect((await connectThrough(bridge.port, "example.invalid:443")).body).toBe("ORIGIN-A");
    bridge.setUpstream({ kind: "socks5", port: socksB.port, label: "node-b" });
    expect((await connectThrough(bridge.port, "example.invalid:443")).body).toBe("ORIGIN-B");
    expect(bridge.upstream).toMatchObject({ label: "node-b" });
  });
  test("swapping the upstream evicts live tunnels so pooled connections cannot outlive a rotation", async () => {
    const first = await startEchoOrigin("ORIGIN-A");
    const second = await startEchoOrigin("ORIGIN-B");
    const socksA = await startFakeSocks(first.port);
    const socksB = await startFakeSocks(second.port);
    const bridge = await startBridge({ kind: "socks5", port: socksA.port, label: "node-a" });

    // Hold an idle tunnel open, mimicking an HTTP client's pooled connection.
    const pooled = net.connect(bridge.port, "127.0.0.1");
    const closed = Promise.withResolvers<void>();
    pooled.on("error", () => pooled.destroy());
    pooled.on("close", () => closed.resolve());
    const established = Promise.withResolvers<void>();
    pooled.on("data", () => established.resolve());
    pooled.on("connect", () =>
      pooled.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid\r\n\r\n"),
    );
    await established.promise;

    bridge.setUpstream({ kind: "socks5", port: socksB.port, label: "node-b" });
    // The rotation must tear the pooled tunnel down, not merely retarget new ones.
    await closed.promise;
    expect((await connectThrough(bridge.port, "example.invalid:443")).body).toBe("ORIGIN-B");
  });

  test("re-setting the same upstream leaves established tunnels alone", async () => {
    const origin = await startEchoOrigin("ORIGIN-A");
    const socks = await startFakeSocks(origin.port);
    const bridge = await startBridge({ kind: "socks5", port: socks.port, label: "node-a" });

    const held = net.connect(bridge.port, "127.0.0.1");
    let destroyed = false;
    held.on("error", () => held.destroy());
    held.on("close", () => {
      destroyed = true;
    });
    const established = Promise.withResolvers<void>();
    held.on("data", () => established.resolve());
    held.on("connect", () => held.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n"));
    await established.promise;

    bridge.setUpstream({ kind: "socks5", port: socks.port, label: "node-a" });
    expect(destroyed).toBe(false);
    held.destroy();
  });

  test("concurrent connections all share the single active upstream", async () => {
    const shared = await startEchoOrigin("ORIGIN-SHARED");
    const other = await startEchoOrigin("ORIGIN-OTHER");
    const socksShared = await startFakeSocks(shared.port);
    await startFakeSocks(other.port);
    const bridge = await startBridge({ kind: "socks5", port: socksShared.port, label: "coolify" });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => connectThrough(bridge.port, "example.invalid:443")),
    );
    expect(results.map((result) => result.body)).toEqual(Array(4).fill("ORIGIN-SHARED"));
    expect(socksShared.connects()).toBe(4);
  });

  test("rejects a non-CONNECT request", async () => {
    const bridge = await startBridge({ kind: "direct" });
    const socket = net.connect(bridge.port, "127.0.0.1");
    const { promise, resolve } = Promise.withResolvers<string>();
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(received));
    socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(await promise).toContain("400");
  });

  test("reports a dead upstream as 502 and counts the failure", async () => {
    const bridge = await startBridge({ kind: "socks5", port: 59_999, label: "dead" });
    const result = await connectThrough(bridge.port, "example.invalid:443");
    expect(result.statusLine).toContain("502");
    expect(bridge.stats.failures).toBe(1);
  });

  test("surfaces a SOCKS5 refusal as a rejection with the reply reason", async () => {
    const refusing = await startRefusingSocks();
    await expect(socks5Connect(refusing.port, "example.invalid", 443, 2_000)).rejects.toThrow(
      /connection refused/i,
    );
  });

  test("reports a SOCKS5 handshake timeout rather than hanging", async () => {
    const silent = await startSilentSocks();
    await expect(socks5Connect(silent.port, "example.invalid", 443, 150)).rejects.toThrow(/timed out/i);
  });
});

describe("router rotation", () => {
  async function buildRouter(): Promise<{ router: Router; socksA: number; socksB: number }> {
    const originA = await startEchoOrigin("NODE-A");
    const originB = await startEchoOrigin("NODE-B");
    const socksA = await startFakeSocks(originA.port);
    const socksB = await startFakeSocks(originB.port);
    const store = new ExhaustionStore(join(await temporaryDirectory(), "exhaustion.json"));
    await store.load();
    const config = routerConfig({
      includeLocalRoute: false,
      providers: {
        "opencode-zen": { strategy: "auto-rotate" },
        freetheai: { strategy: "pinned", node: "node-a" },
      },
    });
    const router = new Router(config, store, fakeTunnels({ "node-a": socksA.port, "node-b": socksB.port }));
    router.setNodes([
      { label: "node-a", hostname: "node-a.ts.net", tailscaleIp: "100.0.0.2", online: true, exitCapable: true, isSelf: false },
      { label: "node-b", hostname: "node-b.ts.net", tailscaleIp: "100.0.0.3", online: true, exitCapable: true, isSelf: false },
    ]);
    for (const route of router.routes) {
      route.latencyMs = route.label === "node-a" ? 10 : 50;
      route.publicIp = route.label === "node-a" ? "203.0.113.10" : "203.0.113.11";
    }
    cleanups.push(() => router.dispose());
    return { router, socksA: socksA.port, socksB: socksB.port };
  }

  test("publishes a stable PI_PROXY bridge port for a routed provider", async () => {
    const { router } = await buildRouter();
    await router.applyAll();
    const published = process.env[proxyEnvKey("opencode-zen")];
    expect(published).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(router.providerRoutes.find((entry) => entry.provider === "opencode-zen")?.activeLabel).toBe("node-a");

    // A rotation must not change the published value: pi-ai memoizes it.
    await router.rotate("opencode-zen");
    expect(process.env[proxyEnvKey("opencode-zen")]).toBe(published);
  });

  test("a 429 sidelines the active IP and advances the whole provider", async () => {
    const { router, socksB } = await buildRouter();
    await router.applyAll();
    const moved = await router.handleRateLimit("opencode-zen", { "retry-after": "600" });
    expect(moved).toMatchObject({ from: "node-a", to: "node-b" });
    expect(moved?.window.source).toBe("retry-after");
    expect(router.store.remainingMs("opencode-zen", "203.0.113.10")).toBeGreaterThan(0);

    const active = router.providerRoutes.find((entry) => entry.provider === "opencode-zen");
    expect(active?.activeLabel).toBe("node-b");
    expect(active?.bridge.upstream).toMatchObject({ kind: "socks5", port: socksB });
  });

  test("all traffic for a provider egresses through the one active node", async () => {
    const { router } = await buildRouter();
    await router.applyAll();
    const bridge = router.providerRoutes.find((entry) => entry.provider === "opencode-zen")?.bridge;
    expect(bridge).toBeDefined();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => connectThrough(bridge!.port, "example.invalid:443")),
    );
    expect(results.map((result) => result.body)).toEqual(["NODE-A", "NODE-A", "NODE-A"]);

    await router.handleRateLimit("opencode-zen", { "retry-after": "600" });
    const afterRotation = await Promise.all(
      Array.from({ length: 3 }, () => connectThrough(bridge!.port, "example.invalid:443")),
    );
    expect(afterRotation.map((result) => result.body)).toEqual(["NODE-B", "NODE-B", "NODE-B"]);
  });

  test("a pinned provider records the cooldown but never moves", async () => {
    const { router } = await buildRouter();
    await router.applyAll();
    expect(router.providerRoutes.find((entry) => entry.provider === "freetheai")?.activeLabel).toBe("node-a");
    const moved = await router.handleRateLimit("freetheai", { "retry-after": "300" });
    expect(moved?.to).toBeUndefined();
    expect(router.store.remainingMs("freetheai", "203.0.113.10")).toBeGreaterThan(0);
    expect(router.providerRoutes.find((entry) => entry.provider === "freetheai")?.activeLabel).toBe("node-a");
  });

  test("an unconfigured provider is left entirely direct", async () => {
    const { router } = await buildRouter();
    await router.applyAll();
    expect(router.select("anthropic")).toBeUndefined();
    expect(process.env[proxyEnvKey("anthropic")]).toBeUndefined();
  });

  test("pool health counts fresh versus total reachable IPs", async () => {
    const { router } = await buildRouter();
    expect(router.poolHealth("opencode-zen")).toEqual({ fresh: 2, total: 2 });
    router.store.markExhausted("opencode-zen", "203.0.113.10", { durationMs: 600_000, source: "default" });
    expect(router.poolHealth("opencode-zen")).toEqual({ fresh: 1, total: 2 });
    expect(router.poolHealth("freetheai")).toEqual({ fresh: 2, total: 2 });
  });

  test("dispose removes published proxy variables", async () => {
    const { router } = await buildRouter();
    await router.applyAll();
    expect(process.env[proxyEnvKey("opencode-zen")]).toBeDefined();
    await router.dispose();
    expect(process.env[proxyEnvKey("opencode-zen")]).toBeUndefined();
  });
  test("probing releases tunnels no provider is routing through", async () => {
    const sshStub = await startEchoOrigin("SSH");
    const store = new ExhaustionStore(join(await temporaryDirectory(), "exhaustion.json"));
    await store.load();
    const config = routerConfig({
      includeLocalRoute: false,
      // Unreachable resolver: the probe must still release its tunnel on failure.
      publicIpUrls: ["https://127.0.0.1:1/"],
      probeTimeoutMs: 400,
      sshPort: sshStub.port,
      providers: { "opencode-zen": { strategy: "auto-rotate" } },
    });
    const tunnels = fakeTunnels({ "node-a": 59_998, "node-b": 59_997 });
    const router = new Router(config, store, tunnels);
    router.setNodes([
      { label: "node-a", hostname: "a.ts.net", tailscaleIp: "127.0.0.1", online: true, exitCapable: true, isSelf: false },
      { label: "node-b", hostname: "b.ts.net", tailscaleIp: "127.0.0.1", online: true, exitCapable: true, isSelf: false },
    ]);
    cleanups.push(() => router.dispose());

    // Ranking needs a latency measurement before a route can be selected.
    await router.probeAll();
    // An unreachable IP resolver must not evict an otherwise healthy node.
    expect(router.routes.every((route) => route.unreachableReason === undefined)).toBe(true);
    expect(router.routes.every((route) => route.ipError !== undefined)).toBe(true);
    await router.applyAll();
    const active = router.providerRoutes.find((entry) => entry.provider === "opencode-zen")?.activeLabel;
    expect(active).toBeDefined();

    tunnels.closed.length = 0;
    await router.probeAll();
    // Every probed node except the one actually carrying traffic is released.
    const released = new Set(tunnels.closed);
    expect(released.has(active as string)).toBe(false);
    for (const label of ["node-a", "node-b"]) {
      if (label !== active) expect(released.has(label)).toBe(true);
    }
  });
});
