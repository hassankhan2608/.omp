import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@oh-my-pi/pi-coding-agent";
import undoRedoExtension from "../src/undo-redo.ts";
import { SnapshotStore, type Exec } from "../src/snapshot.ts";
import { cursorForBranch, loadState, saveState, type UndoState } from "../src/state.ts";

const temporaryDirectories: string[] = [];
const originalDataHome = process.env.XDG_DATA_HOME;

const exec: Exec = async (command, args, options) => {
  const child = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-undo-redo-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function gitRepository(): Promise<string> {
  const directory = await temporaryDirectory();
  const result = await exec("git", ["init", "--quiet", directory], { cwd: directory });
  if (result.code !== 0) throw new Error(result.stderr);
  return directory;
}

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })));
});

describe("isolated workspace snapshots", () => {
  test("restores modified, created, and deleted files in both directions", async () => {
    const data = await temporaryDirectory();
    process.env.XDG_DATA_HOME = data;
    const worktree = await gitRepository();
    await writeFile(join(worktree, "changed.txt"), "before\n");
    await writeFile(join(worktree, "deleted.txt"), "keep me\n");

    const snapshots = await SnapshotStore.create(exec, worktree, "snapshot-roundtrip");
    expect(snapshots).toBeDefined();
    const before = await snapshots!.capture();

    await writeFile(join(worktree, "changed.txt"), "after\n");
    await writeFile(join(worktree, "created.txt"), "new\n");
    await rm(join(worktree, "deleted.txt"));
    const after = await snapshots!.capture();
    const files = await snapshots!.changedFiles(before, after);
    expect(files.sort()).toEqual(["changed.txt", "created.txt", "deleted.txt"]);

    expect(await snapshots!.restore(before, files)).toBe(3);
    expect(await readFile(join(worktree, "changed.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(worktree, "deleted.txt"), "utf8")).toBe("keep me\n");
    expect(await readFile(join(worktree, "created.txt"), "utf8").catch(() => undefined)).toBeUndefined();

    expect(await snapshots!.restore(after, files)).toBe(3);
    expect(await readFile(join(worktree, "changed.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(worktree, "created.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(worktree, "deleted.txt"), "utf8").catch(() => undefined)).toBeUndefined();
  });
});

describe("persistent turn state", () => {
  test("round-trips state and derives the visible cursor from the active branch", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const state: UndoState = {
      version: 1,
      cwd: directory,
      cursor: 2,
      turns: [
        {
          prompt: "first",
          userEntryId: "u1",
          afterLeafId: "a1",
          files: [],
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          prompt: "second",
          userEntryId: "u2",
          afterLeafId: "a2",
          files: [],
          completedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    };

    await saveState(path, state);
    const loaded = await loadState(path, directory);
    expect(loaded).toEqual(state);
    expect(cursorForBranch(loaded, new Set(["u1", "a1", "u2", "a2"]))).toBe(2);
    expect(cursorForBranch(loaded, new Set(["u1", "a1"]))).toBe(1);
    expect(cursorForBranch(loaded, new Set())).toBe(0);
  });
});

describe("OMP commands", () => {
  test("undoes and redoes files, then invalidates redo after a replacement turn", async () => {
    const data = await temporaryDirectory();
    process.env.XDG_DATA_HOME = data;
    const cwd = await gitRepository();
    await writeFile(join(cwd, "app.txt"), "before\n");

    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
    const commands = new Map<string, RegisteredCommand>();
    const shorts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>();
    const notifications: string[] = [];
    let editorText = "";
    let entries: Array<Record<string, unknown>> = [];
    const completedEntries = [
      { id: "u1", parentId: null, type: "message", message: { role: "user" } },
      { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
    ];

    const api = {
      exec,
      logger: { warn: () => undefined, error: () => undefined },
      on: (event: string, handler: (payload: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) => {
        commands.set(name, { name, ...options });
      },
      registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) => {
        shorts.set(key, options);
      },
    } as unknown as ExtensionAPI;
    undoRedoExtension(api);

    const sessionManager = {
      getSessionId: () => "session-one",
      getLeafId: () => (entries.at(-1)?.id as string | undefined) ?? null,
      getBranch: () => entries,
    };
    const context = {
      cwd,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      abort: () => undefined,
      waitForIdle: async () => undefined,
      sessionManager,
      ui: {
        notify: (message: string) => notifications.push(message),
        setEditorText: (text: string) => {
          editorText = text;
        },
      },
      navigateTree: async (targetId: string) => {
        if (targetId === "u1") {
          entries = [];
          editorText = "change app";
        } else if (targetId === "a1") {
          entries = completedEntries;
        }
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;

    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", prompt: "change app", systemPrompt: [] }, context);
    }
    entries = completedEntries;
    await writeFile(join(cwd, "app.txt"), "after\n");
    for (const handler of handlers.get("agent_end") ?? []) {
      await handler({ type: "agent_end", messages: [] }, context);
    }

    await commands.get("undo")!.handler("", context);
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("before\n");
    expect(editorText).toBe("change app");
    expect(notifications.at(-1)).toContain("Undid user turn 1; restored 1 file");

    await commands.get("redo")!.handler("", context);
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("after\n");
    expect(editorText).toBe("");
    expect(notifications.at(-1)).toContain("Redid user turn 1; restored 1 file");

    await commands.get("undo")!.handler("", context);
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", prompt: "replace app differently", systemPrompt: [] }, context);
    }
    entries = [
      { id: "u2", parentId: null, type: "message", message: { role: "user" } },
      { id: "a2", parentId: "u2", type: "message", message: { role: "assistant" } },
    ];
    await writeFile(join(cwd, "app.txt"), "replacement\n");
    for (const handler of handlers.get("agent_end") ?? []) {
      await handler({ type: "agent_end", messages: [] }, context);
    }
    await commands.get("redo")!.handler("", context);
    expect(notifications.at(-1)).toBe("Nothing to redo");
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("replacement\n");

    // Default shortcuts are registered and invoke the same move logic.
    expect(shorts.has("alt+u")).toBe(true);
    expect(shorts.has("alt+r")).toBe(true);

    // Undo via the alt+u shortcut restores the pre-turn file state.
    await shorts.get("alt+u")!.handler(context as ExtensionContext);
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("before\n");

    // Redo via the alt+r shortcut re-applies the change.
    await shorts.get("alt+r")!.handler(context as ExtensionContext);
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("replacement\n");
  });
});
describe("multi-tool, multi-turn, and edge-case behavior", () => {
  test("handles multi-file edits across nested directories in a single turn", async () => {
    const data = await temporaryDirectory();
    process.env.XDG_DATA_HOME = data;
    const worktree = await gitRepository();

    await mkdir(join(worktree, "src/components"), { recursive: true });
    await writeFile(join(worktree, "src/index.ts"), "console.log('hello');\n");
    await writeFile(join(worktree, "src/components/Button.tsx"), "export const Button = () => null;\n");

    const snapshots = await SnapshotStore.create(exec, worktree, "multi-tool");
    expect(snapshots).toBeDefined();
    const before = await snapshots!.capture();

    // Simulate multi-tool execution: ast_edit + write + bash
    await writeFile(join(worktree, "src/index.ts"), "console.log('hello world');\n"); // ast_edit / edit
    await writeFile(join(worktree, "src/components/Card.tsx"), "export const Card = () => null;\n"); // write
    await rm(join(worktree, "src/components/Button.tsx")); // bash / rm

    const after = await snapshots!.capture();
    const files = await snapshots!.changedFiles(before, after);
    expect(files.sort()).toEqual(["src/components/Button.tsx", "src/components/Card.tsx", "src/index.ts"]);

    // Revert turn
    await snapshots!.restore(before, files);
    expect(await readFile(join(worktree, "src/index.ts"), "utf8")).toBe("console.log('hello');\n");
    expect(await readFile(join(worktree, "src/components/Button.tsx"), "utf8")).toBe("export const Button = () => null;\n");
    expect(await readFile(join(worktree, "src/components/Card.tsx"), "utf8").catch(() => undefined)).toBeUndefined();
  });

  test("handles 3 consecutive turns stepping backward and forward", async () => {
    const data = await temporaryDirectory();
    process.env.XDG_DATA_HOME = data;
    const cwd = await gitRepository();

    await writeFile(join(cwd, "file.txt"), "v0\n");

    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
    const commands = new Map<string, RegisteredCommand>();
    const notifications: string[] = [];
    let editorText = "";
    let entries: Array<Record<string, unknown>> = [];

    const api = {
      exec,
      logger: { warn: () => undefined, error: () => undefined },
      on: (event: string, handler: (payload: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) => {
        commands.set(name, { name, ...options });
      },
      registerShortcut: () => undefined,
    } as unknown as ExtensionAPI;
    undoRedoExtension(api);

    let activeLeafId = "root";
    const sessionManager = {
      getSessionId: () => "multi-turn-session",
      getLeafId: () => activeLeafId,
      getBranch: () => entries,
    };

    const context = {
      cwd,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      abort: () => undefined,
      waitForIdle: async () => undefined,
      sessionManager,
      ui: {
        notify: (message: string) => notifications.push(message),
        setEditorText: (text: string) => { editorText = text; },
      },
      navigateTree: async (targetId: string) => {
        activeLeafId = targetId;
        if (targetId === "u3") editorText = "turn 3 prompt";
        if (targetId === "u2") editorText = "turn 2 prompt";
        if (targetId === "u1") editorText = "turn 1 prompt";
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;

    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);

    // Turn 1
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", prompt: "turn 1 prompt", systemPrompt: [] }, context);
    }
    entries = [
      { id: "u1", parentId: null, type: "message", message: { role: "user" } },
      { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
    ];
    activeLeafId = "a1";
    await writeFile(join(cwd, "file.txt"), "v1\n");
    for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end", messages: [] }, context);

    // Turn 2
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", prompt: "turn 2 prompt", systemPrompt: [] }, context);
    }
    entries = [
      ...entries,
      { id: "u2", parentId: "a1", type: "message", message: { role: "user" } },
      { id: "a2", parentId: "u2", type: "message", message: { role: "assistant" } },
    ];
    activeLeafId = "a2";
    await writeFile(join(cwd, "file.txt"), "v2\n");
    for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end", messages: [] }, context);

    // Turn 3
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", prompt: "turn 3 prompt", systemPrompt: [] }, context);
    }
    entries = [
      ...entries,
      { id: "u3", parentId: "a2", type: "message", message: { role: "user" } },
      { id: "a3", parentId: "u3", type: "message", message: { role: "assistant" } },
    ];
    activeLeafId = "a3";
    await writeFile(join(cwd, "file.txt"), "v3\n");
    for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end", messages: [] }, context);

    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v3\n");

    // Undo Turn 3 -> file should be v2
    await commands.get("undo")!.handler("", context);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v2\n");
    expect(editorText).toBe("turn 3 prompt");

    // Undo Turn 2 -> file should be v1
    await commands.get("undo")!.handler("", context);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v1\n");
    expect(editorText).toBe("turn 2 prompt");

    // Undo Turn 1 -> file should be v0
    await commands.get("undo")!.handler("", context);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v0\n");
    expect(editorText).toBe("turn 1 prompt");

    // Extra Undo -> Nothing to undo
    await commands.get("undo")!.handler("", context);
    expect(notifications.at(-1)).toBe("Nothing to undo");

    // Redo Turn 1 -> v1
    await commands.get("redo")!.handler("", context);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v1\n");

    // Redo Turn 2 -> v2
    await commands.get("redo")!.handler("", context);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v2\n");

    // Redo Turn 3 -> v3
    await commands.get("redo")!.handler("", context);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("v3\n");

    // Extra Redo -> Nothing to redo
    await commands.get("redo")!.handler("", context);
    expect(notifications.at(-1)).toBe("Nothing to redo");
  });

  test("handles empty turns without file modifications", async () => {
    const data = await temporaryDirectory();
    process.env.XDG_DATA_HOME = data;
    const cwd = await gitRepository();

    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
    const commands = new Map<string, RegisteredCommand>();
    const notifications: string[] = [];

    const api = {
      exec,
      logger: { warn: () => undefined, error: () => undefined },
      on: (event: string, handler: (payload: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) => {
        commands.set(name, { name, ...options });
      },
      registerShortcut: () => undefined,
    } as unknown as ExtensionAPI;
    undoRedoExtension(api);

    let entries: Array<Record<string, unknown>> = [];
    const context = {
      cwd,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      abort: () => undefined,
      waitForIdle: async () => undefined,
      sessionManager: {
        getSessionId: () => "read-only-session",
        getLeafId: () => (entries.at(-1)?.id as string | undefined) ?? null,
        getBranch: () => entries,
      },
      ui: {
        notify: (message: string) => notifications.push(message),
        setEditorText: () => undefined,
      },
      navigateTree: async () => ({ cancelled: false }),
    } as unknown as ExtensionCommandContext;

    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);

    // Read-only question turn (grep/glob/read only, no file edits)
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", prompt: "what is the code structure?", systemPrompt: [] }, context);
    }
    entries = [
      { id: "u1", parentId: null, type: "message", message: { role: "user" } },
      { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
    ];
    for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end", messages: [] }, context);

    await commands.get("undo")!.handler("", context);
    expect(notifications.at(-1)).toContain("Undid user turn 1; restored 0 files");
  });
  test("undoes file changes produced by bash commands (touch, echo, sed, rm)", async () => {
    const data = await temporaryDirectory();
    process.env.XDG_DATA_HOME = data;
    const worktree = await gitRepository();

    await writeFile(join(worktree, "existing.txt"), "original content\n");

    const snapshots = await SnapshotStore.create(exec, worktree, "bash-test");
    expect(snapshots).toBeDefined();
    const before = await snapshots!.capture();

    // Simulate Bash tool execution:
    // 1. bash: `echo "modified content" > existing.txt`
    await exec("sh", ["-c", 'echo "modified content" > existing.txt'], { cwd: worktree });
    // 2. bash: `touch created_by_bash.txt`
    await exec("sh", ["-c", "touch created_by_bash.txt"], { cwd: worktree });
    // 3. bash: `mkdir -p sub && echo "nested" > sub/file.txt`
    await mkdir(join(worktree, "sub"), { recursive: true });
    await exec("sh", ["-c", 'echo "nested" > sub/file.txt'], { cwd: worktree });

    const after = await snapshots!.capture();
    const files = await snapshots!.changedFiles(before, after);
    expect(files.sort()).toEqual(["created_by_bash.txt", "existing.txt", "sub/file.txt"]);

    // Undo -> Revert all file modifications done by bash
    await snapshots!.restore(before, files);

    expect(await readFile(join(worktree, "existing.txt"), "utf8")).toBe("original content\n");
    expect(await readFile(join(worktree, "created_by_bash.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(worktree, "sub/file.txt"), "utf8").catch(() => undefined)).toBeUndefined();

    // Redo -> Re-apply bash file modifications
    await snapshots!.restore(after, files);
    expect(await readFile(join(worktree, "existing.txt"), "utf8")).toBe("modified content\n");
    expect(await readFile(join(worktree, "created_by_bash.txt"), "utf8")).toBe("");
    expect(await readFile(join(worktree, "sub/file.txt"), "utf8")).toBe("nested\n");
  });
});
