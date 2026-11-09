import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../core/errors";
import { WechatImageUploads } from "../desktop/wechat-image-uploads";

test("微信素材按内容复用：封面、正文、不同稿件和重启后不重复上传，账号和空间隔离", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-wechat-uploads-"));
  let writes = 0,
    reads = 0,
    folder = dir;
  const verify = async () => {
    reads++;
  };
  const upload = async () => ({
    url: `https://mmbiz.qpic.cn/material-${++writes}.png`,
    id: String(writes),
  });
  const bytes = Buffer.from("same normalized image");
  try {
    const uploads = new WechatImageUploads(() => folder, verify);
    const first = await uploads.use("gh_first", bytes, upload);
    assert.deepEqual(await uploads.use("gh_first", bytes, upload), first);
    assert.deepEqual(
      await new WechatImageUploads(() => folder, verify).use(
        "gh_first",
        bytes,
        upload,
      ),
      first,
    );
    assert.equal(writes, 1);
    assert.equal(reads, 2, "复用前核对素材可读且内容一致");
    await uploads.use("gh_second", bytes, upload);
    await uploads.use("gh_first", Buffer.from("new image"), upload);
    folder = join(dir, "another-space");
    await uploads.use("gh_first", bytes, upload);
    assert.equal(writes, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("素材并发和失败：同内容只上传一次，上传失败不记成功缓存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-wechat-uploads-"));
  let writes = 0;
  const cache = new WechatImageUploads(
    () => dir,
    async () => {},
  );
  const bytes = Buffer.from("image");
  try {
    await assert.rejects(
      cache.use("gh_first", bytes, async () => {
        throw Error("上传失败");
      }),
    );
    const upload = async () => {
      writes++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { url: "https://mmbiz.qpic.cn/material.png" };
    };
    const values = await Promise.all([
      cache.use("gh_first", bytes, upload),
      cache.use("gh_first", bytes, upload),
    ]);
    assert.deepEqual(values[0], values[1]);
    assert.equal(writes, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("缓存素材读取暂时失败或内容不一致时停止，不因网络抖动重复上传；确已删除才重新上传", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-wechat-uploads-"));
  let writes = 0,
    error: Error | null = null;
  const cache = new WechatImageUploads(
    () => dir,
    async () => {
      if (error) throw error;
    },
  );
  const bytes = Buffer.from("image");
  const upload = async () => ({
    url: `https://mmbiz.qpic.cn/material-${++writes}.png`,
  });
  try {
    await cache.use("gh_first", bytes, upload);
    for (const failure of [
      new Error("网络超时"),
      new AppError("WECHAT_IMAGE_MISMATCH", "素材内容不一致"),
    ]) {
      error = failure;
      await assert.rejects(cache.use("gh_first", bytes, upload), failure);
      assert.equal(writes, 1);
    }
    error = new AppError("WECHAT_IMAGE_MISSING", "HTTP404");
    await cache.use("gh_first", bytes, upload);
    assert.equal(writes, 2);
    error = null;
    await cache.use("gh_first", bytes, upload);
    assert.equal(writes, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
