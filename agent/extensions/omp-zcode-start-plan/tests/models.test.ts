import { Effort } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import { ZCODE_MODELS } from "../src/models";

test("publishes the Start Plan model limits", () => {
  expect(ZCODE_MODELS.map((model) => [model.id, model.contextWindow, model.maxTokens])).toEqual([
    ["glm-5.3", 1_000_000, 128_000],
    ["glm-5-turbo", 200_000, 128_000],
  ]);
  expect(ZCODE_MODELS[0]?.thinking).toEqual({
    mode: "anthropic-budget-effort",
    efforts: [Effort.Low, Effort.High, Effort.Max],
    defaultLevel: Effort.Max,
  });
  expect(ZCODE_MODELS[1]?.thinking).toEqual({
    mode: "budget",
    efforts: [Effort.Low],
    defaultLevel: Effort.Low,
  });
});
