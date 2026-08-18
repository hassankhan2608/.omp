## Why

Free and anonymous AI model tiers (such as OpenCode Zen) enforce strict sliding-window rate limits based on the client's public egress IP address. Users with a Tailnet containing multiple exit nodes currently have no automated way to selectively route AI traffic through their exit nodes, track per-provider rate limit exhaustion, prioritize routes by lowest latency, or pin specific providers (e.g. FreeTheAI to Coolify) while keeping their regular workstation traffic on direct local internet.

## What Changes

- Add a native OMP extension `omp-tailscale-router` that manages process-isolated SOCKS5 tunnels to Tailscale exit nodes without modifying system-wide networking.
- Implement periodic 5-minute background discovery that measures TCP/ping latency and fetches the true external public IP for every online node and the local direct connection.
- Provide per-provider and per-IP exhaustion tracking persisted across OMP sessions so that an IP rate-limited on one provider (e.g. `opencode-zen`) automatically cools down without impacting other providers (e.g. `freetheai`).
- Support granular per-provider routing strategies: `auto-rotate` (lowest latency fresh IP first), `pinned` (e.g. `coolify`), and `direct` (bypasses proxy).
- Handle automatic 429 failover during active agent runs by marking the current public IP as exhausted and immediately retrying on the next lowest-latency node.
- Introduce interactive `/tailscale` slash commands (`/tailscale status`, `/tailscale rotate`, `/tailscale switch`, `/tailscale pin`, `/tailscale reset`).
- Parse upstream HTTP 429 response headers (`retry-after`, `x-ratelimit-reset`, Cloudflare rate limit headers) to dynamically set exact, provider-specified cooldown windows instead of relying solely on flat estimates.
- Render a live TUI HUD badge in the OMP status bar showing the active route node, latency (e.g. `24ms`), and fresh IP pool count (e.g. `6/8`).
- Share one active egress IP across the main agent and all concurrent subagents, advancing to the next node only when that IP is exhausted (no per-agent IP spreading).

## Capabilities

### New Capabilities
- `tailscale-smart-router`: Latency-prioritized, per-provider Tailscale proxy routing with dynamic public IP discovery, per-provider exhaustion cooldown memory, and seamless 429 auto-rotation.

### Modified Capabilities
*(None)*

## Impact

- **Extension**: New plugin directory `agent/extensions/tailscale-router` registered with OMP plugin manager.
- **Storage**: Persistent exhaustion state stored in `~/.local/share/omp/tailscale-router/exhaustion.json`.
- **System Footprint**: Zero root/sudo requirements, zero modification of Linux default gateway or routing tables, and zero dangling background daemons upon OMP shutdown.
