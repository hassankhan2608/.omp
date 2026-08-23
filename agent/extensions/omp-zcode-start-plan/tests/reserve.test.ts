import { isUsageLimit, status } from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import { checkZcodeUsageReserve } from "../src/reserve";

function balanceFetch(balances: unknown[]): FetchImpl {
  return async () => new Response(JSON.stringify({ code: 0, data: { balances } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const baseBalance = {
  show_name: "GLM-5.3",
  total_units: 100_000,
  expires_at: 2_000,
};

test("raises OMP's usage-limit signal when every relevant entitlement reaches the 98 percent reserve", async () => {
  const fetchImpl = balanceFetch([
    { ...baseBalance, entitlement_id: "weekend", used_units: 98_000, remaining_units: 2_000 },
    { ...baseBalance, entitlement_id: "trial", used_units: 99_000, remaining_units: 1_000 },
  ]);

  let caught: unknown;
  try {
    await checkZcodeUsageReserve(fetchImpl, "plan-jwt", "GLM-5.3", { now: 1_000_000 });
  } catch (error) {
    caught = error;
  }

  expect(isUsageLimit(caught)).toBe(true);
  expect(status(caught)).toBe(429);
  expect(caught).toMatchObject({ code: "zcode_usage_reserve" });
  if (!caught || typeof caught !== "object" || !("headers" in caught) || !(caught.headers instanceof Headers)) {
    throw new Error("usage-limit error omitted response headers");
  }
  expect(caught.headers.get("retry-after")).toBe("1000");
});

test("keeps an account eligible while any relevant entitlement remains below reserve", async () => {
  const fetchImpl = balanceFetch([
    { ...baseBalance, entitlement_id: "weekend", used_units: 99_000, remaining_units: 1_000 },
    { ...baseBalance, entitlement_id: "trial", used_units: 97_999, remaining_units: 2_001 },
    { ...baseBalance, entitlement_id: "turbo", show_name: "GLM-5-Turbo", used_units: 100_000, remaining_units: 0 },
  ]);

  await expect(checkZcodeUsageReserve(fetchImpl, "plan-jwt", "glm-5.3", { now: 1_000_000 })).resolves.toBeUndefined();
});

test("fails open when the balance endpoint is unavailable", async () => {
  const fetchImpl: FetchImpl = async () => new Response("unavailable", { status: 503 });
  await expect(checkZcodeUsageReserve(fetchImpl, "plan-jwt", "glm-5.3")).resolves.toBeUndefined();
});
