import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";
import { LEVEL_ORDER, type PermissionLevel } from "./config";

export interface CommandSafety {
  reason: string;
  /** Lowest autonomy level that no longer needs an approval for this form. */
  minimumLevel?: PermissionLevel;
  /** Whether a reusable session grant may be offered for this form. */
  persistable: boolean;
  /** Wrapper executable that hid the real command, when the floor came from indirection. */
  indirection?: string;
}

export interface BashCommandUnit {
  text: string;
  executable?: string;
  /** Command word exactly as written, so path-qualified binaries stay distinguishable. */
  executableWord?: string;
  arguments: string[];
  safety?: CommandSafety;
}

/** A floor without `minimumLevel` always asks; otherwise it asks below that level. */
export function safetyRequiresApproval(
  safety: CommandSafety | undefined,
  level: PermissionLevel,
): boolean {
  if (!safety) return false;
  if (!safety.minimumLevel) return true;
  return LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(safety.minimumLevel);
}

export interface BashAnalysis {
  commands: BashCommandUnit[];
  paths: string[];
  malformed: boolean;
  catastrophicReason?: string;
}

let parserPromise: Promise<Parser> | undefined;

async function createParser(): Promise<Parser> {
  const require = createRequire(import.meta.url);
  await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm") });
  const parser = new Parser();
  parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));
  return parser;
}

export async function warmBashParser(): Promise<void> {
  parserPromise ??= createParser().catch((error) => {
    parserPromise = undefined;
    throw error;
  });
  await parserPromise;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) words.push(current);
  return words;
}

const ALWAYS_INDIRECT: Record<string, true> = {
  chroot: true, command: true, doas: true, env: true, eval: true, exec: true, flock: true, nice: true,
  nohup: true, parallel: true, "rust-parallel": true, rush: true, setsid: true, stdbuf: true, su: true,
  sudo: true, timeout: true, time: true, watch: true, xargs: true,
};
const SHELLS: Record<string, true> = { bash: true, dash: true, fish: true, ksh: true, sh: true, zsh: true };
const SENSITIVE_BASENAMES: Record<string, true> = {
  ".env": true, ".netrc": true, ".npmrc": true, ".pypirc": true, credentials: true,
  id_ed25519: true, id_rsa: true,
};

const CREDENTIAL_DATA_EXTENSIONS: Record<string, true> = {
  json: true,
  txt: true,
  yaml: true,
  yml: true,
  toml: true,
  db: true,
  sqlite: true,
  sqlite3: true,
  enc: true,
  key: true,
};

/** Bare credential filenames need assessment even without a slash. */
function isSensitiveBasename(basename: string): boolean {
  if (SENSITIVE_BASENAMES[basename]) return true;
  const lower = basename.toLowerCase();
  const extension = /\.([a-z0-9]+)$/.exec(lower)?.[1];
  const stem = extension ? lower.slice(0, -(extension.length + 1)) : lower;
  const credentialWord = /(?:^|[-_.])(tokens?|credentials|auth)(?:$|[-_.])/.test(stem);
  return credentialWord && (extension === undefined || CREDENTIAL_DATA_EXTENSIONS[extension] === true);
}

interface CommandSafetyRule {
  reason: string;
  subcommands?: readonly string[];
  arguments?: readonly string[];
  argumentPrefixes?: readonly string[];
  shortFlags?: readonly string[];
  always?: true;
  unlessArguments?: readonly string[];
  /** Bounded-mutation forms clear this floor at or above the named level. */
  minimumLevel?: PermissionLevel;
}

