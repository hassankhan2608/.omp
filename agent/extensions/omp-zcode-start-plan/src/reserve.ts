import { resolveUsedFraction, type FetchImpl } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { PROVIDER_ID } from "./constants";
import { zcodeUsageProvider } from "./usage";

export const ZCODE_USAGE_RESERVE_FRACTION = 0.98;

interface UsageReserveOptions {
  now?: number;
  signal?: AbortSignal;
  threshold?: number;
}

export async function checkZcodeUsageReserve(
  fetchImpl: FetchImpl,
  accessToken: string,
  modelId: string,
  options: UsageReserveOptions = {},
): Promise<void> {
  const report = await zcodeUsageProvider.fetchUsage({
    provider: PROVIDER_ID,
    credential: { type: "oauth", accessToken },
    signal: options.signal,
  }, { fetch: fetchImpl });
  if (!report) return;

  const normalizedModelId = modelId.toLowerCase();
  const relevant = report.limits.filter((limit) => limit.scope.modelId?.toLowerCase() === normalizedModelId);
  if (relevant.length === 0) return;

  const threshold = options.threshold ?? ZCODE_USAGE_RESERVE_FRACTION;
  if (relevant.some((limit) => (resolveUsedFraction(limit) ?? 0) < threshold)) return;

  const now = options.now ?? Date.now();
  const resetsAt = relevant
    .map((limit) => limit.window?.resetsAt)
    .filter((value): value is number => value !== undefined && value > now)
    .sort((left, right) => left - right)[0];
  const retryAfterSeconds = resetsAt === undefined ? 300 : Math.max(1, Math.ceil((resetsAt - now) / 1_000));
  const headers = new Headers({ "retry-after": String(retryAfterSeconds) });
  throw new ProviderHttpError(
    `ZCode usage limit reached: every ${normalizedModelId} entitlement is at or above ${threshold * 100}%`,
    429,
    { headers, code: "zcode_usage_reserve" },
  );
}
