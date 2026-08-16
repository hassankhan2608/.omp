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
  });
});