/** Semantic floors for commands whose read/check form shares a prefix with a writing or executing form. */
const COMMAND_SAFETY: Readonly<Record<string, readonly CommandSafetyRule[]>> = {
  sed: [{
    reason: "sed can edit files in place or load an uninspected script",
    arguments: ["--in-place", "--file"],
    shortFlags: ["i", "f"],
  }],
  awk: [{
    reason: "awk can load an uninspected program or native extension",
    arguments: ["--file", "--exec", "--load"],
    shortFlags: ["f", "E", "l"],
  }],
  ss: [{
    reason: "ss can forcibly close matching sockets",
    arguments: ["--kill"],
    shortFlags: ["K"],
  }],
  find: [{
    reason: "find can write results, delete paths, execute commands, or follow symbolic links",
    arguments: ["-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-exec", "-execdir", "-ok", "-okdir", "-follow"],
    shortFlags: ["L"],
  }],
  fd: [{
    reason: "fd can execute commands or cross hidden and symbolic-link boundaries",
    arguments: ["--exec", "--exec-batch", "--hidden", "--follow"],
    shortFlags: ["x", "X", "H", "L"],
  }],
  rg: [{
    reason: "ripgrep can execute a preprocessor or cross archive, hidden, ignore, and symbolic-link boundaries",
    arguments: ["--pre", "--pre-glob", "--search-zip", "--hidden", "--no-ignore", "--follow"],
    argumentPrefixes: ["--no-ignore-"],
    shortFlags: ["z", ".", "L"],
  }],
  grep: [{
    reason: "grep can follow symbolic links while recursing",
    arguments: ["--dereference-recursive"],
    shortFlags: ["R"],
  }],
  unzip: [
    {
      reason: "unzip overwrite and update modes replace existing files",
      arguments: ["-o", "-f", "-u", "-B"],
    },
    {
      reason: "unzip extracts archive members to disk",
      always: true,
      unlessArguments: ["-l", "--list", "-t", "-v", "-z", "-p", "-c"],
      minimumLevel: "medium",
    },
  ],
  truncate: [{
    reason: "truncate rewrites file length in place",
    always: true,
    minimumLevel: "medium",
  }],
  openssl: [{
    reason: "openssl can write generated material to files",
    arguments: ["-out", "-writerand", "-keyout", "-passout", "-rand"],
  }],
  journalctl: [{
    reason: "journalctl maintenance rotates, flushes, or deletes journal data",
    arguments: ["--rotate", "--sync", "--flush", "--relinquish-var", "--smart-relinquish-var"],
    argumentPrefixes: ["--vacuum-"],
  }],
  omp: [
    {
      reason: "omp extension and config overrides change which code runs",
      arguments: ["--extension", "-e", "--config", "--plugin-dir"],
    },
    {
      reason: "omp models refresh rewrites the local model catalog",
      subcommands: ["models"],
      arguments: ["refresh"],
    },
    {
      reason: "omp plugin management installs, removes, or toggles code",
      subcommands: ["plugin"],
      arguments: [
        "install", "uninstall", "link", "enable", "disable", "upgrade", "marketplace", "config",
        "doctor", "discover", "features",
      ],
    },
  ],
  ag: [{
    reason: "the silver searcher can cross hidden, ignored, and symbolic-link boundaries or execute a pager",
    arguments: ["--hidden", "--unrestricted", "--follow", "--pager"],
    shortFlags: ["u", "f"],
  }],
  ack: [{
    reason: "ack can execute an external pager",
    arguments: ["--pager"],
  }],
  file: [{
    reason: "file can compile a magic database",
    arguments: ["--compile"],
    shortFlags: ["C"],
  }],
  less: [{
    reason: "less can write its input to a log file",
    arguments: ["--log-file"],
    shortFlags: ["o", "O"],
  }],
  tree: [{
    reason: "tree can write output or follow symbolic links",
    arguments: ["--output"],
    shortFlags: ["o", "l"],
  }],
  git: [
    {
      reason: "git diff, log, and show can write output or invoke external helpers",
      subcommands: ["diff", "log", "show"],
      arguments: ["--output", "--ext-diff", "--textconv"],
    },
    {
      reason: "git branch options can mutate refs or tracking configuration",
      subcommands: ["branch"],
      arguments: [
        "--delete", "--move", "--copy", "--force", "--track", "--no-track", "--set-upstream-to",
        "--unset-upstream", "--edit-description", "--create-reflog",
      ],
      shortFlags: ["d", "D", "m", "M", "c", "C", "f", "t", "u"],
    },
    {
      reason: "git tag options can create, replace, sign, or delete tags",
      subcommands: ["tag"],
      arguments: [
        "--delete", "--force", "--annotate", "--sign", "--local-user", "--message", "--file", "--edit",
        "--create-reflog", "--cleanup",
      ],
      shortFlags: ["d", "f", "a", "s", "u", "m", "F", "e"],
    },
    {
      reason: "git grep can invoke configured text conversion or an external pager",
      subcommands: ["grep"],
      arguments: ["--textconv", "--open-files-in-pager"],
    },
    {
      reason: "git cat-file can invoke configured filters or text conversion",
      subcommands: ["cat-file"],
      arguments: ["--filters", "--textconv"],
    },
    {
      reason: "git stash show can invoke external diff helpers or text conversion",
      subcommands: ["stash"],
      arguments: ["--ext-diff", "--textconv"],
    },
    {
      reason: "git ls-remote can select an arbitrary remote upload-pack program",
      subcommands: ["ls-remote"],
      arguments: ["--upload-pack", "--exec"],
    },
    {
      reason: "git reflog can expire, delete, or write reference-log entries",
      subcommands: ["reflog"],
      arguments: ["expire", "delete", "write", "drop"],
    },
    {
      reason: "git archive can write the archive directly to a file",
      subcommands: ["archive"],
      arguments: ["--output"],
      shortFlags: ["o"],
    },
  ],
  docker: [{
    reason: "docker compose config can write the rendered configuration to a file",
    subcommands: ["config"],
    arguments: ["--output"],
    shortFlags: ["o"],
  }],
  curl: [{
    reason: "curl can write files, upload data, change requests, load configuration, or expose credentials",
    arguments: [
      "--output", "--remote-name", "--remote-name-all", "--output-dir", "--dump-header", "--cookie-jar",
      "--etag-save", "--trace", "--trace-ascii", "--trace-config", "--stderr", "--libcurl", "--upload-file",
      "--request", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--form",
      "--form-string", "--json", "--config", "--next", "--no-head", "--get", "--continue-at", "--remote-time",
      "--remote-header-name", "--cookie", "--header", "--user", "--netrc", "--netrc-file", "--netrc-optional",
      "--key", "--cert", "--proxy-key", "--proxy-cert", "--write-out",
    ],
    shortFlags: ["o", "O", "D", "c", "T", "d", "F", "X", "G", "K", "C", "R", "J", "b", "H", "u", "E", "w"],
  }],
  sort: [{
    reason: "sort can write output to a file",
    arguments: ["--output"],
    shortFlags: ["o"],
  }],
  diff: [{
    reason: "diff can write comparison output to a file",
    arguments: ["--output"],
  }],
  date: [{
    reason: "date can change the system clock",
    arguments: ["--set"],
    shortFlags: ["s"],
  }],
  bunx: [{
    reason: "formatter and linter write or fix mode can modify workspace files",
    subcommands: ["prettier", "eslint", "biome", "oxlint", "ruff", "black"],
    arguments: ["--write", "--fix", "--in-place", "--unsafe-fixes"],
  }],
  eslint: [{
    reason: "eslint fix or cache mode writes workspace files",
    arguments: ["--fix", "--cache"],
  }],
  biome: [{
    reason: "biome write or fix mode modifies workspace files",
    arguments: ["--write", "--fix"],
    minimumLevel: "medium",
  }],
  oxlint: [{
    reason: "oxlint fix mode modifies workspace files",
    arguments: ["--fix"],
  }],
  ruff: [
    {
      reason: "ruff fix mode modifies workspace files",
      arguments: ["--fix", "--unsafe-fixes"],
    },
    {
      reason: "ruff format mode modifies workspace files",
      subcommands: ["format"],
      always: true,
      unlessArguments: ["--check", "--diff"],
    },
  ],
  black: [{
    reason: "black format mode modifies workspace files",
    always: true,
    unlessArguments: ["--check", "--diff"],
  }],
  tsc: [{
    reason: "TypeScript build metadata and traces write workspace files",
    arguments: ["--incremental", "--composite", "--generateTrace", "--tsBuildInfoFile"],
  }],
  go: [{
    reason: "go list can invoke tools, alter module resolution, use overlays, or export build artifacts",
    subcommands: ["list"],
    arguments: ["-exec", "-toolexec", "-mod", "-modfile", "-overlay", "-export"],
    argumentPrefixes: ["-exec=", "-toolexec=", "-mod=", "-modfile=", "-overlay="],
  }],
  cargo: [{
    reason: "cargo tree can resolve or update dependency state unless the lockfile is enforced",
    subcommands: ["tree"],
    always: true,
    unlessArguments: ["--locked", "--frozen"],
  }],
};

