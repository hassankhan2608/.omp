import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const LEVEL_ORDER = ["low", "medium", "high"] as const;
export type PermissionLevel = (typeof LEVEL_ORDER)[number];

export interface ProfileRules {
  allowlist: string[];
  denylist: string[];
}

export interface PathRules {
  denylist: string[];
  allowlist: string[];
  externalDirectory: "allow" | "ask" | "deny";
  externalAllowlist: string[];
  externalReadAllowlist: string[];
}

export interface PermissionGateConfig {
  $schema?: string;
  defaultLevel: PermissionLevel;
  profiles: Record<PermissionLevel, ProfileRules>;
  commandBlocklist: string[];
  paths: PathRules;
  customEnvironment: "allow" | "ask" | "deny";
  pty: "allow" | "ask" | "deny";
}

const profileSchema = z.strictObject({
  allowlist: z.array(z.string().min(1)),
  denylist: z.array(z.string().min(1)),
});

const configSchema = z.strictObject({
  $schema: z.string().optional(),
  defaultLevel: z.enum(LEVEL_ORDER),
  profiles: z.strictObject({
    low: profileSchema,
    medium: profileSchema,
    high: profileSchema,
  }),
  commandBlocklist: z.array(z.string().min(1)),
  paths: z.strictObject({
    denylist: z.array(z.string().min(1)),
    allowlist: z.array(z.string().min(1)),
    externalDirectory: z.enum(["allow", "ask", "deny"]),
    externalAllowlist: z.array(z.string().min(1)),
    externalReadAllowlist: z.array(z.string().min(1)),
  }),
  customEnvironment: z.enum(["allow", "ask", "deny"]),
  pty: z.enum(["allow", "ask", "deny"]),
});

const LOW_COMMANDS = [
  "cd *", "pwd", "ls *", "cat *", "head *", "tail *", "less *", "file *", "stat *", "wc *",
  "tree *", "readlink *", "realpath *", "printf *", "echo *", "sort *", "tr *", "diff *", "cmp *",
  "comm *", "paste *", "cut *", "uniq *", "basename *", "dirname *", "seq *", "true *", "test *",
  "break *", "continue *", "exit *", "return *", "shift *", "read *",
  "jq *", "md5sum *", "sha1sum *", "sha224sum *", "sha256sum *", "sha384sum *", "sha512sum *",
  "b2sum *", "which *", "whereis *", "type *", "sed *", "awk *", "rg *", "grep *", "find *", "fd *",
  "ag *", "ack *", "locate *", "lsof *", "ss *", "curl *", "git status *", "git diff *", "git log *",
  "git show *", "git blame *", "git rev-parse *", "git rev-list *", "git merge-base *", "git ls-files *",
  "git ls-tree *", "git worktree list *", "git remote -v", "git for-each-ref *", "git grep *",
  "git cat-file *", "git check-ignore *", "git ls-remote *", "git branch --show-current",
  "git branch --list *", "git branch -a", "git branch -a *", "git branch -r", "git branch -r *",
  "git branch -v", "git branch -v *", "git branch -vv", "git branch -vv *", "git config --get *",
  "git config --get-all *", "git config --get-regexp *", "git config --list *", "git reflog *",
  "git archive *", "git tag --list *", "git stash list *", "git stash show *", "env", "printenv *",
  "ps *", "pgrep *",
  "uname *", "whoami", "id *", "nproc *", "uptime *", "free *", "df *", "du *", "lsblk *", "lscpu *",
  "date *", "sleep *", "host *", "dig *", "nslookup *", "ping -c *", "npm list *", "npm ls *",
  "npm view *", "npm info *", "npm outdated *", "yarn list *", "yarn info *", "pip list *", "pip show *",
  "pip freeze *", "cargo tree *", "go list *", "openspec --help", "openspec --version",
  "openspec * --help", "openspec instructions *", "openspec list *", "openspec show *",
  "openspec status *", "openspec validate *", "bunx openspec --help", "bunx openspec --version",
  "bunx openspec * --help", "bunx openspec instructions *", "bunx openspec list *",
  "bunx openspec show *", "bunx openspec status *", "bunx openspec validate *", "docker compose *",
  "docker ps *", "bunx prettier --check *",
  "bunx prettier --list-different *", "bun x prettier --check *", "bun x prettier --list-different *",
  "prettier --check *", "prettier --list-different *", "prettier --write *",
  "bunx prettier --write *", "bun x prettier --write *",
  "bunx tsc --noEmit *", "bun x tsc --noEmit *",
  "bun run typecheck", "bun run typecheck *", "bun test", "bun test *",
  "tsc --noEmit *", "bunx eslint *", "bun x eslint *", "eslint *", "bunx biome check *",
  "bunx biome lint *", "bun x biome check *", "bun x biome lint *", "biome check *", "biome lint *",
  "bunx oxlint *", "bun x oxlint *", "oxlint *", "ruff check *", "ruff format --check *",
  "black --check *", "mypy *",
  "command -v *", "strings *", "qmllint *", "fold *", "od *",
  "tailscale status *", "tailscale ping *",
  "omp --help", "omp --version", "omp models *", "omp plugin list *",
  "openssl rand *", "unzip -l *", "journalctl *",
];

