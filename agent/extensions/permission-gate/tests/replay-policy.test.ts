import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaySessionFiles } from "../scripts/replay-policy";

test("replays Bash calls as aggregate counts without retaining command text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-replay-"));
  try {
    const session = join(directory, "session.jsonl");
    await writeFile(session, [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", toolCalls: [{ name: "bash", arguments: { command: "git -C /repo status" } }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", toolCalls: [{ name: "bash", arguments: { command: "mkfs.ext4 /dev/sda1" } }] },
      }),
      "{ not json",
    ].join("\n"));

    const result = await replaySessionFiles([session]);
    expect(result.bashCalls).toBe(2);
    expect(result.commandUnits).toBe(2);
    expect(result.parseErrors).toBe(1);
    expect(result.byLevel.high.deny).toBeGreaterThanOrEqual(1);
    expect(result.byLevel.low.allow).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/repo");
    expect(serialized).not.toContain("mkfs");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