const SYSTEM_MUTATORS: Record<string, true> = {
  groupadd: true, groupdel: true, iptables: true, passwd: true, service: true, systemctl: true, ufw: true,
  useradd: true, userdel: true,
};

function hasArgument(arguments_: readonly string[], expected: string): boolean {
  return arguments_.some((argument) =>
    argument === expected || (expected.startsWith("--") && argument.startsWith(`${expected}=`)),
  );
}

function hasShortFlag(arguments_: readonly string[], expected: string): boolean {
  return arguments_.some((argument) => /^-[^-]/.test(argument) && argument.slice(1).includes(expected));
}

function matchesSafetyRule(rule: CommandSafetyRule, arguments_: readonly string[]): boolean {
  if (rule.subcommands && !rule.subcommands.some((subcommand) => arguments_.includes(subcommand))) return false;
  if (rule.unlessArguments?.some((argument) => hasArgument(arguments_, argument))) return false;
  if (rule.always) return true;
  if (rule.arguments?.some((argument) => hasArgument(arguments_, argument))) return true;
  if (rule.argumentPrefixes?.some((prefix) => arguments_.some((argument) => argument.startsWith(prefix)))) return true;
  return rule.shortFlags?.some((flag) => hasShortFlag(arguments_, flag)) === true;
}

interface ProgramOperands {
  programs: string[];
  paths: string[];
}

function sedOperands(arguments_: readonly string[]): ProgramOperands {
  const programs: string[] = [];
  const paths: string[] = [];
  let hasProgram = false;
  let options = true;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && (argument === "--expression" || argument === "-e")) {
      const program = arguments_[++index];
      if (program !== undefined) programs.push(program);
      hasProgram = true;
      continue;
    }
    if (options && argument.startsWith("--expression=")) {
      programs.push(argument.slice("--expression=".length));
      hasProgram = true;
      continue;
    }
    if (options && (argument === "--file" || argument === "-f")) {
      const path = arguments_[++index];
      if (path !== undefined && path !== "-") paths.push(path);
      hasProgram = true;
      continue;
    }
    if (options && argument.startsWith("--file=")) {
      const path = argument.slice("--file=".length);
      if (path && path !== "-") paths.push(path);
      hasProgram = true;
      continue;
    }
    const shortProgram = options ? /^-[nErusz]*([ef])(.*)$/.exec(argument) : null;
    if (shortProgram) {
      const value = shortProgram[2] || arguments_[++index];
      if (value !== undefined && value !== "-") {
        if (shortProgram[1] === "e") programs.push(value);
        else paths.push(value);
      }
      hasProgram = true;
      continue;
    }
    if (options && argument.startsWith("-")) continue;
    if (!hasProgram) {
      programs.push(argument);
      hasProgram = true;
    } else if (argument !== "-") {
      paths.push(argument);
    }
  }
  return { programs, paths };
}

function awkOperands(arguments_: readonly string[]): ProgramOperands {
  const programs: string[] = [];
  const paths: string[] = [];
  let hasProgram = false;
  let options = true;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && ["-f", "--file", "-E", "--exec"].includes(argument)) {
      const path = arguments_[++index];
      if (path !== undefined && path !== "-") paths.push(path);
      hasProgram = true;
      continue;
    }
    if (options && /^(?:--file|--exec)=/.test(argument)) {
      const path = argument.slice(argument.indexOf("=") + 1);
      if (path && path !== "-") paths.push(path);
      hasProgram = true;
      continue;
    }
    if (options && ["-e", "--source"].includes(argument)) {
      const program = arguments_[++index];
      if (program !== undefined) programs.push(program);
      hasProgram = true;
      continue;
    }
    if (options && argument.startsWith("--source=")) {
      programs.push(argument.slice("--source=".length));
      hasProgram = true;
      continue;
    }
    if (options && ["-F", "--field-separator", "-v", "--assign", "-W", "--load", "-l"].includes(argument)) {
      index++;
      continue;
    }
    if (options && /^(?:-F.|-v.|-W.|-l.|--field-separator=|--assign=|--load=)/.test(argument)) continue;
    if (options && argument.startsWith("-")) continue;
    if (!hasProgram) {
      programs.push(argument);
      hasProgram = true;
    } else if (argument !== "-" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      paths.push(argument);
    }
  }
  return { programs, paths };
}

