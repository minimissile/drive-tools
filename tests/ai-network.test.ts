import test from "node:test";
import assert from "node:assert/strict";
import { openRouterTarget, openRouterJsonRequest } from "../core/ai-network";

test("OpenRouter系统网络只接收固定官方接口和方法，凭据不会被发送到其他站点", () => {
  for (const [url, method] of [
    ["https://openrouter.ai/api/v1/key", "GET"],
    ["https://openrouter.ai/api/v1/models", "GET"],
    ["https://openrouter.ai/api/v1/chat/completions", "POST"],
  ])
    assert.equal(openRouterTarget(url, method).href, url);
  for (const [url, method] of [
    ["http://openrouter.ai/api/v1/key", "GET"],
    ["https://openrouter.ai.evil.test/api/v1/key", "GET"],
    ["https://someone@openrouter.ai/api/v1/key", "GET"],
    ["https://openrouter.ai:444/api/v1/key", "GET"],
    ["https://openrouter.ai/api/v1/key?redirect=https://evil.test", "GET"],
    ["https://openrouter.ai/api/v1/key#test", "GET"],
    ["https://openrouter.ai/api/v1/key", "POST"],
    ["https://openrouter.ai/api/v1/chat/completions", "GET"],
    ["https://openrouter.ai/redirect", "GET"],
  ])
    assert.throws(() => openRouterTarget(url, method), {
      code: "AI_NETWORK_TARGET",
    });
});

test("OpenRouter 系统网络只允许向官方图片端点提交 POST", () => {
  const imageUrl = "https://openrouter.ai/api/v1/images";
  assert.equal(openRouterTarget(imageUrl, "POST").href, imageUrl);
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.throws(() => openRouterTarget(imageUrl, method), {
      code: "AI_NETWORK_TARGET",
    });
  }
  for (const [url, method] of [
    [`${imageUrl}/models`, "GET"],
    [`${imageUrl}/`, "POST"],
    [`${imageUrl}/generations`, "POST"],
    [`${imageUrl}/edits`, "POST"],
    [`${imageUrl}?`, "POST"],
    [`${imageUrl}?redirect=https://example.test`, "POST"],
    [`${imageUrl}#image`, "POST"],
    ["http://openrouter.ai/api/v1/images", "POST"],
    ["https://openrouter.ai.example.test/api/v1/images", "POST"],
    ["https://user:token@openrouter.ai/api/v1/images", "POST"],
    ["https://openrouter.ai:444/api/v1/images", "POST"],
    ["https://openrouter.ai/api/v1/videos", "POST"],
  ]) {
    assert.throws(() => openRouterTarget(url, method), {
      code: "AI_NETWORK_TARGET",
    });
  }
});

test("系统网络适配保留请求、超时与HTTP回执，失败只请求一次，不静默回落重发", async () => {
  let calls = 0;
  const controller = new AbortController();
  const request = openRouterJsonRequest(async (url, init) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.body, '{"model":"fixture"}');
    assert.equal(init.method, "POST");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer fixture-only",
    );
    assert.equal(init.signal, controller.signal);
    assert.equal(init.redirect, "error");
    return new Response(
      JSON.stringify({ error: { message: "Request path cannot be relayed" } }),
      { status: 400 },
    );
  });
  const observed: number[] = [];
  await assert.rejects(
    () =>
      request(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          body: '{"model":"fixture"}',
          headers: { Authorization: "Bearer fixture-only" },
          signal: controller.signal,
          redirect: "follow",
        },
        1000,
        (_body, status) => observed.push(status),
      ),
    { status: 400 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(observed, [400]);
  await assert.rejects(() => request("https://evil.test", { method: "POST" }), {
    code: "AI_NETWORK_TARGET",
  });
  assert.equal(calls, 1);
});
