import type { BashCommandUnit } from "./bash";
import type { BashSafetyConfig, CommandSafetyRule, Policy } from "./config";

export interface SafetyDecision {
  policy: Extract<Policy, "ask" | "deny">;
  reason: string;
}

function hasArgument(arguments_: readonly string[], expected: string): boolean {
  return arguments_.some((argument) =>
    argument === expected || (expected.startsWith("--") && argument.startsWith(`${expected}=`)),
  );
}

function ruleMatches(rule: CommandSafetyRule, command: BashCommandUnit): boolean {
  if (rule.subcommands && !rule.subcommands.includes(command.arguments[0] ?? "")) return false;
  if (rule.unlessArguments?.some((argument) => hasArgument(command.arguments, argument))) return false;

  const matches: boolean[] = [];
  if (rule.subcommands) matches.push(true);
  if (rule.always) matches.push(true);
  if (rule.arguments) {
    matches.push(rule.arguments.some((argument) => hasArgument(command.arguments, argument)));
  }
  if (rule.argumentPrefixes) {
    matches.push(rule.argumentPrefixes.some((prefix) => command.arguments.some((argument) => argument.startsWith(prefix))));
  }
  if (rule.shortFlags) {
    matches.push(command.arguments.some((argument) => {
      if (!/^-[^-]/.test(argument)) return false;
      const cluster = argument.slice(1);
      return rule.shortFlags!.some((flag) => cluster.includes(flag));
    }));
  }
  return matches.some(Boolean);
}

/** Evaluate config-defined safety floors without allowing them to downgrade a normal permission decision. */
export function resolveCommandSafety(
  config: BashSafetyConfig,
  command: BashCommandUnit,
): SafetyDecision | undefined {
  if (!command.executable) return undefined;
  let decision: SafetyDecision | undefined;
  for (const rule of config.commands[command.executable] ?? []) {
    if (!ruleMatches(rule, command)) continue;
    const matched = { policy: rule.policy, reason: rule.reason } satisfies SafetyDecision;
    if (matched.policy === "deny") return matched;
    decision = matched;
  }
  return decision;
}

export function resolveBashToolSafety(
  config: BashSafetyConfig,
  input: Record<string, unknown>,
): SafetyDecision[] {
  const decisions: SafetyDecision[] = [];
  const environment = input.env;
  if (environment && typeof environment === "object" && Object.keys(environment).length > 0) {
    if (config.customEnvironment !== "allow") {
      decisions.push({
        policy: config.customEnvironment,
        reason: "Custom environment variables can change otherwise safe command behavior",
      });
    }
  }
  if (input.pty === true && config.pty !== "allow") {
    decisions.push({
      policy: config.pty,
      reason: "PTY mode enables interactive programs, pagers, and shell escapes",
    });
  }
  return decisions;
}