const TEXT_SEARCH_VALUE_OPTIONS: Record<string, true> = {
  "-A": true, "-B": true, "-C": true, "-g": true, "-j": true, "-m": true, "-t": true, "-T": true,
  "--after-context": true, "--before-context": true, "--binary-files": true, "--color": true,
  "--colors": true, "--context": true, "--context-separator": true, "--devices": true,
  "--directories": true, "--exclude": true, "--exclude-dir": true, "--field-context-separator": true,
  "--field-match-separator": true, "--glob": true, "--hostname-bin": true, "--hyperlink-format": true,
  "--iglob": true, "--ignore-file": true, "--include": true, "--label": true, "--max-columns": true,
  "--max-count": true, "--max-depth": true, "--max-filesize": true, "--path-separator": true,
  "--pre": true, "--pre-glob": true, "--replace": true, "--sort": true, "--sortr": true,
  "--threads": true, "--type": true, "--type-add": true, "--type-not": true,
};

function textSearchPaths(arguments_: readonly string[]): string[] {
  const paths: string[] = [];
  let explicitPattern = false;
  let implicitPattern = false;
  let options = true;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && (argument === "-e" || argument === "--regexp")) {
      index++;
      explicitPattern = true;
      continue;
    }
    if (options && (argument.startsWith("-e") && argument.length > 2 || argument.startsWith("--regexp="))) {
      explicitPattern = true;
      continue;
    }
    if (options && (argument === "-f" || argument === "--file")) {
      const path = arguments_[++index];
      if (path !== undefined && path !== "-") paths.push(path);
      explicitPattern = true;
      continue;
    }
    if (options && (argument.startsWith("-f") && argument.length > 2 || argument.startsWith("--file="))) {
      const path = argument.startsWith("--") ? argument.slice(argument.indexOf("=") + 1) : argument.slice(2);
      if (path && path !== "-") paths.push(path);
      explicitPattern = true;
      continue;
    }
    if (options && TEXT_SEARCH_VALUE_OPTIONS[argument]) {
      index++;
      continue;
    }
    if (options && argument.startsWith("-")) continue;
    if (!explicitPattern && !implicitPattern) {
      implicitPattern = true;
      continue;
    }
    if (argument !== "-") paths.push(argument);
  }
  return paths;
}

