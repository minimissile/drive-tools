import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, removeV14, file, currentSchemaVersion } from "./helpers";
import { Database } from "../core/database";
import { ZhidaoOperations } from "../core/zhidao/service";
import {
  extractBaiduShares,
  parseZhidaoSearch,
  safeHtmlAnswer,
  questionTitle,
} from "../core/zhidao/parsers";
import { readTableBytes, keywordRows } from "../core/table-files";
import { xlsx } from "../core/export-formats";
import { miningSources, parseMining } from "../core/zhidao/mining";
import { parseZhidaoJson, ZhidaoClient } from "../core/zhidao/client";
import { pansouUrl } from "../core/zhidao/pansou";
import { ServiceHttpError } from "../core/errors";

const link = "https://pan.baidu.com/s/1testshare123";
const account = {
  id: "zd_fixture",
  alias: "测试知道账号",
  uid: "uid-zd",
  nickname: "测试用户",
  status: "connected" as const,
  bulkPermission: true,
  checkedAt: new Date().toISOString(),
  message: "测试会话",
};
async function operations(
  fetcher = async () => "<a href='/soft/1234.htm'>测试软件名称</a>",
) {
  const f = await fixture();
  await f.app.secrets.set("openrouter", "zhidao-test-key");
  f.app.db.setSetting("aiModels", { copy: "test/copy" });
  const op = new ZhidaoOperations(
    f.app.repo,
    f.app.secrets,
    f.app.ai,
    f.ports,
    f.dir,
    () => {},
    { fetcher, pace: 0 },
  );
  op.store.saveAccount(account);
  op.client.identity = async () => ({
    uid: account.uid,
    nickname: account.nickname,
    stoken: "temporary-token",
  });
  op.client.permission = async () => true;
  op.client.publishingRights = async () => ({ hasPermission: true, isBanned: false, quota: 5000, usedQuota: 0, remainingQuota: 5000 });
  let calls = 0;
  f.app.ai.resourceExport = async <T>(
    _name: string,
    _schema: unknown,
    _instruction: string,
    input: unknown,
  ) => {
    calls++;
    return {
      answer:
        "根据输入资料给出完整的测试回答。操作前请核对实际条件，按步骤整理、检查并保存。",
    } as T;
  };
  return {
    ...f,
    op,
    calls: () => calls,
    async cleanup() {
      op.close();
      await f.cleanup();
    },
  };
}
function template(op: ZhidaoOperations) {
  const r = op.store.create("template", "已审问答", {}, 1);
  op.store.state(r.id, "completed", "", 1);
  return op.store.put(r.id, "one", {
    name: "自制练习",
    question: "怎样整理本人资料？",
    answer: "<p>先整理目录，再核对文件。</p>",
    reviewed: true,
    status: "ready",
  });
}

