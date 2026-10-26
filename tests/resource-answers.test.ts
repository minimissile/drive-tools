import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resourceAnswersFixture } from "./resource-answers-fixture";
import type {
  ResourceAnswer,
  ResourceAnswerInput,
} from "../shared/resource-answers";
const input = (
  ids: string[],
  extra: Partial<ResourceAnswerInput> = {},
): ResourceAnswerInput => ({
  requestId: randomUUID(),
  question: "如何学习这些资料？",
  resourceIds: ids,
  style: "新手友好",
  format: "text",
  instruction: "",
  previousId: null,
  ...extra,
});

test("多资源文字、复制、校准和历史版本均走真实IPC与临时数据库", async () => {
  const f = await resourceAnswersFixture();
  try {
    const first = (await f.app.invoke(
      "resourceAnswers.generate",
      input(f.ids),
    )) as ResourceAnswer;
    assert.equal(first.status, "completed");
    assert.equal(f.calls[0].resources.length, 2);
    await f.app.invoke("resourceAnswers.copy", {
      id: first.id,
      format: "text",
    });
    assert.match(f.clipboard.text, /英语零基础/);
    const second = (await f.app.invoke(
      "resourceAnswers.generate",
      input(f.ids, {
        previousId: first.id,
        instruction: "缩短到三步",
        style: "简洁直接",
      }),
    )) as ResourceAnswer;
    assert.equal(f.calls[1].previous.body, first.body);
    assert.match(second.body, /缩短到三步/);
    const history = (await f.app.invoke(
      "resourceAnswers.list",
    )) as ResourceAnswer[];
    assert.equal(history.length, 2);
    assert.equal(history.find((r) => r.id === first.id)?.body, first.body);
  } finally {
    await f.cleanup();
  }
});
test("重复点击与已完成请求重放不会再次调用模型", async () => {
  const f = await resourceAnswersFixture();
  try {
    f.control.hold = true;
    const req = input(f.ids);
    const a = f.app.invoke("resourceAnswers.generate", req);
    const b = f.app.invoke("resourceAnswers.generate", req);
    assert.equal(f.calls.length, 1);
    assert.equal(f.app.resourceAnswers.isBusy, true);
    f.control.release!();
    const [one, two] = await Promise.all([a, b]);
    assert.deepEqual(one, two);
    await f.app.invoke("resourceAnswers.generate", req);
    assert.equal(f.calls.length, 1);
  } finally {
    f.control.release?.();
    await f.cleanup();
  }
});
test("失败与中断不覆盖旧结果，不自动重试；无资源输入先拒绝", async () => {
  const f = await resourceAnswersFixture();
  try {
    const original = (await f.app.invoke(
      "resourceAnswers.generate",
      input(f.ids),
    )) as ResourceAnswer;
    f.control.failNext = true;
    const failed = input(f.ids, {
      previousId: original.id,
      instruction: "重写",
    });
    await assert.rejects(
      f.app.invoke("resourceAnswers.generate", failed),
      /模拟模型/,
    );
    await assert.rejects(
      f.app.invoke("resourceAnswers.generate", failed),
      /已提交或中断/,
    );
    assert.equal(f.calls.length, 2);
    await assert.rejects(f.app.invoke("resourceAnswers.generate", input([])));
    assert.equal(f.calls.length, 2);
    const orphan = { ...original, id: randomUUID(), status: "generating" };
    f.app.db.setSetting("resourceAnswers:run:" + orphan.id, orphan);
    const rows = (await f.app.invoke(
      "resourceAnswers.list",
    )) as ResourceAnswer[];
    assert.equal(rows.find((r) => r.id === orphan.id)?.status, "uncertain");
    assert.equal(rows.find((r) => r.id === original.id)?.body, original.body);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.cleanup();
  }
});
test("图文实际图片链路、复制PNG和富文本，未完成图片不能复制完整图文", async () => {
  const f = await resourceAnswersFixture();
  try {
    const run = (await f.app.invoke(
      "resourceAnswers.generate",
      input(f.ids, { format: "mixed", question: "<script>学习</script>" }),
    )) as ResourceAnswer;
    assert.ok(run.draftId);
    assert.equal(f.app.repo.draft(run.draftId!).creative?.cards.length, 2);
    await assert.rejects(
      f.app.invoke("resourceAnswers.copy", { id: run.id, format: "rich" }),
      /先生成全部图片/,
    );
    for (let slot = 0; slot < 2; slot++)
      await f.app.invoke("studio.submit", {
        draftId: run.draftId!,
        kind: "image",
        model: "qa-image",
        slot,
        reserveMicros: 100000,
      });
    assert.equal(f.control.imageCalls, 2);
    const jobs = f.app.studio.jobs(run.draftId!);
    assert.equal(jobs.filter((j) => j.status === "completed").length, 2);
    await f.app.invoke("studio.assetCopy", { name: jobs[0].asset + ".png" });
    assert.ok(f.clipboard.imageBytes > 0);
    await f.app.invoke("resourceAnswers.copy", { id: run.id, format: "rich" });
    assert.equal((f.clipboard.html.match(/<img /g) || []).length, 2);
    assert.ok(!f.clipboard.html.includes("<script>"));
    assert.match(f.clipboard.html, /&lt;script&gt;/);
    const replacement = (await f.app.invoke("studio.submit", {
      draftId: run.draftId!,
      kind: "image",
      model: "qa-image",
      slot: 0,
      reserveMicros: 100000,
      regenerate: true,
    })) as { id: string };
    assert.equal(f.control.imageCalls, 3);
    assert.notEqual(replacement.id, jobs[0].id);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});
test("单图只有一张方案；图片路径与版本输入受校验", async () => {
  const f = await resourceAnswersFixture();
  try {
    const run = (await f.app.invoke(
      "resourceAnswers.generate",
      input(f.ids, { format: "image" }),
    )) as ResourceAnswer;
    assert.equal(f.app.repo.draft(run.draftId!).creative?.cards.length, 1);
    await assert.rejects(
      f.app.invoke("studio.assetCopy", { name: "../../private.png" }),
    );
    await assert.rejects(
      f.app.invoke("resourceAnswers.copy", { id: "invalid", format: "text" }),
    );
    await assert.rejects(
      f.app.invoke("resourceAnswers.generate", input(Array(11).fill(f.ids[0]))),
    );
  } finally {
    await f.cleanup();
  }
});
