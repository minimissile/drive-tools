import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { AiService } from "../core/ai";
import { BitBrowser, assertEditorPage } from "../core/bitbrowser";
import { csv } from "../core/csv";
import type { BrowserBinding } from "../shared/types";
test("指纹窗口连接测试只打开已存编辑器，不创建发布记录或改动草稿审核", async () => {
  const f = await fixture();
  try {
    let opened = "";
    f.app.bit.open = async (binding) => {
      opened = binding.windowId;
      return { opened: true, url: binding.editorUrl };
    };
    const binding = (await f.app.invoke("binding.save", {
      platform: "xiaohongshu",
      alias: "测试窗口",
      windowId: "window-1",
      editorUrl: "https://creator.xiaohongshu.com/",
      linkPermission: "none",
      ruleNote: "",
    })) as BrowserBinding;
    await f.app.invoke("binding.open", { id: binding.id });
    assert.equal(opened, "window-1");
    assert.equal(f.app.repo.drafts().length, 0);
    assert.equal(f.app.snapshot().publications.length, 0);
    await assert.rejects(f.app.invoke("binding.open", { id: "missing" }), {
      code: "NOT_FOUND",
    });
  } finally {
    await f.cleanup();
  }
});
test("OpenRouter连接诊断只返回额度字段，不泄露Key或创建生成费用记录", async () => {
  const f = await fixture();
  try {
    await f.app.secrets.set("openrouter", "private-api-key");
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (url, init) => {
        assert.equal(url, "https://openrouter.ai/api/v1/key");
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer private-api-key",
        );
        return {
          data: {
            label: "private-api-key",
            hash: "private-hash",
            creator_user_id: "private-id",
            usage: 1.25,
            usage_daily: 0.01,
            limit: null,
            limit_remaining: null,
            is_free_tier: false,
          },
        };
      },
    );
    const result = await ai.connection();
    assert.equal(result.usageMicros, 1250000);
    assert.equal(result.usageDailyMicros, 10000);
    assert.equal(result.limitMicros, null);
    assert.equal(result.remainingMicros, null);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(f.app.repo.calls().length, 0);
    const invalid = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async () => ({ data: {} }),
    );
    await assert.rejects(invalid.connection(), { code: "INVALID_RESPONSE" });
  } finally {
    await f.cleanup();
  }
});
test("OpenRouter异常价格不会绕过预算，业务错误不会伪造成功", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false);
    await f.app.secrets.set("openrouter", "private-api-key");
    f.app.db.setSetting("model", "test/structured");
    f.app.db.setSetting("dailyAiBudgetMicros", 100000);
    let requests = 0;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (url) => {
        requests++;
        if (url.endsWith("/models"))
          return {
            data: [
              {
                id: "test/structured",
                pricing: { prompt: "NaN", completion: "-1" },
                supported_parameters: ["structured_outputs"],
              },
            ],
          };
        return { error: { code: 402, message: "余额不足" } };
      },
    );
    const models = await ai.models();
    assert.equal(models[0].promptPrice, null);
    assert.equal(models[0].completionPrice, null);
    await assert.rejects(ai.extract(saved.resourceId), {
      code: "MODEL_PRICE_REQUIRED",
    });
    assert.equal(requests, 1);
    f.app.db.setSetting("modelCatalog", [
      {
        id: "test/structured",
        promptPrice: 0.000001,
        completionPrice: 0.000001,
        structured: true,
      },
    ]);
    await assert.rejects(ai.extract(saved.resourceId), {
      code: "AI_REMOTE_ERROR",
    });
    assert.equal(f.app.repo.calls()[0].status, "uncertain");
    assert.equal(f.app.repo.drafts().length, 0);
  } finally {
    await f.cleanup();
  }
});
test("OpenRouter只发送资源文字，记录实际美元费用，错误结构不落库", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false);
    await f.app.secrets.set("openrouter", "private-api-key");
    f.app.db.setSetting("model", "test/structured");
    f.app.db.setSetting("modelCatalog", [
      {
        id: "test/structured",
        promptPrice: 0.000001,
        completionPrice: 0.000002,
        structured: true,
      },
    ]);
    f.app.db.setSetting("dailyAiBudgetMicros", 100000);
    let calls = 0,
      invalid = false;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (url, init) => {
        assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
        assert.match(String(init?.body), /AI办公/);
        assert.doesNotMatch(
          String(init?.body),
          /source123|private-api-key|owner-1|source-file/,
        );
        calls++;
        return {
          usage: { cost: 0.012 },
          choices: [
            {
              message: {
                content: JSON.stringify(
                  invalid
                    ? { body: 42 }
                    : {
                        title: "办公练习",
                        body: "练习会议纪要的整理。",
                        tags: ["#办公"],
                        coverText: "一步一步练习",
                      },
                ),
              },
            },
          ],
        };
      },
    );
    const draft = await ai.draft(saved.copyId, "xiaohongshu", null);
    assert.equal(draft.reviewed, false);
    assert.equal(f.app.repo.calls()[0].confirmedMicros, 12000);
    invalid = true;
    await assert.rejects(ai.draft(saved.copyId, "x", null), {
      code: "INVALID_AI_RESPONSE",
    });
    assert.equal(f.app.repo.drafts().length, 1);
    f.app.db.setSetting("dailyAiBudgetMicros", 1);
    await assert.rejects(ai.draft(saved.copyId, "x", null), {
      code: "AI_BUDGET_EXCEEDED",
    });
    assert.equal(calls, 2);
  } finally {
    await f.cleanup();
  }
});
test("比特只使用配置的本机服务，窗口分页和服务错误均按实际响应处理", async () => {
  const requests: any[] = [];
  const bit = new BitBrowser(
    async () => ({ url: "http://127.0.0.1:54345", key: "local-key" }),
    async (url, init) => {
      requests.push({ url, init });
      return url.endsWith("/health")
        ? { success: true }
        : {
            success: true,
            data: { list: [{ id: "window-1", name: "本人内容号", seq: 1 }] },
          };
    },
  );
  assert.equal((await bit.health()).connected, true);
  assert.equal((await bit.windows())[0].id, "window-1");
  assert.equal(requests.length, 2);
  const remote = new BitBrowser(
    async () => ({ url: "http://evil.test", key: null }),
    async () => {
      throw new Error("不应请求");
    },
  );
  await assert.rejects(remote.health(), { code: "INVALID_LOCAL_URL" });
  const failed = new BitBrowser(
    async () => ({ url: "http://localhost:1111", key: null }),
    async () => ({ success: false, msg: "服务未启动" }),
  );
  await assert.rejects(failed.health(), { code: "BIT_ERROR" });
  const malformed = new BitBrowser(
    async () => ({ url: "http://localhost:1111", key: null }),
    async () => ({ success: true, data: { list: [{ name: "缺少ID" }] } }),
  );
  await assert.rejects(malformed.windows(), { code: "BIT_SCHEMA_CHANGED" });
});
test("费用CSV保留未知值与币种，防止单元格公式注入", () => {
  assert.equal(
    csv([
      ["时间", "金额"],
      ['=HYPERLINK("bad")', null],
      ["CNY", 0],
    ]),
    '\uFEFF"时间","金额"\r\n"\'=HYPERLINK(""bad"")",""\r\n"CNY","0"\r\n',
  );
});

