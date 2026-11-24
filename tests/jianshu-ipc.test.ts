import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./helpers";
import type { JianshuDetail } from "../shared/jianshu";
import { jianshuSaveSchema } from "../shared/jianshu";
const body =
  "这份资料包含词汇练习和阅读记录，可以先从目录中选择适合自己的部分，再按每日安排逐步练习。记录不熟悉的表达，方便以后回顾。";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=",
  "base64",
);
test("jianshu integrated IPC preserves owned entry, images, copy/export and honest handoff", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "jianshu-export-test-"));
  const copied: { html: string; text: string }[] = [];
  let preparations = 0;
  const f = await fixture(
    {},
    {
      chooseDirectory: async () => exportRoot,
      copyRichText: async (html, text) => {
        copied.push({ html, text });
      },
      readWeiboImages: async (platform) => {
        assert.equal(platform, "jianshu");
        return [{ name: "本地配图.png", bytes: png }];
      },
      websiteSessions: {
        isOpen: () => false,
        login: async () => {},
        clear: async () => {},
        invalidate: async () => {},
        status: async () => ({
          hasSession: true,
          uid: "03f80ba6b743",
          windowOpen: false,
          error: null,
        }),
        verify: async () => ({
          hasSession: true,
          uid: "03f80ba6b743",
          windowOpen: false,
          error: null,
        }),
      },
      jianshu: {
        async prepare(_account, payload) {
          preparations++;
          assert.equal(copied.at(-1)?.text, payload.text);
          assert.match(payload.text, /p9x2/);
          return {
            opened: true,
            filled: false,
            editorUrl: "https://www.jianshu.com/writer#/",
            message: "官网待人工发布",
          };
        },
        async checkResult(_a, url, payload) {
          return { verified: true, url, reason: "作者正文入口匹配" };
        },
      },
    },
  );
  try {
    const { copyId } = await f.add(false);
    const uid = f.app.repo.getAccount(f.account.id).uid!;
    f.app.db.run(
      "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at=?,share_id='own-share',share_url=?,share_owner_uid=?,share_verified_at=? WHERE id=?",
      JSON.stringify([
        {
          id: "own-file",
          name: "自主练习清单.pdf",
          parentId: "target-folder",
          isDirectory: false,
          size: 120,
        },
      ]),
      uid,
      new Date().toISOString(),
      "https://pan.quark.cn/s/own123",
      uid,
      new Date().toISOString(),
      copyId,
    );
    await f.app.secrets.set(`share:${copyId}`, "p9x2");
    const account = await f.app.websiteAccounts.add("jianshu", "简书集成测试");
    let draft = (await f.app.invoke("jianshu.create", {
      requestId: randomUUID(),
      copyId,
      accountId: account.id,
      sourceIds: [],
      template: "resource",
      title: "资料使用说明",
      body,
    })) as JianshuDetail;
    assert.match(draft.delivery.text, /https:\/\/pan.quark.cn\/s\/own123/);
    assert.match(draft.delivery.text, /p9x2/);
    assert.equal(draft.article.stage, "editing");
    draft = (await f.app.invoke("jianshu.importImages", {
      id: draft.article.id,
      revision: draft.article.revision,
    })) as JianshuDetail;
    assert.equal(draft.article.images.length, 1);
    const image = (await f.app.invoke("jianshu.image", {
      id: draft.article.id,
      revision: draft.article.revision,
      file: draft.article.images[0].file,
    })) as string;
    assert.match(image, /^data:image\/png;base64,/);
    await assert.rejects(
      f.app.invoke("jianshu.image", {
        id: draft.article.id,
        revision: draft.article.revision,
        file: "a".repeat(64) + ".png",
      }),
      /不包含/,
    );
    const savedImages = draft.article.images;
    draft = (await f.app.invoke(
      "jianshu.save",
      jianshuSaveSchema.parse({ ...draft.article, images: [] }),
    )) as JianshuDetail;
    assert.equal(draft.article.images.length, 0);
    assert.match(
      (await f.app.invoke("jianshu.image", {
        id: draft.article.id,
        revision: draft.article.revision,
        file: savedImages[0].file,
      })) as string,
      /^data:image\/png;base64,/,
    );
    draft = (await f.app.invoke(
      "jianshu.save",
      jianshuSaveSchema.parse({ ...draft.article, images: savedImages }),
    )) as JianshuDetail;
    await f.app.invoke("jianshu.copy", {
      id: draft.article.id,
      revision: draft.article.revision,
    });
    assert.match(copied[0].text, /p9x2/);
    assert.equal(copied[0].html.includes("<h1>资料使用说明</h1>"), false);
    const folder = (await f.app.invoke("jianshu.export", {
      id: draft.article.id,
      revision: draft.article.revision,
    })) as string;
    assert.match(await readFile(join(folder, "article.md"), "utf8"), /p9x2/);
    assert.deepEqual(
      await readFile(join(folder, "images", draft.article.images[0].file)),
      png,
    );
    draft = (await f.app.invoke("jianshu.prepare", {
      id: draft.article.id,
      revision: draft.article.revision,
    })) as JianshuDetail;
    assert.equal(preparations, 1);
    assert.equal(copied.length, 2);
    assert.equal(draft.article.stage, "prepared");
    assert.equal(draft.article.receiptUrl, null);
    assert.equal(f.app.jianshu.isBusy, false);
    assert.equal(
      JSON.stringify(
        f.app.db.setting(`jianshu:article:v1:${draft.article.id}`, null),
      ).includes("p9x2"),
      false,
    );
    const editorUrl =
      "https://www.jianshu.com/writer#/notebooks/57443510/notes/146614893";
    const pending = {
      editorUrl,
      filled: false,
      pendingImageSha256: draft.article.images[0].sha256,
      uploadedImages: 0,
      totalImages: 1,
      titleHash: "a".repeat(64),
      textHash: "b".repeat(64),
      uploadedImageRefs: [],
    };
    f.app.db.setSetting(`jianshu:article:v1:${draft.article.id}`, {
      ...draft.article,
      stage: "uncertain",
      editorUrl,
      preparedFill: pending,
    });
    const resolve = {
      id: draft.article.id,
      revision: draft.article.revision,
      notPublished: true,
    };
    const ordinary = (await f.app.invoke(
      "jianshu.resolve",
      resolve,
    )) as JianshuDetail;
    assert.equal(
      ordinary.article.preparedFill?.pendingImageSha256,
      pending.pendingImageSha256,
    );
    const recovered = (await f.app.invoke("jianshu.resolve", {
      ...resolve,
      imageNotUploaded: true,
    })) as JianshuDetail;
    assert.equal(
      recovered.article.preparedFill?.pendingImageSha256,
      null,
      "实际IPC schema必须透传显式图片确认",
    );
    assert.equal(recovered.article.editorUrl, editorUrl);
    assert.equal(recovered.article.preparedUid, draft.article.preparedUid);
    assert.equal(recovered.article.preparedFill?.textHash, pending.textHash);
    assert.equal(preparations, 1, "人工确认不会自动再次写入或上传");
    await assert.rejects(
      f.app.invoke("jianshu.resolve", { ...resolve, imageNotUploaded: true }),
      /没有待确认的图片/,
    );
  } finally {
    await f.cleanup();
    await rm(exportRoot, { recursive: true, force: true });
  }
});
test("new article IPC validates input and source-only draft does not need a cloud-drive account", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.app.invoke("jianshu.create", { requestId: "invalid" }),
      /UUID|uuid|Invalid/,
    );
    const input = {
      requestId: randomUUID(),
      title: "手动整理文章",
      body,
      sourceIds: [],
      template: "guide",
    };
    const first = (await f.app.invoke(
      "jianshu.create",
      input,
    )) as JianshuDetail;
    const second = (await f.app.invoke(
      "jianshu.create",
      input,
    )) as JianshuDetail;
    assert.equal(first.article.id, second.article.id);
    assert.equal(first.delivery.resourceUrl, null);
    assert.equal(first.delivery.text.includes("资料获取"), false);
    const list = (await f.app.invoke("jianshu.list")) as unknown[];
    assert.equal(list.length, 1);
    await assert.rejects(
      f.app.invoke("jianshu.copy", { id: first.article.id, revision: 2 }),
      /版本/,
    );
  } finally {
    await f.cleanup();
  }
});