const MEDIUM_COMMANDS = [
  "mv *", "cp *", "mkdir *", "touch *", "ln *", "rm *", "rmdir *", "git add *", "git commit *",
  "git checkout *", "git switch *", "git stash *", "git merge *", "git rebase *", "git restore *",
  "git cherry-pick *", "git revert *", "git fetch *", "git pull *", "git branch *", "git tag *", "npm *",
  "npx *", "yarn *", "pnpm *", "bun *", "bunx *", "node *", "deno *", "pip *", "python *", "python3 *",
  "pytest *", "poetry *", "uv *", "cargo *", "rustc *", "rustfmt *", "go *", "make *", "cmake *",
  "gradle *", "mvn *", "curl *", "wget *", "docker build *", "docker images *", "docker ps *", "docker logs *",
  "biome format --write *", "biome check --write *",
  "bunx biome format --write *", "bun x biome format --write *",
  "unzip *", "truncate *",
  "gh issue create *", "gh issue edit *", "gh issue comment *", "gh issue close *", "gh issue reopen *",
  "gh pr create *", "gh pr edit *", "gh pr comment *", "gh pr review *", "gh pr close *", "gh pr reopen *",
];

const MEDIUM_DENYLIST = [
  "git push *", "git clean -f*", "git clean -d*f*", "rm -rf *", "sudo *", "doas *", "su *",
  "docker compose up *", "docker compose down *", "docker run *", "kubectl *", "terraform apply *",
  "terraform destroy *", "pulumi up *", "pulumi destroy *",
];

const HIGH_DENYLIST = [
  "sudo *", "doas *", "su *", "git push *--force*", "git push *-f *", "git clean -f*", "git clean -d*f*",
  "rm -rf *", "chmod -R *", "chown -R *", "systemctl *", "service *", "iptables *", "ufw *", "passwd *",
  "useradd *", "userdel *", "groupadd *", "groupdel *",
];

export function defaultConfig(schemaUrl?: string): PermissionGateConfig {
  return {
    ...(schemaUrl ? { $schema: schemaUrl } : {}),
    defaultLevel: "low",
    profiles: {
      low: { allowlist: [...LOW_COMMANDS], denylist: [] },
      medium: { allowlist: [...MEDIUM_COMMANDS], denylist: [...MEDIUM_DENYLIST] },
      high: { allowlist: ["*"], denylist: [...HIGH_DENYLIST] },
    },
    commandBlocklist: [
      "mkfs*", "wipefs *", "shutdown *", "reboot *", "halt *", "poweroff *", "rm -rf /", "rm -rf /*",
      "dd *of=/dev/*",
    ],
    paths: {
      denylist: [
        "**/.env", "**/.env.*", "**/.ssh/**", "**/.gnupg/**", "**/.aws/credentials", "**/.netrc",
        "**/.npmrc", "**/.pypirc", "**/.config/*token*", "**/.config/**/*token*",
      ],
      allowlist: ["**/.env.example", "**/.env.sample"],
      externalDirectory: "ask",
      externalAllowlist: ["/tmp", "/tmp/*"],
      externalReadAllowlist: [],
    },
    customEnvironment: "ask",
    pty: "ask",
  };
}

export function configPath(agentDirectory: string): string {
  return join(agentDirectory, "permission-gate.json");
}

function validationError(path: string, error: z.ZodError): Error {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
  return new Error(`Invalid permission gate config ${path}: ${details}`);
}

export async function loadConfig(agentDirectory: string, schemaUrl?: string): Promise<PermissionGateConfig> {
  const path = configPath(agentDirectory);
  await mkdir(agentDirectory, { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(defaultConfig(schemaUrl), null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`Cannot create permission gate config ${path}: ${(error as Error).message}`);
    }
  }

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read permission gate config ${path}: ${(error as Error).message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in permission gate config ${path}: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw validationError(path, parsed.error);
  return parsed.data;
}