function sedScriptHasExternalEffect(program: string): boolean {
  const addressedCommand = /(?:^|[;{}\n])\s*(?:(?:(?:\d+|\$|\/(?:\\.|[^/])*\/)(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^/])*\/))?)\s*)?[erRwW](?:\s|$)/;
  if (addressedCommand.test(program)) return true;
  for (let index = 0; index + 1 < program.length; index++) {
    if (program[index] !== "s") continue;
    const delimiter = program[index + 1]!;
    if (/[\sA-Za-z0-9\\]/.test(delimiter)) continue;
    let cursor = index + 2;
    for (let field = 0; field < 2; field++) {
      let closed = false;
      while (cursor < program.length) {
        if (program[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (program[cursor++] === delimiter) {
          closed = true;
          break;
        }
      }
      if (!closed) break;
      if (field === 1) {
        const end = program.slice(cursor).search(/[;\n]/);
        const flags = program.slice(cursor, end < 0 ? undefined : cursor + end).trim();
        if (flags.includes("e") || /^[0-9gpImM]*w(?:\s|$)/.test(flags)) return true;
      }
    }
  }
  return false;
}

function maskQuotedProgram(program: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  return [...program].map((character) => {
    if (escaped) {
      escaped = false;
      return quote ? " " : character;
    }
    if (character === "\\") {
      escaped = true;
      return quote ? " " : character;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      return " ";
    }
    if (character === "'" || character === '"') {
      quote = character;
      return " ";
    }
    return character;
  }).join("");
}

function awkScriptHasExternalEffect(program: string): boolean {
  const masked = maskQuotedProgram(program);
  if (/\bsystem\s*\(|@load\b|\|\s*&?\s*getline\b|\bgetline\b[^;\n]*</.test(masked)) return true;
  let depth = 0;
  let printDepth: number | undefined;
  for (let index = 0; index < masked.length; index++) {
    const character = masked[index]!;
    if (character === "(" || character === "[") {
      depth++;
      continue;
    }
    if (character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === ";" || character === "\n" || character === "}") {
      printDepth = undefined;
      continue;
    }
    if (/\w/.test(character)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(index))?.[0];
      if (word === "print" || word === "printf") printDepth = depth;
      if (word) index += word.length - 1;
      continue;
    }
    if (printDepth !== undefined && depth <= printDepth && (character === ">" || character === "|")) return true;
  }
  return false;
}

const DOCKER_COMPOSE_VALUE_OPTIONS: Record<string, true> = {
  "-f": true, "-p": true, "--ansi": true, "--env-file": true, "--file": true, "--parallel": true,
  "--profile": true, "--progress": true, "--project-directory": true, "--project-name": true,
};

function dockerComposeSubcommand(arguments_: readonly string[]): string | undefined {
  if (arguments_[0] !== "compose") return undefined;
  for (let index = 1; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (DOCKER_COMPOSE_VALUE_OPTIONS[argument]) {
      index++;
      continue;
    }
    if (/^(?:-[fp].+|--[^=]+=)/.test(argument) || argument.startsWith("-")) continue;
    return argument;
  }
  return undefined;
}

function alwaysAsk(reason: string): CommandSafety {
  return { reason, persistable: false };
}

/** Semantic floor for one already-resolved executable and its arguments. */
export function commandSafetyFor(
  executable: string,
  arguments_: readonly string[],
): CommandSafety | undefined {
  if (SYSTEM_MUTATORS[executable]) return alwaysAsk(`${executable} changes machine or account state`);
  if (ALWAYS_INDIRECT[executable]
    && !(executable === "command" && arguments_[0] === "-v" && arguments_.length === 2)) {
    return { reason: `Command indirection through ${executable}`, persistable: false, indirection: executable };
  }
  if (SHELLS[executable] && arguments_.some((word) => /^-[^-]*c/.test(word))) {
    return alwaysAsk(`Opaque shell program through ${executable} -c`);
  }
  if (executable === "git" && arguments_.includes("push")
    && (hasArgument(arguments_, "--force") || hasArgument(arguments_, "--force-with-lease")
      || hasArgument(arguments_, "--force-if-includes") || hasShortFlag(arguments_, "f"))) {
    return alwaysAsk("Forced git push can overwrite remote history");
  }
  if (executable === "git" && arguments_.includes("clean")
    && (hasArgument(arguments_, "--force") || hasShortFlag(arguments_, "f"))) {
    return alwaysAsk("Forced git clean permanently deletes untracked files");
  }
  if (executable === "rm"
    && (hasArgument(arguments_, "--recursive") || hasShortFlag(arguments_, "r") || hasShortFlag(arguments_, "R"))
    && (hasArgument(arguments_, "--force") || hasShortFlag(arguments_, "f"))) {
    return alwaysAsk("Recursive forced deletion");
  }
  if ((executable === "chmod" || executable === "chown")
    && (hasArgument(arguments_, "--recursive") || hasShortFlag(arguments_, "R"))) {
    return alwaysAsk(`Recursive ${executable} changes`);
  }
  if (executable === "sed" && sedOperands(arguments_).programs.some(sedScriptHasExternalEffect)) {
    return alwaysAsk("sed script can read, write, or execute outside the stdout transformation");
  }
  if (executable === "awk" && awkOperands(arguments_).programs.some(awkScriptHasExternalEffect)) {
    return alwaysAsk("awk program can read, write, or execute outside its input stream");
  }
  if (executable === "docker" && arguments_[0] === "compose"
    && !["config", "ps"].includes(dockerComposeSubcommand(arguments_) ?? "")) {
    return alwaysAsk("Only docker compose config and ps are read-only at low autonomy");
  }
  for (const rule of COMMAND_SAFETY[executable] ?? []) {
    if (!matchesSafetyRule(rule, arguments_)) continue;
    return rule.minimumLevel
      ? { reason: rule.reason, minimumLevel: rule.minimumLevel, persistable: true }
      : alwaysAsk(rule.reason);
  }
  return undefined;
}

function commandParts(text: string): { executable?: string; words: string[]; inlineEnvironment: boolean } {
  const words = shellWords(text);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  const commandName = words[index];
  const executable = commandName?.split("/").at(-1)?.toLowerCase();
  return { executable, words: words.slice(index), inlineEnvironment: index > 0 };
}

function commandSafety(text: string, redirected: boolean, backgrounded: boolean): CommandSafety | undefined {
  const { executable, words, inlineEnvironment } = commandParts(text);
  if (!executable) return alwaysAsk("Dynamic or empty command name");
  if (/[$`]/.test(words[0] ?? "")) return alwaysAsk("Dynamic command name");
  if (inlineEnvironment) return alwaysAsk("Inline environment variables can change command behavior");
  if (redirected) return alwaysAsk("Shell redirection");
  if (backgrounded) return alwaysAsk("Background execution");
  // Indirection and opaque-shell floors live in commandSafetyFor so they also
  // apply to children of peeled wrappers.
  return commandSafetyFor(executable, words.slice(1));
}

function catastrophicReason(command: string, units: BashCommandUnit[]): string | undefined {
  const compact = command.replace(/\s+/g, " ").trim();
  if (/^:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*&.*\}\s*;?\s*:$/.test(compact)) return "Fork bomb";
  if (/(?:^|[;&|]\s*)(?:curl|wget)\b[^|]*\|\s*(?:(?:sudo|doas|env|command|exec|nohup)\s+(?:(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*)*(?:\S+\/)?(?:bash|dash|ksh|sh|zsh)\b/.test(compact)) {
    return "Remote script piped directly into a shell";
  }
  for (const unit of units) {
    let { executable, words } = commandParts(unit.text);
    if (executable && ALWAYS_INDIRECT[executable]) {
      const nestedIndex = words.findIndex((word, index) =>
        index > 0 && /^(?:rm|dd|mkfs(?:\\..*)?|halt|poweroff|reboot|shutdown|chmod|chown)$/.test(word.split("/").at(-1) ?? ""),
      );
      if (nestedIndex > 0) {
        words = words.slice(nestedIndex);
        executable = words[0]!.split("/").at(-1)!.toLowerCase();
      }
    }
    if (!executable) continue;
    if (/^mkfs(?:\.|$)/.test(executable)) return "Filesystem formatting command";
    if (["halt", "poweroff", "reboot", "shutdown"].includes(executable)) return "Machine shutdown command";
    if (executable === "dd" && words.some((word) => /^of=\/dev\/(?!null(?:$|\/))/.test(word))) {
      return "Raw write to a block or device path";
    }
    if (executable === "rm") {
      const shortFlags = words.filter((word) => /^-[^-]/.test(word)).join("");
      const recursive = shortFlags.includes("r") || words.includes("--recursive");
      const force = shortFlags.includes("f") || words.includes("--force");
      const home = homedir();
      const destructiveTarget = words.some((word) =>
        /^(?:\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\})(?:$|\/)/.test(word) || word === home || word.startsWith(`${home}/`),
      );
      if (recursive && force && destructiveTarget) return "Recursive forced deletion of a root or home path";
    }
    if (["chmod", "chown"].includes(executable) && words.includes("-R") && words.some((word) => word === "/" || word === "/*")) {
      return `Recursive ${executable} of the filesystem root`;
    }
  }
  return undefined;
}

function looksLikePath(word: string): boolean {
  if (!word || word === "-" || word.startsWith("--")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) return false;
  if (/^(?:@)?[<(]/.test(word)) return false;
  // Explicit filesystem spelling is unambiguous, including // and quoted paths with spaces.
  if (/^(?:\/|\.\/|\.\.\/|~(?:\/|$))/.test(word)) return true;
  const basename = word.split("/").at(-1) ?? word;
  if (isSensitiveBasename(basename)) return true;
  // Prose, programs, structured bodies, and shell syntax are data, not paths.
  if (/[\s"'`{}[\]();|&<>$\\]/.test(word)) return false;
  // Bare relative subtrees remain useful for symlink-aware path assessment.
  return /^[A-Za-z0-9_.@%+=,-]+(?:\/[A-Za-z0-9_.@%+=,-]+)+$/.test(word);
}

const CURL_FILE_OPTIONS: Record<string, true> = {
  "-o": true,
  "--output": true,
  "-T": true,
  "--upload-file": true,
  "-E": true,
  "--cert": true,
  "--key": true,
  "--cacert": true,
  "--capath": true,
  "--proxy-cert": true,
  "--proxy-key": true,
  "--proxy-cacert": true,
  "--crlfile": true,
  "-c": true,
  "--cookie-jar": true,
  "-K": true,
  "--config": true,
  "--netrc-file": true,
  "-D": true,
  "--dump-header": true,
  "--trace": true,
  "--trace-ascii": true,
  "--output-dir": true,
  "--unix-socket": true,
  "--abstract-unix-socket": true,
  "--alt-svc": true,
  "--hsts": true,
  "--etag-compare": true,
  "--etag-save": true,
};

const CURL_AT_FILE_OPTIONS: Record<string, true> = {
  "-b": true,
  "--cookie": true,
  "-d": true,
  "--data": true,
  "--data-ascii": true,
  "--data-binary": true,
  "--data-urlencode": true,
  "--json": true,
  "-F": true,
  "--form": true,
};

const CURL_SHORT_FILE_OPTIONS: Record<string, true> = {
  o: true, T: true, E: true, c: true, K: true, D: true,
};
const CURL_SHORT_AT_FILE_OPTIONS: Record<string, true> = { b: true, d: true, F: true };
const CURL_SHORT_VALUE_OPTIONS: Record<string, true> = {
  A: true, C: true, H: true, P: true, Q: true, U: true, X: true,
  e: true, m: true, r: true, t: true, u: true, w: true, x: true, y: true, Y: true, z: true,
};

function curlEmbeddedFile(value: string): string | undefined {
  const marker = /(?:^|=)(?:@|<)(.+)$/.exec(value)
    ?? /^[^@=]+@(.+)$/.exec(value)
    ?? /^(?:@|<)(.+)$/.exec(value);
  const path = marker?.[1]?.split(";")[0];
  if (!path || path === "-" || /^[<(]/.test(path)) return undefined;
  return looksLikePath(path) ? path : undefined;
}

/** Curl has data-bearing options whose values commonly contain `/`; only its file-bearing options are paths. */
function curlPaths(arguments_: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument.startsWith("file://")) {
      try {
        paths.push(fileURLToPath(argument));
      } catch {
        // Malformed file URLs remain policy-visible through the command text.
      }
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals > 0 ? argument.slice(0, equals) : argument;
    const inlineValue = equals > 0 ? argument.slice(equals + 1) : undefined;
    if (CURL_FILE_OPTIONS[option]) {
      const value = inlineValue ?? arguments_[++index];
      if (value && value !== "-") paths.push(value);
      continue;
    }
    if (CURL_AT_FILE_OPTIONS[option]) {
      const value = inlineValue ?? arguments_[++index];
      const path = value ? curlEmbeddedFile(value) : undefined;
      if (path) paths.push(path);
      continue;
    }
    if (!/^-[^-].+/.test(argument)) continue;
    const short = argument.slice(1);
    for (let offset = 0; offset < short.length; offset++) {
      const flag = short[offset]!;
      const attached = short.slice(offset + 1);
      if (CURL_SHORT_FILE_OPTIONS[flag]) {
        const value = attached || arguments_[++index];
        if (value && value !== "-") paths.push(value);
        break;
      }
      if (CURL_SHORT_AT_FILE_OPTIONS[flag]) {
        const value = attached || arguments_[++index];
        const path = value ? curlEmbeddedFile(value) : undefined;
        if (path) paths.push(path);
        break;
      }
      if (CURL_SHORT_VALUE_OPTIONS[flag]) {
        if (!attached) index++;
        break;
      }
    }
  }
  return paths;
}

const DATA_ONLY_COMMANDS: Record<string, true> = {
  echo: true,
  printf: true,
  type: true,
  whereis: true,
  which: true,
};

const GIT_FILE_OPTIONS: Record<string, true> = {
  "-C": true,
  "--git-dir": true,
  "--work-tree": true,
  "-F": true,
  "--file": true,
  "--pathspec-from-file": true,
  "--exclude-from": true,
  "--output": true,
};

const GIT_TEXT_OPTIONS: Record<string, true> = {
  "-m": true,
  "--message": true,
  "--author": true,
  "--date": true,
  "--format": true,
  "--pretty": true,
  "--grep": true,
  "--exec": true,
  "--upload-pack": true,
};

const GIT_PATH_SUBCOMMANDS: Record<string, true> = {
  add: true, apply: true, archive: true, blame: true, "check-ignore": true, clean: true,
  diff: true, grep: true, "ls-files": true, log: true, mv: true, restore: true, rm: true,
  show: true, status: true,
};

function gitPathspecPath(argument: string): string | undefined {
  let path = argument;
  if (path.startsWith(":(")) {
    const close = path.indexOf(")");
    if (close < 0) return undefined;
    path = path.slice(close + 1);
  } else if (/^:[:!^/]/.test(path)) {
    path = path.slice(2);
  }
  return path && looksLikePath(path) ? path : undefined;
}

/** Git revisions and messages commonly contain `/`; only explicit path positions are assessed. */
function gitPaths(arguments_: readonly string[]): string[] {
  const paths: string[] = [];
  let subcommand: string | undefined;
  let afterSeparator = false;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals > 0 ? argument.slice(0, equals) : argument;
    const inlineValue = equals > 0 ? argument.slice(equals + 1) : undefined;
    if (subcommand === "clean" && (option === "-e" || option === "--exclude")) {
      if (inlineValue === undefined) index++;
      continue;
    }
    if (GIT_FILE_OPTIONS[option]) {
      const value = inlineValue ?? arguments_[++index];
      if (value && looksLikePath(value)) paths.push(value);
      continue;
    }
    if (GIT_TEXT_OPTIONS[option]) {
      if (inlineValue === undefined) index++;
      continue;
    }
    if (argument.startsWith("-")) continue;
    if (!subcommand) {
      subcommand = argument;
      continue;
    }
    if (afterSeparator || GIT_PATH_SUBCOMMANDS[subcommand] || /^(?:\/|\.\/|\.\.\/|~(?:\/|$))/.test(argument)) {
      const path = gitPathspecPath(argument);
      if (path) paths.push(path);
    }
  }
  return paths;
}

