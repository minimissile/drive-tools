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
import { parseZhidaoJson } from "../core/zhidao/client";
import { pansouUrl } from "../core/zhidao/pansou";

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
test("模板HTML转义内容，轮换标题始终保留前后缀并限制49字", () => {
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
    assert.match(title, /链接|资源/);
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
    t.mock.timers.enable({ apis: ["setTimeout"] });
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
      assert.equal(pages, 3);
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
