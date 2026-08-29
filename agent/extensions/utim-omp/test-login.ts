import ext from "./index.ts";

const SERVER = (process.env.UTIM_SERVER_URL ?? "https://api.utim.dev").replace(/\/+$/, "");

let registeredName = "";
const captured: { name: string; config: unknown } = { name: "", config: undefined as unknown };

const pi = {
	setLabel: (_l: string) => {},
	registerProvider: (name: string, config: unknown) => {
		registeredName = name;
		captured.config = config;
	},
} as unknown as Parameters<typeof ext>[0];

function makeFetch(kind: "ok" | "expired" | "denied" | "badrequest") {
	return async (input: string | URL | Request) => {
		const url = String(input);
		const path = url.replace(SERVER, "");
		let body = "";
		if (path.endsWith("/auth/device/request")) {
			if (kind === "badrequest") body = JSON.stringify({ error: "nope" });
			else body = JSON.stringify({ device_code: "dc123", user_code: "ABCD-EFGH", verify_url: "https://utim.dev/activate?code=XYZ", expires_in: 600, interval: 0 });
		} else if (path.includes("/auth/device/poll")) {
			if (kind === "expired") body = JSON.stringify({ status: "expired" });
			else if (kind === "denied") body = JSON.stringify({ status: "denied", error: "user denied" });
			else body = JSON.stringify({ status: "authorized", api_key: "utim-testkey-123", email: "a@b.com" });
		}
		return { text: async () => body } as Response;
	};
}

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error("FAIL: " + msg);
		process.exit(1);
	}
	console.log("ok: " + msg);
}

async function run() {
	ext(pi);
	assert(registeredName === "utim", "provider registered as 'utim'");
	const cfg = captured.config as { oauth: { name: string; login: (c: unknown) => Promise<unknown>; getApiKey: (c: { access: string }) => string } };
	assert(cfg.oauth.name === "UTIM (free models)", "oauth name set");

	// happy path
	const onAuthCalls: string[] = [];
	const creds = (await cfg.oauth.login({
		onAuth: (info: { url: string }) => onAuthCalls.push(info.url),
		onProgress: () => {},
		onPrompt: async () => "",
		signal: undefined,
		fetch: makeFetch("ok") as unknown as (i: string | URL | Request, init?: RequestInit) => Promise<Response>,
	})) as { refresh: string; access: string; expires: number; email?: string; accountId?: string; orgId?: string };
	assert(onAuthCalls.length === 1 && onAuthCalls[0].includes("utim.dev/activate"), "onAuth surfaced verify URL");
	assert(creds.access === "utim-testkey-123", "api_key returned as access");
	assert(creds.refresh === "utim-testkey-123", "api_key returned as refresh");
	assert(creds.email === "a@b.com", "email captured");
	assert(creds.accountId === "a@b.com", "accountId distinguishes account");
	assert(typeof creds.expires === "number" && creds.expires > Date.now(), "expires is future-dated");
	assert(cfg.oauth.getApiKey(creds) === "utim-testkey-123", "getApiKey returns access token");

	// expired path
	let threw = false;
	try {
		await cfg.oauth.login({
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async () => "",
			signal: undefined,
			fetch: makeFetch("expired") as unknown as (i: string | URL | Request, init?: RequestInit) => Promise<Response>,
		});
	} catch {
		threw = true;
	}
	assert(threw, "expired device code throws");

	// denied path
	threw = false;
	try {
		await cfg.oauth.login({
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async () => "",
			signal: undefined,
			fetch: makeFetch("denied") as unknown as (i: string | URL | Request, init?: RequestInit) => Promise<Response>,
		});
	} catch {
		threw = true;
	}
	assert(threw, "denied device code throws");

	// bad request (no device_code) path
	threw = false;
	try {
		await cfg.oauth.login({
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async () => "",
			signal: undefined,
			fetch: makeFetch("badrequest") as unknown as (i: string | URL | Request, init?: RequestInit) => Promise<Response>,
		});
	} catch {
		threw = true;
	}
	assert(threw, "failed device request start throws");

	console.log("\nALL AUTH-FLOW CHECKS PASSED");
}

run().catch((e) => {
	console.error("ERROR:", e);
	process.exit(1);
});
