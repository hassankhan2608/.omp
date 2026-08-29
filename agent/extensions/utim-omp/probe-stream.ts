import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.utim/config.json`, "utf8")) as { api_key: string };
const token = cfg.api_key;
const model = "nvidia/nemotron-3-ultra-550b-a55b:free";

async function probe(headers: Record<string, string>, body: Record<string, unknown>) {
	console.log("\n=== headers:", JSON.stringify(headers), "body keys:", Object.keys(body).join(","));
	const res = await fetch("https://api.utim.dev/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	console.log("status:", res.status, res.statusText);
	if (!res.body) { console.log("NO BODY"); return; }
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let count = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			if (line) { console.log("LINE:", line); count++; }
			if (count > 40) { console.log("...truncated"); return; }
		}
	}
	console.log("total lines:", count);
}

// Reference Python CLI shape: model_id + X-API-Key
const messages = [{ role: "user", content: "Reply with exactly: pong" }];
await probe({ "X-API-Key": token }, { model_id: model, stream: true, messages });
await probe({ "X-API-Key": token }, { model_id: model, stream: true, messages, max_tokens: 64 });
// Current plugin shape: model + Bearer
await probe({ Authorization: `Bearer ${token}` }, { model, stream: true, messages, max_tokens: 64 });