test("知道账号检查期间阻止并发检查、移除和任务启动，同一身份不能重复绑定", async () => {
  const f = await operations();
  try {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.op.client.identity = async () => {
      await ready;
      return {
        uid: account.uid,
        nickname: account.nickname,
        stoken: "test-token",
      };
    };
    const checking = f.op.check(account.id);
    assert.equal(f.op.isBusy, true);
    await assert.rejects(f.op.check(account.id), { code: "ACCOUNT_BUSY" });
    await assert.rejects(f.op.removeAccount(account.id), {
      code: "ACCOUNT_BUSY",
    });
    await assert.rejects(
      f.op.start({
        kind: "answer",
        input: {
          mode: "auto",
          accountId: account.id,
          count: 1,
          style: "简洁回答",
        },
        authorized: true,
      }),
      { code: "ACCOUNT_BUSY" },
    );
    release();
    await checking;
    assert.equal(f.op.isBusy, false);
    const duplicate = await f.op.addAccount("重复身份测试");
    await assert.rejects(f.op.check(duplicate.id), {
      code: "DUPLICATE_ACCOUNT",
    });
    assert.equal(f.op.store.account(duplicate.id).status, "expired");
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});

test("采集解析保留链接和邻近提取码，区分正常空页、风控和结构变化", () => {
  assert.deepEqual(
    extractBaiduShares(`<p>${link}?pwd=a1B2</p><p>${link} 提取码：a1B2</p>`),
    [{ name: "", link: link + "?pwd=a1B2", code: "a1B2" }],
  );
  assert.equal(
    extractBaiduShares(`${link} 提取码：<b>c3d4</b>`)[0].code,
    "c3d4",
  );
  assert.equal(
    parseZhidaoSearch(
      '<a href="https://zhidao.baidu.com/question/123456.html"><em>真实</em>问题</a>',
    )[0].title,
    "真实问题",
  );
  assert.deepEqual(parseZhidaoSearch("没有找到相关结果"), []);
  assert.throws(() => parseZhidaoSearch("百度安全验证 wappass"), {
    code: "SOURCE_VERIFICATION",
  });
  assert.throws(() => parseZhidaoSearch("新结构无法识别"), {
    code: "SOURCE_CHANGED",
  });
});
test("模板HTML转义内容，轮换标题使用自然问句并限制49字", () => {
  const html = safeHtmlAnswer(
    '<script>alert("x")</script>\n正常说明',
    link,
    "a1b2",
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes(link));
  for (let n = 0; n < 20; n++) {
    const title = questionTitle("本人独立制作的学习资料".repeat(20), n);
    assert.ok(title.length <= 49);
    assert.match(title, /[？?]$/);
  }
});
test("XLSX、带BOM CSV与TXT导入真实表格，关键词拒绝资源表与多列", () => {
  const rows = [
    ["资源名称", "网盘链接", "提取码"],
    ["本人练习", link, "a1b2"],
  ];
  assert.deepEqual(readTableBytes("资源.xlsx", xlsx(rows)), rows);
  assert.deepEqual(
    readTableBytes("词.csv", Buffer.from('\uFEFF"甲软件"\r\n"乙软件"')),
    [["甲软件"], ["乙软件"]],
  );
  assert.deepEqual(keywordRows([["甲软件"], ["甲软件"], ["乙软件"]]), [
    "甲软件",
    "乙软件",
  ]);
  assert.throws(() => keywordRows([["名称", "链接"]]), {
    code: "KEYWORD_COLUMNS",
  });
  assert.throws(() => keywordRows([[link]]), { code: "INVALID_KEYWORDS" });
  assert.throws(() => readTableBytes("旧表.xls", Buffer.from("old")), {
    code: "INVALID_TABLE",
  });
  const damaged = xlsx(rows);
  damaged[damaged.indexOf(Buffer.from("本人练习"))] ^= 1;
  assert.throws(() => readTableBytes("损坏.xlsx", damaged));
});
test("八领域均有可解析来源，软件新榜与豆瓣JSON去重，PanSou只接受本机HTTP", () => {
  assert.equal(Object.keys(miningSources).length, 8);
  for (const list of Object.values(miningSources)) assert.ok(list.length >= 2);
  assert.deepEqual(
    parseMining(
      '<a href="/soft/123.htm">软件A</a><a href="/soft/123.htm">软件A</a><a href="/news/456">新闻</a>',
      miningSources.软件[0],
    ),
    ["软件A"],
  );
  assert.deepEqual(
    parseMining(
      JSON.stringify({
        subjects: [{ title: "测试影片" }, { title: "测试影片" }],
      }),
      miningSources.电影[0],
    ),
    ["测试影片"],
  );
  assert.equal(pansouUrl("http://127.0.0.1:8888"), "http://127.0.0.1:8888");
  for (const url of [
    "https://example.com",
    "http://example.com",
    "http://127.0.0.1:8888/api",
    "http://user:pass@127.0.0.1",
  ])
    assert.throws(() => pansouUrl(url));
});
test("v13升级先备份，新增运营表且不更改已有资源，重开不会重复备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-v14-"));
  try {
    const path = join(dir, "test.db");
    new Database(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(removeV14 + "PRAGMA user_version=13");
    raw.close();
    const migrated = new Database(path);
    assert.equal(migrated.get<any>("PRAGMA user_version").user_version, currentSchemaVersion);
    assert.ok(
      migrated.get(
        "SELECT name FROM sqlite_master WHERE name='operation_items'",
      ),
    );
    migrated.close();
    new Database(path).close();
    assert.equal(
      (await readdir(dir)).filter((n) => n.includes("before-v14")).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("答题缺少Key或文案模型时在取题前拒绝启动，配置后可继续原任务", async () => {
  const f = await operations();
  try {
    let reads = 0, submits = 0;
    f.op.client.questions = async () => {
      reads++;
      return {
        items: [{ qid: "configured", question: "如何整理资料？" }],
        nextBase: 1, hasMore: false,
      };
    };
    f.op.client.answer = async () => {
      submits++;
      return { errno: 0, data: { aid: "configured-aid" } };
    };
    const input = {
      mode: "auto" as const, accountId: account.id,
      count: 1, categories: ["emotion" as const],
    };
    const start = { kind: "answer" as const, authorized: true as const, input };
    f.app.secrets.remove("openrouter");
    await assert.rejects(f.op.start(start), { code: "API_KEY_REQUIRED" });
    await assert.rejects(f.op.start({
      kind: "answer", authorized: true,
      input: { mode: "manual", question: "如何整理资料？" },
    }), { code: "API_KEY_REQUIRED" });
    await f.app.secrets.set("openrouter", "zhidao-test-key");
    f.app.db.setSetting("aiModels", {});
    await assert.rejects(f.op.start(start), { code: "MODEL_REQUIRED" });
    assert.equal(f.op.store.list("answer").total, 0);

    const run = f.op.store.create("answer", "已有失败任务", input, 1);
    f.op.store.state(run.id, "failed", "请先配置OpenRouter API Key。");
    assert.throws(() => f.op.resume(run.id), { code: "MODEL_REQUIRED" });
    assert.equal(f.op.store.run(run.id).status, "failed");
    assert.equal(reads, 0);
    assert.equal(submits, 0);
    assert.equal(f.calls(), 0);
    assert.equal(f.app.repo.calls().length, 0);

    f.app.db.setSetting("aiModels", { copy: "test/copy" });
    f.op.resume(run.id);
    await f.op.settled(run.id);
    assert.equal(f.op.store.run(run.id).status, "completed");
    assert.equal(submits, 1);
    assert.equal(f.calls(), 1);
  } finally {
    await f.cleanup();
  }
});

test("只读摘要、任务历史和导入不调用AI，手动回答显式执行且不携带凭据", async () => {
  const f = await operations();
  try {
    f.op.summary();
    f.op.store.list();
    assert.equal(f.calls(), 0);
    const imported = f.op.importResources([
      ["资源名称", "网盘链接", "提取码"],
      ["自制练习", link, "a1b2"],
      ["无效项", "不是链接", ""],
    ]);
    assert.equal(f.op.store.items(imported.id)[0].name, "自制练习");
    assert.equal(f.calls(), 0);
    const run = await f.op.start({
      kind: "answer",
      input: { mode: "manual", question: "如何整理？", style: "步骤详解" },
      authorized: true,
    });
    await f.op.settled(run.id);
    assert.equal(f.calls(), 1);
    assert.equal(f.op.store.run(run.id).status, "completed");
    assert.match(f.op.store.items(run.id)[0].answer, /完整/);
    assert.ok(!JSON.stringify(f.op.summary()).includes("temporary-token"));
    await assert.rejects(
      f.op.start({
        kind: "answer",
        input: { mode: "manual", question: "如何整理？" },
        authorized: false,
      } as any),
    );
  } finally {
    await f.cleanup();
  }
});
test("挖词落盘、写入原有词池且历史去重；不伪造补足目标数量", async () => {
  const f = await operations();
  try {
    const run = await f.op.start({
      kind: "mine",
      input: { category: "软件", count: 10, live: false },
      authorized: true,
    });
    await f.op.settled(run.id);
    const items = f.op.store.items(run.id);
    assert.equal(items.length, 1);
    assert.equal(f.calls(), 0);
    const poolId = f.op.savePool(
      run.id,
      items.map((i) => i.id),
      "测试词池",
    );
    assert.equal(
      f.app.repo.pools().find((p) => p.id === poolId)!.keywords[0].word,
      "测试软件名称",
    );
    assert.match(f.op.store.run(run.id).message, /目标10/);
    const again = await f.op.start({
      kind: "mine",
      input: { category: "软件", count: 10 },
      authorized: true,
    });
    await f.op.settled(again.id);
    assert.equal(f.op.store.items(again.id).length, 0);
  } finally {
    await f.cleanup();
  }
});
test("精准双来源采集保存验活主项、备选链接和进度，读取历史不重跑", async () => {
  const f = await operations();
  try {
    let searches = 0;
    f.op.pansou.search = async () => {
      searches++;
      return [
        { name: "本人练习", link, code: "a1b2", score: 1 },
        { name: "备选练习", link: link + "b", code: "c3d4", score: 0 },
      ];
    };
    const run = await f.op.start({
      kind: "collect",
      input: {
        mode: "precise",
        keywords: ["练习"],
        count: 1,
        accountIds: [],
        zhidao: false,
        pansou: true,
      },
      authorized: true,
    });
    await f.op.settled(run.id);
    assert.equal(f.op.store.run(run.id).status, "completed");
    assert.equal(f.op.store.items(run.id)[0].backups.length, 1);
    f.op.store.detail(run.id);
    assert.equal(searches, 1);
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});
test("自动回答只有aid才记成功，题库已答跳过，达到目标后停止取题", async () => {
  const f = await operations();
  try {
    let submits = 0;
    f.op.client.questions = async () => ({
      items: [
        { qid: "q1", question: "测试问题", answered: false },
        { qid: "q2", question: "已经回答", answered: true },
      ],
      nextBase: 1,
      hasMore: false,
    });
    f.op.client.answer = async () => {
      submits++;
      return { errno: 0, data: { aid: "answer-1" } };
    };
    const run = await f.op.start({
      kind: "answer",
      input: { mode: "auto", accountId: account.id, count: 1 },
      authorized: true,
    });
    await f.op.settled(run.id);
    assert.equal(submits, 1);
    assert.equal(f.op.store.items(run.id)[0].answerId, "answer-1");
    assert.equal(f.op.store.run(run.id).done, 1);
  } finally {
    await f.cleanup();
  }
});
test(
  "自动答题待审核响应在后续分类再次出现时不重发，显式核对后才可重试",
  { timeout: 3000 },
  async (t) => {
    const f = await operations();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      let submits = 0,
        pages = 0;
      f.op.client.questions = async () => {
        pages++;
        return {
          items: [
            { qid: "pending-qid", question: "重复出现的待审核问题" },
            { qid: "pending-qid", question: "重复出现的待审核问题" },
          ],
          nextBase: 1,
          hasMore: false,
        };
      };
      f.op.client.answer = async () => {
        submits++;
        return submits === 1
          ? { errno: 36 }
          : { errno: 0, data: { aid: "confirmed-answer" } };
      };
      const run = await f.op.start({
        kind: "answer",
        input: { mode: "auto", accountId: account.id, count: 1 },
        authorized: true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.op.store.items(run.id)[0].status, "uncertain");
      t.mock.timers.tick(18000);
      await f.op.settled(run.id);
      assert.equal(submits, 1);
      assert.equal(pages, 2); // Random sampling, then the pre-submit answered check.
      f.op.resume(run.id);
      await f.op.settled(run.id);
      assert.equal(submits, 1);
      f.op.resolve(f.op.store.items(run.id)[0].id, "retry");
      f.op.resume(run.id);
      await f.op.settled(run.id);
      assert.equal(submits, 2);
      assert.equal(f.op.store.items(run.id)[0].answerId, "confirmed-answer");
    } finally {
      t.mock.timers.reset();
      await f.cleanup();
    }
  },
);
test("上传响应丢失标记未知，继续不会重复上传，人工核对未提交后才重试", async () => {
  const f = await operations();
  try {
    const source = template(f.op);
    let uploads = 0;
    f.op.client.upload = async () => {
      uploads++;
      throw new Error("connection lost");
    };
    const run = await f.op.start({
      kind: "publish",
      input: {
        itemIds: [source.id],
        accountId: account.id,
        taskName: "测试上传",
      },
      authorized: true,
    });
    await f.op.settled(run.id);
    let item = f.op.store.items(run.id)[0];
    assert.equal(item.status, "uncertain");
    f.op.resume(run.id);
    await f.op.settled(run.id);
    assert.equal(uploads, 1);
    f.op.resolve(item.id, "retry");
    f.op.client.upload = async () => {
      uploads++;
      return { code: 200, data: { taskId: "upload-1" } };
    };
    f.op.resume(run.id);
    await f.op.settled(run.id);
    item = f.op.store.items(run.id)[0];
    assert.equal(uploads, 2);
    assert.equal(item.status, "submitted");
    assert.equal(item.taskId, "upload-1");
    assert.match(item.message, /审核结果尚未确认/);
  } finally {
    await f.cleanup();
  }
});
test("停止时收到真实成功响应仍保存taskId，任务不会误报未知或重复上传", async () => {
  const f = await operations();
  try {
    const source = template(f.op);
    let finish!: (value: any) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    f.op.client.upload = async () => {
      entered();
      return new Promise((r) => (finish = r));
    };
    const run = await f.op.start({
      kind: "publish",
      input: {
        itemIds: [source.id],
        accountId: account.id,
        taskName: "停止边界",
      },
      authorized: true,
    });
    await started;
    f.op.pause(run.id);
    finish({ code: 200, data: { taskId: "already-accepted" } });
    await f.op.settled(run.id);
    assert.equal(f.op.store.items(run.id)[0].taskId, "already-accepted");
    assert.equal(f.op.store.items(run.id)[0].status, "submitted");
  } finally {
    await f.cleanup();
  }
});
test("修改正文撤销审核，未审核内容不能上传；已提交结果禁止编辑或移除", async () => {
  const f = await operations();
  try {
    const source = template(f.op);
    const saved = f.op.saveItem({
      id: source.id,
      name: source.name,
      question: source.question,
      answer: "改过的答案",
      reviewed: true,
    });
    assert.equal(saved.reviewed, false);
    await assert.rejects(
      f.op.start({
        kind: "publish",
        input: {
          itemIds: [source.id],
          accountId: account.id,
          taskName: "未审核",
        },
        authorized: true,
      }),
      { code: "REVIEW_REQUIRED" },
    );
    const committed = f.op.store.put(source.runId, source.key, {
      status: "submitted",
    });
    assert.throws(() => f.op.removeItems([committed.id]), {
      code: "ITEM_LOCKED",
    });
  } finally {
    await f.cleanup();
  }
});
test("崩溃恢复将运行任务暂停、发送中条目标为未知；读取不自动继续", async () => {
  const f = await operations();
  try {
    const source = template(f.op);
    const run = f.op.store.create(
      "publish",
      "发送中",
      { accountId: account.id },
      1,
    );
    f.op.store.state(run.id, "running", "");
    const item = f.op.store.put(run.id, source.id, { name: source.name });
    f.op.store.submitting(item);
    f.op.store.recover();
    assert.equal(f.op.store.run(run.id).status, "paused");
    assert.equal(f.op.store.item(item.id).status, "uncertain");
    assert.equal(f.op.isBusy, false);
  } finally {
    await f.cleanup();
  }
});
test("资源交接先检查主项与备选，再交给原批量队列；权利确认缺失被拒绝", async () => {
  const f = await fixture();
  try {
    const baidu = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "百度测试",
    })) as any;
    await f.app.invoke("account.check", { id: baidu.id });
    const run = f.app.zhidao.importResources([
      ["资源名称", "网盘链接", "提取码"],
      ["练习", link, "a1b2"],
    ]);
    const item = f.app.zhidao.store.items(run.id)[0];
    f.app.zhidao.store.put(run.id, item.key, {
      backups: [{ name: "备选练习", link: link + "b", code: "c3d4" }],
    });
    const original = f.provider.inspect.bind(f.provider);
    let checks = 0;
    f.provider.inspect = async (a, source, ...rest) => {
      checks++;
      if (source.url === link) throw new Error("主链接失效");
      return original(a, source, ...rest);
    };
    const result = (await f.app.invoke("zhidao.collect.transfer", {
      itemIds: [item.id],
      accountId: baidu.id,
      directory: "/测试采集",
      rightsConfirmed: true,
    })) as any;
    assert.equal(checks, 2);
    assert.equal(result.copyIds.length, 1);
    assert.equal(f.provider.transfers, 0);
    assert.ok(f.app.repo.getCopy(result.copyIds[0]));
    assert.match(f.app.zhidao.store.item(item.id).message, /备选/);
    await assert.rejects(
      f.app.invoke("zhidao.collect.transfer", {
        itemIds: [item.id],
        accountId: baidu.id,
        directory: "/测试采集",
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("同账号已提交内容禁止另建重复上传任务，发布期间原问答不能被修改", async () => {
  const f = await operations();
  try {
    const source = template(f.op);
    let entered!: () => void, finish!: (v: any) => void;
    const enteredPromise = new Promise<void>((r) => (entered = r));
    f.op.client.upload = async () => {
      entered();
      return new Promise((r) => (finish = r));
    };
    const run = await f.op.start({
      kind: "publish",
      input: {
        itemIds: [source.id],
        accountId: account.id,
        taskName: "防重复",
      },
      authorized: true,
    });
    await enteredPromise;
    assert.throws(
      () =>
        f.op.saveItem({
          id: source.id,
          name: source.name,
          question: source.question,
          answer: "并发修改",
          reviewed: true,
        }),
      { code: "ITEM_LOCKED" },
    );
    finish({ code: 200, data: { taskId: "unique-upload" } });
    await f.op.settled(run.id);
    await assert.rejects(
      f.op.start({
        kind: "publish",
        input: {
          itemIds: [source.id],
          accountId: account.id,
          taskName: "再次上传",
        },
        authorized: true,
      }),
      { code: "ALREADY_SUBMITTED" },
    );
  } finally {
    await f.cleanup();
  }
});

test("从本人网盘建链响应丢失后只查已有分享，恢复并归档，不重复创建", async () => {
  const f = await fixture();
  try {
    const baidu = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "本人百度",
    })) as any;
    await f.app.invoke("account.check", { id: baidu.id });
    f.provider.ownUrl = "https://pan.baidu.com/s/ownshare12345";
    f.provider.actual = [file];
    f.provider.failShare = true;
    const first = (await f.app.invoke("drive.files.share", {
      accountId: baidu.id,
      path: "/",
      fileIds: [file.id],
      rightsConfirmed: true,
    })) as any;
    assert.equal(first.urls.length, 0);
    assert.equal(first.failures.length, 1);
    assert.equal(first.failures[0].uncertain, true);
    assert.equal(f.provider.shares, 1);
    const recovered = (await f.app.invoke("drive.files.share", {
      accountId: baidu.id,
      path: "/",
      fileIds: [file.id],
      rightsConfirmed: true,
    })) as any;
    assert.equal(recovered.urls.length, 1);
    assert.equal(f.provider.shares, 1);
    assert.equal(((await f.app.invoke("zhidao.targets", {})) as any).total, 1);
    await assert.rejects(
      f.app.invoke("drive.share.reset", {
        accountId: baidu.id,
        fileIds: [file.id],
        confirmed: true,
      }),
      { code: "SHARE_EXISTS" },
    );
  } finally {
    await f.cleanup();
  }
});

test("网盘管理写入前复核文件ID，禁止根目录操作；成功后撤销关联资源核验", async () => {
  const f = await fixture();
  try {
    const baidu = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "本人百度",
    })) as any;
    await f.app.invoke("account.check", { id: baidu.id });
    f.provider.ownUrl = "https://pan.baidu.com/s/ownshare12345";
    f.provider.actual = [file];
    let mutations = 0;
    Object.assign(f.provider, {
      manage: async () => {
        mutations++;
      },
    });
    await assert.rejects(
      f.app.invoke("drive.manage", {
        accountId: baidu.id,
        action: "delete",
        path: "/",
        fileId: file.id,
        confirmed: true,
      }),
      { code: "ROOT_PROTECTED" },
    );
    await assert.rejects(
      f.app.invoke("drive.manage", {
        accountId: baidu.id,
        action: "rename",
        path: "/" + file.name,
        fileId: "different-id",
        name: "新名称",
        confirmed: true,
      }),
      { code: "FILES_CHANGED" },
    );
    assert.equal(mutations, 0);
    await f.app.invoke("drive.files.share", {
      accountId: baidu.id,
      path: "/",
      fileIds: [file.id],
      rightsConfirmed: true,
    });
    const ready = ((await f.app.invoke("zhidao.targets", {})) as any).items[0];
    assert.ok(ready);
    await f.app.invoke("drive.manage", {
      accountId: baidu.id,
      action: "rename",
      path: "/" + file.name,
      fileId: file.id,
      name: "新名称.pdf",
      confirmed: true,
    });
    assert.equal(mutations, 1);
    assert.equal(f.app.repo.getCopy(ready.copyId).shareVerifiedAt, null);
  } finally {
    await f.cleanup();
  }
});

test("问答模板复用现有AI，生成前实时核对本人分享；失效分享不产生模型调用", async () => {
  const f = await fixture();
  try {
    const baidu = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "本人百度",
    })) as any;
    await f.app.invoke("account.check", { id: baidu.id });
    f.provider.ownUrl = "https://pan.baidu.com/s/ownshare12345";
    f.provider.actual = [file];
    await f.app.invoke("drive.files.share", {
      accountId: baidu.id,
      path: "/",
      fileIds: [file.id],
      rightsConfirmed: true,
    });
    const target = ((await f.app.invoke("zhidao.targets", {})) as any).items[0];
    let generated = 0;
    f.app.ai.resourceExport = async <T>() => {
      generated++;
      return { answer: "这是基于本人资料摘要的完整说明。" } as T;
    };
    f.provider.ownValid = false;
    const blocked = (await f.app.invoke("zhidao.start", {
      kind: "template",
      input: { copyIds: [target.copyId] },
      authorized: true,
    })) as any;
    await f.app.zhidao.settled(blocked.id);
    assert.equal(generated, 0);
    assert.equal(f.app.zhidao.store.run(blocked.id).status, "failed");
    f.provider.ownValid = true;
    await f.app.invoke("copies.check", { copyIds: [target.copyId] });
    const run = (await f.app.invoke("zhidao.start", {
      kind: "template",
      input: { copyIds: [target.copyId] },
      authorized: true,
    })) as any;
    await f.app.zhidao.settled(run.id);
    assert.equal(generated, 1);
    assert.match(f.app.zhidao.store.items(run.id)[0].answer, /ownshare12345/);
    assert.equal(f.app.zhidao.store.items(run.id)[0].reviewed, false);
  } finally {
    await f.cleanup();
  }
});

