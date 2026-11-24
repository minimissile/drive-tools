import test from "node:test";
import assert from "node:assert/strict";
import { BitBrowser } from "../core/bitbrowser";
import { AppError, ServiceHttpError } from "../core/errors";

test("比特本地服务断连与超时给出明确连接原因，不暴露凭据，不自动重发", async () => {
  for (const failure of [
    new TypeError("fetch failed"),
    Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
  ]) {
    let calls = 0;
    const bit = new BitBrowser(
      async () => ({ url: "http://127.0.0.1:54345", key: "fixture-secret" }),
      async () => {
        calls++;
        throw failure;
      },
    );
    await assert.rejects(
      () => bit.health(),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "BIT_CONNECTION_UNAVAILABLE");
        assert.match(error.message, /启动比特客户端并开启本地 API/);
        assert.ok(!error.message.includes("fixture-secret"));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
test("比特服务已返回的明确HTTP拒绝保留原错误，不误报连接失败", async () => {
  const failure = new ServiceHttpError(403, "比特API无访问权限");
  const bit = new BitBrowser(
    async () => ({ url: "http://127.0.0.1:54345", key: null }),
    async () => {
      throw failure;
    },
  );
  await assert.rejects(
    () => bit.health(),
    (error) => error === failure,
  );
});
