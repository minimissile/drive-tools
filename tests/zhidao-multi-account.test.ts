import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { ZhidaoOperations } from "../core/zhidao/service";
import { AnswerReservations } from "../core/zhidao/answer-history";
import {
  autoAnswersStart,
  zhidaoAccountLabel,
  zhidaoAccountName,
} from "../shared/zhidao";
import {
  answerDraftSchema,
  defaultAnswerDraft,
} from "../src/zhidao/answer-draft";

const options = {
  count: 1,
  categories: ["emotion"],
  intervalSeconds: 18,
  style: "第一人称共鸣",
  instructions: "",
  authorized: true,
};
async function setup() {
  const f = await fixture();
  await f.app.secrets.set("openrouter", "isolated-fixture-key");
  f.app.db.setSetting("aiModels", { copy: "fixture/copy" });
  let scheduled = 0;
  const op = new ZhidaoOperations(
    f.app.repo,
    f.app.secrets,
    f.app.ai,
    f.ports,
    f.dir,
    () => {},
    {
      pace: 0,
      schedule: async (_refs, _label, action) => {
        scheduled++;
        return action();
      },
    },
  );
  for (let n = 1; n <= 4; n++)
    op.store.saveAccount({
      id: `zd_multi${n}`,
      alias: `百度知道 · #${n}`,
      nickname: `答主${n}`,
      uid: `uid-${n}`,
      status: "connected",
      bulkPermission: false,
      checkedAt: new Date().toISOString(),
      message: "",
    });
  op.client.identity = async (id) => ({
    uid: op.store.account(id).uid,
    nickname: op.store.account(id).nickname,
    stoken: "fixture",
  });
  op.client.questions = async () => ({
    items: [{ qid: "shared-1", question: "怎样安排自己的学习时间？" }],
    hasMore: false,
    nextBase: 8,
    total: 1,
  });
  let generated = 0,
    submitted = 0;
  f.app.ai.resourceExport = async <T>() => {
    generated++;
    return {
      answer:
        "我会先列出本周任务，再为最重要的任务留出固定时间，每晚根据实际完成情况调整。",
    } as T;
  };
  op.client.answer = async () => {
    submitted++;
    return { errno: 0, data: { aid: `aid-${submitted}` } };
  };
  return {
    ...f,
    op,
    counts: () => ({ generated, submitted, scheduled }),
    async cleanup() {
      op.close();
      await f.cleanup();
    },
  };
}
test("账号昵称优先展示，保留不同备注；旧单号草稿迁移为多选且可清空", () => {
  assert.equal(
    zhidaoAccountLabel({ nickname: "真实昵称", alias: "主账号" }),
    "真实昵称 · 主账号",
  );
  assert.equal(zhidaoAccountName({ nickname: "", alias: "主账号" }), "主账号");
  const { accountIds, ...old } = defaultAnswerDraft;
  assert.deepEqual(
    answerDraftSchema.parse({ ...old, accountId: "zd_one" }).accountIds,
    ["zd_one"],
  );
  assert.deepEqual(
    answerDraftSchema.parse({ ...old, accountId: "", accountIds: [] })
      .accountIds,
    [],
  );
  assert.equal(
    autoAnswersStart.safeParse({ ...options, accountIds: ["one", "one"] })
      .success,
    false,
  );
  assert.equal(
    autoAnswersStart.safeParse({
      ...options,
      accountIds: ["one"],
      categories: ["emotion", "education"],
    }).success,
    false,
  );
});
test("题号或规范化标题重复时互斥，不同题目并行，释放后可重新占用", () => {
  const claims = new AnswerReservations();
  assert.equal(claims.claim("a", "q1", "怎么学习？"), true);
  assert.equal(claims.claim("b", "q1", "另一个标题"), false);
  assert.equal(claims.claim("b", "q2", "怎 么 学 习!"), false);
  assert.equal(claims.claim("b", "q3", "怎么练字？"), true);
  claims.release("a");
  assert.equal(claims.claim("c", "q1", "怎么学习？"), true);
});
test("四账号可同时启动，同账号不能叠加；停止一个账号不停止其他账号", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const identity = f.op.client.identity.bind(f.op.client);
  f.op.client.identity = async (id) => {
    await gate;
    return identity(id);
  };
  try {
    const runs = f.op.startAnswers({
      ...options,
      accountIds: [1, 2, 3, 4].map((n) => `zd_multi${n}`),
    });
    assert.equal(runs.length, 4);
    assert.ok(
      runs.every((r) => r.status === "running" && r.title.includes("答主")),
    );
    assert.equal(f.op.answerSessions().length, 4);
    await assert.rejects(
      f.op.start({
        kind: "answer",
        authorized: true,
        input: { mode: "auto", accountId: "zd_multi2", count: 1 },
      }),
      { code: "ACCOUNT_BUSY" },
    );
    f.op.pause(runs[0].id);
    assert.equal(f.op.store.run(runs[1].id).status, "running");
    release();
    await Promise.all(runs.map((r) => f.op.settled(r.id)));
    assert.equal(f.op.store.run(runs[0].id).status, "paused");
    assert.equal(f.counts().submitted, 1);
    assert.equal(f.counts().scheduled, 0, "自动答题不占用全局长任务队列槽位");
  } finally {
    release();
    await f.cleanup();
  }
});
test("并发遇到同一道题时只生成、提交一次", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let generated = 0;
  f.app.ai.resourceExport = async <T>() => {
    generated++;
    await gate;
    return {
      answer:
        "我会先列出每天可以使用的时间，安排学习任务并在晚上核对完成情况。",
    } as T;
  };
  try {
    const runs = f.op.startAnswers({
      ...options,
      accountIds: ["zd_multi1", "zd_multi2"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.race(runs.map((r) => f.op.settled(r.id))),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("重复题应被跳过而非同时等待生成")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(generated, 1);
    release();
    await Promise.all(runs.map((r) => f.op.settled(r.id)));
    assert.equal(generated, 1);
    assert.equal(f.counts().submitted, 1);
    assert.ok(
      runs.some((r) =>
        f.op.store
          .answerLogs(r.id, 1)
          .items.some((l) => l.message.includes("其他账号正在处理")),
      ),
    );
  } finally {
    release();
    await f.cleanup();
  }
});
test("批量预检失败不启动部分账号，重复百度身份不能并发", async () => {
  const f = await setup();
  try {
    const before = f.op.store.list("answer").total;
    assert.throws(() =>
      f.op.startAnswers({ ...options, accountIds: ["zd_multi1", "missing"] }),
    );
    assert.equal(f.op.store.list("answer").total, before);
    f.op.store.saveAccount({
      ...f.op.store.account("zd_multi2"),
      uid: "uid-1",
    });
    assert.throws(
      () =>
        f.op.startAnswers({
          ...options,
          accountIds: ["zd_multi1", "zd_multi2"],
        }),
      { code: "DUPLICATE_ACCOUNT" },
    );
    assert.equal(f.counts().generated, 0);
  } finally {
    await f.cleanup();
  }
});
