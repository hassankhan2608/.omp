import { type ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";

export interface TunnelHandle {
  /** Node label this tunnel egresses through. */
  label: string;
  /** Loopback port serving SOCKS5. */
  socksPort: number;
  /** SSH user that the tailnet policy accepted. */
  user: string;
}

/**
 * The slice of tunnel management the router depends on. Exists so tests can
 * exercise rotation without spawning real SSH processes.
 */
export interface TunnelProvider {
  ensure(label: string, host: string): Promise<TunnelHandle>;
  close(label: string): void;
  disposeAll(): void;
}

interface ActiveTunnel extends TunnelHandle {
  process: ChildProcess;
}

/** SSH options that keep tunnels non-interactive and fail fast. */
const SSH_BASE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  // Without this, ssh stays up after the forward fails and the bridge would
  // dial a dead SOCKS port on every request.
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-N",
];

/**
 * Reserve a loopback port by binding and releasing it.
 *
 * `ssh -D 0` is not portable, so the port must be chosen before spawning. A
 * bind/release still races in theory, but `ExitOnForwardFailure` turns a lost
 * race into a clean tunnel failure rather than silent misrouting.
 */
export async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("failed to reserve a loopback port"));
      return;
    }
    const { port } = address;
    server.close(() => resolve(port));
  });
  return promise;
}

/**
 * Owns one `ssh -D` SOCKS5 tunnel per Tailscale node.
 *
 * Tunnels are created lazily (only nodes actually routed to pay the cost) and
 * every process is killed on dispose so no forwarder outlives the session.
 */
export class TunnelManager implements TunnelProvider {
  #tunnels = new Map<string, ActiveTunnel>();
  #pending = new Map<string, Promise<TunnelHandle>>();
  #users: readonly string[];
  #connectTimeoutMs: number;
  #sshPort: number;

  constructor(users: readonly string[], connectTimeoutMs: number, sshPort = 22) {
    this.#users = users;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#sshPort = sshPort;
    installExitGuard();
    liveManagers.add(this);
  }

  /** Labels with a live tunnel. */
  get activeLabels(): string[] {
    return [...this.#tunnels.keys()];
  }

  get(label: string): TunnelHandle | undefined {
    return this.#tunnels.get(label);
  }

  /**
   * Return a live tunnel for a node, creating one if needed. Concurrent
   * callers share a single in-flight attempt so a fan-out of requests cannot
   * spawn duplicate forwarders for the same node.
   */
  async ensure(label: string, host: string): Promise<TunnelHandle> {
    const existing = this.#tunnels.get(label);
    if (existing !== undefined && existing.process.exitCode === null && !existing.process.killed) return existing;
    if (existing !== undefined) this.#tunnels.delete(label);

    const inFlight = this.#pending.get(label);
    if (inFlight !== undefined) return inFlight;

    const attempt = this.#open(label, host).finally(() => this.#pending.delete(label));
    this.#pending.set(label, attempt);
    return attempt;
  }

  async #open(label: string, host: string): Promise<TunnelHandle> {
    const failures: string[] = [];
    // The tailnet SSH policy decides which usernames are permitted, and it
    // differs per node, so each candidate is tried in configured order.
    for (const user of this.#users) {
      const socksPort = await reserveLoopbackPort();
      const child = spawn(
        "ssh",
        [
          ...SSH_BASE_ARGS,
          "-o",
          `ConnectTimeout=${Math.ceil(this.#connectTimeoutMs / 1000)}`,
          "-p",
          String(this.#sshPort),
          "-D",
          `127.0.0.1:${socksPort}`,
          `${user}@${host}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const ready = await this.#awaitListening(child, socksPort);
      if (ready.ok) {
        const tunnel: ActiveTunnel = { label, socksPort, user, process: child };
        this.#tunnels.set(label, tunnel);
        child.once("exit", () => {
          if (this.#tunnels.get(label) === tunnel) this.#tunnels.delete(label);
        });
        return tunnel;
      }
      child.kill("SIGKILL");
      failures.push(`${user}@${host}: ${ready.reason}`);
    }
    throw new Error(`no SSH tunnel to ${label} (${failures.join("; ")})`);
  }

  /**
   * Wait until the SOCKS port accepts a connection, the process exits, or the
   * deadline passes. Process liveness alone is not readiness: ssh reports
   * forward failures only after authenticating.
   */
  async #awaitListening(child: ChildProcess, port: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const deadline = Date.now() + this.#connectTimeoutMs + 4_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = stderr.trim().split("\n").at(-1) ?? `exited with code ${child.exitCode}`;
        return { ok: false, reason: detail };
      }
      const probe = net.connect(port, "127.0.0.1");
      const { promise, resolve } = Promise.withResolvers<boolean>();
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => {
        probe.destroy();
        resolve(false);
      });
      if (await promise) return { ok: true };
      await Bun.sleep(120);
    }
    const detail = stderr.trim().split("\n").at(-1);
    return { ok: false, reason: detail !== undefined && detail.length > 0 ? detail : "SOCKS port never accepted a connection" };
  }

  /** Kill one tunnel. */
  close(label: string): void {
    const tunnel = this.#tunnels.get(label);
    if (tunnel === undefined) return;
    this.#tunnels.delete(label);
    tunnel.process.kill("SIGKILL");
  }

  /** Kill every tunnel. Safe to call repeatedly. */
  disposeAll(): void {
    for (const tunnel of this.#tunnels.values()) tunnel.process.kill("SIGKILL");
    this.#tunnels.clear();
    liveManagers.delete(this);
  }
}
/**
 * Every live manager in this process.
 *
 * `ssh` children are not in OMP's process group teardown path, so an abrupt
 * exit would otherwise reparent them and leave forwarders running against the
 * tailnet. The guard below kills them on any normal termination path.
 */
const liveManagers = new Set<TunnelManager>();
let exitGuardInstalled = false;

function installExitGuard(): void {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  const killAll = (): void => {
    for (const manager of liveManagers) manager.disposeAll();
  };
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    // `once` plus no `exit()` call keeps OMP's own signal handling intact.
    process.once(signal, killAll);
  }
}
