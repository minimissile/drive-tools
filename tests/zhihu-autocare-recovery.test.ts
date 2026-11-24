import assert from "node:assert/strict";
import test from "node:test";
import { ZhihuAutocare } from "../core/zhihu-autocare/service";
import { autocareStateKey } from "../core/zhihu-autocare/state";
import type { AutocareState } from "../shared/zhihu-autocare";
import { zhihuFixture } from "./zhihu-fixture";

type Fixture = Awaited<ReturnType<typeof zhihuFixture>>;

function autocare(f: Fixture) {
  return new ZhihuAutocare({
    db: f.db,
    dataPath: f.dir,
    zhihu: f.service,
    participation: { snapshot: () => ({ candidates: [], activities: [] }) },
    operations: { snapshot: () => ({ plans: [] }), isBusy: false },
    pipix: {
      requestPolicy: () => ({
        remainingToday: 0,
        policy: { dailyRequests: 0, listPagesPerRun: 0 },
      }),
    },
    ai: {
      modelFor: () => "fixture/no-generation",
      assertTextConfigured: () => {
        throw new Error("模拟生成服务未配置");
      },
    },
    changed: () => {},
  } as unknown as ConstructorParameters<typeof ZhihuAutocare>[0]);
}

test("知乎创作计划重启接续原批次和未来排期，过期后不重新启动", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await zhihuFixture();
  let automation = autocare(f);
  try {
    const a = await f.addAccount();
    const initial = automation.snapshot();
    const configured = automation.save(
      { ...initial.config, accountIds: [a.id] },
      initial.revision,
    );
    const started = await automation.toggle(true, configured.revision);
    assert.ok(started.run);
    automation.close();
    automation = autocare(f);
    assert.deepEqual(automation.snapshot().run, started.run);
    assert.deepEqual(automation.snapshot().cycles, started.cycles);
    assert.equal(automation.logs.read({ search: "batch.started" }).total, 1);
    assert.equal(automation.logs.read({ search: "batch.resumed" }).total, 1);

    automation.close();
    t.mock.timers.setTime(Date.parse(started.run.deadlineAt) + 1000);
    automation = autocare(f);
    assert.equal(automation.snapshot().run?.id, started.run.id);
    assert.equal(automation.snapshot().run?.status, "expired");
    assert.deepEqual(automation.snapshot().cycles, {});
    assert.equal(f.submissions, 0);
  } finally {
    automation.close();
    await f.close();
  }
});

test("知乎一号断开或无法生成时，另一号仍查分、排期并核验已审原创稿的回执", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await zhihuFixture();
  const automation = autocare(f);
  try {
    const a = await f.addAccount("已断开账号");
    const b = await f.addAccount("已连接账号");
    const draft = f.content({ accountId: b.id });
    f.service.setOriginalDraft(draft.id, draft.version, b.id);
    f.db.run(
      "UPDATE website_accounts SET status='disconnected' WHERE id=?",
      a.id,
    );
    const initial = automation.snapshot();
    const configured = automation.save(
      { ...initial.config, accountIds: [a.id, b.id] },
      initial.revision,
    );
    const started = await automation.toggle(true, configured.revision);
    const blockedAt = Date.parse(started.cycles[a.id].at);
    const readyAt = Date.parse(started.cycles[b.id].at);
    t.mock.timers.setTime(blockedAt + 1000);
    await automation.tick();
    t.mock.timers.setTime(readyAt + 1000);
    await automation.tick();
    const current = automation.snapshot();
    assert.equal(current.progressCheckRuns[b.id], current.run?.id);
    assert.equal(current.progressCheckRuns[a.id], undefined);
    assert.deepEqual(current.blockedAccountIds, [a.id]);
    const job = current.jobs.find((job) => job.contentId === draft.id);
    assert.equal(job?.status, "queued");
    assert.equal(job?.accountId, b.id);
    assert.equal(job?.generatedAt, undefined);
    assert.ok(
      job?.scheduledAt &&
        Date.parse(job.scheduledAt) < Date.parse(current.run!.deadlineAt),
    );
    assert.equal(f.submissions, 0);
    assert.equal(
      automation.logs.read({ search: "source.original_ready" }).total,
      1,
    );
    assert.equal(automation.logs.read({ search: "creator.partial" }).total, 1);
    assert.equal(automation.logs.read({ search: "creator.updated" }).total, 0);
    const saved = f.db.setting<AutocareState>(autocareStateKey, current);
    assert.equal(
      saved.jobs.find((entry) => entry.id === job.id)?.taskId,
      job.taskId,
    );
    const publishAt =
      Math.max(Date.parse(job.scheduledAt!), Date.parse(current.nextCheckAt!)) +
      1000;
    t.mock.timers.setTime(publishAt);
    f.advance(publishAt - f.time);
    await automation.tick();
    const published = automation
      .snapshot()
      .jobs.find((entry) => entry.id === job.id);
    assert.equal(f.submissions, 1);
    assert.equal(published?.status, "published");
    assert.equal(published.url, "https://zhuanlan.zhihu.com/p/10001");
  } finally {
    automation.close();
    await f.close();
  }
});
