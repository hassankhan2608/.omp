import { commandSafetyFor, type BashCommandUnit, type CommandSafety } from "./shell";

/**
 * Policy-facing view of one Bash command unit.
 *
 * `display` is what the user sees and what the shell runs. `canonical` is the
 * normalized spelling used for allowlist lookup, grant matching, and grant
 * creation, so semantically identical invocations share one approval identity.
 */
export interface CommandIdentity {
  display: string;
  canonical: string;
  executable?: string;
  arguments: string[];
  paths: string[];
  safety?: CommandSafety;
}

/** Wrappers whose only effect is running another command under a limit or timer. */
const PEELABLE_WRAPPERS: Record<string, true> = { timeout: true, time: true };

/**
 * Indirection floors this module can actually resolve. Any other wrapper
 * (`eval`, `env`, `xargs`, `nohup`, `watch`, …) keeps its always-ask floor,
 * because the command it runs is data we cannot classify.
 */
const NORMALIZABLE_INDIRECTION: Record<string, true> = { timeout: true, time: true, command: true };

/**
 * Executables that can run arbitrary programs. A wrapper around any of these
 * cannot inherit the inner command's policy, because the inner text is data.
 */
const INTERPRETERS: Record<string, true> = {
  bash: true, bun: true, bunx: true, chroot: true, dash: true, deno: true, doas: true, env: true,
  eval: true, exec: true, fish: true, flock: true, ksh: true, nice: true, node: true, nohup: true,
  npx: true, osascript: true, parallel: true, perl: true, php: true, python: true, python3: true,
  ruby: true, "rust-parallel": true, rush: true, setsid: true, sh: true, stdbuf: true, su: true,
  sudo: true, watch: true, xargs: true, zsh: true,
};

/** `timeout` options that never redirect output or change the child program. */
const TIMEOUT_FLAGS: Record<string, true> = {
  "--preserve-status": true, "--foreground": true, "-v": true, "--verbose": true,
};
const TIMEOUT_VALUE_OPTIONS: Record<string, true> = {
  "-k": true, "--kill-after": true, "-s": true, "--signal": true,
};
const TIMEOUT_DURATION = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/;

/** POSIX `time` reporting flags. GNU `-o`/`-a` write files and are excluded. */
const TIME_FLAGS: Record<string, true> = { "-p": true, "--portability": true };

const GIT_PATH_OPTIONS: Record<string, true> = {
  "-C": true, "--git-dir": true, "--work-tree": true,
};

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;
const MAX_PEEL_DEPTH = 4;

function renderCommand(executable: string, arguments_: readonly string[]): string {
  const quoted = [executable, ...arguments_].map((token) =>
    SHELL_SAFE_TOKEN.test(token) ? token : `'${token.replaceAll("'", String.raw`'\''`)}'`,
  );
  return quoted.join(" ");
}

interface Resolution {
  executable: string;
  arguments: string[];
  paths: string[];
  safety?: CommandSafety;
}

/** Strip Git global options that relocate the repository without changing the operation. */
function resolveGit(arguments_: readonly string[]): Resolution {
  const paths: string[] = [];
  let index = 0;
  while (index < arguments_.length) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-")) break;
    const separatorIndex = argument.indexOf("=");
    const name = separatorIndex > 0 ? argument.slice(0, separatorIndex) : argument;
    if (!GIT_PATH_OPTIONS[name]) {
      return {
        executable: "git",
        arguments: [...arguments_],
        paths,
        safety: {
          reason: `Git global option ${name} can change configuration or program resolution`,
          persistable: false,
        },
      };
    }
    if (separatorIndex > 0) {
      paths.push(argument.slice(separatorIndex + 1));
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      return {
        executable: "git",
        arguments: [...arguments_],
        paths,
        safety: { reason: `Git global option ${name} is missing its value`, persistable: false },
      };
    }
    paths.push(value);
    index += 2;
  }
  const remaining = arguments_.slice(index);
  if (remaining.length === 0) {
    return {
      executable: "git",
      arguments: [...arguments_],
      paths,
      safety: { reason: "Git command has no subcommand to classify", persistable: false },
    };
  }
  return { executable: "git", arguments: remaining, paths };
}

