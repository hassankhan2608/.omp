import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";

/** How a provider's traffic is dispatched. */
export type RouteStrategy = "auto-rotate" | "pinned" | "direct";

const ProviderPolicySchema = type({
  strategy: "'auto-rotate'|'pinned'|'direct'",
  "node?": "string > 0",
  "cooldownMinutes?": "number > 0",
});

const RouterConfigSchema = type({
  "providers?": { "[string]": ProviderPolicySchema },
  "refreshIntervalMinutes?": "number > 0",
  "defaultCooldownMinutes?": "number > 0",
  "sshUsers?": "(string > 0)[]",
  "includeLocalRoute?": "boolean",
  "publicIpUrls?": "(string > 0)[]",
  "sshPort?": "number > 0",
  "probeTimeoutMs?": "number > 0",
});

export type ProviderPolicy = typeof ProviderPolicySchema.infer;
export type RouterConfig = Required<typeof RouterConfigSchema.infer>;

export const DIRECT_POLICY: ProviderPolicy = { strategy: "direct" };

export const DEFAULT_CONFIG: RouterConfig = {
  providers: {
    "opencode-zen": { strategy: "auto-rotate" },
    freetheai: { strategy: "pinned", node: "coolify" },
  },
  refreshIntervalMinutes: 5,
  defaultCooldownMinutes: 60,
  sshUsers: ["root", "ubuntu"],
  includeLocalRoute: true,
  publicIpUrls: ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"],
  sshPort: 22,
  probeTimeoutMs: 6_000,
};

/**
 * Validate a raw config object and merge it over {@link DEFAULT_CONFIG}.
 * Schema violations are returned verbatim rather than coerced, so a typo
 * surfaces to the user instead of silently routing traffic somewhere they
 * never asked for. A `pinned` policy without a node is rejected here because
 * the router has no defensible node to fall back to.
 */
export function parseConfig(raw: unknown): { config: RouterConfig; errors: string[] } {
  const parsed = RouterConfigSchema(raw);
  if (parsed instanceof type.errors) {
    return { config: DEFAULT_CONFIG, errors: parsed.map((issue) => issue.message) };
  }
  const errors: string[] = [];
  const providers = parsed.providers ?? DEFAULT_CONFIG.providers;
  for (const [provider, policy] of Object.entries(providers)) {
    if (policy.strategy === "pinned" && policy.node === undefined) {
      errors.push(`providers.${provider}.node is required when strategy is "pinned"`);
    }
  }
  if (errors.length > 0) return { config: DEFAULT_CONFIG, errors };
  return { config: { ...DEFAULT_CONFIG, ...parsed, providers }, errors };
}

/**
 * Load `tailscale-router.json` from the extension directory. A missing file is
 * the expected default state; malformed JSON is surfaced so the user can see
 * why their settings were ignored.
 */
export async function loadConfig(extensionDirectory: string): Promise<{ config: RouterConfig; errors: string[] }> {
  const path = join(extensionDirectory, "tailscale-router.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { config: DEFAULT_CONFIG, errors: [] };
    return { config: DEFAULT_CONFIG, errors: [`unable to read ${path}: ${String(error)}`] };
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    return { config: DEFAULT_CONFIG, errors: [`invalid JSON in ${path}: ${String(error)}`] };
  }
}

/**
 * pi-ai reads `PI_PROXY_<NORMALIZED>`, uppercasing the provider id and
 * replacing every non-alphanumeric character with `_`
 * (see pi-ai/src/utils/proxy.ts getProxyForProvider). Mirrored here so the
 * published variable name always matches what pi-ai will look up.
 */
export function proxyEnvKey(provider: string): string {
  return `PI_PROXY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
