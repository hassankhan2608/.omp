import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { expect, test } from "bun:test";
import zcodeStartPlan from "../src/extension";

test("registers the native provider, usage, OAuth, diagnostics, and cleanup", () => {
  const providers = new Map<string, ProviderConfig>();
  const commands: string[] = [];
  const events: string[] = [];
  const fake = {
    setLabel: () => {},
    registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
  } as unknown as ExtensionAPI;

  zcodeStartPlan(fake);

  const provider = providers.get("zcode-start-plan");
  expect(provider?.api).toBe("zcode-start-plan-anthropic");
  expect(provider?.models).toHaveLength(2);
  expect(provider?.oauth?.name).toBe("ZCode Start Plan");
  expect(provider?.usage?.id).toBe("zcode-start-plan");
  expect(commands).toEqual(["zcode-status", "zcode-probe"]);
  expect(events).toContain("session_shutdown");
});