test("百度题目与上传ID按原始数字读取，避免大整数精度丢失", () => {
  const value = parseZhidaoJson(
    '{"qid":1888888888888888888,"data":{"aid":1999999999999999999,"taskId":1777777777777777777}}',
  );
  assert.equal(value.qid, "1888888888888888888");
  assert.equal(value.data.aid, "1999999999999999999");
  assert.equal(value.data.taskId, "1777777777777777777");
});
test("榜单解析支持TapTap结构化列表、红果封面名称和猫眼片名", () => {
  assert.deepEqual(
    parseMining(
      '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"name":"测试游戏"}]}</script>',
      miningSources.游戏[0],
    ),
    ["测试游戏"],
  );
  assert.deepEqual(
    parseMining(
      '<img alt="测试短剧封面"><img alt="二维码">',
      miningSources.短剧[0],
    ),
    ["测试短剧"],
  );
  assert.deepEqual(
    parseMining('<p class="first-line">测试电影</p>', miningSources.电影[2]),
    ["测试电影"],
  );
});

test("知道协议识别官方登录标记、分页与活动提交参数", async () => {
  const requests: { id: string; url: URL; init: RequestInit }[] = [];
  let response: unknown = { isLogin: "1", uid: "owner", userName: "本人", stoken: "local-token" };
  const client = new ZhidaoClient({
    login: async () => {}, clear: async () => {}, close: async () => {}, setCookie: async () => {},
    request: async (id, url, init = {}) => {
      requests.push({ id, url: new URL(url), init });
      return { status: 200, body: JSON.stringify(response) };
    },
  });
  assert.equal((await client.identity("zd_protocol")).uid, "owner");
  assert.equal(requests[0].url.pathname, "/api/logininfo");
  response = { isLogin: "0", uid: "owner", stoken: "local-token" };
  await assert.rejects(client.identity("zd_protocol"), { code: "AUTH_EXPIRED" });
  response = { code: 200, data: { list: [{ qid: "1", question: "问题" }], base: "8", hasMore: "0" } };
  assert.equal((await client.questions("zd_protocol", "emotion", 0)).hasMore, false);
  response = { code: 200, data: { list: [{ qid: "2", question: "问题" }], total: 2 } };
  assert.deepEqual(await client.questions("zd_protocol", "emotion", 0), {
    items: [{ qid: "2", question: "问题" }], nextBase: 1, hasMore: true, total: 2,
  });
  response = { errno: 0, data: { aid: "accepted" } };
  assert.ok(requests.filter((request) => request.url.pathname === "/qa/api/query/result/category").every((request) => request.init.cache === "no-store"));
  await client.answer("zd_protocol", "1", "测试回答", "local-token");
  const sent = requests.at(-1)!;
  assert.equal(sent.id, "zd_protocol");
  assert.equal(new URLSearchParams(String(sent.init.body)).get("activity"), "21th");
  assert.equal(new URLSearchParams(String(sent.init.body)).get("stoken"), "local-token");
});

