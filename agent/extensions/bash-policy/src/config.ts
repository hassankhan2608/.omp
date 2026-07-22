import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type Policy = "allow" | "ask" | "deny";
export type DecisionValue = Policy | { deny: string };
export type RuleMap = Record<string, DecisionValue>;
export type SurfacePolicy = DecisionValue | RuleMap;
export type PermissionConfig = Record<string, SurfacePolicy>;

export interface CommandSafetyRule {
  policy: "ask" | "deny";
  reason: string;
  subcommands?: string[];
  arguments?: string[];
  argumentPrefixes?: string[];
  shortFlags?: string[];
  always?: boolean;
  unlessArguments?: string[];
}

export interface BashSafetyConfig {
  customEnvironment: Policy;
  pty: Policy;
  commands: Record<string, CommandSafetyRule[]>;
}

export interface AgentConfig {
  permission?: PermissionConfig;
}

export interface PolicyConfig {
  $schema?: string;
  hideDeniedTools: boolean;
  bashSafety: BashSafetyConfig;
  permission: PermissionConfig;
  agents: Record<string, AgentConfig>;
}

const policySchema = z.enum(["allow", "ask", "deny"]);
const denySchema = z.strictObject({ deny: z.string().min(1) });
const decisionSchema = z.union([policySchema, denySchema]);
const ruleMapSchema = z.record(z.string().min(1), decisionSchema);
const surfaceSchema = z.union([decisionSchema, ruleMapSchema]);
const permissionSchema = z.record(z.string().min(1), surfaceSchema);
const matcherArraySchema = z.array(z.string().min(1)).min(1);
const shortFlagArraySchema = z.array(z.string().length(1)).min(1);
const commandSafetyRuleSchema = z
  .strictObject({
    policy: z.enum(["ask", "deny"]),
    reason: z.string().min(1),
    subcommands: matcherArraySchema.optional(),
    arguments: matcherArraySchema.optional(),
    argumentPrefixes: matcherArraySchema.optional(),
    shortFlags: shortFlagArraySchema.optional(),
    always: z.literal(true).optional(),
    unlessArguments: matcherArraySchema.optional(),
  })
  .refine(
    (rule) =>
      rule.always !== undefined ||
      rule.subcommands !== undefined ||
      rule.arguments !== undefined ||
      rule.argumentPrefixes !== undefined ||
      rule.shortFlags !== undefined,
    { message: "At least one matcher field or always is required" },
  );
const bashSafetySchema = z.strictObject({
  customEnvironment: policySchema.optional(),
  pty: policySchema.optional(),
  commands: z.record(z.string().min(1), z.array(commandSafetyRuleSchema)).optional(),
});
const agentSchema = z.strictObject({ permission: permissionSchema.optional() });
const configSchema = z.strictObject({
  $schema: z.string().optional(),
  hideDeniedTools: z.boolean().optional(),
  bashSafety: bashSafetySchema.optional(),
  permission: permissionSchema.optional(),
  agents: z.record(z.string().min(1), agentSchema).optional(),
});
type RawPolicyConfig = z.infer<typeof configSchema>;

function describeValidationError(path: string, error: z.ZodError): Error {
  const issues = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  return new Error(`Invalid bash policy config ${path}: ${issues}`);
}

