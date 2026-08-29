import { isAbsolute, join } from "node:path";
import type { BellConfig, BellEvent } from "./config";

export type SpawnPlayer = (command: string[]) => void;
export type RingTerminal = () => void | Promise<void>;

export interface NotifierRuntime {
  now: () => number;
  spawn: SpawnPlayer;
  ring: RingTerminal;
}

export function buildPlayCommand(soundFile: string, platform = process.platform): string[] {
  if (platform === "darwin") return ["afplay", soundFile];
  if (platform === "win32") {
    const escaped = soundFile.replaceAll("'", "''");
    return ["powershell", "-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`];
  }
  return ["paplay", soundFile];
}

export function resolveSoundPath(extensionDir: string, file: string): string {
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return file;
  return join(extensionDir, "sounds", file);
}

const DEFAULT_RUNTIME: NotifierRuntime = {
  now: Date.now,
  spawn: (command) => {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
  },
  ring: () => Bun.write(Bun.stdout, "\x07").then(() => undefined),
};

export class TerminalNotifier {
  readonly #config: BellConfig;
  readonly #extensionDir: string;
  readonly #runtime: NotifierRuntime;
  #lastNotificationAt = Number.NEGATIVE_INFINITY;

  constructor(config: BellConfig, extensionDir: string, runtime: NotifierRuntime = DEFAULT_RUNTIME) {
    this.#config = config;
    this.#extensionDir = extensionDir;
    this.#runtime = runtime;
  }

  async notify(event: BellEvent): Promise<boolean> {
    if (!this.#config.enabled) return false;
    const sound = this.#config.sounds[this.#config.events[event]];
    if (!sound?.enabled) return false;

    const now = this.#runtime.now();
    if (now - this.#lastNotificationAt < this.#config.debounceMs) return false;
    this.#lastNotificationAt = now;

    try {
      this.#runtime.spawn(buildPlayCommand(resolveSoundPath(this.#extensionDir, sound.file)));
    } catch {
      // Audio is advisory; a missing player must never interrupt OMP.
    }

    if (this.#config.focusTerminal) {
      try {
        await this.#runtime.ring();
      } catch {
        // Terminal focus is advisory for the same reason.
      }
    }
    return true;
  }
}
