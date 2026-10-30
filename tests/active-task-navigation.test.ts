import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { activeTaskOptions } from "../src/tasks/active-task-options";
import type { OperationRun } from "../shared/zhidao";
import type { Job } from "../shared/types";
import type { DiscoverySummary } from "../shared/baidu-discovery";

test("百度采词进入公共任务切换器，定位对应任务并排除已完成任务", () => {
  const run = {
    id: "baidu1",
    status: "running",
    input: { seeds: ["画竹子教程"] },
    completedCount: 1,
    queryCount: 3,
  } as DiscoverySummary;
  const options = activeTaskOptions(
    [],
    [],
    [run, { ...run, id: "done", status: "completed" }],
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].page, "baidu-discovery");
  assert.deepEqual(options[0].focus, { id: "baidu1", kind: "baidu-discovery" });
  assert.match(options[0].label, /1\/3/);
});

test("进行中运营任务不受历史分页限制，并排除完成/暂停任务及内部配置", async () => {
  const f = await fixture();
  try {
    const store = f.app.zhidao.store;
    const active = store.create(
      "answer",
      "早期答题",
      { accountId: "private" },
      10,
    );
    store.state(active.id, "running", "", 3);
    for (let i = 0; i < 25; i++) {
      const r = store.create("publish", `已完成${i}`, {}, 1);
      store.state(r.id, "completed", "", 1);
    }
    const paused = store.create("answer", "已暂停", {}, 2);
    store.state(paused.id, "paused", "");
    const rows = (await f.app.invoke("zhidao.activeRuns")) as Omit<
      OperationRun,
      "config"
    >[];
    assert.deepEqual(
      rows.map((r) => r.id),
      [active.id],
    );
    assert.equal(rows[0].done, 3);
    assert.equal("config" in rows[0], false);
    store.state(active.id, "completed", "", 10);
    assert.deepEqual(await f.app.invoke("zhidao.activeRuns"), []);
  } finally {
    await f.cleanup();
  }
});

test("任务入口区分同页多个答题/上传任务，网盘任务按实际状态展示", () => {
  const runs = [
    {
      id: "answer1",
      kind: "answer",
      title: "英语",
      status: "running",
      done: 2,
      total: 10,
    },
    {
      id: "answer2",
      kind: "answer",
      title: "编程",
      status: "running",
      done: 4,
      total: 20,
    },
    {
      id: "publish1",
      kind: "publish",
      title: "资料上传",
      status: "running",
      done: 1,
      total: 8,
    },
    {
      id: "done",
      kind: "answer",
      title: "完成",
      status: "completed",
      done: 1,
      total: 1,
    },
  ] as Omit<OperationRun, "config">[];
  const jobs = [
    { id: "job1", title: "转存英语", stage: "queued" },
    { id: "job2", title: "已完成转存", stage: "completed" },
  ] as Job[];
  const options = activeTaskOptions(runs, jobs);
  assert.equal(options.length, 4);
  assert.deepEqual(
    options.map((o) => o.focus.id),
    ["answer1", "answer2", "publish1", "job1"],
  );
  assert.equal(options[0].page, "zhidao-qa");
  assert.equal(options[1].page, "zhidao-qa");
  assert.equal(options[2].page, "zhidao-publish");
  assert.equal(options[3].page, "tasks");
  assert.match(options[0].label, /2\/10/);
  assert.deepEqual(activeTaskOptions([], []), []);
});