async function readConfig(path: string, required: boolean): Promise<RawPolicyConfig | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read bash policy config ${path}: ${(error as Error).message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in bash policy config ${path}: ${(error as Error).message}`);
  }

  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw describeValidationError(path, parsed.error);
  return parsed.data;
}

function isRuleMap(value: SurfacePolicy | undefined): value is RuleMap {
  return typeof value === "object" && value !== null && !("deny" in value);
}

function mergeSurface(base: SurfacePolicy | undefined, override: SurfacePolicy): SurfacePolicy {
  if (!isRuleMap(override)) return override;
  const merged: RuleMap = isRuleMap(base) ? { ...base } : base === undefined ? {} : { "*": base };
  for (const [pattern, decision] of Object.entries(override)) {
    // Delete first so a project/agent override is evaluated after every inherited rule.
    delete merged[pattern];
    merged[pattern] = decision;
  }
  return merged;
}

export function mergePermissions(base: PermissionConfig, override: PermissionConfig | undefined): PermissionConfig {
  if (!override) return { ...base };
  const merged: PermissionConfig = { ...base };
  for (const [surface, policy] of Object.entries(override)) {
    merged[surface] = mergeSurface(merged[surface], policy);
  }
  return merged;
}

const defaultBashSafety: BashSafetyConfig = {
  customEnvironment: "ask",
  pty: "ask",
  commands: {},
};

function resolveBashSafety(config: RawPolicyConfig["bashSafety"]): BashSafetyConfig {
  return {
    customEnvironment: config?.customEnvironment ?? defaultBashSafety.customEnvironment,
    pty: config?.pty ?? defaultBashSafety.pty,
    commands: { ...(config?.commands ?? {}) },
  };
}

const policyRank: Record<Policy, number> = { allow: 0, ask: 1, deny: 2 };

function mostRestrictivePolicy(base: Policy, override: Policy | undefined): Policy {
  return override !== undefined && policyRank[override] > policyRank[base] ? override : base;
}

function mergeBashSafety(
  base: BashSafetyConfig,
  override: RawPolicyConfig["bashSafety"],
): BashSafetyConfig {
  const commands: Record<string, CommandSafetyRule[]> = { ...base.commands };
  for (const [executable, rules] of Object.entries(override?.commands ?? {})) {
    commands[executable] = [...(commands[executable] ?? []), ...rules];
  }
  return {
    customEnvironment: mostRestrictivePolicy(base.customEnvironment, override?.customEnvironment),
    pty: mostRestrictivePolicy(base.pty, override?.pty),
    commands,
  };
}

export function applyAgentPolicy(config: PolicyConfig, principal: string): PolicyConfig {
  const generic = principal === "main" ? undefined : config.agents.subagent;
  const exact = config.agents[principal];
  let permission = mergePermissions(config.permission, generic?.permission);
  if (exact && exact !== generic) permission = mergePermissions(permission, exact.permission);
  return { ...config, permission };
}

export interface LoadedConfig {
  config: PolicyConfig;
  globalPath: string;
  projectPath: string;
}

export async function loadPolicyConfig(extensionDir: string, cwd: string): Promise<LoadedConfig> {
  const globalPath = join(extensionDir, "config.json");
  const projectPath = join(cwd, ".omp", "bash-policy.json");
  const [globalConfig, projectConfig] = await Promise.all([
    readConfig(globalPath, true),
    readConfig(projectPath, false),
  ]);
  if (!globalConfig) throw new Error(`Missing required bash policy config ${globalPath}`);
  const base: PolicyConfig = {
    $schema: globalConfig.$schema,
    hideDeniedTools: globalConfig.hideDeniedTools ?? true,
    bashSafety: resolveBashSafety(globalConfig.bashSafety),
    permission: globalConfig.permission ?? { "*": "allow", bash: { "*": "ask" } },
    agents: globalConfig.agents ?? {},
  };
  const agents = { ...base.agents };
  for (const [name, override] of Object.entries(projectConfig?.agents ?? {})) {
    const inherited = agents[name];
    agents[name] = {
      permission: mergePermissions(inherited?.permission ?? {}, override.permission),
    };
  }
  const config: PolicyConfig = projectConfig
    ? {
        $schema: projectConfig.$schema ?? base.$schema,
        hideDeniedTools: projectConfig.hideDeniedTools ?? base.hideDeniedTools,
        bashSafety: mergeBashSafety(base.bashSafety, projectConfig.bashSafety),
        permission: mergePermissions(base.permission, projectConfig.permission),
        agents,
      }
    : base;

  return { config, globalPath, projectPath };
}
