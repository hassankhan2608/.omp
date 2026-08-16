import { resolve } from "node:path";
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { SnapshotStore, type Exec } from "./snapshot.ts";
import { cursorForBranch, loadState, saveState, statePath, type UndoState, type UndoTurn } from "./state.ts";

interface PendingTurn {
  prompt: string;
  parentLeafId: string | null;
  beforeTree?: string;
}

interface RuntimeState {
  cwd: string;
  path: string;
  state: UndoState;
  snapshots?: SnapshotStore;
  pending?: PendingTurn;
  tail: Promise<void>;
}

type Direction = "undo" | "redo";

function sessionKey(ctx: ExtensionContext): string {
  return `${ctx.sessionManager.getSessionId()}\0${resolve(ctx.cwd)}`;
}

function entryIds(ctx: ExtensionContext): Set<string> {
  return new Set(ctx.sessionManager.getBranch().map(entry => entry.id));
}

function firstUserEntryId(ctx: ExtensionContext, parentLeafId: string | null): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  const parentIndex = parentLeafId === null ? -1 : branch.findIndex(entry => entry.id === parentLeafId);
  for (const entry of branch.slice(parentIndex + 1)) {
    if (entry.type === "message" && entry.message.role === "user") return entry.id;
  }
  return undefined;
}

