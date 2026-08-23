import { type as schema } from "@oh-my-pi/omptype";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import {
  PROVIDER_ID,
  ZCODE_BILLING_BALANCE_URL,
  ZCODE_BILLING_CURRENT_URL,
} from "./constants";
import { diagnostics } from "./diagnostics";
import { zcodeIdentityHeaders } from "./transport";

const BalanceSchema = schema({
  entitlement_id: "string",
  show_name: "string",
  total_units: "number",
  "used_units?": "number",
  "remaining_units?": "number",
  "available_units?": "number",
  "expires_at?": "number | string | null",
});

const BalanceResponseSchema = schema({
  code: "number",
  data: { balances: BalanceSchema.array() },
});

const PlanSchema = schema({
  "plan_id?": "string",
  "name?": "string",
  "description?": "string",
  "status?": "string",
  "ends_at?": "number | string | null",
});

const CurrentResponseSchema = schema({
  code: "number",
  data: {
    "plans?": PlanSchema.array(),
    "plan_id?": "string",
    "name?": "string",
    "description?": "string",
    "status?": "string",
    "ends_at?": "number | string | null",
  },
});

type Plan = typeof PlanSchema.infer;

export interface UsageIdentity {
  accountId?: string;
  email?: string;
}

function timestampMs(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
}

function usageStatus(usedFraction: number): UsageLimit["status"] {
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

export function parseBalanceReport(
  payload: unknown,
  identity: UsageIdentity,
  fetchedAt: number,
): UsageReport | null {
  let parsed: typeof BalanceResponseSchema.infer;
  try {
    parsed = BalanceResponseSchema.assert(payload);
  } catch {
    return null;
  }
  if (parsed.code !== 0) return null;

  const limits: UsageLimit[] = parsed.data.balances.map((balance) => {
    const total = Math.max(0, balance.total_units);
    const used = Math.max(0, balance.used_units ?? Math.max(0, total - (balance.remaining_units ?? balance.available_units ?? total)));
    const remaining = Math.max(0, balance.remaining_units ?? balance.available_units ?? total - used);
    const usedFraction = total > 0 ? used / total : 1;
    const remainingFraction = total > 0 ? remaining / total : 0;
    const expiresAt = timestampMs(balance.expires_at);
    const modelId = balance.show_name.toLowerCase();
    return {
      id: balance.entitlement_id,
      label: `${balance.show_name} · ${balance.entitlement_id}`,
      scope: {
        provider: PROVIDER_ID,
        ...(identity.accountId ? { accountId: identity.accountId } : {}),
        modelId,
        shared: true,
      },
      ...(expiresAt === undefined ? {} : {
        window: { id: balance.entitlement_id, label: "Entitlement", resetsAt: expiresAt },
      }),
      amount: {
        unit: "tokens",
        limit: total,
        used,
        remaining,
        usedFraction,
        remainingFraction,
      },
      status: usageStatus(usedFraction),
    };
  });

  return {
    provider: PROVIDER_ID,
    fetchedAt,
    limits,
    metadata: {
      ...(identity.accountId ? { accountId: identity.accountId } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      endpoint: ZCODE_BILLING_BALANCE_URL,
    },
  };
}

function activePlan(current: typeof CurrentResponseSchema.infer): Plan | undefined {
  const plans = current.data.plans;
  if (plans?.length) return plans.find((plan) => plan.status === "active") ?? plans[0];
  if (current.data.name || current.data.plan_id) return current.data;
  return undefined;
}

export const zcodeUsageProvider: UsageProvider = {
  id: PROVIDER_ID,
  validatesCredentials: true,
  retainLastGoodOnFailure: true,
  supports: ({ provider, credential }) => (
    provider === PROVIDER_ID
    && credential.type === "oauth"
    && typeof credential.accessToken === "string"
    && credential.accessToken.length > 0
  ),
  async fetchUsage(params, ctx) {
    const accessToken = params.credential.accessToken;
    if (params.provider !== PROVIDER_ID || params.credential.type !== "oauth" || !accessToken) return null;
    const headers = {
      ...zcodeIdentityHeaders(),
      Authorization: `Bearer ${accessToken}`,
    };
    try {
      const [currentResponse, balanceResponse] = await Promise.all([
        ctx.fetch(ZCODE_BILLING_CURRENT_URL, { headers, signal: params.signal }),
        ctx.fetch(ZCODE_BILLING_BALANCE_URL, { headers, signal: params.signal }),
      ]);
      if (!currentResponse.ok || !balanceResponse.ok) {
        ctx.logger?.warn("ZCode usage endpoint failed", {
          currentStatus: currentResponse.status,
          balanceStatus: balanceResponse.status,
        });
        return null;
      }
      const current = CurrentResponseSchema.assert(await currentResponse.json());
      if (current.code !== 0) return null;
      const fetchedAt = Date.now();
      const report = parseBalanceReport(await balanceResponse.json(), {
        accountId: params.credential.accountId,
        email: params.credential.email,
      }, fetchedAt);
      if (!report) return null;
      const plan = activePlan(current);
      report.metadata = {
        ...report.metadata,
        currentEndpoint: ZCODE_BILLING_CURRENT_URL,
        ...(plan?.plan_id ? { planId: plan.plan_id } : {}),
        ...(plan?.name ? { planName: plan.name } : {}),
        ...(plan?.description ? { planDescription: plan.description } : {}),
        ...(timestampMs(plan?.ends_at) ? { planExpiresAt: timestampMs(plan?.ends_at) } : {}),
      };
      diagnostics.recordUsage(fetchedAt);
      return report;
    } catch (error) {
      ctx.logger?.warn("ZCode usage fetch failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  },
};
