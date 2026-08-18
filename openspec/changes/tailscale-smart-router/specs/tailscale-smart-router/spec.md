## Purpose

Provides latency-prioritized, per-provider proxy routing through local and Tailscale exit nodes with dynamic public IP resolution, per-provider exhaustion cooldown memory, and seamless 429 rate-limit auto-rotation for OMP model requests.

## ADDED Requirements

### Requirement: Dynamic Node Discovery and Latency Ranking
The system SHALL discover all online Tailscale nodes and the local direct interface, periodically measuring TCP latency and sorting available routes from lowest to highest latency.

#### Scenario: Background node discovery and ranking
- **WHEN** the session starts or the 5-minute background timer fires
- **THEN** the router probes online Tailscale exit nodes, measures latency to each, and updates the ranked route table without blocking user operations

### Requirement: Public Egress IP Resolution
The system SHALL resolve the actual external public IP address associated with each route candidate, detecting changes in dynamic residential/hotspot IPs while preserving static IPs.

#### Scenario: Dynamic IP detection
- **WHEN** a background probe executes through a route candidate
- **THEN** the router queries an external IP service (e.g. ipify) through that specific route and records its real public IP address in the routing table

### Requirement: Per-Provider and Per-IP Exhaustion Tracking
The system SHALL track rate limit exhaustion independently per provider and per public IP, persisting cooldown states to disk across session restarts.

#### Scenario: Provider-specific rate limit recording
- **WHEN** an upstream provider returns a 429 rate limit error for an active route
- **THEN** the router marks that specific public IP as exhausted solely for that provider for a configurable cooldown period (default: 60 minutes) and leaves the IP eligible for other providers

#### Scenario: Cooldown expiration upon session resume
- **WHEN** a new session starts or the router evaluates candidates
- **THEN** previously exhausted IPs whose cooldown window has elapsed are automatically restored to the active pool

### Requirement: Granular Provider Routing Strategy
The system SHALL enforce user-configured routing policies per provider, supporting `auto-rotate` (lowest latency non-exhausted IP), `pinned` (fixed node binding), and `direct` (bypass proxy).

#### Scenario: Auto-rotation for free providers
- **WHEN** a model request targets a provider configured with `auto-rotate` (e.g. `opencode-zen`)
- **THEN** the router dispatches the request through the lowest-latency route whose public IP is not currently exhausted for that provider

#### Scenario: Pinned routing for designated providers
- **WHEN** a model request targets a provider configured with `pinned` (e.g. `freetheai` pinned to `coolify`)
- **THEN** the router dispatches the request strictly through the designated node regardless of other rotation states

#### Scenario: Direct routing for standard providers
- **WHEN** a model request targets an unrouted or `direct` provider (e.g. `anthropic` or `google`)
- **THEN** the router bypasses local proxies and sends traffic directly through the workstation's default network

### Requirement: Seamless 429 Failover and Retry
The system SHALL automatically fail over and retry an active turn when a rotatable provider hits a 429 rate limit.

#### Scenario: In-flight 429 recovery
- **WHEN** a model request receives an HTTP 429 rate limit response from an auto-rotating provider
- **THEN** the router flags the current IP as exhausted for that provider, selects the next fastest eligible node, establishes the tunnel, and re-executes the turn without manual user intervention

### Requirement: Interactive Slash Commands
The system SHALL provide interactive `/tailscale` commands for inspecting routing status, pinning providers, triggering rotations, and resetting exhaustion state.

#### Scenario: Inspecting routing table status
- **WHEN** the user executes `/tailscale status`
- **THEN** the system displays a table of discovered nodes, active public IPs, measured latencies, provider pin bindings, and cooldown timers

#### Scenario: Manually rotating routes
- **WHEN** the user executes `/tailscale rotate`
- **THEN** the router switches the active route to the next best non-exhausted node and reports the updated public IP

#### Scenario: Clearing exhaustion memory
- **WHEN** the user executes `/tailscale reset`
- **THEN** the router wipes the persistent exhaustion state and immediately marks all available IPs as fresh

### Requirement: Non-Disruptive Process Lifecycle
The system SHALL operate entirely within the OMP session lifecycle, ensuring zero modification to the host operating system's global routing table and zero orphaned background processes upon session shutdown.

#### Scenario: Clean shutdown
- **WHEN** the OMP session shuts down
- **THEN** all local tunnels, sockets, and background polling timers are immediately closed and terminated
### Requirement: Exact Header-Driven Cooldown Scheduling
The system SHALL parse upstream HTTP 429 response headers (such as `retry-after` in seconds or date formats, `x-ratelimit-reset`, and Cloudflare rate-limit headers) to set exact cooldown timestamps rather than relying solely on fixed estimates.

#### Scenario: Header-derived cooldown calculation
- **WHEN** an upstream provider returns a 429 response carrying a valid `retry-after` or `x-ratelimit-reset` header
- **THEN** the router sets the exhaustion duration matching the exact duration parsed from the header (with a 5-second safety buffer), falling back to the configured default only when headers are absent or unparseable

### Requirement: Live Status Line HUD Badge
The system SHALL render a live status line badge in OMP indicating the active route node, measured latency, and fresh/exhausted IP pool metrics.

#### Scenario: Status line update on route change
- **WHEN** the active route changes or a background probe refreshes node health
- **THEN** the router updates OMP's status line with the active node label, latency in milliseconds, and the ratio of fresh-to-total public IPs (e.g. `󰖩 ts: coolify · 24ms · 7/8`)

### Requirement: Single Shared Active Route
The system SHALL route all traffic for a given provider — the main agent and every concurrent subagent — through one shared active egress node, advancing to another node only when the current public IP becomes exhausted.

#### Scenario: Concurrent agents share one egress IP
- **WHEN** the main agent and one or more subagents issue requests concurrently to the same provider
- **THEN** every request egresses through the same active node and reports the same public IP

#### Scenario: Whole-session advance on exhaustion
- **WHEN** the active public IP becomes exhausted for that provider
- **THEN** the router advances all subsequent traffic for that provider — main agent and subagents alike — to the next eligible node together