const SSH_FILE_OPTIONS: Record<string, true> = {
  "-i": true, "-F": true, "-E": true, "-S": true,
};
const SSH_VALUE_OPTIONS: Record<string, true> = {
  "-B": true, "-b": true, "-c": true, "-D": true, "-I": true, "-J": true, "-L": true,
  "-l": true, "-m": true, "-O": true, "-o": true, "-p": true, "-Q": true, "-R": true,
  "-W": true, "-w": true,
};
const SSH_O_FILE_KEYS: Record<string, true> = {
  certificatefile: true,
  globalknownhostsfile: true,
  identityfile: true,
  revokedhostkeys: true,
  userknownhostsfile: true,
};

function sshConfigPath(value: string): string | undefined {
  const equals = value.indexOf("=");
  if (equals < 0) return undefined;
  const key = value.slice(0, equals).toLowerCase();
  const path = value.slice(equals + 1);
  return SSH_O_FILE_KEYS[key] && looksLikePath(path) ? path : undefined;
}

/** SSH operands after the destination are programs for the remote host, not local paths. */
function sshPaths(arguments_: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (SSH_FILE_OPTIONS[argument]) {
      const value = arguments_[++index];
      if (value && looksLikePath(value)) paths.push(value);
      continue;
    }
    const attachedFile = /^(-[iFES])(.+)$/.exec(argument);
    if (attachedFile?.[2] && looksLikePath(attachedFile[2])) {
      paths.push(attachedFile[2]);
      continue;
    }
    if (SSH_VALUE_OPTIONS[argument]) {
      const value = arguments_[++index];
      if (argument === "-o" && value) {
        const path = sshConfigPath(value);
        if (path) paths.push(path);
      }
      continue;
    }
    const attachedValue = /^(-[BbcdIJLlmOoPpQRWw])(.+)$/.exec(argument);
    if (attachedValue) {
      if (attachedValue[1] === "-o") {
        const path = sshConfigPath(attachedValue[2]!);
        if (path) paths.push(path);
      }
      continue;
    }
    if (!argument.startsWith("-")) break;
  }
  return paths;
}

