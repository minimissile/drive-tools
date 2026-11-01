import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import {
  photoPublicationText,
  type PhotoForm,
  type PhotoPost,
} from "../shared/photo-posts";

const form: PhotoForm = {
  title: "办公练习资料",
  subtitle: "可编辑的练习清单",
  details: "练习清单.pdf\n操作说明.txt",
  audience: "办公学习者",
  passphrase: "繁體口令測試",
  retrieval: "search",
  theme: "blue",
  platforms: ["douyin", "kuaishou", "xiaohongshu"],
};
function crc(bytes: Buffer) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
}
function png() {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(1080);
  h.writeUInt32BE(1440, 4);
  h[8] = 8;
  h[9] = 2;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", h),
    chunk("IDAT", deflateSync(Buffer.alloc((1080 * 3 + 1) * 1440))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const images = [png(), png(), png()];
async function setup() {
  const f = await fixture();
  const saved = await f.add();
  await f.app.queue.execute(saved.jobId);
  const save = (value = form, previous?: PhotoPost) =>
    f.app.invoke("photoPosts.save", {
      copyId: saved.copyId,
      form: value,
      id: previous?.id,
      expectedVersion: previous?.version,
    }) as Promise<PhotoPost>;
  return { ...f, saved, save };
}

test("Chinese retrieval phrases persist separately, retain exact characters, and reject stale edits", async () => {
  const f = await setup();
  try {
    const post = await f.save();
    assert.equal(post.version, 1);
    assert.equal(
      f.app.photoPosts.get(post.id).form.passphrase,
      form.passphrase,
    );
    assert.equal(await f.app.secrets.get(`share:${f.saved.copyId}`), "test");
    assert.match(photoPublicationText(form, "夸克", "douyin"), /繁體口令測試/);
    const second = await f.save({ ...form, subtitle: "已更新" }, post);
    assert.equal(second.version, 2);
    await assert.rejects(f.save(form, post), { code: "PHOTO_VERSION_CHANGED" });
    const same = await f.save(second.form, second);
    assert.equal(same.version, 2);
    assert.equal(f.app.photoPosts.list().length, 1);
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.provider.shares, 1);
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});
test("export writes three real PNG files and all platform copy with a versioned manifest", async () => {
  const f = await setup();
  try {
    f.ports.chooseDirectory = async () => f.dir;
    const post = await f.save();
    const result = await f.app.photoPosts.export({
      id: post.id,
      version: post.version,
      images,
    });
    assert.ok(result);
    assert.equal((await readdir(result.folder)).length, 7);
    assert.equal(
      (await readFile(join(result.folder, "01.png"))).readUInt32BE(16),
      1080,
    );
    const manifest = JSON.parse(
      await readFile(join(result.folder, "内容信息.json"), "utf8"),
    );
    assert.equal(manifest.published, false);
    assert.equal(manifest.passphrase, form.passphrase);
    assert.equal(manifest.shareUrl, f.provider.ownUrl);
    assert.match(
      await readFile(join(result.folder, "xiaohongshu-发布文案.txt"), "utf8"),
      /繁體口令測試/,
    );
    assert.equal(f.app.photoPosts.get(post.id).exportedVersion, 1);
  } finally {
    await f.cleanup();
  }
});
test("missing phrases, invalid images, cancelled dialogs and changed shares cannot produce a ready package", async () => {
  const f = await setup();
  try {
    const post = await f.save();
    assert.equal(
      await f.app.photoPosts.export({ id: post.id, version: 1, images }),
      null,
    );
    assert.equal(f.app.photoPosts.get(post.id).exportedVersion, null);
    await assert.rejects(
      f.app.photoPosts.export({
        id: post.id,
        version: 1,
        images: ["bad", ...images.slice(1)],
      }),
      { code: "PHOTO_IMAGE_INVALID" },
    );
    f.app.db.run(
      "UPDATE copies SET share_version=share_version+1 WHERE id=?",
      f.saved.copyId,
    );
    await assert.rejects(
      f.app.photoPosts.export({ id: post.id, version: 1, images }),
      { code: "PHOTO_SOURCE_CHANGED" },
    );
    const noPhrase = await f.save({ ...form, passphrase: "" }, post);
    await assert.rejects(
      f.app.photoPosts.export({
        id: post.id,
        version: noPhrase.version,
        images,
      }),
      { code: "PHOTO_PHRASE_REQUIRED" },
    );
    const foreign = await f.save(
      { ...form, details: "来源分享 https://pan.quark.cn/s/source123" },
      noPhrase,
    );
    await assert.rejects(
      f.app.photoPosts.export({
        id: foreign.id,
        version: foreign.version,
        images,
      }),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
  } finally {
    await f.cleanup();
  }
});
test("opening an official editor is a handoff and publication results validate the platform", async () => {
  const f = await setup();
  try {
    const opened: string[] = [];
    f.ports.photoPostBrowser = {
      open: async (p) => {
        opened.push(p);
      },
      isOpen: () => false,
      close: () => {},
    };
    f.ports.chooseDirectory = async () => f.dir;
    let post = await f.save();
    await assert.rejects(
      f.app.photoPosts.open({ id: post.id, version: 1, platform: "douyin" }),
      { code: "PHOTO_EXPORT_REQUIRED" },
    );
    await f.app.photoPosts.export({ id: post.id, version: 1, images });
    post = await f.app.photoPosts.open({
      id: post.id,
      version: 1,
      platform: "douyin",
    });
    assert.deepEqual(opened, ["douyin"]);
    assert.equal(post.publications[0].status, "opened");
    assert.throws(
      () =>
        f.app.photoPosts.result({
          id: post.id,
          version: 1,
          platform: "douyin",
          status: "published",
          url: "https://www.kuaishou.com/short-video/test",
        }),
      { code: "INVALID_PUBLICATION_URL" },
    );
    post = f.app.photoPosts.result({
      id: post.id,
      version: 1,
      platform: "douyin",
      status: "published",
      url: "https://www.douyin.com/note/123456",
    });
    assert.equal(post.publications[0].status, "published");
    assert.throws(
      () =>
        f.app.photoPosts.result({
          id: post.id,
          version: 1,
          platform: "douyin",
          status: "submitted",
          url: "https://www.douyin.com/note/123456",
        }),
      { code: "PHOTO_ALREADY_PUBLISHED" },
    );
    const next = await f.save({ ...form, title: "新版资料" }, post);
    assert.equal(next.exportedVersion, 1);
    assert.equal(next.publications[0].version, 1);
    assert.throws(
      () => f.app.photoPosts.remove({ id: post.id, version: next.version }),
      { code: "PHOTO_HISTORY_EXISTS" },
    );
  } finally {
    await f.cleanup();
  }
});
test("export locks the task while the directory dialog is pending", async () => {
  const f = await setup();
  try {
    let release!: (path: string | null) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    f.ports.chooseDirectory = async () => {
      entered();
      return new Promise<string | null>((r) => {
        release = r;
      });
    };
    const post = await f.save(),
      pending = f.app.photoPosts.export({ id: post.id, version: 1, images });
    await waiting;
    await assert.rejects(f.save({ ...form, title: "并行更新" }, post), {
      code: "PHOTO_BUSY",
    });
    assert.throws(() => f.app.photoPosts.remove({ id: post.id, version: 1 }), {
      code: "PHOTO_BUSY",
    });
    release(null);
    assert.equal(await pending, null);
    assert.equal(f.app.photoPosts.isBusy, false);
  } finally {
    await f.cleanup();
  }
});

test("history limits apply within a copy and selected older tasks remain readable", async () => {
  const f = await setup();
  try {
    const first = await f.save();
    const other = await f.add(false, {
      title: "其他资料",
      sourceText: "https://pan.quark.cn/s/other123",
      directory: "/其他资料",
    });
    for (let i = 0; i < 101; i++)
      await f.app.invoke("photoPosts.save", {
        copyId: other.copyId,
        form: { ...form, title: `其他资源任务${i}` },
      });
    const own = (await f.app.invoke("photoPosts.list", {
      copyId: f.saved.copyId,
    })) as PhotoPost[];
    assert.deepEqual(
      own.map((p) => p.id),
      [first.id],
    );
    for (let i = 0; i < 101; i++)
      await f.save({ ...form, title: `当前资源任务${i}` });
    const recent = (await f.app.invoke("photoPosts.list", {
      copyId: f.saved.copyId,
    })) as PhotoPost[];
    assert.equal(recent.length, 100);
    assert.equal(
      (
        (await f.app.invoke("photoPosts.get", {
          id: first.id,
          copyId: f.saved.copyId,
        })) as PhotoPost
      ).id,
      first.id,
    );
    await assert.rejects(
      f.app.invoke("photoPosts.get", { id: first.id, copyId: other.copyId }),
      { code: "PHOTO_COPY_MISMATCH" },
    );
  } finally {
    await f.cleanup();
  }
});
