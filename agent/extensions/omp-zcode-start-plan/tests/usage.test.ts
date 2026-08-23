import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import { parseBalanceReport, zcodeUsageProvider } from "../src/usage";

const payload = {
  code: 0,
  data: {
    plans: [
      { plan_id: "weekend", name: "ZCode Weekend Build", status: "active", ends_at: 1_787_533_200 },
    ],
    balances: [
      { entitlement_id: "ent_wk", show_name: "GLM-5.3", total_units: 100_000_000, used_units: 316, available_units: 99_999_684 },
      { entitlement_id: "ent_trial", show_name: "GLM-5.3", total_units: 3_000_000, used_units: 0, available_units: 3_000_000 },
      { entitlement_id: "ent_turbo", show_name: "GLM-5-Turbo", total_units: 2_000_000, used_units: 0, available_units: 2_000_000 },
    ],
  },
};

test("preserves every Start Plan entitlement as an account-scoped token bucket", () => {
  const report = parseBalanceReport(payload, { accountId: "acct-1", email: "one@example.com" }, 1_787_462_987_000);

  expect(report?.limits.map((limit) => ({
    id: limit.id,
    label: limit.label,
    amount: limit.amount,
    scope: limit.scope,
    status: limit.status,
  }))).toEqual([
    {
      id: "ent_wk",
      label: "GLM-5.3 · ent_wk",
      amount: { unit: "tokens", limit: 100_000_000, used: 316, remaining: 99_999_684, usedFraction: 0.00000316, remainingFraction: 0.99999684 },
      scope: { provider: "zcode-start-plan", accountId: "acct-1", modelId: "glm-5.3", shared: true },
      status: "ok",
    },
    {
      id: "ent_trial",
      label: "GLM-5.3 · ent_trial",
      amount: { unit: "tokens", limit: 3_000_000, used: 0, remaining: 3_000_000, usedFraction: 0, remainingFraction: 1 },
      scope: { provider: "zcode-start-plan", accountId: "acct-1", modelId: "glm-5.3", shared: true },
      status: "ok",
    },
    {
      id: "ent_turbo",
      label: "GLM-5-Turbo · ent_turbo",
      amount: { unit: "tokens", limit: 2_000_000, used: 0, remaining: 2_000_000, usedFraction: 0, remainingFraction: 1 },
      scope: { provider: "zcode-start-plan", accountId: "acct-1", modelId: "glm-5-turbo", shared: true },
      status: "ok",
    },
  ]);
  expect(report?.metadata).toMatchObject({
    accountId: "acct-1",
    email: "one@example.com",
    planId: "weekend",
    planName: "ZCode Weekend Build",
    planExpiresAt: 1_787_533_200_000,
  });
});

test("marks a token bucket warning at ninety percent and exhausted at its limit", () => {
  const warning = parseBalanceReport({
    code: 0,
    data: { balances: [{ entitlement_id: "warn", show_name: "GLM-5.3", total_units: 100, used_units: 90, remaining_units: 10 }] },
  }, {}, 1);
  const exhausted = parseBalanceReport({
    code: 0,
    data: { balances: [{ entitlement_id: "done", show_name: "GLM-5.3", total_units: 100, used_units: 100, remaining_units: 0 }] },
  }, {}, 1);

  expect(warning?.limits[0]?.status).toBe("warning");
  expect(exhausted?.limits[0]?.status).toBe("exhausted");
});

test("fetches the same versioned balance endpoint as ZCode", async () => {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  const report = await zcodeUsageProvider.fetchUsage({
    provider: "zcode-start-plan",
    credential: {
      type: "oauth",
      accessToken: "plan-jwt",
      accountId: "acct-1",
      email: "one@example.com",
    },
  }, { fetch: fetchImpl });

  expect(urls).toEqual([
    "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.8.1",
  ]);
  expect(report?.limits).toHaveLength(3);
});
