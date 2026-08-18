import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ExhaustionEntry {
  /** Epoch millis when the rate limit was observed. */
  exhaustedAt: number;
  /** Epoch millis when the IP becomes eligible again. */
  expiresAt: number;
  /** Where the window came from, for display and debugging. */
  source: "retry-after" | "ratelimit-reset" | "default";
}

/** Persisted shape: provider -> public IP -> cooldown entry. */
export type ExhaustionState = Record<string, Record<string, ExhaustionEntry>>;

/**
 * A 429's cooldown window, derived from provider headers when they are
 * trustworthy. `source` explains which header won so `/tailscale status` can
 * show whether a wait is provider-declared or a local guess.
 */
export interface CooldownWindow {
  durationMs: number;
  source: ExhaustionEntry["source"];
}

/** Guard against a malformed header pinning an IP out for an absurd duration. */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Providers reset on window boundaries; a small pad avoids retrying a tick early. */
const COOLDOWN_SAFETY_BUFFER_MS = 5_000;

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  // Header records reach extensions with provider-dependent casing.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/**
 * Derive how long to sideline an IP after a 429.
 *
 * Honors `retry-after` (delta-seconds or HTTP-date) and the `*-ratelimit-reset`
 * family (delta-seconds or absolute epoch seconds), falling back to the
 * configured default when nothing parses. Using the provider's own number
 * releases an IP the moment its window actually lapses instead of holding it
 * for a conservative hour.
 */
export function parseCooldown(
  headers: Record<string, string>,
  defaultMinutes: number,
  now: number = Date.now(),
): CooldownWindow {
  const fallback: CooldownWindow = { durationMs: defaultMinutes * 60_000, source: "default" };

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && seconds > 0) {
      return { durationMs: Math.min(seconds * 1000 + COOLDOWN_SAFETY_BUFFER_MS, MAX_COOLDOWN_MS), source: "retry-after" };
    }
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate) && asDate > now) {
      return { durationMs: Math.min(asDate - now + COOLDOWN_SAFETY_BUFFER_MS, MAX_COOLDOWN_MS), source: "retry-after" };
    }
  }

  for (const name of ["x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset"]) {
    const raw = headerValue(headers, name);
    if (raw === undefined) continue;
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    // Values above ~1e9 are epoch seconds; smaller ones are a relative delta.
    const durationMs = value > 1_000_000_000 ? value * 1000 - now : value * 1000;
    if (durationMs <= 0) continue;
    return { durationMs: Math.min(durationMs + COOLDOWN_SAFETY_BUFFER_MS, MAX_COOLDOWN_MS), source: "ratelimit-reset" };
  }

  return fallback;
}

/**
 * Per-provider, per-IP rate-limit memory persisted across sessions.
 *
 * Partitioning by provider is the whole point: a 429 from one gateway says
 * nothing about another gateway's quota, so an IP sidelined for
 * `opencode-zen` must stay usable for every other provider. Persisting it
 * means a restarted session does not immediately re-hit a still-limited IP.
 */
export class ExhaustionStore {
  #path: string;
  #state: ExhaustionState = {};
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  static defaultPath(): string {
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    return join(base, "omp", "tailscale-router", "exhaustion.json");
  }

  get path(): string {
    return this.#path;
  }

  /** Load persisted state. A missing or corrupt file starts empty. */
  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      this.#state = this.#coerce(parsed);
    } catch {
      this.#state = {};
    }
  }

  #coerce(parsed: unknown): ExhaustionState {
    if (typeof parsed !== "object" || parsed === null) return {};
    const state: ExhaustionState = {};
    for (const [provider, byIp] of Object.entries(parsed)) {
      if (typeof byIp !== "object" || byIp === null) continue;
      const entries: Record<string, ExhaustionEntry> = {};
      for (const [ip, entry] of Object.entries(byIp)) {
        if (typeof entry !== "object" || entry === null) continue;
        if (!("expiresAt" in entry) || !("exhaustedAt" in entry)) continue;
        const expiresAt = Number(entry.expiresAt);
        const exhaustedAt = Number(entry.exhaustedAt);
        if (!Number.isFinite(expiresAt) || !Number.isFinite(exhaustedAt)) continue;
        const rawSource = "source" in entry ? entry.source : undefined;
        const source: ExhaustionEntry["source"] =
          rawSource === "retry-after" || rawSource === "ratelimit-reset" ? rawSource : "default";
        entries[ip] = { exhaustedAt, expiresAt, source };
      }
      if (Object.keys(entries).length > 0) state[provider] = entries;
    }
    return state;
  }

  /** Record a rate limit for one provider/IP pair and persist it. */
  markExhausted(provider: string, publicIp: string, window: CooldownWindow, now: number = Date.now()): ExhaustionEntry {
    const entry: ExhaustionEntry = {
      exhaustedAt: now,
      expiresAt: now + window.durationMs,
      source: window.source,
    };
    const byIp = this.#state[provider] ?? {};
    byIp[publicIp] = entry;
    this.#state[provider] = byIp;
    this.#persist();
    return entry;
  }

  /**
   * Remaining cooldown in millis, or 0 when eligible. Expired entries are
   * dropped on read so the pool self-heals without a sweep timer.
   */
  remainingMs(provider: string, publicIp: string, now: number = Date.now()): number {
    const entry = this.#state[provider]?.[publicIp];
    if (entry === undefined) return 0;
    if (entry.expiresAt <= now) {
      delete this.#state[provider]?.[publicIp];
      this.#persist();
      return 0;
    }
    return entry.expiresAt - now;
  }

  /** Cooldown entries still in force for a provider, keyed by public IP. */
  activeFor(provider: string, now: number = Date.now()): Record<string, ExhaustionEntry> {
    const byIp = this.#state[provider];
    if (byIp === undefined) return {};
    const active: Record<string, ExhaustionEntry> = {};
    for (const [ip, entry] of Object.entries(byIp)) {
      if (entry.expiresAt > now) active[ip] = entry;
    }
    return active;
  }

  /** Forget every cooldown, treating all IPs as fresh. */
  reset(): void {
    this.#state = {};
    this.#persist();
  }

  /** Flush pending writes; used on shutdown and by tests. */
  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  /**
   * Serialize writes and swap the file in atomically. Two sessions can rotate
   * at once, and a torn file would silently drop every cooldown; the unique
   * temp name plus rename keeps readers on a complete document.
   */
  #persist(): void {
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#writeQueue = this.#writeQueue.then(async () => {
      const temporary = `${this.#path}.${process.pid}.${Date.now().toString(36)}.tmp`;
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        await writeFile(temporary, `${snapshot}\n`, "utf8");
        await rename(temporary, this.#path);
      } catch {
        // Losing cooldown memory degrades routing but must never break a turn.
      }
    });
  }
}
