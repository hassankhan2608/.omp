import * as net from "node:net";

/**
 * Where a bridge sends traffic. `direct` dials the target itself (the
 * workstation's own egress); `socks5` tunnels through a local `ssh -D`
 * listener, which is what puts traffic on a Tailscale node's egress IP.
 */
export type BridgeUpstream = { kind: "direct" } | { kind: "socks5"; port: number; label: string };

const SOCKS_VERSION = 0x05;
const SOCKS_NO_AUTH = 0x00;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYP_IPV4 = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;
const SOCKS_ATYP_IPV6 = 0x04;

/** SOCKS5 reply codes worth naming; anything else is reported numerically. */
const SOCKS_REPLY_TEXT: Record<number, string> = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

export interface Socks5Result {
  socket: net.Socket;
  /** Bytes the upstream already sent past the handshake; must be forwarded. */
  overflow: Buffer;
}

/**
 * Perform a SOCKS5 no-auth CONNECT against a local listener.
 *
 * The target is sent as a domain name (ATYP 0x03) so DNS resolves on the
 * remote node rather than locally — the equivalent of curl's
 * `--socks5-hostname`. Resolving locally would leak the workstation's DNS view
 * and can select a different CDN edge than the egress IP's region.
 */
export function socks5Connect(
  socksPort: number,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socks5Result> {
  const { promise, resolve, reject } = Promise.withResolvers<Socks5Result>();
  const socket = net.connect(socksPort, "127.0.0.1");
  let stage: "greeting" | "connect" = "greeting";
  let buffer = Buffer.alloc(0);
  let settled = false;

  const timer = setTimeout(() => {
    fail(new Error(`SOCKS5 handshake to 127.0.0.1:${socksPort} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  function fail(error: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    reject(error);
  }

  function succeed(overflow: Buffer): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("error", fail);
    resolve({ socket, overflow });
  }

  function onData(chunk: Buffer): void {
    buffer = Buffer.concat([buffer, chunk]);
    if (stage === "greeting") {
      if (buffer.length < 2) return;
      if (buffer[0] !== SOCKS_VERSION || buffer[1] !== SOCKS_NO_AUTH) {
        fail(new Error(`SOCKS5 greeting rejected (ver=${buffer[0]}, method=${buffer[1]})`));
        return;
      }
      buffer = buffer.subarray(2);
      stage = "connect";
      const hostBytes = Buffer.from(host, "utf8");
      socket.write(
        Buffer.concat([
          Buffer.from([SOCKS_VERSION, SOCKS_CMD_CONNECT, 0x00, SOCKS_ATYP_DOMAIN, hostBytes.length]),
          hostBytes,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]),
      );
    }
    if (stage === "connect") {
      if (buffer.length < 5) return;
      const reply = buffer[1] ?? 0xff;
      if (reply !== 0x00) {
        fail(new Error(`SOCKS5 CONNECT failed: ${SOCKS_REPLY_TEXT[reply] ?? `reply 0x${reply.toString(16)}`}`));
        return;
      }
      const addressType = buffer[3];
      // Reply header is VER REP RSV ATYP + bound address + 2-byte port. The
      // bound address must be consumed before the tunnel carries real bytes.
      const addressLength =
        addressType === SOCKS_ATYP_IPV4
          ? 4
          : addressType === SOCKS_ATYP_IPV6
            ? 16
            : addressType === SOCKS_ATYP_DOMAIN
              ? 1 + (buffer[4] ?? 0)
              : -1;
      if (addressLength < 0) {
        fail(new Error(`SOCKS5 reply used unsupported address type 0x${(addressType ?? 0).toString(16)}`));
        return;
      }
      const headerLength = 4 + addressLength + 2;
      if (buffer.length < headerLength) return;
      succeed(buffer.subarray(headerLength));
    }
  }

  socket.once("error", fail);
  socket.once("connect", () => socket.write(Buffer.from([SOCKS_VERSION, 0x01, SOCKS_NO_AUTH])));
  socket.on("data", onData);
  return promise;
}

export interface BridgeStats {
  /** Tunnelled connections accepted since start. */
  connections: number;
  /** Connections that could not reach the upstream. */
  failures: number;
}

/**
 * A loopback HTTP CONNECT proxy with a hot-swappable upstream.
 *
 * Bun's `fetch` rejects `socks5://` proxies outright
 * (`UnsupportedProxyProtocol`), so a SOCKS5 tunnel cannot be handed to it
 * directly. This bridge is the translation layer: it speaks the HTTP proxy
 * protocol Bun accepts and forwards through whichever upstream is currently
 * selected. Because the port is stable for the process lifetime, rotation is a
 * pure upstream swap and never has to touch `PI_PROXY_*` (whose lookup pi-ai
 * memoizes per provider).
 */
export class ConnectBridge {
  #server: net.Server;
  #upstream: BridgeUpstream;
  #port = 0;
  #sockets = new Set<net.Socket>();
  #timeoutMs: number;
  #stats: BridgeStats = { connections: 0, failures: 0 };

  constructor(upstream: BridgeUpstream, timeoutMs: number) {
    this.#upstream = upstream;
    this.#timeoutMs = timeoutMs;
    this.#server = net.createServer((client) => this.#handle(client));
    this.#server.on("error", () => {
      /* listener errors surface through listen() and per-connection failures */
    });
  }

  get port(): number {
    return this.#port;
  }

  get upstream(): BridgeUpstream {
    return this.#upstream;
  }

  get stats(): BridgeStats {
    return { ...this.#stats };
  }

  /**
   * Redirect the bridge to a new egress and drop every live tunnel.
   *
   * Tearing down existing sockets is load-bearing, not cleanup: HTTP clients
   * (Bun's `fetch` included) pool connections per proxy URL, and this port
   * never changes. A pooled CONNECT tunnel established through the previous
   * node would keep carrying requests out of the old IP, so swapping the
   * upstream alone silently fails to rotate. Killing the sockets forces the
   * next request to re-CONNECT through the new upstream. Rotation follows a
   * failed (429) request, so no useful in-flight work is discarded.
   */
  setUpstream(upstream: BridgeUpstream): void {
    const previous = this.#upstream;
    this.#upstream = upstream;
    const unchanged =
      upstream.kind === "direct"
        ? previous.kind === "direct"
        : previous.kind === "socks5" && previous.port === upstream.port;
    if (unchanged) return;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }

  async listen(): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#server.once("error", reject);
    this.#server.listen(0, "127.0.0.1", () => {
      this.#server.removeListener("error", reject);
      resolve();
    });
    await promise;
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("bridge failed to bind a loopback TCP port");
    }
    this.#port = address.port;
    return this.#port;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#server.close(() => resolve());
    await promise;
  }

  #track(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }

  async #openUpstream(host: string, port: number): Promise<Socks5Result> {
    const upstream = this.#upstream;
    if (upstream.kind === "socks5") return socks5Connect(upstream.port, host, port, this.#timeoutMs);
    const socket = net.connect(port, host);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`direct connect to ${host}:${port} timed out after ${this.#timeoutMs}ms`));
    }, this.#timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    await promise;
    return { socket, overflow: Buffer.alloc(0) };
  }

  #handle(client: net.Socket): void {
    this.#track(client);
    client.on("error", () => client.destroy());
    client.once("data", (head: Buffer) => {
      // Only CONNECT is implemented: pi-ai exclusively issues HTTPS provider
      // requests, which every HTTP proxy client expresses as CONNECT.
      const requestLine = head.toString("latin1").split("\r\n", 1)[0] ?? "";
      const target = /^CONNECT\s+(\[[^\]]+\]|[^\s:]+):(\d+)/i.exec(requestLine);
      if (target === null) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const host = target[1]?.replace(/^\[|\]$/g, "") ?? "";
      const port = Number(target[2]);
      this.#stats.connections += 1;
      this.#openUpstream(host, port).then(
        ({ socket, overflow }) => {
          this.#track(socket);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (overflow.length > 0) client.write(overflow);
          socket.pipe(client);
          client.pipe(socket);
          const teardown = (): void => {
            socket.destroy();
            client.destroy();
          };
          socket.on("error", teardown);
          socket.on("close", teardown);
          client.on("close", teardown);
        },
        (error: Error) => {
          this.#stats.failures += 1;
          client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\nrouter upstream failed: ${error.message}`);
        },
      );
    });
  }
}
