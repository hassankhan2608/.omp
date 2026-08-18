import type { ExtensionContext, ExtensionUIContext, ExtensionUISelectItem } from "@oh-my-pi/pi-coding-agent";
import { globMatches } from "./policy";

export interface SessionRule {
  surface: string;
  pattern: string;
}

export interface ApprovalItem {
  label: string;
  description?: string;
  value?: string;
  allowed: boolean;
  rule?: SessionRule;
}

export interface ApprovalRequest {
  key: string;
  title: string;
  description: string;
  principal: string;
  items: ApprovalItem[];
  requiresExact?: boolean;
  persistable?: boolean;
}

export type ApprovalResult =
  | { kind: "once" }
  | { kind: "deny" }
  | { kind: "exact" }
  | { kind: "rules"; rules: SessionRule[]; exact: boolean };

interface SessionGrants {
  exact: Set<string>;
  rules: SessionRule[];
}

interface ApprovalBroker {
  parentSessionId?: string;
  parentUi?: ExtensionUIContext;
  queue: Promise<void>;
  denialEpoch: number;
  grants: Map<string, SessionGrants>;
}

const BROKER_SYMBOL = Symbol.for("omp.bash-policy.approval-broker.v3");

function broker(): ApprovalBroker {
  const processGlobal = globalThis as typeof globalThis & { [BROKER_SYMBOL]?: ApprovalBroker };
  processGlobal[BROKER_SYMBOL] ??= { queue: Promise.resolve(), denialEpoch: 0, grants: new Map() };
  return processGlobal[BROKER_SYMBOL];
}