/** Peel `timeout`/`time` wrappers, or accept the exact `command -v NAME` lookup form. */
function resolveWrapper(
  executable: string,
  arguments_: readonly string[],
  depth: number,
): Resolution {
  const unchanged: Resolution = {
    executable,
    arguments: [...arguments_],
    paths: [],
    safety: { reason: `Command indirection through ${executable}`, persistable: false },
  };
  if (depth >= MAX_PEEL_DEPTH) {
    return { ...unchanged, safety: { reason: "Nested command wrappers are too deep to classify", persistable: false } };
  }

  let index = 0;
  if (executable === "timeout") {
    while (index < arguments_.length) {
      const argument = arguments_[index]!;
      if (!argument.startsWith("-")) break;
      const separatorIndex = argument.indexOf("=");
      const name = separatorIndex > 0 ? argument.slice(0, separatorIndex) : argument;
      if (TIMEOUT_FLAGS[name]) index += 1;
      else if (TIMEOUT_VALUE_OPTIONS[name]) index += separatorIndex > 0 ? 1 : 2;
      else {
        return { ...unchanged, safety: { reason: `Unsupported timeout option ${name}`, persistable: false } };
      }
    }
    const duration = arguments_[index];
    if (duration === undefined || !TIMEOUT_DURATION.test(duration)) {
      return { ...unchanged, safety: { reason: "timeout duration could not be identified", persistable: false } };
    }
    index += 1;
  } else if (executable === "time") {
    while (index < arguments_.length && arguments_[index]!.startsWith("-")) {
      const argument = arguments_[index]!;
      if (argument === "-o" || argument.startsWith("--output")) {
        return { ...unchanged, safety: { reason: "time can write timing output to a file", persistable: false } };
      }
      if (!TIME_FLAGS[argument]) {
        return { ...unchanged, safety: { reason: `Unsupported time option ${argument}`, persistable: false } };
      }
      index += 1;
    }
  }

  const childName = arguments_[index];
  if (childName === undefined) {
    return { ...unchanged, safety: { reason: `${executable} has no wrapped command`, persistable: false } };
  }
  const childExecutable = childName.split("/").at(-1)?.toLowerCase();
  if (!childExecutable || /[$`]/.test(childName)) {
    return { ...unchanged, safety: { reason: "Wrapped command name is dynamic", persistable: false } };
  }
  if (childName.toLowerCase() !== childExecutable) {
    return {
      ...unchanged,
      safety: { reason: "Wrapped command uses a path-qualified executable", persistable: false },
    };
  }
  if (INTERPRETERS[childExecutable]) {
    return {
      ...unchanged,
      safety: { reason: `Wrapped interpreter ${childExecutable} cannot be normalized safely`, persistable: false },
    };
  }
  return resolveCommandShape(childExecutable, arguments_.slice(index + 1), depth + 1);
}

function resolveCommandShape(
  executable: string,
  arguments_: readonly string[],
  depth: number,
): Resolution {
  if (executable === "git") return resolveGit(arguments_);
  if (PEELABLE_WRAPPERS[executable]) return resolveWrapper(executable, arguments_, depth);
  if (executable === "command") {
    const names = arguments_.filter((argument) => !argument.startsWith("-"));
    if (arguments_[0] !== "-v" || names.length !== 1 || arguments_.length !== 2) {
      return {
        executable,
        arguments: [...arguments_],
        paths: [],
        safety: { reason: "Only the exact command -v NAME lookup form is recognized", persistable: false },
      };
    }
    return { executable, arguments: [...arguments_], paths: [] };
  }
  return { executable, arguments: [...arguments_], paths: [] };
}

/**
 * Derive the policy identity for one parsed command unit.
 *
 * Normalization is conservative: anything that cannot be proven equivalent
 * keeps its original spelling and carries an always-ask safety floor.
 */
export function canonicalizeCommand(unit: BashCommandUnit): CommandIdentity {
  const base: CommandIdentity = {
    display: unit.text,
    canonical: unit.text,
    ...(unit.executable ? { executable: unit.executable } : {}),
    arguments: [...unit.arguments],
    paths: [],
    ...(unit.safety ? { safety: unit.safety } : {}),
  };
  if (!unit.executable) return base;

  // A path-qualified command runs an on-disk binary that merely shares a name
  // with a trusted tool, so it must never inherit that tool's policy.
  if (unit.executableWord !== undefined && unit.executableWord.toLowerCase() !== unit.executable) return base;

  // Floors describing the invocation itself (redirection, background execution,
  // inline environment, opaque interpreters) survive normalization. Only
  // indirection this module can actually resolve may be re-derived.
  if (unit.safety && !(unit.safety.indirection !== undefined && NORMALIZABLE_INDIRECTION[unit.safety.indirection])) {
    return base;
  }

  const resolved = resolveCommandShape(unit.executable, unit.arguments, 0);
  const safety = resolved.safety ?? commandSafetyFor(resolved.executable, resolved.arguments);
  return {
    display: unit.text,
    canonical: renderCommand(resolved.executable, resolved.arguments),
    executable: resolved.executable,
    arguments: resolved.arguments,
    paths: resolved.paths,
    ...(safety ? { safety } : {}),
  };
}
