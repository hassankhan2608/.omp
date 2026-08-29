import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	Provider,
	SimpleStreamOptions,
	TextContent,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageScope,
	UsageUnit,
	UsageWindow,
} from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import * as PiAi from "@oh-my-pi/pi-ai";

/**
 * utim-omp — omp-native UTIM provider.
 *
 * Registers UTIM as a first-class omp provider so everything is native:
 *   /login utim     → device flow through omp's OAuth UI (stores credential)
 *   /logout         → omp lists + removes the stored UTIM credential
 *   omp models      → UTIM free models appear (registered via fetchDynamicModels)
 *   model select    → requests stream natively through utim's /completions
 *                     endpoint via streamSimple (custom content_delta/done protocol)
 *   omp usage       → UTIM quota shown via the omp-native UsageProvider
 *                     (ProviderConfig.usage, honored by omp 18.x).
 *
 * No utim CLI is spawned, no utim config is rewritten, no external deps:
 * only omp SDK type imports plus Bun/Node runtime globals.
 */

const SERVER = (process.env.UTIM_SERVER_URL ?? "https://api.utim.dev").replace(/\/+$/, "");
const UTIM_PROVIDER = "utim" as Provider;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
	headers?: Record<string, string>;
	body?: unknown;
	signal?: AbortSignal;
	fetchImpl?: FetchFn;
}

async function fetchJson<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
	const doFetch = opts.fetchImpl ?? fetch;
	const res = await doFetch(SERVER + path, {
		method,
		headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		signal: opts.signal,
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = JSON.parse(text);
	} catch {
		data = { _raw: text, _status: res.status };
	}
	return data as T;
}

type WithResolvers = {
	withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
};

// ── Model catalog ────────────────────────────────────────────────────────────

interface CatalogEntry {
	model_id?: string;
	name?: string;
	context_window?: number;
	capabilities?: unknown;
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
	{ id: "poolside/laguna-s-2.1:free", name: "Poolside Laguna S 2.1", api: "utim" as Api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 8192 },
	{ id: "cohere/north-mini-code:free", name: "Cohere North Mini Code", api: "utim" as Api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 8192 },
	{ id: "minimax/minimax-m3:free", name: "MiniMax M3", api: "utim" as Api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 40000, maxTokens: 8192 },
];

function capHas(caps: unknown, needle: string): boolean {
	return Array.isArray(caps) && caps.some((c) => typeof c === "string" && c.toLowerCase().includes(needle));
}

async function fetchUtimModels(_apiKey?: string | undefined): Promise<ProviderModelConfig[]> {
	try {
		const cat = await fetchJson<Record<string, CatalogEntry[]>>("GET", "/models/catalog");
		const models: ProviderModelConfig[] = [];
		for (const arr of Object.values(cat)) {
			for (const m of arr) {
				const id = typeof m.model_id === "string" ? m.model_id : "";
				if (!id.endsWith(":free")) continue;
				const cw = typeof m.context_window === "number" ? m.context_window : 32000;
				models.push({
					id,
					name: typeof m.name === "string" ? m.name : id,
					api: "utim" as Api,
					reasoning: capHas(m.capabilities, "reasoning"),
					input: capHas(m.capabilities, "image") ? ["text", "image"] : ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: cw,
					maxTokens: Math.min(cw, 8192),
				});
			}
		}
		if (models.length > 0) return models;
	} catch {
		// fall through to static fallback
	}
	return FALLBACK_MODELS;
}

// ── Usage (omp-native UsageProvider; omp 18.x reads ProviderConfig.usage) ─────

function num(v: unknown): number {
	return typeof v === "number" ? v : Number(v ?? 0);
}

