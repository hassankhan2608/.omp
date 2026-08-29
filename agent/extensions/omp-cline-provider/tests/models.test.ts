import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@cline/llms";
import {
  fetchRecommendedFreeIds,
  loadFreeClineModels,
} from "../src/models.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const freePayload = (...ids: string[]) => ({
  free: ids.map((id) => ({ id, name: id, description: "", tags: [] })),
});

const catalog: Record<string, ModelInfo> = {
  "z-ai/glm-5.3-flash": {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 200_000,
    maxTokens: 32_000,
    capabilities: ["tools", "reasoning", "images"],
    modalities: { input: ["text", "image"], output: ["text"] },
    systemRole: "system",
    pricing: { input: 1.25, output: 4.5 },
  },
  "paid/model": {
    id: "paid/model",
    name: "Paid",
    contextWindow: 128_000,
    maxTokens: 8_192,
    capabilities: ["tools"],
    pricing: { input: 0, output: 0 },
  },
  "suffix/model:free": {
    id: "suffix/model:free",
    name: "Suffix only",
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

describe("fetchRecommendedFreeIds", () => {
  test("accepts only a non-empty free string array", async () => {
    const ids = await fetchRecommendedFreeIds(async () =>
      response(freePayload("z-ai/glm-5.3-flash")),
    );
    expect([...ids]).toEqual(["z-ai/glm-5.3-flash"]);

    for (const payload of [{}, { free: [] }, { free: [1] }, { free: [""] }]) {
      await expect(
        fetchRecommendedFreeIds(async () => response(payload)),
      ).rejects.toThrow();
    }
  });

  test("deduplicates exact ids", async () => {
    const ids = await fetchRecommendedFreeIds(async () =>
      response(freePayload("a/model", "a/model", "b/model")),
    );
    expect([...ids]).toEqual(["a/model", "b/model"]);
  });

  test("reports an HTTP status without exposing the response body", async () => {
    const promise = fetchRecommendedFreeIds(async () =>
      response({ accessToken: "secret" }, 503),
    );
    await expect(promise).rejects.toThrow("503");
    await expect(promise).rejects.not.toThrow("secret");
  });
});

describe("loadFreeClineModels", () => {
  test("intersects exact live free ids with valid Cline chat metadata", async () => {
    const models = await loadFreeClineModels({
      fetchImpl: async () =>
        response(freePayload("z-ai/glm-5.3-flash", "unknown/model")),
      loadCatalog: async () => ({ ...catalog }),
    });

    expect(models.map((model) => model.id)).toEqual([
      "z-ai/glm-5.3-flash",
    ]);
    expect(models[0]).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      supportsTools: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    });
  });

  test("does not infer free status from price or suffix", async () => {
    const models = await loadFreeClineModels({
      fetchImpl: async () => response(freePayload("z-ai/glm-5.3-flash")),
      loadCatalog: async () => ({ ...catalog }),
    });
    expect(models.some(({ id }) => id === "paid/model")).toBe(false);
    expect(models.some(({ id }) => id === "suffix/model:free")).toBe(false);
  });

  test("omits free ids with invalid required metadata", async () => {
    const models = await loadFreeClineModels({
      fetchImpl: async () =>
        response(freePayload("invalid/context", "z-ai/glm-5.3-flash")),
      loadCatalog: async () => ({
        ...catalog,
        "invalid/context": {
          id: "invalid/context",
          contextWindow: 0,
          maxTokens: Number.NaN,
        },
      }),
    });
    expect(models.map(({ id }) => id)).toEqual(["z-ai/glm-5.3-flash"]);
  });

  test("maps developer role support only when Cline declares it", async () => {
    const models = await loadFreeClineModels({
      fetchImpl: async () =>
        response(freePayload("developer/model", "default/model")),
      loadCatalog: async () => ({
        "developer/model": {
          id: "developer/model",
          contextWindow: 64_000,
          maxTokens: 4_096,
          systemRole: "developer",
        },
        "default/model": {
          id: "default/model",
          contextWindow: 64_000,
          maxTokens: 4_096,
        },
      }),
    });
    expect(models.map(({ compat }) =>
      compat && "supportsDeveloperRole" in compat
        ? compat.supportsDeveloperRole
        : undefined,
    )).toEqual([
      false,
      true,
    ]);
  });

  test("prefers GLM Flash then sorts remaining ids deterministically", async () => {
    const model = (id: string): ModelInfo => ({
      id,
      contextWindow: 64_000,
      maxTokens: 4_096,
    });
    const models = await loadFreeClineModels({
      fetchImpl: async () =>
        response(freePayload("z/model", "z-ai/glm-5.3-flash", "a/model")),
      loadCatalog: async () => ({
        "z/model": model("z/model"),
        "z-ai/glm-5.3-flash": model("z-ai/glm-5.3-flash"),
        "a/model": model("a/model"),
      }),
    });
    expect(models.map(({ id }) => id)).toEqual([
      "z-ai/glm-5.3-flash",
      "a/model",
      "z/model",
    ]);
  });

  test("fails closed when no valid free model remains", async () => {
    await expect(
      loadFreeClineModels({
        fetchImpl: async () => response(freePayload("unknown/model")),
        loadCatalog: async () => ({ ...catalog }),
      }),
    ).rejects.toThrow("Cline free model catalog is empty");
  });
});
