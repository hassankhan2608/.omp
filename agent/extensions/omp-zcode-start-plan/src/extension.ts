import { Effort, type Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { closeCaptchaBroker, getCaptchaBrokerSnapshot } from "./captcha/client";
import { PROVIDER_ID, ZCODE_BASE_URL } from "./constants";
import { diagnostics } from "./diagnostics";
import { ZCODE_MODELS } from "./models";
import { loginZcodeStartPlan } from "./oauth";
import { streamZcodeStartPlan } from "./transport";
import { zcodeUsageProvider } from "./usage";

function output(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(message);
}

function statusPayload(ctx: ExtensionCommandContext): Record<string, unknown> {
  const identity = ctx.modelRegistry.authStorage.getOAuthAccountIdentity(PROVIDER_ID);
  return {
    provider: PROVIDER_ID,
    endpoint: `${ZCODE_BASE_URL}/v1/messages`,
    account: identity ?? "not authenticated",
    broker: getCaptchaBrokerSnapshot(),
    request: diagnostics.snapshot(),
    commands: {
      login: `/login ${PROVIDER_ID}`,
      usage: "omp usage or /usage",
      model: `/model ${PROVIDER_ID}/glm-5.3`,
      probe: "/zcode-probe (consumes quota)",
    },
  };
}

async function runProbe(ctx: ExtensionCommandContext): Promise<void> {
  const model = ctx.modelRegistry.find(PROVIDER_ID, "glm-5.3");
  if (!model) {
    output(ctx, "ZCode Start Plan model is not registered", "error");
    return;
  }
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    output(ctx, `Authenticate first with /login ${PROVIDER_ID}`, "error");
    return;
  }
  output(ctx, "Running a minimal ZCode Start Plan probe; this consumes quota.", "warning");
  const context: Context = {
    systemPrompt: ["Reply concisely."],
    messages: [{ role: "user", content: "Reply with exactly ZCODE_PROBE_OK.", timestamp: Date.now() }],
  };
  try {
    const message = await streamZcodeStartPlan(model, context, {
      apiKey,
      reasoning: Effort.Low,
      maxTokens: 32,
      acceptEmptyResponse: false,
    }).result();
    output(ctx, `ZCode probe succeeded (tokens: ${message.usage.totalTokens}).`);
  } catch (error) {
    output(ctx, `ZCode probe failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export default function zcodeStartPlan(pi: ExtensionAPI): void {
  pi.setLabel("ZCode Start Plan");
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: ZCODE_BASE_URL,
    api: "zcode-start-plan-anthropic",
    streamSimple: streamZcodeStartPlan,
    authHeader: true,
    models: ZCODE_MODELS,
    usage: zcodeUsageProvider,
    oauth: {
      name: "ZCode Start Plan",
      login: loginZcodeStartPlan,
      getApiKey: (credentials) => credentials.access,
    },
  });

  pi.registerCommand("zcode-status", {
    description: "Show redacted ZCode Start Plan provider state",
    handler: async (_args, ctx) => output(ctx, JSON.stringify(statusPayload(ctx), null, 2)),
  });

  pi.registerCommand("zcode-probe", {
    description: "Send a minimal ZCode Start Plan request (consumes quota)",
    handler: async (_args, ctx) => runProbe(ctx),
  });

  pi.on("session_shutdown", () => {
    closeCaptchaBroker();
  });
}
