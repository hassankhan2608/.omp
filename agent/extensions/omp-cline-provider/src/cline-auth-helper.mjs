import { createInterface } from "node:readline";
import { getProviderAuthHandler } from "@cline/core";

const handler = getProviderAuthHandler("cline");
if (
  !handler ||
  handler.providerId !== "cline" ||
  handler.storageProviderId !== "cline"
) {
  throw new Error("Cline auth handler is unavailable");
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const receive = async () => {
  const next = await iterator.next();
  if (next.done) throw new Error("Cline auth helper input closed");
  return JSON.parse(next.value);
};

const command = process.argv[2];
if (command === "probe") {
  send({
    type: "result",
    providerId: handler.providerId,
    storageProviderId: handler.storageProviderId,
  });
} else if (command === "login") {
  const credentials = await handler.login({
    callbacks: {
      onAuth(info) {
        send({ type: "auth", info });
      },
      onProgress(message) {
        send({ type: "progress", message });
      },
      async onPrompt(prompt) {
        send({ type: "prompt", prompt });
        const response = await receive();
        if (
          response.type !== "prompt-result" ||
          typeof response.value !== "string"
        ) {
          throw new Error("Invalid Cline auth prompt response");
        }
        return response.value;
      },
    },
  });
  send({ type: "result", credentials });
} else if (command === "refresh") {
  const request = await receive();
  if (request.type !== "refresh") throw new Error("Invalid Cline refresh request");
  const credentials = await handler.refresh(request.input);
  send({ type: "result", credentials });
} else {
  throw new Error(`Unknown Cline auth helper command: ${command ?? ""}`);
}

lines.close();