test("自动答题先随机翻阅多页再生成，达到目标后不再取题或生成", async () => {
  const f = await operations();
  try {
    const bases: number[] = [];
    let readCountAtGeneration = 0;
    f.op.client.questions = async (_account, _category, base) => {
      bases.push(base);
      return { items: [{ qid: `random-${base}`, question: `资料整理问题${base}` }],
        nextBase: base + 8, hasMore: true, total: 1600 };
    };
    f.app.ai.resourceExport = async <T>() => {
      readCountAtGeneration = bases.length;
      return { answer: "先整理目录，再核对文件。" } as T;
    };
    let submits = 0;
    f.op.client.answer = async () => { submits++; return { errno: 0, data: { aid: "random-confirmed" } }; };
    const run = await f.op.start({ kind: "answer", authorized: true,
      input: { mode: "auto", accountId: account.id, count: 1, categories: ["emotion"] } });
    await f.op.settled(run.id);
    assert.ok(readCountAtGeneration >= 3 && readCountAtGeneration <= 5);
    assert.equal(bases.length, readCountAtGeneration + 1);
    assert.equal(new Set(bases.slice(0, -1)).size, readCountAtGeneration);
    assert.equal(submits, 1);
    assert.equal(f.op.store.run(run.id).done, 1);
  } finally { await f.cleanup(); }
});

