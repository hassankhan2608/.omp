## Context

See `proposal.md` for motivation and background. OMP executes model requests via `fetch` / `@oh-my-pi/pi-ai` HTTP clients. On Linux, Tailscale exposes active nodes and exit node capabilities through its local CLI (`tailscale status --json`, `tailscale exit-node list`). The host machine has multiple active Tailscale exit nodes with distinct public IPs.

## Goals / Non-Goals

**Goals:**
- Provide per-provider and per-IP routing that routes specific AI providers (e.g. `opencode-zen`, `freetheai`) through chosen or rotating Tailscale nodes.
- Maintain a dynamic, latency-ranked pool containing both the local direct connection (0ms baseline) and all online Tailscale exit nodes.
- Accurately resolve and track real public egress IPs, handling dynamic residential/hotspot IP changes every 5 minutes.
- Persist per-provider exhaustion cooldown states across OMP sessions to avoid immediate 429 retries on restarted sessions.
- Cleanly manage local proxy tunnels during session lifecycle with zero background process residue or system routing table modifications.

**Non-Goals:**
- Modifying host system default gateways, `/etc/resolv.conf`, or iptables.
- Proxying non-AI traffic (user's browser, discord, local dev servers remain 100% direct).
- Managing Tailscale credentials, node authorization, or tailnet administration.

## Decisions

### Decision 1: Stable Per-Provider Bridge Port with Swappable Upstream
- **Choice**: Allocate one long-lived loopback HTTP CONNECT bridge per routed provider, publish it once as `PI_PROXY_<PROVIDER>`, and rotate by swapping the bridge's *upstream* (a given node's `ssh -D` SOCKS5 tunnel, or a direct socket) instead of rewriting environment variables.
- **Rationale**: `getProxyForProvider()` memoizes per provider, so mutating `PI_PROXY_*` mid-session requires the internal `__resetProxyCache()` test seam and would silently serve a stale proxy if that seam ever disappeared. A stable port sidesteps the cache entirely: the env value never changes and rotation is a pure in-process upstream swap. "Direct" becomes just another upstream mode (plain `net.connect`), so the local IP is a first-class pool member.
- **Verified constraints** (measured, not assumed):
  - `pi-ai/utils/proxy.ts` resolves `PI_PROXY_<NORMALIZED_PROVIDER>` (e.g. `opencode-zen` -> `PI_PROXY_OPENCODE_ZEN`), falling back to `PI_PROXY`, then `HTTPS_PROXY`/`ALL_PROXY`. Providers with no variable set stay fully direct.
  - `wrapFetchForProxy()` is applied per request in `stream.ts` (lines 891, 1422), so a route change takes effect on the next model call with no client rebuild.
  - `getProxyForProvider()` memoizes per provider; the exported `__resetProxyCache()` seam (reachable via the package's `./utils/*` export) is REQUIRED after each mutation or the stale proxy persists.
  - Bun's `fetch` rejects `socks5://` and `socks5h://` with `UnsupportedProxyProtocol` — identical to a bogus scheme. Only `http://` proxies are usable, which is why the SOCKS5 tunnel MUST be fronted by an HTTP CONNECT bridge rather than handed to `fetch` directly.
  - Tailnet SSH policy permits `root@`/`ubuntu@` (not the local username), so the tunnel user is configurable per node.
- **Rationale**: Keeps routing strictly inside OMP's own model requests while allowing several providers to egress through *different* nodes simultaneously. Verified end to end: direct egress `103.137.113.158` vs bridged egress `80.225.216.153`.
- **Alternatives Considered**:
  - *Handing `socks5://` straight to `fetch`*: Rejected — empirically unsupported by Bun (`UnsupportedProxyProtocol`).
  - *System-wide `tailscale set --exit-node`*: Rejected because it diverts all host traffic and can require sudo/operator privileges.
  - *`tailscaled --outbound-http-proxy-listen`*: Rejected because it requires root plus a daemon restart and exposes only one globally-selected exit node, which cannot satisfy simultaneous per-provider routing.
  - *Global `HTTPS_PROXY` environment variable*: Rejected because it forces every provider and subprocess through one proxy instead of per-provider dispatch.

### Decision 2: Multi-Tier Egress Pool (Direct Local Interface as Primary)
- **Choice**: Treat the workstation's local direct connection as Route Candidate #0 with 0ms baseline latency.
- **Rationale**: Local direct internet is the fastest path and gives an additional free IP quota bucket. Tailscale exit nodes are engaged only when the local IP is exhausted for that provider or when a provider is explicitly pinned to a remote node.
- **Alternatives Considered**:
  - *Always tunneling all requests through Tailscale*: Rejected due to unnecessary tunnel latency overhead for fresh local IPs.

### Decision 3: Decoupled Background Probe Daemon (5-Minute Interval)
- **Choice**: Probe node latency (TCP RTT) and external public IPs (`https://api.ipify.org`) asynchronously using an unreferenced background timer, updating an in-memory cache table.
- **Rationale**: Model request dispatchers read synchronously/instantly from the in-memory cache with zero blocking latency during prompt submission.
- **Alternatives Considered**:
  - *Probing latency/IP synchronously on every request*: Rejected due to adding 300ms–1500ms overhead to every user prompt.

### Decision 4: Per-Provider Exhaustion Partitioning with Persistent Atomic JSON Storage
- **Choice**: Store exhaustion state partitioned by provider (`{ exhausted: { [provider]: { [publicIp]: { timestamp, cooldownMinutes } } } }`) in `~/.local/share/omp/tailscale-router/exhaustion.json` using atomic temporary file renames.
- **Rationale**: A rate limit on OpenCode Zen should not block that IP from being used on FreeTheAI or other services. Atomic writes prevent corruption across rapid sessions.

### Decision 5: Granular Policy Engine (`auto-rotate`, `pinned`, `direct`)
- **Choice**: Allow configuration in `agent/config.yml` or runtime slash commands to assign strategies per provider:
  - `opencode-zen` -> `strategy: auto-rotate` (lowest latency non-exhausted IP)
  - `freetheai` -> `strategy: pinned, node: coolify`
  - default -> `strategy: direct`
### Decision 6: Header-Driven Dynamic Cooldown Parser
- **Choice**: Extract and evaluate HTTP 429 response headers (`retry-after`, `x-ratelimit-reset`, `ratelimit-reset`, `cf-mitigated`) when rate limits occur.
- **Rationale**: When an upstream provider specifies a short rate limit duration (e.g. 15 minutes), parsing headers unlocks the IP at the exact second the constraint expires rather than enforcing a conservative 60-minute default.
- **Fallback**: If headers are missing or unparseable, fall back to the provider's configured `cooldownMinutes` (default: 60 min).

### Decision 7: TUI Live HUD Badge Integration
- **Choice**: Use OMP's `ExtensionUIContext.setStatus()` to maintain an active routing status badge (e.g. `󰖩 ts: coolify · 24ms · 7/8 fresh`).
- **Rationale**: Gives real-time visibility into the egress route, latency, and quota pool health directly in the footer without requiring manual command execution.
### Decision 8: Single Shared Active Route per Provider
- **Choice**: All traffic for a provider — the main agent and every concurrent subagent — egresses through one active node at a time. Rotation is a whole-session move triggered only by exhaustion of the current public IP, never a per-agent or per-connection spread.
- **Rationale**: The user requires one shared IP so quota is consumed predictably from a single bucket and only advances to the next node when that bucket is genuinely exhausted. Spreading concurrent agents across several IPs would instead partially consume many buckets at once, fragmenting the pool.
- **Mechanics**: The swappable-upstream bridge (Decision 1) makes this the natural default — every inbound connection resolves the provider's single current upstream, so concurrent subagents inherently share it, and one swap redirects all subsequent connections together.
- **Alternatives Considered**:
  - *Connection-level round-robin across nodes*: Rejected — it would give concurrent subagents different IPs, contradicting the shared-IP requirement.
  - *Per-subagent env leases*: Rejected — `PI_PROXY_*` is process-global, so concurrent writes race and cross-contaminate routes.

## Risks / Trade-offs

- **[Risk]** Tailscale exit node goes offline mid-session.
  - **Mitigation**: Health checks detect connection failures, immediately mark the node as temporarily unavailable, and fall back to the next fastest node.
- **[Risk]** Public IP resolution service (ipify) is slow or unreachable.
  - **Mitigation**: Fall back to secondary IP resolvers (`icanhazip.com`, `ifconfig.me`) with a strict 3-second timeout; retain last known IP on total probe failure.
- **[Risk]** Local port collision on SOCKS5 port (1085).
  - **Mitigation**: Probe port availability before binding; dynamically select an available ephemeral port if 1085 is occupied.

## Migration Plan

1. Scaffold extension in `agent/extensions/tailscale-router`.
2. Implement core modules: `discovery.ts`, `exhaustion.ts`, `tunnel.ts`, `router.ts`.
3. Wire OMP hooks (`session_start`, `before_provider_request`, `session_shutdown`) and `/tailscale` commands.
4. Add comprehensive unit tests covering latency ranking, IP resolution, exhaustion partitioning, and failover.
5. Register plugin via `omp plugin link`.
