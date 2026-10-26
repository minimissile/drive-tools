import test from "node:test";
import assert from "node:assert/strict";
import { publishingFixture } from "./zhidao-publish-fixture";
import { publishInput } from "../shared/zhidao";
import { publishingRights, uploadReceipt } from "../core/zhidao/publishing";

test("发布契约兼容官方0/200与直接数据；权限、额度、封禁与大整数ID不混淆", () => {
  for (const code of [0, 200]) {
    const rights = publishingRights({
      code,
      data: {
        hasPermission: "1",
        quota: "5000",
        usedQuota: "12",
        isBanned: "0",
      },
    });
    assert.equal(rights.remainingQuota, 4988);
    assert.equal(rights.isBanned, false);
    assert.equal(
      uploadReceipt({ code, data: { taskId: "10000000000000000001" } }).taskId,
      "10000000000000000001",
    );
  }
  assert.equal(publishingRights({ hasPermission: false }).remainingQuota, null);
  assert.equal(uploadReceipt({ id: "123" }).taskId, "123");
  assert.equal(uploadReceipt({ code: 0, data: {} }).rejected, false);
  assert.equal(uploadReceipt({ code: 400, msg: "拒绝" }).rejected, true);
  assert.throws(() => publishingRights({ code: 0, data: {} }));
  assert.equal(
    publishInput.safeParse({
      accountId: "x",
      taskName: "长".repeat(16),
      itemIds: ["i"],
    }).success,
    false,
  );
  assert.equal(
    publishInput.safeParse({
      accountId: "x",
      taskName: "正常",
      itemIds: ["i", "i"],
    }).success,
    false,
  );
});

async function start(
  f: Awaited<ReturnType<typeof publishingFixture>>,
  count = 3,
) {
  const sources = f.seed(count);
  const run = await f.invoke("zhidao.start", {
    kind: "publish",
    input: {
      accountId: f.account.id,
      taskName: "十五字以内的批量发布验收",
      itemIds: sources.map((item) => item.id),
    },
    authorized: true,
  });
  await f.service.zhidao.settled(run.id);
  return {
    run: f.service.zhidao.store.run(run.id),
    sources,
    items: f.service.zhidao.store.items(run.id),
  };
}

