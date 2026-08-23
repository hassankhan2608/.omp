import blocks from "./zcode-system.json" with { type: "json" };
import { isRecord } from "./type-guards";

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

const ZCODE_SYSTEM_BLOCKS: readonly SystemBlock[] = blocks as SystemBlock[];

function normalizeUserSystem(system: unknown): SystemBlock[] {
  if (system === null || system === undefined) return [];
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(system)) return [];
  const normalized: SystemBlock[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) normalized.push({ type: "text", text: item });
      continue;
    }
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string" || !item.text.trim()) continue;
    normalized.push({
      type: "text",
      text: item.text,
      ...(isRecord(item.cache_control) && item.cache_control.type === "ephemeral"
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    });
  }
  return normalized;
}

export function buildZcodeSystem(existingSystem: unknown, currentModel: string): SystemBlock[] {
  return [
    ...ZCODE_SYSTEM_BLOCKS.map((block) => structuredClone(block)),
    {
      type: "text",
      text: `- You are powered by the model named ${currentModel}.`,
      cache_control: { type: "ephemeral" },
    },
    ...normalizeUserSystem(existingSystem),
  ];
}