test("比特实名、客户端拦截及平台登录页不会误报编辑器就绪", () => {
  const target = "https://creator.xiaohongshu.com/";
  assert.throws(
    () =>
      assertEditorPage(
        target,
        "chrome-extension://client/index.html",
        "无法访问此网站！暂不支持未实名用户访问，请完成实名认证并升级客户端",
      ),
    { code: "BIT_REALNAME_REQUIRED" },
  );
  assert.throws(
    () =>
      assertEditorPage(
        target,
        "chrome-extension://client/index.html",
        "网站访问受限",
      ),
    { code: "BIT_CLIENT_BLOCKED" },
  );
  assert.throws(
    () => assertEditorPage(target, "https://creator.xiaohongshu.com/login"),
    { code: "EDITOR_LOGIN_REQUIRED" },
  );
  assert.throws(() => assertEditorPage(target, "https://other.test/"), {
    code: "EDITOR_REDIRECTED",
  });
  assert.throws(
    () => assertEditorPage(target, "http://creator.xiaohongshu.com/"),
    { code: "EDITOR_REDIRECTED" },
  );
  assert.doesNotThrow(() =>
    assertEditorPage(target, "https://creator.xiaohongshu.com/publish/publish"),
  );
});

test("CSDN入口支持官方创作中心跳转，HTTP错误和其他账号域名仍阻止交付", () => {
  assert.doesNotThrow(() =>
    assertEditorPage(
      "https://editor.csdn.net/",
      "https://mp.csdn.net/mp_blog/creation/editor",
    ),
  );
  assert.throws(
    () =>
      assertEditorPage(
        "https://editor.csdn.net/",
        "https://editor.csdn.net/",
        "",
        403,
      ),
    { code: "EDITOR_HTTP_ERROR" },
  );
  for (const current of [
    "https://passport.csdn.net/login",
    "https://mp.csdn.net.attacker.test/edit",
    "https://user:pass@mp.csdn.net/edit",
    "https://mp.csdn.net:444/edit",
  ])
    assert.throws(() => assertEditorPage("https://mp.csdn.net/edit", current), {
      code: "EDITOR_REDIRECTED",
    });
});

