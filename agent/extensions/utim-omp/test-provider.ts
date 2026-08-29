import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import type {
	Api,
	AssistantMessageEvent,
	Context,
	Model,
} from "@oh-my-pi/pi-ai";
import utimProvider from "./index";

const completionsLines = [
	'{"type":"content_delta","text":"Hello"}',
	'{"type":"content_delta","text":" world"}',
	'{"type":"done","content":"Hello world","usage":{"input_tokens":12,"output_tokens":3}}',
];
const quotaJson = JSON.stringify({
	plan: "free",
	credits_used: 50,
	credits_limit: 3000,
	requests_used: 10,
	requests_limit: 100,
	free_bonus_balance: 0,
	free_bonus_limit: 0,
	five_hour_quota_exhausted: false,
	five_hour_reset_at: null,
	reset_at: "2026-09-01T00:00:00Z",
});
const catalogJson = JSON.stringify({
	openrouter: [
		{ model_id: "foo/bar:free", name: "Foo Bar", context_window: 16000, capabilities: ["text", "reasoning"] },
		{ model_id: "foo/baz", name: "Baz", context_window: 8000 },
		{ model_id: "x/y:free", name: "X Y", context_window: 24000, capabilities: ["text", "image"] },
	],
});

function streamBody(lines: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const l of lines) controller.enqueue(enc.encode(l + "\n"));
			controller.close();
		},
	});
}

