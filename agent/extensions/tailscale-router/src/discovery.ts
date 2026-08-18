import * as net from "node:net";
import { type } from "@oh-my-pi/omptype";

/** The workstation's own connection, always present as the zero-hop route. */
export const LOCAL_ROUTE_LABEL = "local";

export interface NodeCandidate {
  /** Short name used in config, commands and the status badge. */
  label: string;
  /** Full MagicDNS name. */
  hostname: string;
  /** Tailnet IPv4 used for SSH and latency probes. */
  tailscaleIp: string;
  online: boolean;
  exitCapable: boolean;
  isSelf: boolean;
}

const PeerSchema = type({
  "DNSName?": "string",
  "TailscaleIPs?": "string[]",
  "Online?": "boolean",
  "ExitNodeOption?": "boolean",
});

const StatusSchema = type({
  "Self?": PeerSchema,
  "Peer?": { "[string]": PeerSchema },
});

type PeerRecord = typeof PeerSchema.infer;

function toCandidate(peer: PeerRecord, isSelf: boolean): NodeCandidate | undefined {
  const hostname = peer.DNSName?.replace(/\.$/, "");
  if (hostname === undefined || hostname.length === 0) return undefined;
  // MagicDNS names are `<label>.<tailnet>.ts.net`; the first segment is the
  // handle users type in config and commands.
  const label = hostname.split(".")[0] ?? hostname;
  const tailscaleIp = peer.TailscaleIPs?.find((address) => net.isIPv4(address));
  if (tailscaleIp === undefined) return undefined;
  return {
    label,
    hostname,
    tailscaleIp,
    online: peer.Online === true,
    exitCapable: peer.ExitNodeOption === true,
    isSelf,
  };
}

/**
 * Extract routable candidates from `tailscale status --json`.
 *
 * Offline and non-exit-capable peers are retained so `/tailscale status` can
 * explain why a node is unusable rather than silently omitting it; selection
 * filters them out later.
 */
export function parseTailscaleStatus(raw: unknown): { nodes: NodeCandidate[]; errors: string[] } {
  const parsed = StatusSchema(raw);
  if (parsed instanceof type.errors) {
    return { nodes: [], errors: parsed.map((issue) => issue.message) };
  }
  const nodes: NodeCandidate[] = [];
  if (parsed.Self !== undefined) {
    const self = toCandidate(parsed.Self, true);
    if (self !== undefined) nodes.push(self);
  }
  for (const peer of Object.values(parsed.Peer ?? {})) {
    const candidate = toCandidate(peer, false);
    if (candidate !== undefined) nodes.push(candidate);
  }
  return { nodes, errors: [] };
}

/** Nodes usable as an egress hop: online, exit-capable, and not this machine. */
export function egressCandidates(nodes: readonly NodeCandidate[]): NodeCandidate[] {
  return nodes.filter((node) => node.online && node.exitCapable && !node.isSelf);
}

/**
 * Measure TCP round-trip to a node's SSH port.
 *
 * SSH reachability is the property that matters — it is the transport the
 * tunnel actually uses — so a node that answers ICMP but refuses SSH is
 * correctly reported as unreachable. Returns `undefined` when unreachable.
 */
export async function probeLatencyMs(host: string, timeoutMs: number, port = 22): Promise<number | undefined> {
  const started = performance.now();
  const socket = net.connect(port, host);
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const finish = (value: number | undefined): void => {
    socket.destroy();
    resolve(value);
  };
  const timer = setTimeout(() => finish(undefined), timeoutMs);
  socket.once("connect", () => {
    clearTimeout(timer);
    finish(Math.round(performance.now() - started));
  });
  socket.once("error", () => {
    clearTimeout(timer);
    finish(undefined);
  });
  return promise;
}

const IP_PATTERN = /^\s*((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)\s*$/i;

/**
 * Resolve the public egress IP, optionally through an HTTP proxy.
 *
 * Several services are tried in order because a single resolver being slow or
 * blocked must not make a healthy node look broken. `proxyUrl` must be an
 * `http://` bridge: Bun's fetch rejects `socks5://` outright.
 */
export async function resolvePublicIp(
  urls: readonly string[],
  timeoutMs: number,
  proxyUrl?: string,
): Promise<{ ip?: string; error?: string }> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        proxy: proxyUrl,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/plain" },
        // A cached answer would hide an IP change mid-session.
        cache: "no-store",
      });
      if (!response.ok) {
        failures.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      const body = await response.text();
      const matched = IP_PATTERN.exec(body);
      if (matched?.[1] === undefined) {
        failures.push(`${url} -> unparseable body`);
        continue;
      }
      return { ip: matched[1] };
    } catch (error) {
      failures.push(`${url} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { error: failures.join("; ") };
}
