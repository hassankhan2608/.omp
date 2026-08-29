import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@oh-my-pi/pi-ai";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { createOfficialClineAuthDependencies } from "./core-bridge.js";

/** Minimal credential shape exchanged with Cline's helper process. */
export interface ClineOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}

/** Callback shape sent to the helper process. */
export interface ClineAuthCallbacks {
  onAuth(info: { url: string; instructions?: string }): void;
  onPrompt(prompt: { message: string; defaultValue?: string }): Promise<string>;
  onProgress?(message: string): void;
}

export interface ClineAuthLoginInput {
  callbacks: ClineAuthCallbacks;
}

export interface ClineAuthRefreshInput {
  settings: Record<string, unknown>;
  credentials: ClineOAuthCredentials;
}

/** Runtime surface of the official Cline auth handler we use. */
export interface ClineAuthHandler {
  providerId: string;
  storageProviderId: string;
  getApiKey(...args: never[]): string | undefined;
  login(input: ClineAuthLoginInput): Promise<ClineOAuthCredentials>;
  refresh(input: ClineAuthRefreshInput): Promise<ClineOAuthCredentials | null>;
  saveCredentials(...args: never[]): unknown;
  isConfigured(...args: never[]): boolean;
  normalizeStoredAccessToken?(access: string): string;
}

export interface AuthDependencies {
  resolveHandler: (providerId: string) => ClineAuthHandler | undefined;
  formatApiKey: (
    providerId: string,
    credentials: Pick<ClineOAuthCredentials, "access">,
  ) => string;
}

const CLINE_PROVIDER_ID = "cline";


async function loadDefaultDependencies(): Promise<AuthDependencies> {
  return createOfficialClineAuthDependencies();
}

function normalizeCredentials(
  credentials: ClineOAuthCredentials,
  handler: ClineAuthHandler,
): OAuthCredentials {
  const access = handler.normalizeStoredAccessToken
    ? handler.normalizeStoredAccessToken(credentials.access)
    : credentials.access;
  const accountId = credentials.accountId?.trim();
  if (
    access.trim().length === 0 ||
    credentials.refresh.trim().length === 0 ||
    !Number.isFinite(credentials.expires) ||
    credentials.expires <= 0 ||
    !accountId
  ) {
    throw new Error("Cline returned invalid credentials");
  }

  return {
    access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    accountId,
    ...(credentials.email?.trim()
      ? { email: credentials.email.trim() }
      : {}),
  };
}

function adaptCallbacks(callbacks: OAuthLoginCallbacks) {
  return {
    onAuth: (info: { url: string; instructions?: string }) =>
      callbacks.onAuth(info),
    onPrompt: (prompt: { message: string; defaultValue?: string }) =>
      callbacks.onPrompt({
        message: prompt.message,
        placeholder: prompt.defaultValue,
      }),
    ...(callbacks.onProgress
      ? { onProgress: (message: string) => callbacks.onProgress?.(message) }
      : {}),
  };
}

export async function createClineOAuth(
  deps?: AuthDependencies,
): Promise<NonNullable<ProviderConfig["oauth"]>> {
  const resolvedDeps = deps ?? (await loadDefaultDependencies());
  const handler = resolvedDeps.resolveHandler(CLINE_PROVIDER_ID);
  if (
    !handler ||
    handler.providerId !== CLINE_PROVIDER_ID ||
    handler.storageProviderId !== CLINE_PROVIDER_ID
  ) {
    throw new Error("Cline auth handler is unavailable");
  }

  return {
    name: "Cline",
    async login(callbacks) {
      const credentials = await handler.login({
        callbacks: adaptCallbacks(callbacks),
      });
      return normalizeCredentials(credentials, handler);
    },
    async refreshToken(credentials) {
      const clineCredentials: ClineOAuthCredentials = {
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        accountId: credentials.accountId,
        email: credentials.email,
      };
      const settings: Record<string, unknown> = {
        provider: CLINE_PROVIDER_ID,
        auth: {
          accessToken: credentials.access,
          refreshToken: credentials.refresh,
          expiresAt: credentials.expires,
          accountId: credentials.accountId,
        },
      };
      const refreshed = await handler.refresh({
        settings,
        credentials: clineCredentials,
      });
      if (!refreshed) {
        throw new Error("Cline refresh returned no credentials");
      }

      const refreshedAccountId = refreshed.accountId?.trim();
      if (
        refreshedAccountId &&
        credentials.accountId &&
        refreshedAccountId !== credentials.accountId
      ) {
        throw new Error("Cline refresh changed account identity");
      }
      return normalizeCredentials(
        {
          ...refreshed,
          accountId: refreshedAccountId ?? credentials.accountId,
          email: refreshed.email ?? credentials.email,
        },
        handler,
      );
    },
    getApiKey(credentials) {
      const apiKey = resolvedDeps.formatApiKey(CLINE_PROVIDER_ID, {
        access: credentials.access,
      });
      if (apiKey.trim().length === 0) {
        throw new Error("Cline request credential is empty");
      }
      return apiKey;
    },
  };
}
