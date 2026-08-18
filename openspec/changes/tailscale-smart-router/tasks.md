## 1. Extension Scaffold & Configuration

- [x] 1.1 Scaffold `agent/extensions/tailscale-router` package with `package.json` and `tsconfig.json`
- [x] 1.2 Define configuration schema and defaults for provider strategies (`auto-rotate`, `pinned`, `direct`) in `src/config.ts`

## 2. Discovery, Latency Probing & Public IP Resolution

- [x] 2.1 Implement Tailscale CLI runner and status parser for exit node enumeration in `src/discovery.ts`
- [x] 2.2 Implement TCP latency prober with sorting from lowest to highest RTT
- [x] 2.3 Implement external public IP resolver with fallback services (`ipify`, `icanhazip`) and 5-minute background refresher

## 3. Per-Provider Exhaustion Storage & Cooldown Management

- [x] 3.1 Implement persistent atomic JSON storage in `src/exhaustion.ts` targeting `~/.local/share/omp/tailscale-router/exhaustion.json`
- [x] 3.2 Implement per-provider and per-IP cooldown expiration math and state updates
- [x] 3.3 Implement memory reset and provider-specific bypass verification
- [x] 3.4 Implement exact header-driven cooldown parser for `retry-after`, `x-ratelimit-reset`, and Cloudflare rate-limit headers

## 4. SOCKS5 Tunneling & Multi-Route Dispatcher

- [x] 4.1 Implement local SOCKS5 tunnel manager in `src/tunnel.ts` supporting dynamic port binding and SSH child process lifecycle
- [x] 4.2 Implement route selector in `src/router.ts` supporting `auto-rotate` (lowest latency non-exhausted IP), `pinned`, and `direct` policies
- [x] 4.3 Implement in-process HTTP CONNECT bridge fronting each SOCKS5 tunnel (Bun `fetch` rejects `socks5://`)
- [x] 4.4 Publish one stable `PI_PROXY_<PROVIDER>` bridge port per routed provider and rotate by swapping the bridge upstream (no env churn)
- [x] 4.5 Enforce a single shared active upstream per provider so concurrent subagents reuse the same egress IP

## 5. OMP Lifecycle, 429 Failover & Slash Commands

- [x] 5.1 Wire extension entry point in `src/tailscale-router.ts` subscribing to `session_start`, `session_shutdown`, and request interceptors
- [x] 5.2 Implement automatic 429 rate-limit interception, IP exhaustion marking, and in-flight node failover
- [x] 5.3 Register `/tailscale` slash commands (`status`, `rotate`, `switch`, `pin`, `reset`)
- [x] 5.4 Implement live status line HUD badge renderer and route-change listener

## 6. Automated Testing & Verification

- [x] 6.1 Create test suite in `tests/tailscale-router.test.ts` verifying discovery, latency sorting, public IP caching, and exhaustion partitioning
- [x] 6.2 Test per-provider isolation (confirming 429 on OpenCode Zen leaves FreeTheAI eligible on the same IP)
- [x] 6.3 Test 429 automatic rotation and graceful direct network fallback
- [x] 6.4 Test header-driven cooldown calculation and HUD status formatting

## 7. Plugin Registration & Live Smoke Test

- [x] 7.1 Link plugin with `omp plugin link ./agent/extensions/tailscale-router`
- [x] 7.2 Verify `/tailscale status` and model routing in a live OMP session
