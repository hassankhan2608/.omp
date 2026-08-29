import { randomUUID } from "node:crypto";
import { platform, release } from "node:os";

export const CLINE_CLIENT_NAME = "cline-cli";
export const CLINE_CLIENT_VERSION = "3.0.60";
export const CLINE_CORE_VERSION = "0.0.81";

/**
 * Builds the fixed request-identity headers the official Cline CLI sends.
 *
 * `@cline/llms` exposes `resolveProviderRequestHeaders`, but importing that
 * package here adds a multi-megabyte catalog to OMP's extension-load graph.
 * The Cline provider passes fixed values to that helper, and its output is a
 * pure mapping. Keep the equivalent mapping local so registration is cheap;
 * `models.ts` still lazy-loads the package only when live catalog discovery is
 * explicitly requested.
 */
export function buildClineRequestHeaders(
  sessionId: string = randomUUID(),
): Record<string, string> {
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": CLINE_CLIENT_NAME,
    "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
    "X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
    "X-PLATFORM": platform(),
    "X-PLATFORM-VERSION": release(),
    "X-CORE-VERSION": CLINE_CORE_VERSION,
    "X-Task-ID": sessionId,
  };
}
