import type { ExtensionContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

export type ApprovalChoice = "once" | "session" | "deny";

interface ApprovalBroker {
  parentSessionId?: string;
  parentUi?: ExtensionUIContext;
  queue: Promise<void>;
  grants: Map<string, Set<string>>;
}

const BROKER_SYMBOL = Symbol.for("omp.bash-policy.approval-broker.v1");

function broker(): ApprovalBroker {
  const processGlobal = globalThis as typeof globalThis & { [BROKER_SYMBOL]?: ApprovalBroker };
  processGlobal[BROKER_SYMBOL] ??= { queue: Promise.resolve(), grants: new Map() };
  return processGlobal[BROKER_SYMBOL];
}

export function registerInteractiveSession(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const state = broker();
  state.parentSessionId = ctx.sessionManager.getSessionId();
  state.parentUi = ctx.ui;
}

export function unregisterSession(ctx: ExtensionContext): void {
  const state = broker();
  const sessionId = ctx.sessionManager.getSessionId();
  state.grants.delete(sessionId);
  if (state.parentSessionId === sessionId) {
    state.parentSessionId = undefined;
    state.parentUi = undefined;
  }
}

export function hasSessionGrant(ctx: ExtensionContext, key: string): boolean {
  return broker().grants.get(ctx.sessionManager.getSessionId())?.has(key) ?? false;
}

export interface ApprovalRequest {
  key: string;
  title: string;
  description: string;
  principal: string;
}

/** Serialize dialogs and forward headless subagent asks to the in-process parent UI. */
export async function requestApproval(ctx: ExtensionContext, request: ApprovalRequest): Promise<ApprovalChoice> {
  const state = broker();
  const ui = ctx.hasUI ? ctx.ui : state.parentUi;
  if (!ui) return "deny";

  let releaseQueue!: () => void;
  const previous = state.queue;
  state.queue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    const forwarded = !ctx.hasUI;
    const heading = forwarded ? `Subagent ${request.principal}: ${request.title}` : request.title;
    process.emit("omp:approval-requested", {
      source: "bash-policy",
      title: heading,
      description: request.description,
      principal: request.principal,
    });
    const choice = await ui.select(
      `${heading}\n${request.description}`,
      [
        "Approve once",
        "Allow this exact request for this session",
        "Deny",
      ],
    );
    if (choice === "Approve once") return "once";
    if (choice === "Allow this exact request for this session") {
      const sessionId = ctx.sessionManager.getSessionId();
      const grants = state.grants.get(sessionId) ?? new Set<string>();
      grants.add(request.key);
      state.grants.set(sessionId, grants);
      return "session";
    }
    return "deny";
  } catch {
    return "deny";
  } finally {
    releaseQueue();
  }
}
