import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AuthDependencies,
  ClineAuthHandler,
  ClineAuthLoginInput,
  ClineAuthRefreshInput,
  ClineOAuthCredentials,
} from "./oauth.js";

const HELPER_PATH = fileURLToPath(
  new URL("./cline-auth-helper.mjs", import.meta.url),
);

type HelperMessage =
  | { type: "auth"; info: { url: string; instructions?: string } }
  | { type: "progress"; message: string }
  | { type: "prompt"; prompt: { message: string; defaultValue?: string } }
  | { type: "result"; credentials: ClineOAuthCredentials | null };

async function runHelper(
  command: "login" | "refresh",
  loginInput?: ClineAuthLoginInput,
  refreshInput?: ClineAuthRefreshInput,
): Promise<ClineOAuthCredentials | null> {
  const child = spawn("node", [HELPER_PATH, command], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();

  if (refreshInput) {
    child.stdin.write(
      `${JSON.stringify({ type: "refresh", input: refreshInput })}\n`,
    );
  }

  const { promise, resolve, reject } =
    Promise.withResolvers<ClineOAuthCredentials | null>();
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };

  let buffer = "";
  child.on("error", fail);
  child.on("exit", (code) => {
    if (!settled && code !== 0) {
      fail(
        new Error(
          `Official Cline auth helper exited with code ${code ?? "unknown"}`,
        ),
      );
    } else if (!settled) {
      fail(new Error("Official Cline auth helper returned no credentials"));
    }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: HelperMessage;
      try {
        message = JSON.parse(line) as HelperMessage;
      } catch {
        fail(new Error("Official Cline auth helper returned invalid output"));
        child.kill();
        return;
      }

      if (message.type === "auth") {
        loginInput?.callbacks.onAuth(message.info);
      } else if (message.type === "progress") {
        loginInput?.callbacks.onProgress?.(message.message);
      } else if (message.type === "prompt") {
        void loginInput?.callbacks
          .onPrompt(message.prompt)
          .then((value) => {
            child.stdin.write(
              `${JSON.stringify({ type: "prompt-result", value })}\n`,
            );
          })
          .catch((error: unknown) => {
            fail(error instanceof Error ? error : new Error(String(error)));
            child.kill();
          });
      } else if (message.type === "result" && !settled) {
        settled = true;
        resolve(message.credentials);
      }
    }
  });

  return promise;
}

const bridgeHandler: ClineAuthHandler = {
  providerId: "cline",
  storageProviderId: "cline",
  getApiKey: () => undefined,
  login: async (input) => {
    const credentials = await runHelper("login", input);
    if (!credentials) throw new Error("Cline login returned no credentials");
    return credentials;
  },
  refresh: (input) => runHelper("refresh", undefined, input),
  saveCredentials: () => {
    throw new Error("Credential persistence belongs to OMP");
  },
  isConfigured: () => false,
  normalizeStoredAccessToken: (accessToken) =>
    accessToken.replace(/^workos:/i, ""),
};

export async function createOfficialClineAuthDependencies(): Promise<AuthDependencies> {
  return {
    resolveHandler: (providerId) =>
      providerId === "cline" ? bridgeHandler : undefined,
    formatApiKey: (_providerId, credentials) => {
      const access = credentials.access.replace(/^workos:/i, "");
      return access ? `workos:${access}` : "";
    },
  };
}