const OMP_FILE_OPTIONS: Record<string, true> = {
  "--config": true,
  "--extension": true,
  "-e": true,
  "--plugin-dir": true,
  "--cwd": true,
};

/** OMP model identifiers and prompts are data; only explicit config/code/workspace options are paths. */
function ompPaths(arguments_: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    const equals = argument.indexOf("=");
    const option = equals > 0 ? argument.slice(0, equals) : argument;
    if (!OMP_FILE_OPTIONS[option]) continue;
    const value = equals > 0 ? argument.slice(equals + 1) : arguments_[++index];
    if (value && looksLikePath(value)) paths.push(value);
  }
  return paths;
}

function commandPaths(unit: BashCommandUnit): string[] {
  if (!unit.executable) return [];
  if (unit.executable === "sed") return sedOperands(unit.arguments).paths;
  if (unit.executable === "awk") return awkOperands(unit.arguments).paths;
  if (["grep", "rg", "ag", "ack"].includes(unit.executable)) return textSearchPaths(unit.arguments);
  if (unit.executable === "curl") return curlPaths(unit.arguments);
  if (unit.executable === "git") return gitPaths(unit.arguments);
  if (unit.executable === "ssh") return sshPaths(unit.arguments);
  if (unit.executable === "omp") return ompPaths(unit.arguments);
  if (unit.executable === "command" && unit.arguments[0] === "-v") return [];
  if (DATA_ONLY_COMMANDS[unit.executable]) return [];
  const positional = unit.arguments.filter((word) => !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const optionValues = unit.arguments.flatMap((word) => {
    const match = /^--[^=]+=(.+)$/.exec(word);
    return match?.[1] && looksLikePath(match[1]) ? [match[1]] : [];
  });
  const candidates = [...positional, ...optionValues];
  // Bare credential names are assessed; other bare names would need the
  // command's own argument grammar, so only words with path structure qualify.
  return candidates.filter((word) => word.includes("/")
    ? looksLikePath(word)
    : /^(?:\.\/|\.\.\/|~(?:\/|$))/.test(word) || isSensitiveBasename(word));
}


function lastCommand(node: Node): Node | undefined {
  if (node.type === "command") return node;
  for (let index = node.childCount - 1; index >= 0; index--) {
    const child = node.child(index);
    if (!child?.isNamed) continue;
    const command = lastCommand(child);
    if (command) return command;
  }
  return undefined;
}

function hasFilesystemRedirect(node: Node): boolean {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child?.isNamed || !/redirect/.test(child.type)) continue;
    if (/heredoc|here[_-]?string/i.test(child.type) || /^\d*<<<?/.test(child.text.trimStart())) continue;
    const destination = child.childForFieldName("destination");
    if (!destination || destination.type === "number" || destination.text === "-" || destination.text === "/dev/null") continue;
    return true;
  }
  return false;
}