const mockFetch: typeof fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
	const url = String(input);
	if (url.includes("/completions")) {
		return new Response(streamBody(completionsLines), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	if (url.includes("/quota")) return new Response(quotaJson, { status: 200 });
	if (url.includes("/models/catalog")) return new Response(catalogJson, { status: 200 });
	return new Response("{}", { status: 200 });
};

globalThis.fetch = mockFetch;

const captured: Record<string, ProviderConfig> = {};
const pi = {
	setLabel() {},
	registerProvider(_id: string, cfg: ProviderConfig) {
		captured[_id] = cfg;
	},
} as unknown as ExtensionAPI;

let failures = 0;
function assert(cond: boolean, msg: string): void {
	if (!cond) {
		failures++;
		console.error("  FAIL: " + msg);
	} else {
		console.log("  ok:   " + msg);
	}
}

function textOf(events: AssistantMessageEvent[]): string {
	const done = events.find((e) => e.type === "done");
	if (!done || done.type !== "done") return "";
	return done.message.content
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("");
}

async function main(): Promise<void> {
	utimProvider(pi);
	const cfg = captured["utim"];
	assert(!!cfg, "provider 'utim' registered");
	assert(typeof cfg.streamSimple === "function", "streamSimple registered");
	assert(typeof cfg.fetchDynamicModels === "function", "fetchDynamicModels registered");
	const usageProvider = (cfg as unknown as { usage?: { fetchUsage: (p: unknown, ctx: unknown) => Promise<unknown> } }).usage;
	assert(typeof usageProvider?.fetchUsage === "function", "usage.fetchUsage registered");

	// --- models ---
	const fetchModels = cfg.fetchDynamicModels as ((apiKey?: string) => Promise<ProviderModelConfig[]>) | undefined;
	const models = await fetchModels!();
	assert(Array.isArray(models) && models.length === 2, `fetchDynamicModels returns only :free models (got ${Array.isArray(models) ? models.length : 0})`);
	assert(models.every((m: ProviderModelConfig) => m.id.endsWith(":free")), "every returned model id ends with :free");
	assert(models.some((m: ProviderModelConfig) => m.reasoning === true), "reasoning capability mapped");
	assert(
		models.some((m: ProviderModelConfig) => JSON.stringify(m.input) === JSON.stringify(["text", "image"])),
		"image capability mapped to input",
	);

	// --- streaming ---
	const model = { id: "poolside/laguna-s-2.1:free", api: "utim", provider: "utim", name: "Laguna", maxTokens: 8192 } as unknown as Model<Api>;
	const context = { messages: [{ role: "user", content: "hi" }], systemPrompt: "be brief" } as unknown as Context;
	const stream = cfg.streamSimple!(model, context, { apiKey: "k" });
	const events: AssistantMessageEvent[] = [];
	for await (const ev of stream) events.push(ev);

	const starts = events.filter((e) => e.type === "start");
	const deltas = events.filter((e) => e.type === "text_delta");
	const dones = events.filter((e) => e.type === "done");
	assert(starts.length === 1, "exactly one start event");
	assert(deltas.length === 2, `two text_delta events (got ${deltas.length})`);
	if (deltas.length >= 2) {
		assert(deltas[0].type === "text_delta" && deltas[0].delta === "Hello" && deltas[1].delta === " world", "deltas carry incremental text");
	}
	assert(dones.length === 1, "exactly one done event");
	if (dones.length === 1 && dones[0].type === "done") {
		assert(dones[0].reason === "stop", "done reason is stop");
		assert(dones[0].message.model === "poolside/laguna-s-2.1:free", "done message has model id");
		const full = textOf(events);
		assert(full === "Hello world", `assembled text is 'Hello world' (got '${full}')`);
		assert(dones[0].message.usage.input === 12 && dones[0].message.usage.output === 3, "usage mapped from input_tokens/output_tokens");
	}

	// --- usage (omp-native UsageProvider) ---
	const report = (await usageProvider!.fetchUsage!(
		{ provider: "utim", credential: { type: "oauth", accessToken: "k", email: "test@utim.dev" } },
		{ fetch: globalThis.fetch },
	)) as {
		provider?: string;
		limits?: Array<{ id: string; label: string; amount: { used?: number; limit?: number; unit?: string }; status?: string; window?: { id: string; label: string; durationMs?: number; resetsAt?: number } }>;
		metadata?: { plan?: string; email?: string };
	};
	assert(report.provider === "utim", "usage report provider = utim");
	assert(report.metadata?.plan === "free", "usage report plan = free");
	assert(report.metadata?.email === "test@utim.dev", "usage report carries account email");
	assert(Array.isArray(report.limits) && report.limits.length === 3, `three usage limits (credits, requests, 5h) (got ${Array.isArray(report.limits) ? report.limits.length : 0})`);
	const credits = report.limits?.find((l) => l.id === "credits");
	assert(!!credits && credits.amount.used === 50 && credits.amount.limit === 3000 && credits.amount.unit === "tokens", "credits limit maps credits_used/limit as tokens");
	const requests = report.limits?.find((l) => l.id === "requests");
	assert(!!requests && requests.amount.used === 10 && requests.amount.limit === 100 && requests.amount.unit === "requests", "requests limit maps requests_used/limit as requests");
	const fiveHour = report.limits?.find((l) => l.id === "five_hour");
	assert(!!fiveHour, "5-hour quota limit present");
	assert(!!fiveHour && fiveHour.amount.used === 0 && fiveHour.amount.limit === 1 && fiveHour.amount.unit === "requests", "5h quota amount maps to not-exhausted");
	assert(!!fiveHour && fiveHour.status === "ok", "5h quota status ok when not exhausted");
	assert(!!fiveHour && fiveHour.window?.id === "5h", "5h quota window id = 5h");

	// --- streaming: content delivered only in done.content (no content_delta) ---
	const doneOnlyLines = [
		'{"type":"queue_status","status":"processing","position":0,"message":"..."}',
		'{"type":"done","content":"final answer","usage":{"input_tokens":5,"output_tokens":2}}',
	];
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		body: streamBody(doneOnlyLines),
		json: async () => ({}),
		text: async () => "",
	})) as unknown as typeof fetch;
	const stream2 = cfg.streamSimple!(model, context, { apiKey: "k" });
	const events2: AssistantMessageEvent[] = [];
	for await (const ev of stream2) events2.push(ev);
	const dones2 = events2.filter((e) => e.type === "done");
	assert(dones2.length === 1, "done-only: exactly one done event");
	if (dones2.length === 1 && dones2[0].type === "done") {
		const c = dones2[0].message.content;
		const first = c[0];
		assert(c.length === 1 && first.type === "text" && first.text === "final answer", "done-only: text taken from done.content");
		assert(dones2[0].message.usage.output === 2, "done-only: usage mapped from done.usage");
	}
	globalThis.fetch = mockFetch;
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("THREW:", e);
	process.exit(1);
});
