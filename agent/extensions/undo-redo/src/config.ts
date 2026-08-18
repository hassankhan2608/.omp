import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyId } from "@oh-my-pi/pi-coding-agent";

/** Keyboard shortcuts for the undo/redo extension. */
export interface UndoRedoConfig {
  /** Trigger the undo command. */
  undoKey: KeyId;
  /** Trigger the redo command. */
  redoKey: KeyId;
}

export const DEFAULT_CONFIG: UndoRedoConfig = {
  undoKey: "alt+u",
  redoKey: "alt+r",
};

const KEY_ID_PATTERN = /^([a-z]+\+)*[a-z0-9]+$/i;

/**
 * Validate a raw config object and merge it over {@link DEFAULT_CONFIG}.
 * A missing or malformed key falls back to the default rather than failing the
 * whole extension: undo/redo must keep working even when the config is broken.
 */
export function parseConfig(raw: unknown): { config: UndoRedoConfig; errors: string[] } {
  if (typeof raw !== "object" || raw === null) {
    return { config: DEFAULT_CONFIG, errors: ["config must be a JSON object"] };
  }
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  const result: UndoRedoConfig = { ...DEFAULT_CONFIG };

  for (const field of ["undoKey", "redoKey"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || !KEY_ID_PATTERN.test(value)) {
      errors.push(`${field} must be a key id like "alt+u" (got ${JSON.stringify(value)})`);
      continue;
    }
    result[field] = value as KeyId;
  }

  return { config: result, errors };
}

/**
 * Synchronous load for startup shortcut registration (registerShortcut is
 * called at factory time, before any event loop turn). Falls back to defaults
 * on any read/parse failure; broken config never blocks undo/redo.
 */
export function loadConfigSync(extensionDirectory: string): { config: UndoRedoConfig; errors: string[] } {
  const path = join(extensionDirectory, "undo-redo.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { config: DEFAULT_CONFIG, errors: [] };
    return { config: DEFAULT_CONFIG, errors: [`unable to read ${path}: ${String(error)}`] };
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    return { config: DEFAULT_CONFIG, errors: [`invalid JSON in ${path}: ${String(error)}`] };
  }
}

/**
 * Load `undo-redo.json` from the extension directory. A missing file is the
 * expected default state; malformed JSON is surfaced so the user can see why
 * their keys were ignored.
 */
export async function loadConfig(extensionDirectory: string): Promise<{ config: UndoRedoConfig; errors: string[] }> {
  const path = join(extensionDirectory, "undo-redo.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { config: DEFAULT_CONFIG, errors: [] };
    return { config: DEFAULT_CONFIG, errors: [`unable to read ${path}: ${String(error)}`] };
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    return { config: DEFAULT_CONFIG, errors: [`invalid JSON in ${path}: ${String(error)}`] };
  }
}
