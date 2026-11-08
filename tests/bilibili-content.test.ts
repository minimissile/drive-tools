import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { VideoService } from "../core/video-service";
import { BilibiliContent } from "../core/bilibili/content";
import {
  canonicalBilibiliReceipt,
  bilibiliEditorUrl,
  type BilibiliEditorPayload,
  type BilibiliPreparation,
} from "../shared/bilibili";

async function setup() {
  const f = await fixture();
  let uid = "123456";
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {},
    status: async () => ({
      hasSession: true,
      uid,
      nickname: "资料整理",
      windowOpen: false,
      error: null,
    }),
    verify: async () => ({
      hasSession: true,
      uid,
      nickname: "资料整理",
      windowOpen: false,
      error: null,
    }),
  };
  const account = f.app.websiteAccounts.add("bilibili", "资料整理号");
  await f.app.websiteAccounts.check(account.id, true);
  const saved = await f.add(false);
  const video = new VideoService(f.app.db, f.dir, () => {}, {
    runtime: async () => ({
      available: true,
      browserExecutable: "/unused/browser",
      message: "fixture",
    }),
    render: async ({ outputDirectory }) => {
      await mkdir(outputDirectory, { recursive: true });
      const videoPath = join(outputDirectory, "video.mp4"),
        coverPath = join(outputDirectory, "cover.png");
      await writeFile(videoPath, "local-video-content");
      await writeFile(coverPath, "local-cover-content");
      return {
        videoPath,
        coverPath,
        width: 1920,
        height: 1080,
        durationSeconds: 12,
      };
    },
  });
  const job = await video.create(saved.copyId, {
    title: "真实资源目录",
    entries: [{ name: "目录.pdf", kind: "file" }],
    aspectRatio: "16:9",
  });
  while (video.isBusy) await new Promise((resolve) => setTimeout(resolve, 5));
  const prepared: BilibiliEditorPayload[] = [];
  let result: Omit<BilibiliPreparation, "preparedAt"> | null = null;
  let prepare = async (payload: BilibiliEditorPayload) => {
    prepared.push(payload);
    return (
      result ?? {
        status: "filled" as const,
        editorUrl: bilibiliEditorUrl(payload.kind),
        filledFields: ["标题", "简介"],
        mediaSelected: true,
        imageSelected: true,
        message: "官网已填写，尚未提交发布。",
      }
    );
  };
  const dependencies = {
    db: f.app.db,
    accounts: f.app.websiteAccounts,
    video,
    repo: f.app.repo,
    dataPath: f.dir,
    port: {
      prepare: async (_account: unknown, payload: BilibiliEditorPayload) =>
        prepare(payload),
    },
    changed() {},
  };
  const content = new BilibiliContent(dependencies);
  return {
    ...f,
    saved,
    account,
    video,
    job,
    prepared,
    dependencies,
    content,
    setUid: (value: string) => {
      uid = value;
    },
    setResult: (value: typeof result) => {
      result = value;
    },
    setPrepare: (value: typeof prepare) => {
      prepare = value;
    },
    draft: () =>
      content.save({
        accountId: account.id,
        copyId: saved.copyId,
        title: "资料目录与自测指南",
        text: "先了解各类测评用途，再按实际目录选择练习。",
        videoJobId: job.id,
      }),
    async cleanup() {
      content.close();
      video.close();
      await f.cleanup();
    },
  };
}