test("比特导航失败会持久显示原因，重试成功清除错误，均不标记为已发布", async () => {
  const f = await fixture();
  try {
    const binding = (await f.app.invoke("binding.save", {
      platform: "xiaohongshu",
      alias: "测试窗口",
      windowId: "window-1",
      editorUrl: "https://creator.xiaohongshu.com/",
      linkPermission: "none",
      ruleNote: "",
    })) as BrowserBinding;
    f.app.bit.open = async () => {
      throw new Error("客户端要求实名认证");
    };
    await assert.rejects(
      f.app.invoke("binding.open", { id: binding.id }),
      /实名认证/,
    );
    const checked = f.app.repo.bindings()[0];
    assert.match(checked.openError!, /实名认证/);
    assert.ok(checked.lastCheckedAt);
    assert.equal(checked.lastOpenedAt, null);
    f.app.bit.open = async () => ({ opened: true, url: binding.editorUrl });
    await f.app.invoke("binding.open", { id: binding.id });
    assert.equal(f.app.repo.bindings()[0].openError, null);
    assert.ok(f.app.repo.bindings()[0].lastOpenedAt);
    assert.equal(f.app.snapshot().publications.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("费用总览统计全部台账，区分币种、未返回实费与未知预留", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 505; i++)
      f.app.db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,status,estimated_micros,reserved_micros,created_at) VALUES(?,?,?,?,?,?,?,?)",
        `call-${i}`,
        "longtail",
        "query",
        1,
        "success",
        3000,
        3000,
        new Date(i * 1000).toISOString(),
      );
    f.app.db.run(
      "INSERT INTO api_calls(id,endpoint,phase,units,status,confirmed_micros,created_at) VALUES('ai-paid','openrouter','draft',1,'success',37,?)",
      new Date().toISOString(),
    );
    f.app.db.run(
      "INSERT INTO api_calls(id,endpoint,phase,units,status,estimated_micros,reserved_micros,created_at) VALUES('ai-unknown','openrouter','draft',1,'uncertain',NULL,NULL,?)",
      new Date().toISOString(),
    );
    const snapshot = f.app.snapshot();
    assert.equal(snapshot.apiCalls.length, 500);
    assert.equal(snapshot.apiUsage.cny.requestCount, 505);
    assert.equal(snapshot.apiUsage.cny.estimatedMicros, 1515000);
    assert.equal(snapshot.apiUsage.cny.confirmedUnknownCount, 505);
    assert.equal(snapshot.apiUsage.usd.requestCount, 2);
    assert.equal(snapshot.apiUsage.usd.confirmedMicros, 37);
    assert.equal(snapshot.apiUsage.usd.confirmedUnknownCount, 1);
    assert.equal(snapshot.apiUsage.usd.pendingUnknownCount, 1);
  } finally {
    await f.cleanup();
  }
});