function sessionGrants(ctx: ExtensionContext): SessionGrants {
  const state = broker();
  const sessionId = ctx.sessionManager.getSessionId();
  let grants = state.grants.get(sessionId);
  if (!grants) {
    grants = { exact: new Set(), rules: [] };
    state.grants.set(sessionId, grants);
  }
  return grants;
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

export function hasExactGrant(ctx: ExtensionContext, key: string): boolean {
  return broker().grants.get(ctx.sessionManager.getSessionId())?.exact.has(key) ?? false;
}

export function sessionAllows(ctx: ExtensionContext, surface: string, value: string): boolean {
  const rules = broker().grants.get(ctx.sessionManager.getSessionId())?.rules;
  if (!rules) return false;
  return rules.some((rule) => {
    if (rule.surface !== surface) return false;
    if (globMatches(value, rule.pattern)) return true;
    return rule.pattern.endsWith(" *") && value === rule.pattern.slice(0, -2);
  });
}

export function addSessionRules(ctx: ExtensionContext, rules: SessionRule[]): void {
  if (rules.length === 0) return;
  const grants = sessionGrants(ctx);
  const existing = new Set(grants.rules.map((rule) => `${rule.surface}\0${rule.pattern}`));
  for (const rule of rules) {
    const key = `${rule.surface}\0${rule.pattern}`;
    if (existing.has(key)) continue;
    existing.add(key);
    grants.rules.push(rule);
  }
}

export function addExactGrant(ctx: ExtensionContext, key: string): void {
  sessionGrants(ctx).exact.add(key);
}

interface SelectorResult {
  kind: "back" | "deny" | "exact" | "rules";
  rules?: SessionRule[];
  exact?: boolean;
}

/** Upper bound on stage-one/stage-two round trips before the request fails closed. */
const MAX_APPROVAL_ROUNDS = 20;
const ACTION_ALL = "Allow all patterns";
const ACTION_APPLY = "Apply selected patterns";
const ACTION_EXACT = "Allow only this exact request";
const ACTION_BACK = "← Back";
const ACTION_DENY = "Deny";

/** Stage two. Uses the same checkbox-marker select surface as OMP's ask tool, so
 *  navigation, mouse, search, and theming match every other OMP dialog. */
async function selectSessionRules(
  ui: ExtensionUIContext,
  request: ApprovalRequest,
): Promise<SelectorResult> {
  const seenRules = new Set<string>();
  const grantable = request.items.filter((item) => {
    if (item.rule === undefined || item.allowed) return false;
    const key = `${item.rule.surface}\0${item.rule.pattern}`;
    if (seenRules.has(key)) return false;
    seenRules.add(key);
    return true;
  });
  const seenAllowed = new Set<string>();
  const already = request.items.filter((item) => {
    if (!item.allowed || seenAllowed.has(item.label)) return false;
    seenAllowed.add(item.label);
    return true;
  });
  const checked = new Set<number>();
  let cursor = 0;

  const heading = already.length > 0
    ? `Allow for this session\n${already.length} already allowed: ${already.map((item) => item.label).join(", ")}`
    : "Allow for this session";

  while (true) {
    const options: ExtensionUISelectItem[] = grantable.map((item) => ({
      label: item.rule!.pattern,
      description: item.label,
    }));
    const markableCount = options.length;

    if (markableCount > 0) options.push(ACTION_ALL);
    if (checked.size > 0) options.push(ACTION_APPLY);
    options.push(ACTION_EXACT, ACTION_BACK, ACTION_DENY);

    const prefix = checked.size > 0 ? `(${checked.size} selected) ` : "";
    const choice = await ui.select(`${prefix}${heading}`, options, {
      outline: true,
      selectionMarker: "checkbox",
      checkedIndices: [...checked],
      markableCount,
      initialIndex: Math.min(cursor, options.length - 1),
      helpText: "up/down navigate  enter toggle or select  esc back",
    });

    if (choice === undefined || choice === ACTION_BACK) return { kind: "back" };
    if (choice === ACTION_DENY) return { kind: "deny" };
    if (choice === ACTION_EXACT) return { kind: "exact" };
    if (choice === ACTION_ALL) {
      const rules = grantable.map((item) => item.rule!);
      return { kind: "rules", rules, exact: request.requiresExact === true || rules.length === 0 };
    }
    if (choice === ACTION_APPLY) {
      const rules = [...checked].sort((left, right) => left - right).map((index) => grantable[index]!.rule!);
      // Only offered when something is checked; an empty set means a stale choice.
      return rules.length > 0 ? { kind: "rules", rules, exact: false } : { kind: "back" };
    }

    // A pattern row: toggle it and reopen with the cursor parked in place.
    const index = grantable.findIndex((item) => item.rule!.pattern === choice);
    // Anything else is not a row we offered. Back out rather than spinning.
    if (index < 0) return { kind: "back" };
    cursor = index;
    if (checked.has(index)) checked.delete(index);
    else checked.add(index);
  }
}

function requestCovered(ctx: ExtensionContext, request: ApprovalRequest): boolean {
  if (hasExactGrant(ctx, request.key)) return true;
  const pending = request.items.filter((item) => !item.allowed);
  return pending.length > 0 && pending.every(
    (item) => item.rule !== undefined
      && sessionAllows(ctx, item.rule.surface, item.value ?? item.label),
  );
}

function persistApproval(ctx: ExtensionContext, request: ApprovalRequest, result: ApprovalResult): void {
  if (request.persistable === false) return;
  if (result.kind === "exact") {
    addExactGrant(ctx, request.key);
    return;
  }
  if (result.kind !== "rules") return;
  addSessionRules(ctx, result.rules);
  if (result.exact) addExactGrant(ctx, request.key);
}

/** Serialize both approval stages and forward headless subagent asks to the parent UI.
 *  Grants are committed before the queue is released, so later queued requests can reuse
 *  them. A denial invalidates requests that were already waiting, but not future asks. */
export async function requestApproval(ctx: ExtensionContext, request: ApprovalRequest): Promise<ApprovalResult> {
  const state = broker();
  const ui = ctx.hasUI ? ctx.ui : state.parentUi;
  if (!ui) return { kind: "deny" };

  const queuedAtDenialEpoch = state.denialEpoch;
  let releaseQueue!: () => void;
  const previous = state.queue;
  state.queue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    if (state.denialEpoch !== queuedAtDenialEpoch) return { kind: "deny" };
    if (request.persistable !== false && requestCovered(ctx, request)) return { kind: "once" };

    const forwarded = !ctx.hasUI;
    const heading = forwarded ? `Subagent ${request.principal}: ${request.title}` : request.title;
    process.emit("omp:approval-requested", {
      source: "bash-policy",
      title: heading,
      description: request.description,
      principal: request.principal,
    });
    const stageOne = request.persistable === false
      ? ["Approve once", "Deny"]
      : ["Approve once", "Allow for this session", "Deny"];
    // Bounded so a non-advancing surface (or a scripted client that always answers
    // the same way) fails closed instead of looping between the two stages forever.
    for (let round = 0; round < MAX_APPROVAL_ROUNDS; round++) {
      const choice = await ui.select(
        `${heading}\n${request.description}`,
        stageOne,
        {
          outline: true,
          selectionMarker: "radio",
          markableCount: stageOne.length,
          helpText: "up/down navigate  enter select  esc deny",
        },
      );
      if (choice === "Approve once") return { kind: "once" };
      if (choice === "Deny" || choice === undefined) {
        state.denialEpoch++;
        return { kind: "deny" };
      }
      if (choice !== "Allow for this session" || request.persistable === false) {
        state.denialEpoch++;
        return { kind: "deny" };
      }


      const selection = await selectSessionRules(ui, request);
      if (selection.kind === "back") continue;
      if (selection.kind === "deny") {
        state.denialEpoch++;
        return { kind: "deny" };
      }
      const result: ApprovalResult = selection.kind === "exact"
        ? { kind: "exact" }
        : { kind: "rules", rules: selection.rules ?? [], exact: selection.exact === true };
      persistApproval(ctx, request, result);
      return result;
    }
    state.denialEpoch++;
    return { kind: "deny" };
  } catch {
    state.denialEpoch++;
    return { kind: "deny" };
  } finally {
    releaseQueue();
  }
}
