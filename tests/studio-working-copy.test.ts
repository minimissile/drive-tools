import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { Database } from "../core/database";
import { inspectBackup, stageRestore } from "../core/backups";
import type { Draft } from "../shared/types";
import type { StudioWorkingCopy } from "../shared/studio";

function edit(
  draft: Draft,
  title = "尚未完成的编辑",
  editedAt = Date.now(),
): StudioWorkingCopy {
  return {
    draftId: draft.id,
    editedAt,
    value: {
      title,
      body: "需要继续核对的正文",
      tags: "英语 课堂",
      coverText: "课堂练习",
      creative: draft.creative,
    },
  };
}
async function setup() {
  const f = await fixture();
  const saved = await f.add();
  await f.app.queue.execute(saved.jobId);
  const create = async (format = "text", platform = "xiaohongshu") =>
    (await f.app.invoke("studio.create", {
      copyId: saved.copyId,
      platform,
      mode: "template",
      format,
      templateId: "resource-guide",
      aspectRatio: format === "video" ? "9:16" : "3:4",
      pageCount: 3,
    })) as Draft;
  return { ...f, saved, create };
}

test("incomplete edits persist separately without changing a reviewed draft or making API calls", async () => {
  const f = await setup();
  try {
    const draft = await f.create();
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    const original = f.app.repo.draft(draft.id);
    const record = edit(draft, "");
    record.value.body = "";
    assert.equal(
      await f.app.invoke("studio.workingCopy", { draftId: draft.id }),
      null,
    );
    await f.app.invoke("studio.workingSave", record);
    assert.deepEqual(
      await f.app.invoke("studio.workingCopy", { draftId: draft.id }),
      record,
    );
    assert.deepEqual(f.app.repo.draft(draft.id), original);
    await assert.rejects(
      f.app.invoke("draft.review", { id: draft.id, reviewed: true }),
      { code: "UNSAVED_DRAFT" },
    );
    await assert.rejects(
      f.app.invoke("publication.package", {
        draftId: draft.id,
        bindingId: null,
        includeLink: false,
      }),
      { code: "UNSAVED_DRAFT" },
    );
    assert.equal(f.app.repo.calls().length, 0);
    await assert.rejects(
      f.app.invoke("draft.save", { id: draft.id, ...record.value, tags: [] }),
    );
    assert.deepEqual(
      await f.app.invoke("studio.workingCopy", { draftId: draft.id }),
      record,
    );
  } finally {
    await f.cleanup();
  }
});

test("draft-scoped edits preserve image/video plans, reject malformed records and ignore stale writes", async () => {
  const f = await setup();
  try {
    const image = await f.create("carousel"),
      video = await f.create("video", "douyin");
    const imageEdit = edit(image),
      videoEdit = edit(video);
    imageEdit.value.creative!.cards[1].copy = "第二页尚未完成的课堂例子";
    imageEdit.value.creative!.cards[1].imagePrompt = "第二页画面要求";
    videoEdit.value.creative!.videoPrompt = "教师翻书，镜头缓慢向前移动";
    videoEdit.value.creative!.voiceover = "未完成的口播参考";
    await f.app.invoke("studio.workingSave", imageEdit);
    await f.app.invoke("studio.workingSave", videoEdit);
    await f.app.invoke(
      "studio.workingSave",
      edit(image, "更旧的请求", imageEdit.editedAt - 1),
    );
    assert.deepEqual(
      await f.app.invoke("studio.workingCopy", { draftId: image.id }),
      imageEdit,
    );
    assert.deepEqual(
      await f.app.invoke("studio.workingCopy", { draftId: video.id }),
      videoEdit,
    );
    await assert.rejects(
      f.app.invoke("studio.workingSave", { ...imageEdit, draftId: "missing" }),
    );
    await assert.rejects(
      f.app.invoke("studio.workingSave", {
        ...imageEdit,
        value: { ...imageEdit.value, title: "a".repeat(201) },
      }),
    );
    await assert.rejects(
      f.app.invoke("studio.workingSave", {
        ...imageEdit,
        value: videoEdit.value,
      }),
      { code: "WORKING_COPY_MISMATCH" },
    );
    await f.app.invoke("studio.workingClear", { draftId: image.id });
    assert.equal(
      await f.app.invoke("studio.workingCopy", { draftId: image.id }),
      null,
    );
    assert.deepEqual(
      await f.app.invoke("studio.workingCopy", { draftId: video.id }),
      videoEdit,
    );
  } finally {
    await f.cleanup();
  }
});

test("working edits survive closing and reopening the database", async () => {
  const f = await setup();
  try {
    const draft = await f.create(),
      record = edit(draft);
    await f.app.invoke("studio.workingSave", record);
    const path = join(f.dir, "reopened.db");
    f.app.db.run("VACUUM INTO ?", path);
    const reopened = new Database(path);
    try {
      assert.deepEqual(
        reopened.setting(`studio:working:${draft.id}`, null),
        record,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("backup restoration retains working content while resetting credentials, review and connections", async () => {
  const f = await setup();
  try {
    const draft = await f.create(),
      record = edit(draft);
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    await f.app.invoke("studio.workingSave", record);
    f.app.db.setSetting("model", "private/model");
    await f.app.secrets.set("openrouter", "test-only-key");
    const destination = join(f.dir, "backups");
    await mkdir(destination);
    f.ports.chooseDirectory = async () => destination;
    const backup = (await f.app.backup())!;
    const info = await inspectBackup(backup);
    const restored = await stageRestore(backup, f.dir, info.databaseSha256);
    const db = new Database(join(restored.dataPath, "panxu.db"));
    try {
      assert.deepEqual(db.setting(`studio:working:${draft.id}`, null), record);
      assert.equal(db.setting("model", null), null);
      assert.equal(db.setting("dailyAiBudgetMicros", -1), 0);
      assert.equal(
        db.get<{ n: number }>("SELECT count(*) n FROM secrets")!.n,
        0,
      );
      assert.equal(
        db.get<{ reviewed: number }>(
          "SELECT reviewed FROM drafts WHERE id=?",
          draft.id,
        )!.reviewed,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("corrupt persisted edits are reported instead of being silently overwritten", async () => {
  const f = await setup();
  try {
    const draft = await f.create();
    f.app.db.setSetting(`studio:working:${draft.id}`, {
      draftId: "another-draft",
      value: {},
    });
    await assert.rejects(
      f.app.invoke("studio.workingCopy", { draftId: draft.id }),
      { code: "WORKING_COPY_INVALID" },
    );
    await assert.rejects(f.app.invoke("studio.workingSave", edit(draft)), {
      code: "WORKING_COPY_INVALID",
    });
    f.app.db.run(
      "UPDATE settings SET value=? WHERE key=?",
      "{broken",
      `studio:working:${draft.id}`,
    );
    await assert.rejects(
      f.app.invoke("studio.workingCopy", { draftId: draft.id }),
      { code: "WORKING_COPY_INVALID" },
    );
  } finally {
    await f.cleanup();
  }
});
