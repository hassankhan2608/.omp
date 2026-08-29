import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { baseDir } from "./state.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

const GIT_TIMEOUT_MS = 120_000;
const CHECKOUT_BATCH_SIZE = 100;


function workspaceKey(worktree: string): string {
  return createHash("sha256").update(worktree).digest("hex").slice(0, 20);
}

function validRelativePath(value: string): boolean {
  if (!value || isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

async function hasSymlinkParent(worktree: string, relativePath: string): Promise<boolean> {
  const parent = dirname(relativePath);
  if (parent === ".") return false;

  let current = worktree;
  for (const segment of parent.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export class SnapshotStore {
  readonly worktree: string;
  readonly root: string;
  readonly gitDir: string;
  readonly stateFile: string;

  #initialized = false;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly exec: Exec,
    worktree: string,
    sessionId: string,
  ) {
    this.worktree = worktree;
    this.root = join(baseDir(), "omp", "undo-redo", workspaceKey(worktree), sessionId);
    this.gitDir = join(this.root, "snapshot.git");
    this.stateFile = join(this.root, "state.json");
  }

  // ponytail: `add -A` walks the whole worktree even outside a repo, unbounded by any
  // .gitignore convention — fine for project-sized dirs, could be slow for a huge cwd.
  // Scratch/home roots (/tmp, $HOME, /) are excluded outright rather than snapshotted.
  static async create(exec: Exec, cwd: string, sessionId: string): Promise<SnapshotStore | undefined> {
    const result = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.code === 0) {
      const worktree = resolve(result.stdout.trim());
      if (worktree) return new SnapshotStore(exec, worktree, sessionId);
    }
    const worktree = resolve(cwd);
    if (worktree === resolve(tmpdir()) || worktree === resolve(homedir()) || worktree === resolve("/")) {
      return undefined;
    }
    return new SnapshotStore(exec, worktree, sessionId);
  }

  async capture(): Promise<string> {
    return this.locked(async () => {
      await this.initialize();
      await this.git(["add", "-A", "--", "."]);
      const tree = (await this.git(["write-tree"])).stdout.trim();
      // Anchor the tree with a ref: write-tree output is otherwise dangling and
      // would be pruned by git gc. The ref also lets `gc --auto` pack safely.
      await this.git(["update-ref", `refs/turns/${tree}`, tree]);
      await this.git(["gc", "--auto"], true);
      return tree;
    });
  }

  async changedFiles(before: string, after: string): Promise<string[]> {
    return this.locked(async () => {
      await this.initialize();
      const result = await this.git(["diff", "--name-only", "-z", before, after, "--", "."]);
      return [...new Set(result.stdout.split("\0").filter(validRelativePath))];
    });
  }

  async restore(tree: string, files: readonly string[]): Promise<number> {
    return this.locked(async () => {
      await this.initialize();
      const paths = [...new Set(files.filter(validRelativePath))];
      const existing: string[] = [];
      const absent: string[] = [];

      for (const path of paths) {
        const result = await this.git(["ls-tree", "-z", tree, "--", `:(top,literal)${path}`], true);
        if (result.code === 0 && result.stdout.length > 0) existing.push(path);
        else absent.push(path);
      }

      absent.sort((left, right) => right.length - left.length);
      for (const path of absent) {
        if (await hasSymlinkParent(this.worktree, path)) {
          throw new Error(`Refusing to remove through a symlinked parent: ${path}`);
        }
        const target = resolve(this.worktree, path);
        const relation = relative(this.worktree, target);
        if (!validRelativePath(relation) || relation.startsWith(`..${sep}`)) {
          throw new Error(`Snapshot path escaped the worktree: ${path}`);
        }
        await rm(target, { force: true, recursive: true });
      }

      existing.sort((left, right) => left.length - right.length);
      for (let index = 0; index < existing.length; index += CHECKOUT_BATCH_SIZE) {
        const batch = existing.slice(index, index + CHECKOUT_BATCH_SIZE);
        await this.git(["checkout", tree, "--", ...batch.map(path => `:(top,literal)${path}`)]);
      }

      return paths.length;
    });
  }

  private async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.root, { recursive: true });
    const probe = await this.exec("git", ["--git-dir", this.gitDir, "rev-parse", "--git-dir"], {
      cwd: this.worktree,
      timeout: GIT_TIMEOUT_MS,
    });
    if (probe.code !== 0) {
      const initialized = await this.exec("git", ["init", "--bare", "--quiet", this.gitDir], {
        cwd: this.worktree,
        timeout: GIT_TIMEOUT_MS,
      });
      if (initialized.code !== 0) throw new Error(initialized.stderr.trim() || "Could not initialize snapshot store");
      await this.git(["config", "core.bare", "false"]);
      await this.git(["config", "core.autocrlf", "false"]);
      await this.git(["config", "core.symlinks", "true"]);
      await this.git(["config", "core.fsmonitor", "false"]);
      await this.git(["config", "gc.auto", "256"]);
    }
    this.#initialized = true;
  }

  private async git(args: string[], allowFailure = false): Promise<ExecResult> {
    const result = await this.exec(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.symlinks=true",
        "--git-dir",
        this.gitDir,
        "--work-tree",
        this.worktree,
        ...args,
      ],
      { cwd: this.worktree, timeout: GIT_TIMEOUT_MS },
    );
    if (!allowFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
    }
    return result;
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => {};
    this.#tail = new Promise<void>(resolveTail => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
