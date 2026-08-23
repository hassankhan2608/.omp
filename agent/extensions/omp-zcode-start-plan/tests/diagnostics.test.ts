import { expect, test } from "bun:test";
import { ZcodeDiagnostics } from "../src/diagnostics";

test("records operational request state without secret values", () => {
  const diagnostics = new ZcodeDiagnostics();
  diagnostics.recordRequest({
    endpoint: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    method: "POST",
    headers: new Headers({
      authorization: "Bearer plan-jwt",
      "x-aliyun-captcha-verify-param": "captcha-secret",
      "x-zcode-app-version": "3.8.1",
    }),
    durationMs: 42,
    status: 200,
    requestId: "req-1",
  });

  const serialized = JSON.stringify(diagnostics.snapshot());
  expect(serialized).toContain("authorization");
  expect(serialized).toContain("x-aliyun-captcha-verify-param");
  expect(serialized).not.toContain("plan-jwt");
  expect(serialized).not.toContain("captcha-secret");
  expect(diagnostics.snapshot()).toMatchObject({ status: 200, requestId: "req-1", durationMs: 42 });
});