test("自动答题跨历史任务和账号按题号与内容去重，未知提交也不能重答", async () => {
  const f = await operations();
  try {
    const old = f.op.store.create("answer", "旧账号答题", { accountId: "removed-account" }, 3);
    f.op.store.put(old.id, "old-id", { questionId: "old-id", question: "历史问题", status: "submitted" });
    f.op.store.put(old.id, "same-text", { questionId: "different-id", question: "如何 和伴侣 沟通？", status: "submitted" });
    f.op.store.put(old.id, "unknown", { questionId: "unknown-id", question: "提交未知问题", status: "uncertain" });
    const sending = f.op.store.put(old.id, "sending", { questionId: "sending-id", question: "发送中问题", status: "ready" });
    f.op.store.submitting(sending);
    f.op.client.questions = async () => ({
      items: [
        { qid: "old-id", question: "标题已经修改" },
        { qid: "new-id-same-text", question: "如何和伴侣沟通?" },
        { qid: "unknown-id", question: "提交未知问题" },
        { qid: "sending-id", question: "发送中问题" },
        { qid: "platform-history", question: "浏览器中已经答过", answered: "1" as any },
        { qid: "new-only", question: "新的情感问题", answered: false },
      ], nextBase: 8, hasMore: false,
    });
    const submitted: string[] = [];
    f.op.client.answer = async (_id, qid) => {
      submitted.push(qid);
      return { errno: 0, data: { aid: "new-answer" } };
    };
    const run = await f.op.start({ kind: "answer", authorized: true,
      input: { mode: "auto", accountId: account.id, count: 10, categories: ["emotion"], style: "第一人称共鸣" } });
    await f.op.settled(run.id);
    assert.deepEqual(submitted, ["new-only"]);
    assert.equal(f.calls(), 1);
    assert.equal(f.op.store.run(run.id).done, 1);
  } finally { await f.cleanup(); }
});