test("逐条审核可一次保存修改与新确认；普通编辑仍撤销旧审核", async () => {
  const f = await publishingFixture();
  try {
    const [source] = f.seed(1, false);
    const input = {
      id: source.id,
      name: source.name,
      question: "如何整理学习资料，方便以后查找？",
      answer: "我会先按主题分类，再按日期和版本命名，最后定期清理重复文件。",
    };
    await assert.rejects(f.service.invoke("zhidao.item.review", input));
    assert.deepEqual(f.service.zhidao.store.item(source.id), source);
    const reviewed = await f.invoke("zhidao.item.review", {
      ...input,
      confirmed: true,
    });
    assert.equal(reviewed.reviewed, true);
    assert.equal(reviewed.answer, input.answer);
    const preview = await f.invoke("zhidao.publish.preview", {
      itemIds: [reviewed.id],
      accountId: f.account.id,
    });
    assert.deepEqual(preview.errors, []);
    const edited = await f.invoke("zhidao.item.save", {
      ...input,
      answer: "修改后的内容需要再次确认。",
      reviewed: true,
    });
    assert.equal(edited.reviewed, false);
    assert.equal(f.events.filter((event) => event.type === "upload").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("审核拒绝不完整或超限内容，校验失败回滚修改与审核状态", async () => {
  const f = await publishingFixture();
  try {
    const [source] = f.seed(1, false);
    const input = {
      id: source.id,
      name: source.name,
      question: source.question,
      answer: source.answer,
      confirmed: true as const,
    };
    for (const patch of [
      { question: " " },
      { question: "问".repeat(50) },
      { answer: " " },
    ]) {
      await assert.rejects(
        f.invoke("zhidao.item.review", { ...input, ...patch }),
        { code: "REVIEW_REQUIRED" },
      );
      assert.deepEqual(f.service.zhidao.store.item(source.id), source);
    }
    // The command must also roll back a valid edit if later publication checks fail.
    f.service.zhidao.store.put(source.runId, source.key, {
      copyId: "removed-copy",
    });
    const before = f.service.zhidao.store.item(source.id);
    await assert.rejects(
      f.invoke("zhidao.item.review", { ...input, answer: "新的合法内容" }),
    );
    assert.deepEqual(f.service.zhidao.store.item(source.id), before);
    f.service.zhidao.store.put(source.runId, source.key, {
      copyId: "",
      status: "submitted",
    });
    const locked = f.service.zhidao.store.item(source.id);
    await assert.rejects(f.invoke("zhidao.item.review", input), {
      code: "ITEM_LOCKED",
    });
    assert.deepEqual(f.service.zhidao.store.item(source.id), locked);
    assert.equal(f.events.filter((event) => event.type === "upload").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("多条审核问答合并一份XLSX、一次POST、一个任务ID；审核查询与上传状态独立", async () => {
  const f = await publishingFixture();
  try {
    const { run, items } = await start(f);
    assert.equal(run.status, "completed");
    assert.equal(run.done, 3);
    const uploads = f.events.filter((event) => event.type === "upload");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].rows!.length, 4);
    assert.equal(new Set(items.map((item) => item.taskId)).size, 1);
    assert.ok(
      items.every(
        (item) => item.status === "submitted" && item.uploadBatchSize === 3,
      ),
    );
    const pending = await f.invoke("zhidao.publish.sync", {
      id: run.id,
    });
    assert.equal((pending.config.platformTasks as any[])[0].status, "pending");
    f.state.taskStatus = 2;
    f.state.successCount = 2;
    f.state.failCount = 1;
    const finished = await f.invoke("zhidao.publish.sync", {
      id: run.id,
    });
    assert.equal((finished.config.platformTasks as any[])[0].failCount, 1);
    f.state.failTasks = true;
    await assert.rejects(f.invoke("zhidao.publish.sync", { id: run.id }));
    assert.deepEqual(
      f.service.zhidao.store.run(run.id).config.platformTasks,
      finished.config.platformTasks,
    );
    assert.equal(f.events.filter((event) => event.type === "upload").length, 1);
    await f.invoke("zhidao.publish.open", { id: run.id });
    assert.deepEqual(f.events.at(-1), {
      type: "open",
      accountId: f.account.id,
      path: "quota",
    });
  } finally {
    await f.cleanup();
  }
});

for (const condition of ["quota", "permission", "banned", "identity"] as const)
  test(`发布前检查${condition}，无实际POST`, async () => {
    const f = await publishingFixture();
    try {
      if (condition === "quota") f.state.rights.quota = 2;
      if (condition === "permission") f.state.rights.hasPermission = false;
      if (condition === "banned") f.state.rights.isBanned = 1;
      if (condition === "identity") f.state.identity = "another-user";
      const { run } = await start(f);
      assert.equal(run.status, "paused");
      assert.equal(
        f.events.filter((event) => event.type === "upload").length,
        0,
      );
    } finally {
      await f.cleanup();
    }
  });

for (const mode of ["unknown", "missing-id"] as const)
  test(`整批${mode}：继续不重传，登记一个任务ID原子确认整批`, async () => {
    const f = await publishingFixture();
    try {
      f.state.mode = mode;
      const { run, items } = await start(f);
      assert.ok(items.every((item) => item.status === "uncertain"));
      await f.invoke("zhidao.resume", { id: run.id, authorized: true });
      await f.service.zhidao.settled(run.id);
      assert.equal(
        f.events.filter((event) => event.type === "upload").length,
        1,
      );
      await f.invoke("zhidao.resolve", {
        id: items[0].id,
        outcome: "submitted",
        remoteId: "real-platform-task",
        confirmed: true,
      });
      assert.ok(
        f.service.zhidao.store
          .items(run.id)
          .every(
            (item) =>
              item.taskId === "real-platform-task" &&
              item.status === "submitted",
          ),
      );
      assert.equal(f.service.zhidao.store.run(run.id).done, 3);
      assert.equal(f.service.zhidao.store.run(run.id).status, "completed");
    } finally {
      await f.cleanup();
    }
  });

test("明确拒绝可恢复；同内容不同来源ID也不能重复上传", async () => {
  const f = await publishingFixture();
  try {
    f.state.mode = "reject";
    const { run, sources } = await start(f, 2);
    assert.equal(run.status, "failed");
    assert.ok(
      f.service.zhidao.store
        .items(run.id)
        .every((item) => item.status === "failed"),
    );
    f.state.mode = "success";
    await f.invoke("zhidao.resume", { id: run.id, authorized: true });
    await f.service.zhidao.settled(run.id);
    assert.equal(f.service.zhidao.store.run(run.id).done, 2);
    const [duplicate] = f.seed();
    f.service.zhidao.store.put(duplicate.runId, duplicate.key, {
      question: sources[0].question,
      answer: sources[0].answer,
    });
    await assert.rejects(
      f.invoke("zhidao.start", {
        kind: "publish",
        input: {
          itemIds: [duplicate.id],
          accountId: f.account.id,
          taskName: "重复",
        },
        authorized: true,
      }),
      { code: "ALREADY_SUBMITTED" },
    );
  } finally {
    await f.cleanup();
  }
});

test("停止期间成功回执持久保存，原问答锁定；暂停恢复不重传已接收批次", async () => {
  const f = await publishingFixture();
  let release!: () => void;
  try {
    f.state.uploadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const [source] = f.seed();
    const run = await f.invoke("zhidao.start", {
      kind: "publish",
      input: {
        itemIds: [source.id],
        accountId: f.account.id,
        taskName: "停止验收",
      },
      authorized: true,
    });
    for (
      let i = 0;
      i < 100 && !f.events.some((event) => event.type === "upload");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.throws(
      () => f.service.zhidao.saveItem({ ...source, answer: "改动" }),
      { code: "ITEM_LOCKED" },
    );
    f.service.zhidao.pause(run.id);
    release();
    await f.service.zhidao.settled(run.id);
    assert.equal(f.service.zhidao.store.items(run.id)[0].status, "submitted");
    await f.invoke("zhidao.resume", { id: run.id, authorized: true });
    await f.service.zhidao.settled(run.id);
    assert.equal(f.service.zhidao.store.run(run.id).status, "completed");
    assert.equal(f.events.filter((event) => event.type === "upload").length, 1);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test("上限100条合并上传，101条拒绝；选择内容变化后旧确认不能发布", async () => {
  const f = await publishingFixture();
  try {
    const sources = f.seed(101);
    const input = {
      accountId: f.account.id,
      taskName: "批量上限",
      itemIds: sources.map((item) => item.id),
    };
    await assert.rejects(
      f.invoke("zhidao.start", { kind: "publish", input, authorized: true }),
    );
    input.itemIds.pop();
    const preview = await f.invoke("zhidao.publish.preview", {
      itemIds: input.itemIds,
      accountId: f.account.id,
    });
    f.service.zhidao.store.put(sources[0].runId, sources[0].key, {
      answer: "改变但重新审核后的正文",
    });
    await assert.rejects(
      f.invoke("zhidao.start", {
        kind: "publish",
        input: { ...input, selectionRevision: preview.revision },
        authorized: true,
      }),
      { code: "SELECTION_CHANGED" },
    );
    const run = await f.invoke("zhidao.start", {
      kind: "publish",
      input,
      authorized: true,
    });
    await f.service.zhidao.settled(run.id);
    assert.equal(f.service.zhidao.store.run(run.id).done, 100);
    assert.equal(f.events.filter((event) => event.type === "upload").length, 1);
    assert.equal(
      f.events.find((event) => event.type === "upload")!.rows!.length,
      101,
    );
  } finally {
    await f.cleanup();
  }
});

test("整批确认未提交后恢复只重试该批，登记、崩溃恢复均不产生部分状态", async () => {
  const f = await publishingFixture();
  try {
    f.state.mode = "unknown";
    const { run, items } = await start(f, 2);
    await f.invoke("zhidao.resolve", {
      id: items[1].id,
      outcome: "retry",
      confirmed: true,
    });
    assert.ok(
      f.service.zhidao.store
        .items(run.id)
        .every((item) => item.status === "ready"),
    );
    f.state.mode = "success";
    await f.invoke("zhidao.resume", { id: run.id, authorized: true });
    await f.service.zhidao.settled(run.id);
    assert.equal(f.events.filter((event) => event.type === "upload").length, 2);
    assert.equal(f.service.zhidao.store.run(run.id).done, 2);
    const recovery = f.service.zhidao.store.create(
      "publish",
      "恢复",
      { itemIds: [] },
      2,
    );
    f.service.zhidao.store.state(recovery.id, "running", "");
    for (const key of ["a", "b"]) {
      const item = f.service.zhidao.store.put(recovery.id, key, {
        uploadBatchId: "same-batch",
        uploadBatchSize: 2,
      });
      f.service.zhidao.store.submitting(item);
    }
    f.service.zhidao.store.recover();
    assert.ok(
      f.service.zhidao.store
        .items(recovery.id)
        .every((item) => item.status === "uncertain"),
    );
  } finally {
    await f.cleanup();
  }
});

test("旧逐条发布任务继续时仅上传剩余项，名称截断后含序号仍不超过15字", async () => {
  const f = await publishingFixture();
  try {
    const sources = f.seed(2);
    const run = f.service.zhidao.store.create(
      "publish",
      "旧任务",
      {
        accountId: f.account.id,
        itemIds: sources.map((item) => item.id),
        taskName: "旧任务名称".repeat(15),
      },
      2,
    );
    f.service.zhidao.store.state(run.id, "paused", "", 1);
    f.service.zhidao.store.put(run.id, sources[0].id, {
      ...sources[0],
      id: "old-submitted",
      runId: run.id,
      key: sources[0].id,
      status: "submitted",
      taskId: "old-task",
    });
    await f.invoke("zhidao.resume", { id: run.id, authorized: true });
    await f.service.zhidao.settled(run.id);
    assert.equal(f.service.zhidao.store.run(run.id).done, 2);
    const uploads = f.events.filter((event) => event.type === "upload");
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0].taskName!.endsWith("-2"));
    assert.equal(uploads[0].rows![1][1], sources[1].question);
  } finally {
    await f.cleanup();
  }
});
