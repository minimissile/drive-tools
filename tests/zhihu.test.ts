import test from "node:test";
import assert from "node:assert/strict";
import { zhihuFixture } from "./zhihu-fixture";
import { zhihuDay, zhihuWeek } from "../core/zhihu/policy";
import { ZhihuOperations } from "../core/zhihu/service";
import { fixture } from "./helpers";
import { inspectBackup, stageRestore } from "../core/backups";
import { Database } from "../core/database";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseZhihuCreatorLevel,
  matchesPublishedZhihuArticle,
} from "../core/zhihu/browser";
import type { ZhihuPayload } from "../shared/zhihu";

test("知乎：回执补核必须匹配原草稿、已发布状态、作者、完整正文与配图数量", () => {
  const payload = {
    task: { uid: "owner" },
    content: { title: "原标题", body: "第一段\n第二段" },
    images: [],
  } as unknown as ZhihuPayload;
  const article = {
    id: "123",
    state: "published",
    uid: "owner",
    title: "原标题",
    body: "第一段 第二段",
    images: 0,
  };
  assert.equal(matchesPublishedZhihuArticle(article, "123", payload), true);
  for (const patch of [
    { id: "999" },
    { state: "draft" },
    { uid: "someone-else" },
    { title: "其他标题" },
    { body: "第一段" },
    { images: 1 },
  ])
    assert.equal(
      matchesPublishedZhihuArticle({ ...article, ...patch }, "123", payload),
      false,
    );
  assert.equal(matchesPublishedZhihuArticle(null, "123", payload), false);
});

test("知乎：新版账号等级链接识别Lv4，忽略榜单等级，冲突或无效值保持未知", () => {
  assert.equal(parseZhihuCreatorLevel(["Lv 4 \u200b"], "榜单：Lv.9 创作者"), 4);
  assert.equal(parseZhihuCreatorLevel(["Lv.0"], "申请入驻"), 0);
  assert.equal(parseZhihuCreatorLevel(["Lv 4", "Lv 5"], "创作等级 Lv.2"), null);
  assert.equal(parseZhihuCreatorLevel(["Lv 11"], "创作等级 Lv.2"), null);
  assert.equal(parseZhihuCreatorLevel(["未知"], "创作等级 Lv.2"), null);
  assert.equal(parseZhihuCreatorLevel([], "创作等级 Lv.2"), 2);
  assert.equal(parseZhihuCreatorLevel([], "创作分 3677，榜单 Lv 9"), null);
});

test("知乎：首篇开通显式排队，未入驻不启用普通养号，回执和等级刷新写入日志", async () => {
  const f = await zhihuFixture();
  try {
    const a = await f.addAccount(),
      c = f.content();
    f.service.record(a.id, false, 0, "模拟未入驻创作者页面");
    assert.throws(
      () => f.service.enqueue(a.id, c.id, new Date(f.time).toISOString()),
      /入驻/,
    );
    assert.throws(() => f.service.activate(a.id, true), /入驻/);
    const task = f.service.enqueue(
      a.id,
      c.id,
      new Date(f.time).toISOString(),
      true,
    );
    assert.equal(task.firstPost, true);
    assert.throws(
      () =>
        f.service.enqueue(
          a.id,
          f.content().id,
          new Date(f.time).toISOString(),
          true,
        ),
      /首篇/,
    );
    f.service.scheduler(true);
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(
      f.service.store.get("zhihu_tasks", task.id).status,
      "published",
    );
    assert.equal(f.service.plan(a.id).progress?.creator, true);
    assert.equal(f.service.plan(a.id).active, false);
    const logs = f.service.logs.read({ accountId: a.id });
    assert.ok(
      logs.items.some(
        (l) => l.event === "task.published" && l.taskId === task.id,
      ),
    );
    assert.ok(logs.items.some((l) => l.event === "task.submitting"));
    assert.ok(f.service.snapshot().lastHeartbeatAt);
  } finally {
    await f.close();
  }
});

