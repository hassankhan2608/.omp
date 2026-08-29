import utimProvider from "./index";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { UsageProvider } from "@oh-my-pi/pi-ai";

// Capture the provider config exactly as omp would, without executing any omp runtime.
const captured: Record<string, ProviderConfig> = {};
const pi = {
	setLabel() {},
	registerProvider(_id: string, cfg: ProviderConfig) {
		captured[_id] = cfg;
	},
} as unknown as ExtensionAPI;

utimProvider(pi);

const utimCfg = captured["utim"] as unknown as { usage?: UsageProvider };
const maybeUsage = utimCfg.usage;
if (!maybeUsage || typeof maybeUsage.fetchUsage !== "function") {
	console.error("usage.fetchUsage not registered");
	process.exit(1);
}
const usage = maybeUsage.fetchUsage;

const raw = readFileSync(process.env.HOME + "/.utim/config.json", "utf8");
const cfg = JSON.parse(raw) as { api_key?: unknown };
const token = typeof cfg.api_key === "string" ? cfg.api_key : "";
if (!token) {
	console.error("no api_key in ~/.utim/config.json");
	process.exit(1);
}

const report = await usage(
	{ provider: "utim", credential: { type: "oauth", accessToken: token } } as unknown as Parameters<typeof usage>[0],
	{ fetch: globalThis.fetch } as unknown as Parameters<typeof usage>[1],
);

if (!report) {
	console.error("fetchUsage returned null (token invalid or endpoint failed)");
	process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
