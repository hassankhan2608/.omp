import { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export const ZCODE_MODELS: ProviderModelConfig[] = [
  {
    id: "glm-5.3",
    name: "GLM-5.3 (ZCode Start Plan)",
    reasoning: true,
    thinking: {
      mode: "anthropic-budget-effort",
      efforts: [Effort.Low, Effort.High, Effort.Max],
      defaultLevel: Effort.Max,
    },
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "glm-5-turbo",
    name: "GLM-5-Turbo (ZCode Start Plan)",
    reasoning: true,
    thinking: {
      mode: "budget",
      efforts: [Effort.Low],
      defaultLevel: Effort.Low,
    },
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
];