test("生成或等待期间出现已答记录时，提交前重新核对并保留回答但不发送", async () => {
  for (const race of ["platform", "local"] as const) {
    const f = await operations();
    try {
      let generated = false, sends = 0;
      f.op.client.questions = async () => ({
        items: [{ qid: "race-id", question: "如何表达自己的感受？", answered: race === "platform" && generated }],
        nextBase: 8, hasMore: false,
      });
      f.app.ai.resourceExport = async <T>() => {
        generated = true;
        if (race === "local") {
          const old = f.op.store.create("answer", "另一任务的历史", {}, 1);
          f.op.store.put(old.id, "race-id", { questionId: "race-id", question: "如何表达自己的感受？", status: "submitted" });
        }
        return { answer: "我的理解是，先照顾自己的感受，再温和表达具体需要。" } as T;
      };
      f.op.client.answer = async () => { sends++; return { errno: 0, data: { aid: "must-not-send" } }; };
      const run = await f.op.start({ kind: "answer", authorized: true,
        input: { mode: "auto", accountId: account.id, count: 1, categories: ["emotion"] } });
      await f.op.settled(run.id);
      assert.equal(sends, 0);
      const item = f.op.store.items(run.id)[0];
      assert.equal(item.status, "skipped");
      assert.match(item.answer, /我的理解/);
      assert.match(item.message, /历史回答或平台已答/);
    } finally { await f.cleanup(); }
  }
});