test("知乎：素材审核、编辑撤销审核、单号同问题去重和无推广养号", async () => {
  const f = await zhihuFixture();
  try {
    const a = await f.addAccount(),
      c = f.content({
        kind: "answer",
        questionUrl: "https://www.zhihu.com/question/123",
      });
    f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    assert.throws(
      () =>
        f.service.enqueue(
          a.id,
          f.content({
            kind: "answer",
            questionUrl: "https://www.zhihu.com/question/123",
          }).id,
          new Date(f.time).toISOString(),
        ),
      /问题/,
    );
    const changed = f.service.saveContent({
      ...c,
      body: "这是一份修改后的正文内容，需要重新进行人工审核。",
    });
    assert.equal(changed.reviewed, false);
    f.service.scheduler(true);
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "attention");
    const ad = f.service.saveContent({
      kind: "article",
      purpose: "warming",
      title: "带推广的素材",
      body: "请点击 https://example.com 购买这份资料。",
      aiAssisted: false,
    });
    assert.throws(() => f.service.review(ad.id, ad.version), /推广/);
  } finally {
    await f.close();
  }
});
test("知乎：多号同 IP 错峰、日上限、实际等级达标和素材耗尽停止", async () => {
  const f = await zhihuFixture();
  try {
    // Keep the one-hour spacing inside one Shanghai day, including late-night runs.
    f.advance(Date.parse(`${zhihuDay(f.time)}T09:00:00+08:00`) - f.time);
    const a = await f.addAccount("甲"),
      b = await f.addAccount("乙");
    f.service.configure({ accountId: a.id, dailyLimit: 1 });
    f.service.enqueue(a.id, f.content().id, new Date(f.time).toISOString());
    const second = f.service.enqueue(
      b.id,
      f.content({ title: "另一个账号的独立内容" }).id,
      new Date(f.time).toISOString(),
    );
    f.service.scheduler(true);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(
      f.service.store.get("zhihu_tasks", second.id).status,
      "queued",
    );
    assert.ok(
      new Date(
        f.service.store.get("zhihu_tasks", second.id).scheduledAt,
      ).getTime() >=
        f.time + 3600000,
    );
    f.advance(3600000);
    await f.service.tick();
    assert.equal(f.submissions, 2);
    const third = f.service.enqueue(
      a.id,
      f.content().id,
      new Date(f.time).toISOString(),
    );
    await f.service.tick();
    assert.equal(f.submissions, 2);
    assert.match(f.service.store.get("zhihu_tasks", third.id).message, /上限/);
    f.service.record(b.id, true, 5, "已在创作者中心核对实际等级");
    assert.throws(() => f.service.activate(b.id, true), /达到/);
    f.service.cancel(third.id);
    f.service.record(a.id, true, 1, "实际等级仍然为一级");
    // Remaining content is reserved to demonstrate depletion without inventing a new post.
    for (const c of f.service.snapshot().contents)
      if (
        !f.service
          .snapshot()
          .tasks.some((t) => t.contentId === c.id && t.status !== "cancelled")
      )
        f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    f.service.activate(b.id, false);
  } finally {
    await f.close();
  }
});
test("知乎：未知结果禁止重发，核对未发布后才允许重新安排", async () => {
  const f = await zhihuFixture();
  try {
    const a = await f.addAccount(),
      c = f.content(),
      t = f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    f.setUnknown(true);
    f.service.scheduler(true);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(f.service.store.get("zhihu_tasks", t.id).status, "attention");
    assert.throws(() => f.service.retry(t.id), /提交阶段|已提交|核对/);
    assert.throws(
      () =>
        f.service.enqueue(a.id, f.content().id, new Date(f.time).toISOString()),
      /核对/,
    );
    assert.throws(
      () => f.service.resolve(t.id, "published", "https://evil.example/p/1"),
      /官方/,
    );
    f.service.resolve(t.id, "not_published");
    f.setUnknown(false);
    f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    f.advance(3600000);
    await f.service.tick();
    assert.equal(f.submissions, 2);
  } finally {
    await f.close();
  }
});
test("知乎：提交前暂停、环境身份变化和重启恢复均不自动重发", async () => {
  const f = await zhihuFixture();
  try {
    const a = await f.addAccount(),
      c = f.content(),
      t = f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    f.before(async () => {
      f.service.scheduler(false);
    });
    f.service.scheduler(true);
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.store.get("zhihu_tasks", t.id).status, "attention");
    const resumed = f.service.retry(t.id);
    assert.equal(resumed.id, t.id);
    assert.equal(resumed.status, "queued");
    assert.equal(f.service.snapshot().tasks.length, 1);
    f.service.cancel(t.id);
    const t2 = f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    f.environments.invalidateIdentity({ kind: "website", id: a.id });
    f.service.scheduler(true);
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.store.get("zhihu_tasks", t2.id).status, "attention");
    f.service.store.save("zhihu_tasks", t2.id, { ...t2, status: "submitting" });
    f.service.close();
    const restarted = new ZhihuOperations({
      db: f.db,
      accounts: f.accounts,
      environments: f.environments,
      queue: f.queue,
      ports: f.ports,
      dataPath: f.dir,
      changed: () => {},
    });
    assert.equal(restarted.running, false);
    assert.equal(restarted.snapshot().tasks[0].status, "attention");
    await restarted.tick();
    assert.equal(f.submissions, 0);
    restarted.close();
  } finally {
    await f.close();
  }
});
test("知乎：计划自动分配、没有素材暂停以及上海日周边界", async () => {
  const f = await zhihuFixture();
  try {
    const a = await f.addAccount();
    f.content();
    f.service.activate(a.id, true);
    f.service.scheduler(true);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(f.service.plan(a.id).active, false);
    assert.match(f.service.plan(a.id).message, /用尽/);
    assert.equal(zhihuDay("2026-10-25T16:01:00Z"), "2026-10-26");
    assert.equal(zhihuWeek("2026-10-25T16:01:00Z"), "2026-10-26");
  } finally {
    await f.close();
  }
});

