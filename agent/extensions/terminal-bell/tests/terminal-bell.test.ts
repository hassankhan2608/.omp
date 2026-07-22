import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type BellConfig } from "../src/config";
import { classifyAgentEnd, registerBellHandlers } from "../src/index";
import { buildPlayCommand, TerminalNotifier } from "../src/notifier";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(overrides: Partial<BellConfig> = {}): BellConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

describe("terminal notifier", () => {
  test("plays mapped sounds, rings optionally, and debounces globally", async () => {
    const commands: string[][] = [];
    let rings = 0;
    let now = 1_000;
    const notifier = new TerminalNotifier(config({ focusTerminal: true }), "/extension", {
      now: () => now,
      spawn: (command) => commands.push(command),
      ring: () => { rings++; },
    });

    expect(await notifier.notify("agent.complete")).toBe(true);
    expect(commands).toEqual([["paplay", "/extension/sounds/complete.oga"]]);
    expect(rings).toBe(1);

    now = 1_499;
    expect(await notifier.notify("approval.requested")).toBe(false);
    now = 1_500;
    expect(await notifier.notify("approval.requested")).toBe(true);
    expect(commands[1]).toEqual(["paplay", "/extension/sounds/minecraft_item_drop.mp3"]);
    expect(rings).toBe(2);
  });

  test("does nothing when the plugin or selected sound is disabled", async () => {
    let spawned = false;
    const disabled = config({ enabled: false });
    const notifier = new TerminalNotifier(disabled, "/extension", {
      now: () => 1,
      spawn: () => { spawned = true; },
      ring: () => undefined,
    });
    expect(await notifier.notify("agent.complete")).toBe(false);
    expect(spawned).toBe(false);
  });

  test("builds native player commands", () => {
    expect(buildPlayCommand("/sound.oga", "linux")).toEqual(["paplay", "/sound.oga"]);
    expect(buildPlayCommand("/sound.oga", "darwin")).toEqual(["afplay", "/sound.oga"]);
    expect(buildPlayCommand("C:\\it's.wav", "win32")[3]).toContain("it''s.wav");
  });
});

describe("OMP event mapping", () => {
  test("distinguishes settled completion, errors, continuations, and aborts", () => {
    expect(classifyAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] })).toBe("agent.complete");
    expect(classifyAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] })).toBe("agent.error");
    expect(classifyAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }], willContinue: true })).toBeUndefined();
    expect(classifyAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] })).toBeUndefined();
  });

  test("rings for Bash policy asks only while an interactive session is active", async () => {
    type Handler = (event: unknown, ctx: { hasUI: boolean }) => unknown;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (event: string, handler: unknown) => handlers.set(event, handler as Handler),
    } as unknown as ExtensionAPI;
    const notifications: string[] = [];
    registerBellHandlers(pi, Promise.resolve({
      notify: async (event) => {
        notifications.push(event);
        return true;
      },
    }));

    await handlers.get("session_start")?.({}, { hasUI: true });
    process.emit("omp:approval-requested", { source: "bash-policy" });
    await Promise.resolve();
    expect(notifications).toEqual(["approval.requested"]);

    await handlers.get("tool_approval_requested")?.({}, { hasUI: true });
    expect(notifications).toEqual(["approval.requested", "approval.requested"]);

    await handlers.get("session_shutdown")?.({}, { hasUI: true });
    process.emit("omp:approval-requested", { source: "bash-policy" });
    await Promise.resolve();
    expect(notifications).toHaveLength(2);
  });
});

describe("configuration", () => {
  test("deep-merges sound overrides and event mappings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-terminal-bell-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "config.json"), JSON.stringify({
      debounceMs: 900,
      sounds: { input: { file: "custom.oga" } },
      events: { "approval.requested": "input" },
    }));

    const loaded = await loadConfig(directory);
    expect(loaded.debounceMs).toBe(900);
    expect(loaded.sounds.input).toEqual({ enabled: true, file: "custom.oga" });
    expect(loaded.sounds.complete).toEqual(DEFAULT_CONFIG.sounds.complete);
  });
});
