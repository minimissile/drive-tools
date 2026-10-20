import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { readDraft, writeDraft } from "../src/storage/local-draft";
import { taskGroup } from "../src/tasks/task-state";
import { fixture } from "./helpers";

test("本地暂存按空间隔离，损坏数据与存储不足不会冒充已保存", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const parse = (value: unknown) =>
    z.object({ title: z.string() }).parse(value);
  assert.equal(
    writeDraft(storage, "workspace-a:new", { title: "暂存资料" }),
    true,
  );
  assert.deepEqual(readDraft(storage, "workspace-a:new", parse), {
    title: "暂存资料",
  });
  assert.equal(readDraft(storage, "workspace-b:new", parse), undefined);
  values.set("bad", "{broken");
  assert.equal(readDraft(storage, "bad", parse), undefined);
  values.set("bad", '{"title":3}');
  assert.equal(readDraft(storage, "bad", parse), undefined);
  assert.equal(
    writeDraft(
      {
        ...storage,
        setItem() {
          throw new Error("QuotaExceededError");
        },
      },
      "full",
      {},
    ),
    false,
  );
});
test("任务异常、执行、完成与已停止分别归类，不把停止当成待处理", () => {
  for (const stage of ["failed", "needs_review", "waiting_login"])
    assert.equal(taskGroup(stage), "attention");
  for (const stage of [
    "queued",
    "preflight",
    "transferring",
    "sharing",
    "archiving",
  ])
    assert.equal(taskGroup(stage), "active");
  assert.equal(taskGroup("completed"), "completed");
  assert.equal(taskGroup("cancelled"), "cancelled");
});
test("设置分区独立保存，验证失败原子回滚，不覆盖其他分区", async () => {
  const f = await fixture();
  try {
    const before = f.app.snapshot().settings;
    await f.app.invoke("settings.save", { bitUrl: "http://127.0.0.1:54321" });
    const after = f.app.snapshot().settings;
    assert.equal(after.bitUrl, "http://127.0.0.1:54321");
    assert.deepEqual(after.aiModels, before.aiModels);
    assert.equal(after.exportCodes, before.exportCodes);
    assert.equal(after.dailyAiBudgetMicros, before.dailyAiBudgetMicros);
    await assert.rejects(
      f.app.invoke("settings.save", {
        bitUrl: "https://example.com",
        exportCodes: !before.exportCodes,
      }),
    );
    assert.equal(f.app.snapshot().settings.exportCodes, before.exportCodes);
    await assert.rejects(f.app.invoke("settings.save", {}));
  } finally {
    await f.cleanup();
  }
});