function fileSummary(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

export default function undoRedoExtension(pi: ExtensionAPI): void {
  const runtimes = new Map<string, Promise<RuntimeState>>();
  const exec: Exec = async (command, args, options) => pi.exec(command, args, options);

  const runtimeFor = (ctx: ExtensionContext): Promise<RuntimeState> => {
    const key = sessionKey(ctx);
    let pending = runtimes.get(key);
    if (!pending) {
      pending = (async () => {
        const cwd = resolve(ctx.cwd);
        const path = statePath(cwd, ctx.sessionManager.getSessionId());
        const state = await loadState(path, cwd);
        state.cursor = cursorForBranch(state, entryIds(ctx));
        const snapshots = await SnapshotStore.create(exec, cwd, ctx.sessionManager.getSessionId()).catch(() => undefined);
        const runtime: RuntimeState = { cwd, path, state, snapshots, tail: Promise.resolve() };
        await saveState(path, state);
        return runtime;
      })();
      runtimes.set(key, pending);
    }
    return pending;
  };

  const exclusive = async <T>(runtime: RuntimeState, operation: () => Promise<T>): Promise<T> => {
    const previous = runtime.tail;
    let release = (): void => {};
    runtime.tail = new Promise<void>(resolveTail => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const finalizePending = async (ctx: ExtensionContext, runtime: RuntimeState): Promise<void> => {
    const pending = runtime.pending;
    if (!pending) return;
    runtime.pending = undefined;

    const userEntryId = firstUserEntryId(ctx, pending.parentLeafId);
    const afterLeafId = ctx.sessionManager.getLeafId();
    if (!userEntryId || !afterLeafId) return;

    let afterTree: string | undefined;
    let files: string[] = [];
    if (runtime.snapshots && pending.beforeTree) {
      try {
        afterTree = await runtime.snapshots.capture();
        files = await runtime.snapshots.changedFiles(pending.beforeTree, afterTree);
      } catch (error) {
        pi.logger.warn("Undo/redo file snapshot failed", { error: String(error), cwd: runtime.cwd });
      }
    }

    const turn: UndoTurn = {
      prompt: pending.prompt,
      userEntryId,
      afterLeafId,
      beforeTree: pending.beforeTree,
      afterTree,
      files,
      completedAt: new Date().toISOString(),
    };
    runtime.state.turns.push(turn);
    runtime.state.cursor = runtime.state.turns.length;
    await saveState(runtime.path, runtime.state);
  };

  const restoreTurn = async (runtime: RuntimeState, turn: UndoTurn, direction: Direction): Promise<number> => {
    if (!runtime.snapshots || !turn.beforeTree || !turn.afterTree || turn.files.length === 0) return 0;
    const tree = direction === "undo" ? turn.beforeTree : turn.afterTree;
    return runtime.snapshots.restore(tree, turn.files);
  };

  const rollbackRestore = async (runtime: RuntimeState, turn: UndoTurn, direction: Direction): Promise<void> => {
    if (!runtime.snapshots || !turn.beforeTree || !turn.afterTree || turn.files.length === 0) return;
    const tree = direction === "undo" ? turn.afterTree : turn.beforeTree;
    await runtime.snapshots.restore(tree, turn.files);
  };

  const move = async (ctx: ExtensionCommandContext, direction: Direction): Promise<void> => {
    if (!ctx.isIdle()) {
      ctx.abort();
      await ctx.waitForIdle();
    }

    const runtime = await runtimeFor(ctx);
    await exclusive(runtime, async () => {
      await finalizePending(ctx, runtime);
      const turnIndex = direction === "undo" ? runtime.state.cursor - 1 : runtime.state.cursor;
      const turn = runtime.state.turns[turnIndex];
      if (!turn) {
        ctx.ui.notify(direction === "undo" ? "Nothing to undo" : "Nothing to redo", "info");
        return;
      }

      let restored = 0;
      try {
        restored = await restoreTurn(runtime, turn, direction);
      } catch (error) {
        ctx.ui.notify(`Could not ${direction} workspace files: ${String(error)}`, "error");
        return;
      }

      const targetId = direction === "undo" ? turn.userEntryId : turn.afterLeafId;
      let cancelled = false;
      try {
        cancelled = (await ctx.navigateTree(targetId, { summarize: false })).cancelled;
      } catch (error) {
        await rollbackRestore(runtime, turn, direction).catch(rollbackError => {
          pi.logger.error("Undo/redo rollback failed", { error: String(rollbackError), cwd: runtime.cwd });
        });
        ctx.ui.notify(`Could not ${direction} conversation: ${String(error)}`, "error");
        return;
      }

      if (cancelled) {
        await rollbackRestore(runtime, turn, direction).catch(rollbackError => {
          pi.logger.error("Undo/redo rollback failed", { error: String(rollbackError), cwd: runtime.cwd });
        });
        ctx.ui.notify(`${direction === "undo" ? "Undo" : "Redo"} cancelled`, "warning");
        return;
      }

      runtime.state.cursor += direction === "undo" ? -1 : 1;
      await saveState(runtime.path, runtime.state);
      if (direction === "redo") ctx.ui.setEditorText("");

      const fileText = runtime.snapshots
        ? `; restored ${fileSummary(restored)}`
        : "; conversation only (workspace is not a Git worktree)";
      ctx.ui.notify(`${direction === "undo" ? "Undid" : "Redid"} user turn ${runtime.state.cursor + (direction === "undo" ? 1 : 0)}${fileText}`, "info");
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    await runtimeFor(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await runtimeFor(ctx);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    const runtime = await runtimeFor(ctx);
    await exclusive(runtime, async () => {
      if (runtime.state.cursor < runtime.state.turns.length) {
        runtime.state.turns.splice(runtime.state.cursor);
      }

      let beforeTree: string | undefined;
      if (runtime.snapshots) {
        try {
          beforeTree = await runtime.snapshots.capture();
        } catch (error) {
          pi.logger.warn("Undo/redo pre-turn snapshot failed", { error: String(error), cwd: runtime.cwd });
        }
      }

      runtime.pending = {
        prompt: event.prompt,
        parentLeafId: ctx.sessionManager.getLeafId(),
        beforeTree,
      };
      await saveState(runtime.path, runtime.state);
    });
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    if (event.willContinue) return;
    const runtime = await runtimeFor(ctx);
    await exclusive(runtime, async () => {
      await finalizePending(ctx, runtime);
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const runtime = await runtimes.get(sessionKey(ctx));
    if (runtime) await exclusive(runtime, async () => saveState(runtime.path, runtime.state));
  });

  pi.registerCommand("undo", {
    description: "Undo the latest user turn and its workspace file changes",
    handler: async (_args, ctx) => move(ctx, "undo"),
  });

  pi.registerCommand("redo", {
    description: "Redo the next undone user turn and its workspace file changes",
    handler: async (_args, ctx) => move(ctx, "redo"),
  });
}