const utimUsageProvider: UsageProvider = {
	id: UTIM_PROVIDER,
	fetchUsage: async (params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> => {
		const token = params.credential.accessToken;
		if (!token) return null;
		let q: Record<string, unknown>;
		try {
			const res = await ctx.fetch(SERVER + "/quota", {
				headers: { Authorization: `Bearer ${token}` },
				signal: params.signal,
			});
			if (!res.ok) {
				ctx.logger?.warn?.("UTIM usage fetch failed", { status: res.status });
				return null;
			}
			q = (await res.json()) as Record<string, unknown>;
		} catch (err) {
			ctx.logger?.warn?.("UTIM usage fetch error", { error: String(err) });
			return null;
		}
		const used = num(q["credits_used"]);
		const limit = num(q["credits_limit"]);
		const reqUsed = num(q["requests_used"]);
		const reqLimit = num(q["requests_limit"]);
		const bonus = num(q["free_bonus_balance"]);
		const bonusLimit = num(q["free_bonus_limit"]);
		const resetAt = typeof q["reset_at"] === "string" ? Date.parse(q["reset_at"] as string) : undefined;
		const window: UsageWindow | undefined = resetAt
			? { id: "monthly", label: "Monthly", durationMs: 30 * 24 * 3600 * 1000, resetsAt: resetAt }
			: undefined;
		const scope: UsageScope = { provider: UTIM_PROVIDER };
		const limits: UsageLimit[] = [
			{
				id: "credits",
				label: "Credits",
				scope,
				amount: { used, limit, unit: "tokens" as UsageUnit },
				...(window ? { window } : {}),
			},
			{
				id: "requests",
				label: "Requests",
				scope,
				amount: { used: reqUsed, limit: reqLimit, unit: "requests" as UsageUnit },
				...(window ? { window } : {}),
			},
		];
	if (bonusLimit > 0) {
		limits.push({
			id: "bonus",
			label: "Bonus credits",
			scope,
			amount: { used: bonus, limit: bonusLimit, unit: "tokens" as UsageUnit },
			...(window ? { window } : {}),
		});
	}
	// 5-hour rolling quota - separate short window; API exposes only an exhausted flag + reset time
	const fiveHourExhausted = q["five_hour_quota_exhausted"] === true;
	const fiveHourReset =
		typeof q["five_hour_reset_at"] === "string" ? Date.parse(q["five_hour_reset_at"] as string) : undefined;
	const fiveHourWindow: UsageWindow = {
		id: "5h",
		label: "5-Hour Rolling",
		durationMs: 5 * 3600 * 1000,
		...(fiveHourReset ? { resetsAt: fiveHourReset } : {}),
	};
	limits.push({
		id: "five_hour",
		label: "5-Hour Quota",
		scope,
		amount: { used: fiveHourExhausted ? 1 : 0, limit: 1, unit: "requests" as UsageUnit },
		window: fiveHourWindow,
		status: fiveHourExhausted ? "exhausted" : "ok",
	});
	return {
		provider: UTIM_PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			plan: q["plan"],
			endpoint: SERVER + "/quota",
			...(params.credential.email ? { email: params.credential.email } : {}),
			...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
		},
		raw: q,
	};
	},
	supports: (params: UsageFetchParams) => params.provider === UTIM_PROVIDER,
};

// ── Native streaming (utim content_delta / done protocol) ─────────────────────

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => {
				if (typeof p === "string") return p;
				if (p && typeof p === "object" && "text" in p) return String(p.text ?? "");
				return "";
			})
			.join("");
	}
	return "";
}

function normalizeMessages(context: Context): Array<{ role: string; content: string }> {
	const out: Array<{ role: string; content: string }> = [];
	for (const m of context.messages) {
		out.push({ role: m.role, content: messageText(m.content) });
	}
	return out;
}

function streamUtim(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	// pi-ai namespaces the event-stream class under a value export the published
	// .d.ts widens; reach it through the namespace object (typed locally).
	type PiAiNamespace = { AssistantMessageEventStream: new () => AssistantMessageEventStream };
	const piAiNs = PiAi as unknown as PiAiNamespace;
	const stream = new piAiNs.AssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("UTIM credentials not set. Run /login utim.");
			const sysText = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n") : context.systemPrompt ?? "";
			const messages = normalizeMessages(context);
			const modelCfg = model as Model<Api> & { maxTokens?: number };
			const maxTokens = typeof modelCfg.maxTokens === "number" ? modelCfg.maxTokens : 8192;
			const payload = {
				model: model.id,
				stream: true,
				max_tokens: options?.maxTokens ?? maxTokens,
				messages: sysText ? [{ role: "system", content: sysText }, ...messages] : messages,
			};
			const res = await fetch(SERVER + "/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(payload),
				signal: options?.signal,
			});
			if (!res.ok) {
				const bodyText = await res.text();
				throw new Error(`UTIM request failed: ${res.status} ${res.statusText} ${bodyText.slice(0, 200)}`);
			}
			const reader = res.body?.getReader();
			if (!reader) throw new Error("UTIM response had no body");
			const decoder = new TextDecoder();
			let buffer = "";
			let textIndex = -1;
			stream.push({ type: "start", partial: output });
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf("\n");
					if (!line) continue;
					let evt: unknown;
					try {
						evt = JSON.parse(line);
					} catch {
						continue;
					}
					const e = evt as {
						type?: string;
						text?: string;
						content?: string | null;
						error?: string | null;
						usage?: { input_tokens?: number; output_tokens?: number };
					};
					if (e.type === "content_delta" && typeof e.text === "string") {
						if (textIndex === -1) {
							textIndex = output.content.length;
							output.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
						}
						const block = output.content[textIndex] as TextContent;
						block.text += e.text;
						stream.push({ type: "text_delta", contentIndex: textIndex, delta: e.text, partial: output });
					} else if (e.type === "done") {
						if (e.usage) {
							output.usage.input = e.usage.input_tokens ?? 0;
							output.usage.output = e.usage.output_tokens ?? 0;
							output.usage.totalTokens = (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0);
						}
						// Some responses deliver the full text only in the done event
						// (no content_delta stream) - use it as the canonical text.
						if (typeof e.content === "string" && e.content.length > 0) {
							if (textIndex === -1) {
								textIndex = output.content.length;
								output.content.push({ type: "text", text: e.content });
								stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
								stream.push({ type: "text_delta", contentIndex: textIndex, delta: e.content, partial: output });
							} else {
								const block = output.content[textIndex] as TextContent;
								block.text = e.content;
							}
						}
						if (typeof e.error === "string" && e.error.length > 0) {
							output.stopReason = "error";
							output.errorMessage = e.error;
							stream.push({ type: "error", reason: "error", error: output });
						}
					}
				}
			}
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (err) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			try {
				stream.end();
			} catch {
				// already ended
			}
		}
	})();

	return stream;
}