test("知乎：周额度与次日等级刷新不会绕过停止条件", async () => {
  const f = await zhihuFixture();
  try {
    const a = await f.addAccount();
    f.service.configure({ accountId: a.id, weeklyLimit: 1 });
    f.service.enqueue(a.id, f.content().id, new Date(f.time).toISOString());
    f.service.scheduler(true);
    await f.service.tick();
    const second = f.service.enqueue(
      a.id,
      f.content().id,
      new Date(f.time).toISOString(),
    );
    f.advance(3600000);
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.match(f.service.store.get("zhihu_tasks", second.id).message, /上限/);
    f.service.cancel(second.id);
    f.service.activate(a.id, true);
    f.ports.zhihu!.progress = async () => ({
      creator: true,
      level: 5,
      source: "official",
      checkedAt: new Date(f.time).toISOString(),
      note: "次日官方等级已达目标",
    });
    f.advance(86400000);
    await f.service.tick();
    assert.equal(f.service.plan(a.id).progress?.level, 5);
    assert.equal(f.service.plan(a.id).active, false);
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("知乎：备份保留配图与任务，恢复撤销审核、等级与调度授权", async () => {
  const base = await fixture(),
    f = await zhihuFixture({ db: base.app.db, dir: base.dir });
  let restored: Database | undefined;
  try {
    const a = await f.addAccount(),
      c = f.content();
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    f.ports.readWeiboImages = async () => [
      { name: "本人配图.png", bytes: image },
    ];
    const withImage = await f.service.images(c.id);
    f.service.review(c.id, withImage.version);
    const task = f.service.enqueue(a.id, c.id, new Date(f.time).toISOString());
    f.service.activate(a.id, true);
    f.service.store.save("zhihu_tasks", task.id, {
      ...task,
      status: "submitting",
    });
    base.ports.chooseDirectory = async () => base.dir;
    const backup = (await base.app.backup())!,
      preview = await inspectBackup(backup);
    assert.equal(preview.zhihuAssets.length, 1);
    const result = await stageRestore(backup, base.dir, preview.databaseSha256);
    restored = new Database(join(result.dataPath, "panxu.db"));
    const contents = JSON.parse(
      restored.get<{ data: string }>(
        "SELECT data FROM zhihu_contents WHERE id=?",
        c.id,
      )!.data,
    );
    const plan = JSON.parse(
      restored.get<{ data: string }>(
        "SELECT data FROM zhihu_plans WHERE id=?",
        a.id,
      )!.data,
    );
    const recovered = JSON.parse(
      restored.get<{ data: string }>(
        "SELECT data FROM zhihu_tasks WHERE id=?",
        task.id,
      )!.data,
    );
    assert.equal(contents.reviewed, false);
    assert.equal(plan.active, false);
    assert.equal(plan.progress, null);
    assert.equal(recovered.status, "attention");
    assert.deepEqual(
      await readFile(
        join(result.dataPath, "zhihu-assets", preview.zhihuAssets[0]),
      ),
      image,
    );
  } finally {
    restored?.close();
    await f.close();
    await base.cleanup();
  }
});
