import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import type { IpcValue } from "../shared/ipc";
import { answerHistory } from "../core/zhidao/answer-history";
import {
  answerProgressDay,
  isTodayAnswerRun,
} from "../shared/zhidao-answer-progress";

test("回答进度按北京时间午夜划分当天，边界不受主机时区影响", () => {
  const time = Date.parse("2026-11-24T08:00:00Z");
  assert.deepEqual(answerProgressDay(time), {
    start: "2026-11-23T16:00:00.000Z",
    end: "2026-11-24T16:00:00.000Z",
  });
  assert.equal(
    isTodayAnswerRun({ createdAt: "2026-11-23T15:59:59.999Z" }, time),
    false,
  );
  assert.equal(
    isTodayAnswerRun({ createdAt: "2026-11-23T16:00:00.000Z" }, time),
    true,
  );
  assert.equal(
    isTodayAnswerRun({ createdAt: "2026-11-24T15:59:59.999Z" }, time),
    true,
  );
  assert.equal(
    isTodayAnswerRun({ createdAt: "2026-11-24T16:00:00.000Z" }, time),
    false,
  );
});

test("当日回答列表的数量和分页不包含昨日、明日或其他业务，跨日自动切换", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-24T12:00:00+08:00"),
  });
  const f = await fixture();
  try {
    const store = f.app.zhidao.store;
    const old = store.create("answer", "昨日回答", {}, 1);
    f.app.db.run(
      "UPDATE operation_runs SET created_at=? WHERE id=?",
      "2026-11-23T15:59:59.999Z",
      old.id,
    );
    store.state(old.id, "completed", "今日更新不应改变创建日期范围", 1);
    for (let i = 0; i < 25; i++) store.create("answer", `今日回答${i}`, {}, 1);
    const tomorrow = store.create("answer", "明日回答", {}, 1);
    f.app.db.run(
      "UPDATE operation_runs SET created_at=? WHERE id=?",
      "2026-11-24T16:00:00.000Z",
      tomorrow.id,
    );
    const other = store.create("template", "模板历史", {}, 1);
    f.app.db.run(
      "UPDATE operation_runs SET created_at=? WHERE id=?",
      "2026-11-20T00:00:00.000Z",
      other.id,
    );
    const first = await f.app.invoke("zhidao.runs", {
      kind: "answer",
      page: 1,
    }) as IpcValue<"zhidao.runs">;
    assert.equal(first.total, 25);
    assert.equal(first.items.length, 20);
    assert.ok(first.items.every((run) => run.title.startsWith("今日回答")));
    assert.equal(store.list("answer", 2).items.length, 5);
    assert.equal(store.list("answer", 4).items.length, 5);
    assert.equal(store.list("template").total, 1);
    t.mock.timers.setTime(Date.parse("2026-11-25T00:00:00+08:00"));
    assert.deepEqual(
      store.list("answer").items.map((run) => run.id),
      [tomorrow.id],
    );
    t.mock.timers.setTime(Date.parse("2026-11-26T00:00:00+08:00"));
    assert.deepEqual(store.list("answer"), { items: [], total: 0 });
  } finally {
    await f.cleanup();
    t.mock.timers.reset();
  }
});

test("各账号今日进度排除旧任务，但跨日仍在运行的任务保留停止入口", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-24T12:00:00+08:00"),
  });
  const f = await fixture();
  try {
    const store = f.app.zhidao.store;
    const old = store.create(
      "answer",
      "旧已结束",
      { mode: "auto", accountId: "old" },
      1,
    );
    const overnight = store.create(
      "answer",
      "跨日运行",
      { mode: "auto", accountId: "overnight" },
      1,
    );
    for (const run of [old, overnight])
      f.app.db.run(
        "UPDATE operation_runs SET created_at=? WHERE id=?",
        "2026-11-22T12:00:00.000Z",
        run.id,
      );
    store.state(old.id, "completed", "", 1);
    store.state(overnight.id, "running", "", 0);
    const current = store.create(
      "answer",
      "当日任务",
      { mode: "auto", accountId: "old" },
      1,
    );
    assert.deepEqual(
      new Set(f.app.zhidao.answerSessions().map((run) => run.id)),
      new Set([overnight.id, current.id]),
    );
    store.state(overnight.id, "paused", "已停止");
    assert.deepEqual(
      f.app.zhidao.answerSessions().map((run) => run.id),
      [current.id],
    );
  } finally {
    await f.cleanup();
    t.mock.timers.reset();
  }
});

test("昨日进度不再列出，已提交与待核对问题仍参与跨日去重", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-24T12:00:00+08:00"),
  });
  const f = await fixture();
  try {
    const store = f.app.zhidao.store;
    const old = store.create("answer", "昨日记录", {}, 2);
    f.app.db.run(
      "UPDATE operation_runs SET created_at=? WHERE id=?",
      "2026-11-21T00:00:00.000Z",
      old.id,
    );
    store.put(old.id, "one", {
      questionId: "old-qid",
      question: "如何沟通自己的感受？",
      status: "submitted",
    });
    store.put(old.id, "two", {
      questionId: "unknown-qid",
      question: "如何安排自己的学习时间？",
      status: "uncertain",
    });
    assert.equal(store.list("answer").total, 0);
    const history = answerHistory(f.app.db);
    assert.equal(history.has("old-qid", "更换了标题"), true);
    assert.equal(history.has("new-qid", "如何 沟通自己的感受?"), true);
    assert.equal(history.has("unknown-qid", "更换了标题"), true);
    assert.equal(history.has("new-qid", "新问题"), false);
  } finally {
    await f.cleanup();
    t.mock.timers.reset();
  }
});