test("自动答题遇到429按Retry-After和退避等待，仅成功生成后提交一次", async (t) => {
  const f = await operations();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let calls = 0, sends = 0;
    f.op.client.questions = async () => ({ items: [{ qid: "rate-retry", question: "如何温和表达感受？" }], nextBase: 8, hasMore: false });
    f.app.ai.resourceExport = async <T>() => {
      calls++;
      if (calls <= 2) throw new ServiceHttpError(429, "Provider returned error", "HTTP_ERROR", calls === 1 ? 10_000 : null);
      return { answer: "我的建议是先梳理感受，再尝试平等沟通。" } as T;
    };
    f.op.client.answer = async () => { sends++; return { errno: 0, data: { aid: "after-limit" } }; };
    const run = await f.op.start({ kind: "answer", authorized: true, input: { mode: "auto", accountId: account.id, count: 1, categories: ["emotion"] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.match(f.op.store.run(run.id).message, /限流.*10秒/);
    t.mock.timers.tick(9999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    t.mock.timers.tick(60000);
    await f.op.settled(run.id);
    assert.equal(calls, 3);
    assert.equal(sends, 1);
    assert.equal(f.op.store.run(run.id).status, "completed");
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test("持续429达到上限后暂停，停止与继续不会绕过模型等待时间", async (t) => {
  const f = await operations();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let calls = 0;
    f.op.client.questions = async () => ({ items: [{ qid: "rate-exhausted", question: "如何与朋友沟通？" }], nextBase: 8, hasMore: false });
    f.app.ai.resourceExport = async <T>() => { calls++; throw new ServiceHttpError(429, "rate limited"); return {} as T; };
    const run = await f.op.start({ kind: "answer", authorized: true, input: { mode: "auto", accountId: account.id, count: 1, categories: ["emotion"] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(60000);
    await f.op.settled(run.id);
    assert.equal(calls, 3);
    assert.equal(f.op.store.run(run.id).status, "paused");
    assert.match(f.op.store.run(run.id).message, /持续限流/);
    f.op.resume(run.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    f.op.pause(run.id);
    await f.op.settled(run.id);
    assert.equal(calls, 3);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test("模型连接结果不明不自动重试，生成期间停止仍保存已付费取得的回答", async () => {
  const f = await operations();
  try {
    let calls = 0, sends = 0;
    f.op.client.questions = async () => ({ items: [{ qid: "stopped-generation", question: "如何表达感受？" }], nextBase: 8, hasMore: false });
    f.app.ai.resourceExport = async <T>() => { calls++; throw new TypeError("fetch failed"); return {} as T; };
    const config = { kind: "answer" as const, authorized: true as const, input: { mode: "auto" as const, accountId: account.id, count: 1, categories: ["emotion" as const] } };
    const failed = await f.op.start(config);
    await f.op.settled(failed.id);
    assert.equal(calls, 1);
    assert.equal(f.op.store.run(failed.id).status, "paused");
    assert.match(f.op.store.run(failed.id).message, /不会自动重试/);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    f.app.ai.resourceExport = async <T>() => { calls++; await ready; return { answer: "我会建议先平静表达自己的需要。" } as T; };
    f.op.client.answer = async () => { sends++; return { errno: 0, data: { aid: "saved-paid-answer" } }; };
    const run = await f.op.start(config);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.op.pause(run.id);
    release();
    await f.op.settled(run.id);
    assert.equal(sends, 0);
    assert.equal(f.op.store.items(run.id)[0].status, "ready");
    f.op.resume(run.id);
    await f.op.settled(run.id);
    assert.equal(calls, 2);
    assert.equal(sends, 1);
  } finally { await f.cleanup(); }
});

test("自动答题无回答ID立即暂停，继续任务不重发，保留问题来源", async () => {
  for (const receipt of [{ errno: 0 }, { data: { aid: "unconfirmed" } }, null]) {
    const f = await operations();
    try {
      let submits = 0;
      f.op.client.questions = async () => ({
        items: [{ qid: "no-receipt", question: "如何整理资料？" }], nextBase: 1, hasMore: false,
      });
      f.op.client.answer = async () => { submits++; if (!receipt) throw Error("模拟发送后断线"); return receipt; };
      const run = await f.op.start({ kind: "answer", authorized: true,
        input: { mode: "auto", accountId: account.id, count: 2 } });
      await f.op.settled(run.id);
      assert.equal(f.op.store.run(run.id).status, "paused");
      const item = f.op.store.items(run.id)[0];
      assert.equal(item.status, "uncertain");
      assert.match(item.sourceUrl, /question\/hx\/no-receipt/);
      f.op.resume(run.id);
      await f.op.settled(run.id);
      assert.equal(submits, 1);
      assert.equal(f.calls(), 1);
      f.op.resolve(item.id, "submitted", "manually-confirmed");
      assert.equal(f.op.store.run(run.id).done, 1);
    } finally { await f.cleanup(); }
  }
});

test("自定义分类、生成要求与提交间隔生效，停止后保留回答和剩余间隔", async (t) => {
  const f = await operations();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const categories: string[] = [], sent: string[] = [];
    let generatedInput: any;
    let generatedCount = 0;
    f.app.ai.resourceExport = async <T>(_name: string, _schema: unknown, _instruction: string, input: unknown) => {
      generatedCount++;
      generatedInput = input;
      return { answer: "整理目录后核对文件。" } as T;
    };
    f.op.client.questions = async (_id, category) => {
      categories.push(category);
      return { items: [1, 2].map((n) => ({ qid: `interval-${n}`, question: `整理问题${n}` })), nextBase: 2, hasMore: false };
    };
    f.op.client.answer = async (_id, qid) => {
      sent.push(qid);
      return { errno: 0, data: { aid: `aid-${qid}` } };
    };
    const run = await f.op.start({ kind: "answer", authorized: true,
      input: { mode: "auto", accountId: account.id, count: 2, categories: ["education"], intervalSeconds: 45, instructions: "分三步说明" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(generatedInput.evidence.requirements, "分三步说明");
    t.mock.timers.tick(20000);
    f.op.pause(run.id);
    await f.op.settled(run.id);
    assert.equal(f.op.store.items(run.id)[1].status, "ready");
    f.op.resume(run.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(24999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    t.mock.timers.tick(1);
    await f.op.settled(run.id);
    assert.deepEqual(new Set(sent), new Set(["interval-1", "interval-2"]));
    assert.equal(sent.length, 2);
    assert.equal(generatedCount, 2);
    assert.ok(categories.every((category) => category === "education"));
    assert.equal(f.op.store.run(run.id).done, 2);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test("自动答题提交前重新核对身份，账号失效不发送已生成回答", async () => {
  const f = await operations();
  try {
    let submits = 0;
    f.op.client.questions = async () => ({ items: [{ qid: "owner-change", question: "如何整理？" }], nextBase: 1, hasMore: false });
    f.app.ai.resourceExport = async <T>() => {
      f.op.client.identity = async () => ({ uid: "someone-else", nickname: "其他账号", stoken: "not-the-owner" });
      return { answer: "先整理再检查。" } as T;
    };
    f.op.client.answer = async () => { submits++; return { errno: 0, data: { aid: "wrong" } }; };
    const run = await f.op.start({ kind: "answer", authorized: true,
      input: { mode: "auto", accountId: account.id, count: 1 } });
    await f.op.settled(run.id);
    assert.equal(submits, 0);
    assert.equal(f.op.store.run(run.id).status, "paused");
    assert.equal(f.op.store.items(run.id)[0].status, "ready");
  } finally { await f.cleanup(); }
});

test("发布权益入口校验目标并复用指定知道账号会话，不提交回答或修改资格", async () => {
  const f = await fixture();
  const opened: {id: string; page: unknown}[] = [];
  let release: (() => void) | undefined;
  f.ports.zhidaoSession = {
    login: async (id, page) => {
      opened.push({id, page});
      if (release) await new Promise<void>(resolve => { release = resolve; });
    },
    close: async () => {}, clear: async () => {}, setCookie: async () => {},
    request: async () => { throw new Error("不应发起答题请求"); },
  };
  try {
    const known = await f.app.invoke("zhidao.account.add", {alias:"权益测试账号"}) as typeof account;
    const before = f.app.zhidao.store.account(known.id);
    await f.app.invoke("zhidao.account.openRights", {id:known.id, page:"answer"});
    await f.app.invoke("zhidao.account.openRights", {id:known.id, page:"quota"});
    assert.deepEqual(opened, [{id:known.id,page:"answer"},{id:known.id,page:"quota"}]);
    assert.deepEqual(f.app.zhidao.store.account(known.id), before);
    await assert.rejects(f.app.invoke("zhidao.account.openRights", {id:known.id,page:"https://example.com"}));
    await assert.rejects(f.app.invoke("zhidao.account.openRights", {id:"missing",page:"answer"}));
    assert.equal(opened.length, 2);
    release = () => {};
    const pending = f.app.invoke("zhidao.account.openRights", {id:known.id,page:"answer"});
    await assert.rejects(f.app.invoke("zhidao.account.openRights", {id:known.id,page:"quota"}), {code:"ACCOUNT_BUSY"});
    release();
    await pending;
  } finally { await f.cleanup(); }
});
