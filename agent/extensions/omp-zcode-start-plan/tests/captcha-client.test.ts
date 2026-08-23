import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { ElectronCaptchaBroker, type BrokerProcess } from "../src/captcha/client";

const config = { sceneId: "scene", region: "sgp", prefix: "prefix" };

class FakeBrokerProcess extends EventEmitter implements BrokerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function respondToRequests(process: FakeBrokerProcess, makeToken: (id: number) => string): void {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number };
      buffer = buffer.slice(newline + 1);
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, verifyParam: makeToken(request.id) })}\n`);
    }
  });
}

test("reuses one Electron process while minting a distinct parameter per request", async () => {
  let launchCount = 0;
  const broker = new ElectronCaptchaBroker({
    launch: () => {
      launchCount += 1;
      const process = new FakeBrokerProcess();
      respondToRequests(process, (id) => `token-${id}`);
      return process;
    },
  });

  expect(await broker.solve(config, "3.8.1")).toBe("token-1");
  expect(await broker.solve(config, "3.8.1")).toBe("token-2");
  expect(launchCount).toBe(1);
  broker.close();
});

test("rejects pending work and relaunches after broker exit", async () => {
  const processes: FakeBrokerProcess[] = [];
  const broker = new ElectronCaptchaBroker({
    launch: () => {
      const process = new FakeBrokerProcess();
      processes.push(process);
      if (processes.length === 2) respondToRequests(process, () => "fresh-token");
      return process;
    },
  });

  const pending = broker.solve(config, "3.8.1");
  processes[0]!.emit("exit", 1, null);
  await expect(pending).rejects.toThrow("exited with code 1");
  expect(await broker.solve(config, "3.8.1")).toBe("fresh-token");
  expect(processes).toHaveLength(2);
  broker.close();
});