// ── Device-flow login ──────────────────────────────────────────────────────────

interface DeviceRequest {
	device_code: string;
	user_code: string;
	verify_url: string;
	expires_in: number;
	interval?: number;
}

interface DevicePoll {
	status: "pending" | "authorized" | "expired" | "denied";
	api_key?: string;
	email?: string;
	error?: string;
}

async function deviceLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const req = await fetchJson<DeviceRequest>("POST", "/auth/device/request", { fetchImpl: callbacks.fetch });
	if (!req.device_code || !req.verify_url) {
		throw new Error("UTIM device flow failed to start: " + JSON.stringify(req));
	}
	callbacks.onAuth({
		url: req.verify_url,
		instructions: "Open this URL and enter code " + req.user_code + " to authorize UTIM.",
	});
	const intervalMs = Math.max((req.interval ?? 5) * 1000, 2000);
	const deadline = Date.now() + (req.expires_in ?? 600) * 1000;
	for (;;) {
		if (callbacks.signal?.aborted) throw new Error("UTIM login cancelled.");
		const pr = await fetchJson<DevicePoll>("GET", "/auth/device/poll?device_code=" + encodeURIComponent(req.device_code), {
			fetchImpl: callbacks.fetch,
			signal: callbacks.signal,
		});
		if (pr.status === "authorized") {
			const apiKey = pr.api_key;
			if (!apiKey) throw new Error("UTIM authorized but no api_key was returned.");
			const identity = pr.email ?? apiKey;
			return {
				refresh: apiKey,
				access: apiKey,
				expires: Date.now() + 10 * 365 * 24 * 3600 * 1000,
				email: pr.email,
				accountId: identity,
				orgId: identity,
			};
		}
		if (pr.status === "expired" || pr.status === "denied") {
			throw new Error("UTIM login " + pr.status + (pr.error ? ": " + pr.error : "."));
		}
		callbacks.onProgress?.(`Waiting for UTIM authorization (code ${req.user_code})…`);
		const promiseCtor = Promise as unknown as WithResolvers;
		const { promise, resolve } = promiseCtor.withResolvers<void>();
		const timer = setTimeout(resolve, intervalMs);
		try {
			await promise;
		} finally {
			clearTimeout(timer);
		}
	}
}

// ── Registration ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.setLabel("UTIM");

	pi.registerProvider("utim", {
		baseUrl: SERVER,
		api: "utim" as Api,
		fetchDynamicModels: fetchUtimModels,
		oauth: {
			name: "UTIM (free models)",
			login: deviceLogin,
			getApiKey: (creds) => creds.access,
		},
		// omp-native usage: 18.x reads ProviderConfig.usage (a UsageProvider) and
		// registers it via AuthStorage.setRuntimeUsageProvider, so `omp usage`
		// shows UTIM quota. 17.3.8's published ProviderConfig lacks `usage`; cast
		// because the running 18.x binary honors it.
		usage: utimUsageProvider,
		streamSimple: streamUtim,
	} as ProviderConfig);
}
