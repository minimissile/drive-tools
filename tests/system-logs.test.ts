import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, now } from "../core/database";
import { RuntimeLog } from "../core/runtime-log";
import { SystemLogs } from "../core/system-logs";
import { AppError } from "../core/errors";
import { fixture as appFixture } from "./helpers";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-system-logs-")),
    db = new Database(join(dir, "panxu.db"));
  return {
    dir,
    db,
    logs: new SystemLogs(db, dir),
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function failedCall(
  db: Database,
  id = "call-one",
  status = "success",
  createdAt = now(),
) {
  db.run(
    "INSERT INTO api_calls(id,endpoint,phase,units,status,message,confirmed_micros,created_at) VALUES(?,?,?,?,?,?,?,?)",
    id,
    "openrouter",
    "wechat_article_copy",
    1,
    status,
    "返回内容校验未通过：模型中断",
    0,
    createdAt,
  );
  db.run(
    "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
    `ai-response:${id}`,
    JSON.stringify({
      model: "qwen/article",
      finishReason: "error",
      raw: "private-article-body-must-not-be-exposed",
    }),
    now(),
  );
}

test("异常汇总包含跨模块警告与错误、历史计费成功但内容无效的AI回执", async () => {
  const f = await fixture();
  try {
    new RuntimeLog(f.db, f.dir, "wechat").record({
      level: "warning",
      event: "draft.verification_failed",
      message: "草稿保存待核对",
    });
    new RuntimeLog(f.db, f.dir, "zhihu").record({
      level: "info",
      event: "ready",
      message: "正常状态",
    });
    failedCall(f.db);
    const page = f.logs.read({ range: "all" });
    assert.equal(page.total, 2);
    assert.deepEqual(page.domains, ["ai", "wechat"]);
    const ai = page.items.find((e) => e.domain === "ai")!;
    assert.equal(ai.level, "error");
    assert.equal(ai.details.finishReason, "error");
    assert.equal(ai.details.model, "qwen/article");
    assert.equal(ai.details.confirmedMicros, 0);
    assert(!JSON.stringify(page).includes("private-article-body"));
    assert.equal(
      f.logs.read({ search: "qwen/article" }).total,
      1,
      "旧缓存的模型可检索",
    );
    assert.equal(f.logs.read({ domain: "wechat", level: "warning" }).total, 1);
    assert.equal(f.logs.read({ domain: "wechat", level: "error" }).total, 0);
  } finally {
    await f.cleanup();
  }
});

test("异常筛选按实际时间与字面关键词查询，分页边界稳定", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 55; n++)
      new RuntimeLog(f.db, f.dir, "wechat").record({
        level: "error",
        event: "rewrite.failed",
        message: n === 0 ? "匹配 100%_exact" : "改写失败",
        taskId: `article-${n}`,
      });
    failedCall(
      f.db,
      "old-call",
      "failed",
      new Date(Date.now() - 40 * 86400000).toISOString(),
    );
    assert.equal(f.logs.read({}).total, 55);
    assert.equal(f.logs.read({ range: "all" }).total, 56);
    assert.equal(f.logs.read({ page: 99 }).page, 2);
    assert.equal(f.logs.read({ page: 2 }).items.length, 5);
    assert.equal(f.logs.read({ search: "100%_exact" }).total, 1);
    assert.equal(f.logs.read({ search: "' OR 1=1 --" }).total, 0);
    assert.equal(f.logs.read({ search: "article-54" }).total, 1);
    assert.throws(() => f.logs.read({ level: "info" }));
  } finally {
    await f.cleanup();
  }
});

test("统一捕获只保留业务标识与诊断，不保存正文凭据，重复读取报错限频", async () => {
  const f = await fixture();
  try {
    const error = new AppError(
      "INVALID_AI_RESPONSE",
      "Bearer secret-value",
      false,
      {
        apiCallId: "call-one",
        model: "qwen/article",
        token: "private-token",
        finishReason: "error",
      },
    );
    const input = {
      id: "article-one",
      accountId: "account-one",
      body: "private-body",
      apiKey: "private-key",
    };
    f.logs.capture("wechat.rewrite", error, input);
    failedCall(f.db);
    assert.equal(
      f.logs.read({}).total,
      1,
      "同一个AI调用不重复显示API和操作异常",
    );
    const entry = f.logs.read({}).items[0];
    assert.equal(entry.taskId, "article-one");
    assert.equal(entry.accountId, "account-one");
    assert.equal(entry.details.code, "INVALID_AI_RESPONSE");
    assert(
      !/secret-value|private-body|private-key|private-token/.test(
        JSON.stringify(entry),
      ),
    );
    f.logs.capture("wechat.get", new Error("读取暂时失败"), input);
    f.logs.capture("wechat.get", new Error("读取暂时失败"), input);
    assert.equal(f.logs.read({}).total, 2, "同一分钟重复自动读取只留一条");
    f.logs.capture("wechat.rewrite", error, input);
    assert.equal(f.logs.read({}).total, 3, "用户主动重试仍留痕");
    f.logs.capture("systemLogs.list", new Error("日志读取失败"), {});
    assert.equal(f.logs.read({}).total, 3, "日志页读取失败不递归写日志");
  } finally {
    await f.cleanup();
  }
});

test("AppService实际IPC失败自动入异常日志，并保留原有错误与工作空间隔离", async () => {
  const f = await appFixture();
  try {
    await assert.rejects(
      f.app.invoke("wechat.get", {
        id: "missing-article",
        body: "not-log-input",
        cookie: "not-log-cookie",
      }),
    );
    const page = (await f.app.invoke("systemLogs.list", {
      domain: "wechat",
    })) as ReturnType<SystemLogs["read"]>;
    assert.equal(page.total, 1);
    assert.equal(page.items[0].taskId, "missing-article");
    assert.equal(page.items[0].details.method, "wechat.get");
    assert(!JSON.stringify(page).includes("not-log-"));
    await assert.rejects(f.app.invoke("systemLogs.list", { page: -1 }));
    assert.equal(
      (
        (await f.app.invoke("systemLogs.list", {})) as ReturnType<
          SystemLogs["read"]
        >
      ).total,
      1,
    );
    const other = new Database(":memory:");
    try {
      assert.equal(new SystemLogs(other, f.dir).read({}).total, 0);
    } finally {
      other.close();
    }
  } finally {
    await f.cleanup();
  }
});
