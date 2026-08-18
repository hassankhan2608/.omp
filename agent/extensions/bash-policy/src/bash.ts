import { createRequire } from "node:module";
import { homedir } from "node:os";
import { Language, Parser, type Node } from "web-tree-sitter";

export interface BashCommandUnit {
  text: string;
  executable?: string;
  arguments: string[];
  forceAskReason?: string;
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
  chroot: true,
  command: true,
  doas: true,
  env: true,
  eval: true,
  exec: true,
  flock: true,
  nice: true,
  nohup: true,
  parallel: true,
  "rust-parallel": true,
  rush: true,
  setsid: true,
  stdbuf: true,
  su: true,
  sudo: true,
  timeout: true,
  time: true,
  watch: true,
  xargs: true,
};
const SHELLS: Record<string, true> = {
  bash: true,
  dash: true,
  fish: true,
  ksh: true,
  sh: true,
  zsh: true,
};
const PATH_COMMANDS: Record<string, true> = {
  cat: true,
  cd: true,
  chmod: true,
  chown: true,
  cp: true,
  du: true,
  file: true,
  head: true,
  less: true,
  ln: true,
  ls: true,
  mkdir: true,
  mv: true,
  readlink: true,
  realpath: true,
  rm: true,
  rmdir: true,
  stat: true,
  tail: true,
  tee: true,
  touch: true,
  tree: true,
  wc: true,
};
const SEARCH_COMMANDS: Record<string, true> = {
  ack: true,
  ag: true,
  fd: true,
  find: true,
  grep: true,
  locate: true,
  rg: true,
};
const SENSITIVE_BASENAMES: Record<string, true> = {
  ".env": true,
  ".netrc": true,
  ".npmrc": true,
  ".pypirc": true,
  credentials: true,
  id_ed25519: true,
  id_rsa: true,
};

function commandParts(text: string): { executable?: string; words: string[] } {
  const words = shellWords(text);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  const commandName = words[index];
  const executable = commandName?.split("/").at(-1)?.toLowerCase();
  return { executable, words: words.slice(index) };
}

function commandForceAskReason(text: string, redirected: boolean, backgrounded: boolean): string | undefined {
  const { executable, words } = commandParts(text);
  if (!executable) return "Dynamic or empty command name";
  if (/[$`]/.test(words[0] ?? "")) return "Dynamic command name";
  if (redirected) return "Shell redirection";
  if (backgrounded) return "Background execution";
  if (ALWAYS_INDIRECT[executable]) return `Command indirection through ${executable}`;
  if (SHELLS[executable] && words.slice(1).some((word) => /^-[^-]*c/.test(word))) {
    return `Opaque shell program through ${executable} -c`;
  }
  return undefined;
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
      const recursiveForce = recursive && force;
      if (recursiveForce && destructiveTarget) return "Recursive forced deletion of a root or home path";
    }
    if (["chmod", "chown"].includes(executable) && words.includes("-R") && words.some((word) => word === "/" || word === "/*")) {
      return `Recursive ${executable} of the filesystem root`;
    }
  }
  return undefined;
}

function looksLikePath(word: string): boolean {
  if (!word || word === "-" || word.startsWith("--")) return false;
  if (/^(?:[A-Za-z]+:)?\/\//.test(word)) return false;
  const basename = word.split("/").at(-1) ?? word;
  return word.startsWith("/") || word.startsWith("./") || word.startsWith("../") || word.startsWith("~") || word.includes("/") || word.startsWith(".") || SENSITIVE_BASENAMES[basename] === true;
}

function commandPaths(unit: BashCommandUnit): string[] {
  if (!unit.executable) return [];
  const positional = unit.arguments.filter(
    (word) => !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word),
  );
  const optionValues = unit.arguments.flatMap((word) => {
    const match = /^--[^=]+=(.+)$/.exec(word);
    return match?.[1] && looksLikePath(match[1]) ? [match[1]] : [];
  });
  const candidates = [...positional, ...optionValues];
  if (PATH_COMMANDS[unit.executable]) return candidates;
  if (SEARCH_COMMANDS[unit.executable]) return candidates.filter(looksLikePath);
  return candidates.filter(looksLikePath);
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
    const destination = child.childForFieldName("destination");
    if (!destination || destination.type === "number" || destination.text === "-") continue;
    if (destination.text === "/dev/null") continue;
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
    const redirected = nextRedirectTargets.some(
      (target) => target.startIndex === node.startIndex && target.endIndex === node.endIndex,
    );
    units.push({
      text,
      executable,
      arguments: words.slice(1),
      forceAskReason: commandForceAskReason(text, redirected, nextBackgrounded),
    });
  }

  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child?.isNamed) walkCommands(child, units, nextRedirectTargets, nextBackgrounded);
  }
}

function collectRedirectPaths(node: Node, paths: string[]): void {
  if (/redirect/.test(node.type)) {
    const words = shellWords(node.text.replace(/^\d*[<>]+&?/, "").trim());
    const candidate = words.at(-1);
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
