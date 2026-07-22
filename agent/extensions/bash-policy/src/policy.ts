import type { DecisionValue, PermissionConfig, Policy, RuleMap, SurfacePolicy } from "./config";

export interface PolicyDecision {
  policy: Policy;
  surface: string;
  value: string;
  pattern?: string;
  reason?: string;
}

/** OpenCode-compatible glob semantics: `*` crosses separators and `?` matches one character. */
export function globMatches(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starValueIndex = 0;

  while (valueIndex < value.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === "?" || patternCharacter === value[valueIndex]) {
      valueIndex++;
      patternIndex++;
      continue;
    }
    if (patternCharacter === "*") {
      starIndex = patternIndex++;
      starValueIndex = valueIndex;
      continue;
    }
    if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      valueIndex = ++starValueIndex;
      continue;
    }
    return false;
  }

  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

function unpackDecision(
  decision: DecisionValue,
  surface: string,
  value: string,
  pattern?: string,
): PolicyDecision {
  if (typeof decision === "string") return { policy: decision, surface, value, pattern };
  return { policy: "deny", surface, value, pattern, reason: decision.deny };
}

function isRuleMap(value: SurfacePolicy): value is RuleMap {
  return typeof value === "object" && !("deny" in value);
}

/** Resolve one surface with last-matching-rule precedence. */
export function resolvePolicy(permission: PermissionConfig, surface: string, value: string): PolicyDecision {
  const configured = permission[surface] ?? permission["*"] ?? "ask";
  if (!isRuleMap(configured)) return unpackDecision(configured, surface, value);

  let matched: { pattern: string; decision: DecisionValue } | undefined;
  for (const [pattern, decision] of Object.entries(configured)) {
    if (globMatches(value, pattern)) matched = { pattern, decision };
  }
  if (!matched) return { policy: "ask", surface, value };
  return unpackDecision(matched.decision, surface, value, matched.pattern);
}

const POLICY_RANK: Record<Policy, number> = { allow: 0, ask: 1, deny: 2 };

/** Return the most restrictive decision; deny beats ask, and ask beats allow. */
export function stricterDecision(left: PolicyDecision, right: PolicyDecision): PolicyDecision {
  return POLICY_RANK[right.policy] > POLICY_RANK[left.policy] ? right : left;
}
