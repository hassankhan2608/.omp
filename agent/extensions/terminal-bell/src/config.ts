import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const BELL_EVENTS = ["agent.complete", "approval.requested", "agent.error"] as const;
export type BellEvent = (typeof BELL_EVENTS)[number];

export interface SoundConfig {
  enabled: boolean;
  file: string;
}

export interface BellConfig {
  enabled: boolean;
  debounceMs: number;
  focusTerminal: boolean;
  sounds: Record<string, SoundConfig>;
  events: Record<BellEvent, string>;
}

export const DEFAULT_CONFIG: BellConfig = {
  enabled: true,
  debounceMs: 500,
  focusTerminal: false,
  sounds: {
    complete: { enabled: true, file: "complete.oga" },
    input: { enabled: true, file: "minecraft_item_drop.mp3" },
    error: { enabled: true, file: "message.oga" },
  },
  events: {
    "agent.complete": "complete",
    "approval.requested": "input",
    "agent.error": "error",
  },
};

const soundOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  file: z.string().min(1).optional(),
});

const rawConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  enabled: z.boolean().optional(),
  debounceMs: z.number().int().min(0).optional(),
  focusTerminal: z.boolean().optional(),
  sounds: z.record(z.string().min(1), soundOverrideSchema).optional(),
  events: z.partialRecord(z.enum(BELL_EVENTS), z.string().min(1)).optional(),
});

export async function loadConfig(extensionDir: string): Promise<BellConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(extensionDir, "config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw error;
  }

  const parsed = rawConfigSchema.parse(raw);
  const sounds: Record<string, SoundConfig> = structuredClone(DEFAULT_CONFIG.sounds);
  for (const [name, override] of Object.entries(parsed.sounds ?? {})) {
    const enabled = override.enabled ?? sounds[name]?.enabled;
    const file = override.file ?? sounds[name]?.file;
    if (typeof enabled !== "boolean" || !file) {
      throw new Error(`Sound ${JSON.stringify(name)} must define enabled and file`);
    }
    sounds[name] = { enabled, file };
  }

  return {
    enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
    debounceMs: parsed.debounceMs ?? DEFAULT_CONFIG.debounceMs,
    focusTerminal: parsed.focusTerminal ?? DEFAULT_CONFIG.focusTerminal,
    sounds,
    events: { ...DEFAULT_CONFIG.events, ...parsed.events },
  };
}