test("本地B站草稿保存、预览、导出及重建不打开官网，关联真实完成视频与封面", async () => {
  const f = await setup();
  try {
    const draft = f.draft(),
      preview = await f.content.preview(draft.id);
    assert.equal(preview.video?.id, f.job.id);
    assert.match(preview.imageUrl!, /^data:image\/png;base64,/);
    assert.deepEqual(preview.issues, []);
    assert.equal(preview.accountLabel, "资料整理");
    assert.equal(f.prepared.length, 0);
    const restarted = new BilibiliContent(f.dependencies);
    assert.equal(restarted.list()[0].id, draft.id);
    assert.equal(restarted.get(draft.id).text, draft.text);
    const output = await restarted.package(draft.id),
      text = output.bytes.toString("utf8");
    assert.match(text, /资料目录与自测指南/);
    assert.match(text, /视频文件：.*\.mp4/);
    assert.match(text, /封面文件：.*\.png/);
    assert.equal(f.prepared.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("旧版本保存不覆盖另一窗口，重新保存清除旧填写回执并保留原稿", async () => {
  const f = await setup();
  try {
    const original = f.draft(),
      updated = f.content.save({ ...original, text: "重新核实后的正文。" });
    assert.equal(updated.revision, original.revision + 1);
    assert.throws(
      () => f.content.save({ ...original, text: "旧窗口正文" }),
      /其它窗口更新/,
    );
    assert.equal(f.content.get(original.id).text, updated.text);
  } finally {
    await f.cleanup();
  }
});
test("官网填写重新核验原账号并只传后端解析的素材，部分填写保持待处理", async () => {
  const f = await setup();
  try {
    const draft = f.draft();
    f.setResult({
      status: "partial",
      editorUrl: bilibiliEditorUrl("video"),
      filledFields: ["标题"],
      mediaSelected: true,
      imageSelected: false,
      message: "已选视频，请在官网补封面。尚未提交发布。",
    });
    const prepared = await f.content.prepare(draft.id);
    assert.equal(prepared.stage, "attention");
    assert.equal(prepared.preparation?.mediaSelected, true);
    assert.equal(prepared.preparation?.imageSelected, false);
    assert.equal(f.prepared.length, 1);
    assert.equal(f.prepared[0].uid, "123456");
    assert.match(f.prepared[0].videoPath!, /\/media\/[a-f0-9]{64}\.mp4$/);
    assert.match(f.prepared[0].coverPath!, /\/media\/[a-f0-9]{64}\.png$/);
    assert.equal("published" in prepared, false);
    f.setUid("654321");
    await assert.rejects(f.content.prepare(draft.id), /其他身份|检查|登录/);
    assert.equal(f.prepared.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("动态及文章复用已有封面；长正文明确提示，未选视频和外来网盘链接不调用官网", async () => {
  const f = await setup();
  try {
    for (const kind of ["dynamic", "article"] as const) {
      const draft = f.content.save({
        ...f.draft(),
        kind,
        text: "正文内容".repeat(50),
      });
      const preview = await f.content.preview(draft.id);
      assert(preview.imageUrl);
      assert(!preview.issues.some((issue) => issue.level === "error"));
    }
    const missing = f.content.save({ ...f.draft(), videoJobId: "" });
    await assert.rejects(f.content.prepare(missing.id), /制作完成的视频/);
    const long = f.content.save({ ...f.draft(), text: "字".repeat(2001) });
    assert(
      (await f.content.preview(long.id)).issues.some(
        (issue) =>
          issue.level === "warning" && issue.message.includes("字数限制"),
      ),
    );
    const foreign = f.content.save({
      ...f.draft(),
      text: "参考 https://pan.quark.cn/s/foreign123",
    });
    await assert.rejects(f.content.prepare(foreign.id), /网盘链接|本人链接/);
    assert.equal(f.prepared.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("关闭发生在账号核验await中时，晚到身份回包也不能打开官网", async () => {
  const f = await setup();
  let release!: () => void;
  try {
    const draft = f.draft();
    f.ports.websiteSessions!.verify = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        hasSession: true,
        uid: "123456",
        nickname: "资料整理",
        windowOpen: false,
        error: null,
      };
    };
    const pending = f.content.prepare(draft.id);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    f.content.close();
    release();
    await assert.rejects(pending, /工作空间已关闭/);
    assert.equal(f.prepared.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("B站素材篡改及符号链接被拒，不将任意本地路径上传", async () => {
  const f = await setup();
  try {
    const draft = f.draft(),
      path = (await f.video.output(f.job.id, "video")).path;
    const bytes = await readFile(path);
    await writeFile(path, "tampered");
    await assert.rejects(f.content.prepare(draft.id), /素材已变化/);
    await writeFile(path, bytes);
    await rm(path);
    await symlink(join(f.dir, "panxu.db"), path);
    await assert.rejects(f.content.prepare(draft.id), /素材已丢失|素材不完整/);
    assert.equal(f.prepared.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("准备中的重复操作、保存及晚回包被拦截，关闭后不写入已关数据库", async () => {
  const f = await setup();
  let release!: () => void;
  try {
    const draft = f.draft();
    f.setPrepare(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        status: "filled",
        editorUrl: bilibiliEditorUrl("video"),
        filledFields: ["标题"],
        mediaSelected: true,
        imageSelected: true,
        message: "尚未提交",
      };
    });
    const pending = f.content.prepare(draft.id);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    assert(f.content.isBusy);
    await assert.rejects(f.content.prepare(draft.id), /正在填写/);
    assert.throws(() => f.content.save(draft), /正在填写/);
    f.content.close();
    release();
    await assert.rejects(pending, /工作空间已关闭/);
  } finally {
    await f.cleanup();
  }
});
test("官网结果记录只接受对应类型的完整B站链接并保持待核实，不推定已发布", async () => {
  const f = await setup();
  try {
    const draft = f.draft(),
      recorded = f.content.recordReceipt(
        draft.id,
        "https://www.bilibili.com/video/BV1RK3t6wEC1/?spm_id_from=tracking",
      );
    assert.equal(
      recorded.receipt?.url,
      "https://www.bilibili.com/video/BV1RK3t6wEC1/",
    );
    assert.equal(recorded.receipt?.status, "unverified");
    assert.equal(recorded.stage, "attention");
    for (const url of [
      "https://evil.test/video/BV1RK3t6wEC1/",
      "javascript:alert(1)",
      "https://user:pass@www.bilibili.com/video/BV1RK3t6wEC1/",
      "https://t.bilibili.com/12345",
    ])
      assert.throws(() => f.content.recordReceipt(draft.id, url));
    assert.equal(
      canonicalBilibiliReceipt(
        "https://t.bilibili.com/12345?foo=bar",
        "dynamic",
      ),
      "https://t.bilibili.com/12345",
    );
    assert.equal(
      canonicalBilibiliReceipt(
        "https://www.bilibili.com/read/cv12345/",
        "article",
      ),
      "https://www.bilibili.com/read/cv12345",
    );
    assert.equal(
      canonicalBilibiliReceipt(
        "https://www.bilibili.com/opus/12345?foo=bar",
        "article",
      ),
      "https://www.bilibili.com/opus/12345",
    );
    assert.equal(f.prepared.length, 0);
  } finally {
    await f.cleanup();
  }
});
