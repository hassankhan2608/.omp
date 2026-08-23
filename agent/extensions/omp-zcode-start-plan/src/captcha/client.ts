import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export interface CaptchaSolveConfig {
  sceneId: string;
  region: string;
  prefix: string;
}

export interface BrokerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(): boolean;
}

interface BrokerRequest {
  id: number;
  appVersion: string;
  config: CaptchaSolveConfig;
}

interface BrokerResponse {
  id: number;
  ok: boolean;
  verifyParam?: string;
  error?: string;
}

interface PendingRequest {
  resolve: (verifyParam: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

interface ElectronCaptchaBrokerOptions {
  timeoutMs?: number;
  launch?: () => BrokerProcess;
}

export interface CaptchaBrokerSnapshot {
  running: boolean;
  pending: number;
  lastLatencyMs?: number;
  lastError?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export class ElectronCaptchaBroker {
  readonly #timeoutMs: number;
  readonly #launch: () => BrokerProcess;
  #process: BrokerProcess | null = null;
  #nextId = 1;
  #stdoutBuffer = "";
  #lastLatencyMs: number | undefined;
  #lastError: string | undefined;
  readonly #pending = new Map<number, PendingRequest>();

  constructor(options: ElectronCaptchaBrokerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#launch = options.launch ?? launchElectronBroker;
  }

  solve(config: CaptchaSolveConfig, appVersion: string): Promise<string> {
    const process = this.#ensureProcess();
    const id = this.#nextId++;
    const request: BrokerRequest = { id, appVersion, config };
    const result = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      const error = new Error(`Electron CAPTCHA solve timed out after ${this.#timeoutMs}ms`);
      this.#lastError = error.message;
      result.reject(error);
    }, this.#timeoutMs);
    this.#pending.set(id, { ...result, timer, startedAt: performance.now() });
    process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (!error) return;
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      this.#lastError = error.message;
      pending.reject(error);
    });
    return result.promise;
  }

  snapshot(): CaptchaBrokerSnapshot {
    return {
      running: this.#process !== null,
      pending: this.#pending.size,
      ...(this.#lastLatencyMs === undefined ? {} : { lastLatencyMs: this.#lastLatencyMs }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  close(): void {
    const process = this.#process;
    this.#process = null;
    if (process) {
      process.stdin.end();
      const forceKill = setTimeout(() => process.kill(), 1_000);
      forceKill.unref();
      process.on("exit", () => clearTimeout(forceKill));
    }
    this.#rejectAll(new Error("Electron CAPTCHA broker closed"));
  }

  #ensureProcess(): BrokerProcess {
    if (this.#process) return this.#process;
    const process = this.#launch();
    this.#process = process;
    process.stdout.on("data", (chunk) => this.#handleStdout(chunk.toString()));
    process.stderr.on("data", (chunk) => {
      if (globalThis.process.env.ZCODE_START_PLAN_DEBUG !== "1") return;
      const message = chunk.toString().trim();
      if (message) console.error(`[zcode-captcha] broker stderr (${message.length} chars)`);
    });
    process.on("error", (error) => this.#handleExit(`Electron CAPTCHA broker failed: ${error.message}`));
    process.on("exit", (code, signal) => {
      const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      this.#handleExit(`Electron CAPTCHA broker exited with ${detail}`);
    });
    return process;
  }

  #handleStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response: BrokerResponse;
      try {
        response = parseBrokerResponse(JSON.parse(line));
      } catch {
        this.#lastError = "Electron CAPTCHA broker returned an invalid response";
        continue;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(response.id);
      this.#lastLatencyMs = Math.round(performance.now() - pending.startedAt);
      if (response.ok && response.verifyParam) {
        this.#lastError = undefined;
        pending.resolve(response.verifyParam);
      } else {
        const error = new Error(response.error || "Electron CAPTCHA solve failed");
        this.#lastError = error.message;
        pending.reject(error);
      }
    }
  }

  #handleExit(message: string): void {
    this.#process = null;
    this.#stdoutBuffer = "";
    this.#lastError = message;
    this.#rejectAll(new Error(message));
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function parseBrokerResponse(value: unknown): BrokerResponse {
  if (!value || typeof value !== "object") throw new Error("response is not an object");
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "number" || typeof response.ok !== "boolean") {
    throw new Error("response is missing id or ok");
  }
  if (response.verifyParam !== undefined && typeof response.verifyParam !== "string") {
    throw new Error("verifyParam is not a string");
  }
  if (response.error !== undefined && typeof response.error !== "string") {
    throw new Error("error is not a string");
  }
  return {
    id: response.id,
    ok: response.ok,
    ...(typeof response.verifyParam === "string" ? { verifyParam: response.verifyParam } : {}),
    ...(typeof response.error === "string" ? { error: response.error } : {}),
  };
}

function launchElectronBroker(): ChildProcessWithoutNullStreams {
  const require = createRequire(import.meta.url);
  const executable = require("electron") as unknown;
  if (typeof executable !== "string" || !executable) throw new Error("Electron executable is unavailable");
  const entryPath = fileURLToPath(new URL("./broker.cjs", import.meta.url));
  return spawn(executable, [entryPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
}

let defaultBroker: ElectronCaptchaBroker | null = null;

export function solveCaptcha(config: CaptchaSolveConfig, appVersion: string): Promise<string> {
  defaultBroker ??= new ElectronCaptchaBroker();
  return defaultBroker.solve(config, appVersion);
}

export function getCaptchaBrokerSnapshot(): CaptchaBrokerSnapshot {
  return defaultBroker?.snapshot() ?? { running: false, pending: 0 };
}

export function closeCaptchaBroker(): void {
  defaultBroker?.close();
  defaultBroker = null;
}
