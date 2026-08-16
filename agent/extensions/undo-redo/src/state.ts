import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UndoTurn {
  prompt: string;
  userEntryId: string;
  afterLeafId: string;
  beforeTree?: string;
  afterTree?: string;
  files: string[];
  completedAt: string;
}

export interface UndoState {
  version: 1;
  cwd: string;
  cursor: number;
  turns: UndoTurn[];
}

function isTurn(value: unknown): value is UndoTurn {
  if (value === null || typeof value !== "object") return false;
  const turn = value as Partial<UndoTurn>;
  return (
    typeof turn.prompt === "string" &&
    typeof turn.userEntryId === "string" &&
    typeof turn.afterLeafId === "string" &&
    (turn.beforeTree === undefined || typeof turn.beforeTree === "string") &&
    (turn.afterTree === undefined || typeof turn.afterTree === "string") &&
    Array.isArray(turn.files) &&
    turn.files.every(file => typeof file === "string") &&
    typeof turn.completedAt === "string"
  );
}

export function statePath(cwd: string, sessionId: string): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const workspace = createHash("sha256").update(cwd).digest("hex").slice(0, 20);
  return join(dataHome, "omp", "undo-redo", workspace, sessionId, "state.json");
}

export async function loadState(path: string, cwd: string): Promise<UndoState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UndoState>;
    if (
      parsed.version !== 1 ||
      parsed.cwd !== cwd ||
      !Array.isArray(parsed.turns) ||
      !parsed.turns.every(isTurn) ||
      !Number.isInteger(parsed.cursor)
    ) {
      return { version: 1, cwd, cursor: 0, turns: [] };
    }
    return {
      version: 1,
      cwd,
      cursor: Math.max(0, Math.min(parsed.cursor as number, parsed.turns.length)),
      turns: parsed.turns,
    };
  } catch {
    return { version: 1, cwd, cursor: 0, turns: [] };
  }
}

let saveCounter = 0;

export async function saveState(path: string, state: UndoState): Promise<void> {
  const dir = dirname(path);
  try {
    await mkdir(dir, { recursive: true });
    const unique = `${process.pid}.${Date.now()}.${++saveCounter}.${randomUUID().slice(0, 8)}`;
    const temporary = `${path}.${unique}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch {
      // Non-fatal persistence fallback
    }
  }
}

export function cursorForBranch(state: UndoState, branchEntryIds: ReadonlySet<string>): number {
  let cursor = 0;
  for (const turn of state.turns) {
    if (!branchEntryIds.has(turn.afterLeafId)) break;
    cursor++;
  }
  return cursor;
}