function walkCommands(
  node: Node,
  units: BashCommandUnit[],
  redirectTargets: readonly Node[] = [],
  backgrounded = false,
): void {
  let nextRedirectTargets = redirectTargets;
  if (node.type === "redirected_statement" && hasFilesystemRedirect(node)) {
    const body = node.childForFieldName("body");
    const target = body ? lastCommand(body) : undefined;
    if (target) nextRedirectTargets = [...redirectTargets, target];
  }
  const nextBackgrounded = backgrounded || node.type === "backgrounded_statement";
  if (node.type === "command") {
    const text = node.text.trim();
    const { executable, words } = commandParts(text);
    const redirected = nextRedirectTargets.some((target) =>
      target.startIndex === node.startIndex && target.endIndex === node.endIndex
    );
    units.push({
      text,
      executable,
      executableWord: words[0],
      arguments: words.slice(1),
      safety: commandSafety(text, redirected, nextBackgrounded),
    });
  }
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child?.isNamed) walkCommands(child, units, nextRedirectTargets, nextBackgrounded);
  }
}

function collectRedirectPaths(node: Node, paths: string[]): void {
  if (node.type !== "redirected_statement"
    && /redirect/.test(node.type)
    && !/heredoc|here[_-]?string/i.test(node.type)) {
    const destination = node.childForFieldName("destination");
    const candidate = destination ? shellWords(destination.text).at(-1) : undefined;
    if (candidate && !/^\d+$/.test(candidate) && candidate !== "-" && candidate !== "/dev/null") {
      paths.push(candidate);
    }
  }
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child?.isNamed) collectRedirectPaths(child, paths);
  }
}

function opaqueShellPayload(unit: BashCommandUnit): string | undefined {
  const { executable, words } = commandParts(unit.text);
  if (!executable || !SHELLS[executable]) return undefined;
  const flagIndex = words.findIndex((word, index) => index > 0 && /^-[^-]*c/.test(word));
  if (flagIndex < 0) return undefined;
  const payloadIndex = words[flagIndex + 1] === "--" ? flagIndex + 2 : flagIndex + 1;
  return words[payloadIndex];
}

export async function analyzeBash(command: string): Promise<BashAnalysis> {
  await warmBashParser();
  const parser = await parserPromise!;
  const tree = parser.parse(command);
  if (!tree) return { commands: [], paths: [], malformed: true };
  const commands: BashCommandUnit[] = [];
  const paths: string[] = [];
  let malformed: boolean;
  try {
    walkCommands(tree.rootNode, commands);
    paths.push(...commands.flatMap(commandPaths));
    collectRedirectPaths(tree.rootNode, paths);
    malformed = tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
  let hardDenyReason = catastrophicReason(command, commands);
  for (const unit of [...commands]) {
    const payload = opaqueShellPayload(unit);
    if (!payload) continue;
    const nested = await analyzeBash(payload);
    commands.push(...nested.commands);
    paths.push(...nested.paths);
    malformed ||= nested.malformed;
    hardDenyReason ??= nested.catastrophicReason;
  }
  return {
    commands,
    paths: [...new Set(paths)],
    malformed,
    catastrophicReason: hardDenyReason,
  };
}
