import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, ExtensionUIContext, ExtensionUISelectItem } from "@oh-my-pi/pi-coding-agent";
import type { PermissionLevel } from "./config";
import { patternMatches } from "./policy";

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
  preview?: string;
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
  levels: Map<string, PermissionLevel>;
}

const BROKER_SYMBOL = Symbol.for("omp.permission-gate.approval-broker.v1");
const MAX_APPROVAL_ROUNDS = 20;
const ACTION_ALL = "Allow all patterns";
const ACTION_APPLY = "Apply selected patterns";
const ACTION_EXACT = "Allow only this exact request";
const ACTION_SELECT_SESSION = "Choose commands for this session…";
const ACTION_EXACT_SESSION = "Allow exact request for this session";
const ACTION_BACK = "← Back";
const ACTION_DENY = "Deny";

function broker(): ApprovalBroker {
  const processGlobal = globalThis as typeof globalThis & { [BROKER_SYMBOL]?: ApprovalBroker };
  processGlobal[BROKER_SYMBOL] ??= {
    queue: Promise.resolve(), denialEpoch: 0, grants: new Map(), levels: new Map(),
  };
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

export function registerSession(ctx: ExtensionContext, defaultLevel: PermissionLevel): void {
  const state = broker();
  const sessionId = ctx.sessionManager.getSessionId();
  state.levels.set(sessionId, defaultLevel);
  if (!ctx.hasUI) return;
  state.parentSessionId = sessionId;
  state.parentUi = ctx.ui;
}

export function unregisterSession(ctx: ExtensionContext): void {
  const state = broker();
  const sessionId = ctx.sessionManager.getSessionId();
  state.grants.delete(sessionId);
  state.levels.delete(sessionId);
  if (state.parentSessionId === sessionId) {
    state.parentSessionId = undefined;
    state.parentUi = undefined;
  }
}

export function currentLevel(ctx: ExtensionContext, fallback: PermissionLevel): PermissionLevel {
  const state = broker();
  const sessionId = ctx.hasUI ? ctx.sessionManager.getSessionId() : state.parentSessionId ?? ctx.sessionManager.getSessionId();
  return state.levels.get(sessionId) ?? fallback;
}

export function setLevel(ctx: ExtensionContext, level: PermissionLevel): void {
  broker().levels.set(ctx.sessionManager.getSessionId(), level);
}

export function hasExactGrant(ctx: ExtensionContext, key: string): boolean {
  return broker().grants.get(ctx.sessionManager.getSessionId())?.exact.has(key) ?? false;
}

export function sessionAllows(ctx: ExtensionContext, surface: string, value: string): boolean {
  const rules = broker().grants.get(ctx.sessionManager.getSessionId())?.rules;
  return rules?.some((rule) => rule.surface === surface && patternMatches(value, rule.pattern)) ?? false;
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

function grantableItems(request: ApprovalRequest): ApprovalItem[] {
  const seen = new Set<string>();
  return request.items.filter((item) => {
    if (item.rule === undefined || item.allowed) return false;
    const key = `${item.rule.surface}\0${item.rule.pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface CompactSelectOption {
  label: string;
  description?: string;
}

export interface CompactSelectRequest {
  title: string;
  heading: string;
  preview?: string;
  options: readonly CompactSelectOption[];
  inlineDescriptions?: boolean;
  initialIndex?: number;
  helpText?: string;
}

function safeUiText(value: string): string {
  return stripVTControlCharacters(value)
    .replaceAll("\r", "")
    .replaceAll("\t", "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function wrapUiText(value: string, width: number): string[] {
  const output: string[] = [];
  for (const sourceLine of value.split("\n")) {
    let remaining = [...sourceLine];
    if (remaining.length === 0) {
      output.push("");
      continue;
    }
    while (remaining.length > width) {
      const window = remaining.slice(0, width);
      let breakAt = 0;
      for (let index = window.length - 1; index > 0; index--) {
        if (window[index] !== " ") continue;
        breakAt = index;
        break;
      }
      if (breakAt === 0) breakAt = width;
      output.push(remaining.slice(0, breakAt).join("").trimEnd());
      remaining = remaining.slice(breakAt);
      while (remaining[0] === " ") remaining.shift();
    }
    output.push(remaining.join(""));
  }
  return output;
}

function padUiText(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - [...value].length));
}

export async function selectCompactOption(
  ui: ExtensionUIContext,
  request: CompactSelectRequest,
): Promise<string | undefined> {
  if (request.options.length === 0) return undefined;
  if (typeof ui.custom !== "function") {
    const fallbackTitle = request.preview
      ? `${request.heading}\n${request.preview}`
      : request.heading;
    return ui.select(
      fallbackTitle,
      request.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      {
        outline: true,
        selectionMarker: "radio",
        markableCount: request.options.length,
        initialIndex: request.initialIndex,
        helpText: request.helpText ?? "up/down navigate  enter select  esc cancel",
      },
    );
  }

  const safeTitle = safeUiText(request.title);
  const safeHeading = safeUiText(request.heading);
  const safePreview = request.preview === undefined ? undefined : safeUiText(request.preview);
  return ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let selectedIndex = Math.max(0, Math.min(request.initialIndex ?? 0, request.options.length - 1));
    return {
      render(width: number): readonly string[] {
        const innerWidth = width - 2;
        const contentWidth = Math.max(1, innerWidth - 2);
        const body: string[] = [];

        for (const line of wrapUiText(safeHeading, contentWidth)) {
          body.push(theme.bold(theme.fg("accent", ` ${padUiText(line, contentWidth)} `)));
        }
        if (safePreview !== undefined) {
          for (const line of wrapUiText(`$ ${safePreview || "No command preview available"}`, contentWidth)) {
            const previewRow = ` ${padUiText(line, contentWidth)} `;
            body.push(theme.bg("customMessageBg", theme.fg("toolOutput", previewRow)));
          }
        }

        request.options.forEach((option, index) => {
          const selected = index === selectedIndex;
          const marker = selected ? "› ●" : "  ○";
          const description = request.inlineDescriptions && option.description
            ? `  ·  ${safeUiText(option.description)}`
            : "";
          const label = `${marker} ${safeUiText(option.label)}${description}`;
          let descriptionStarted = false;
          wrapUiText(label, contentWidth).forEach((line, lineIndex) => {
            const separatorIndex = line.indexOf("  ·  ");
            if (separatorIndex >= 0) descriptionStarted = true;
            const descriptionOnly = description.length > 0 && descriptionStarted && separatorIndex < 0 && lineIndex > 0;
            const labelPart = separatorIndex >= 0 ? line.slice(0, separatorIndex) : descriptionOnly ? "" : line;
            const descriptionPart = separatorIndex >= 0 ? line.slice(separatorIndex) : descriptionOnly ? line : "";
            const styledLabel = selected
              ? theme.bold(theme.fg("accent", labelPart))
              : theme.fg("text", labelPart);
            const styledLine = `${styledLabel}${theme.fg("muted", descriptionPart)}`;
            const row = ` ${styledLine}${" ".repeat(Math.max(0, contentWidth - [...line].length))} `;
            body.push(selected ? theme.bg("selectedBg", row) : row);
          });
        });

        const help = request.helpText ?? "↑/↓ move  ·  Enter select  ·  Esc cancel";
        body.push(theme.fg("dim", ` ${padUiText(help, contentWidth)} `));

        const chip = ` ${safeTitle} `;
        const top = chip.length + 2 <= innerWidth
          ? `${theme.fg("border", "╭─")}${theme.bold(theme.fg("accent", chip))}${theme.fg("border", `${"─".repeat(innerWidth - chip.length - 1)}╮`)}`
          : theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
        const framed = body.map((line) =>
          `${theme.fg("border", "│")}${line}${theme.fg("border", "│")}`);
        const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
        return [top, ...framed, bottom];
      },
      invalidate(): void {},
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
          selectedIndex = (selectedIndex - 1 + request.options.length) % request.options.length;
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          selectedIndex = (selectedIndex + 1) % request.options.length;
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
          done(request.options[selectedIndex]?.label);
        }
      },
    };
  });
}

async function selectApprovalAction(
  ui: ExtensionUIContext,
  title: string,
  description: string,
  preview: string,
  actions: readonly CompactSelectOption[],
): Promise<string | undefined> {
  const heading = description ? `${title}  ·  ${description}` : title;
  return selectCompactOption(ui, {
    title: "Permission Gate",
    heading,
    preview,
    options: actions,
    helpText: "↑/↓ move  ·  Enter select  ·  Esc deny",
  });
}

async function selectSessionRules(ui: ExtensionUIContext, request: ApprovalRequest): Promise<SelectorResult> {
  const grantable = grantableItems(request);
  const already = [...new Set(request.items.filter((item) => item.allowed).map((item) => item.label))];
  const checked = new Set<number>();
  let cursor = 0;
  const heading = already.length > 0
    ? `Allow for this session\n${already.length} already allowed: ${already.join(", ")}`
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
      return rules.length > 0 ? { kind: "rules", rules, exact: false } : { kind: "back" };
    }
    const index = grantable.findIndex((item) => item.rule!.pattern === choice);
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
    (item) => item.rule !== undefined && sessionAllows(ctx, item.rule.surface, item.value ?? item.label),
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

/** Serialize prompts, forward child asks to the parent UI, and commit grants before releasing the queue. */
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
      source: "permission-gate", title: heading, description: request.description, principal: request.principal,
    });
    const grantable = request.persistable === false ? [] : grantableItems(request);
    const singleRule = grantable.length === 1 ? grantable[0]!.rule : undefined;
    const sessionChoice = singleRule ? `Allow ${singleRule.pattern} for this session` : ACTION_SELECT_SESSION;
    const stageOne: CompactSelectOption[] = request.persistable === false
      ? [
          { label: "Approve once", description: "Run this request once and store nothing." },
          { label: ACTION_DENY, description: "Block this request." },
        ]
      : [
          { label: "Approve once", description: "Run this request once and store nothing." },
          {
            label: sessionChoice,
            description: singleRule
              ? `Reuse ${singleRule.pattern} for the remainder of this session.`
              : "Choose reusable command patterns in a second step.",
          },
          {
            label: ACTION_EXACT_SESSION,
            description: "Reuse only this complete Bash request for this session.",
          },
          { label: ACTION_DENY, description: "Block this request." },
        ];

    for (let round = 0; round < MAX_APPROVAL_ROUNDS; round++) {
      const choice = await selectApprovalAction(
        ui,
        heading,
        request.description,
        request.preview ?? request.items.map((item) => item.label).join(" && "),
        stageOne,
      );
      if (choice === "Approve once") return { kind: "once" };
      if (choice === ACTION_DENY || choice === undefined) {
        state.denialEpoch++;
        return { kind: "deny" };
      }
      if (choice === ACTION_EXACT_SESSION) {
        const result: ApprovalResult = { kind: "exact" };
        persistApproval(ctx, request, result);
        return result;
      }
      if (singleRule && choice === sessionChoice) {
        const result: ApprovalResult = { kind: "rules", rules: [singleRule], exact: false };
        persistApproval(ctx, request, result);
        return result;
      }
      if (choice !== sessionChoice || request.persistable === false) {
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
