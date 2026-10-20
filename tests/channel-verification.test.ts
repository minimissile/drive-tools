import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture, removeV11 } from "./helpers";
import { Database } from "../core/database";
import { inspectBackup, stageRestore } from "../core/backups";
import { bindingEditorUrl, bindingVerificationState } from "../shared/channels";
import {
  deliveryCheckIsStale,
  type PublicationDeliveryCheck,
} from "../shared/publication-checks";
import type { BrowserBinding, Draft, Publication } from "../shared/types";

async function ready(platform = "wechat", format = "article") {
  const f = await fixture(),
    saved = await f.add();
  await f.app.queue.execute(saved.jobId);
  const draft = (await f.app.invoke("draft.manual", {
    copyId: saved.copyId,
    platform,
    contentFormat: format,
    template: true,
  })) as Draft;
  await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
  return { ...f, saved, draft };
}
const bindingInput = {
  platform: "wechat",
  alias: "验收账号",
  windowId: "qa-window",
  editorUrl: "https://mp.weixin.qq.com/",
  linkPermission: "allowed",
  ruleNote: "已在模拟指纹窗口核对本人账号文章正文配套资料的使用场景。",
  capabilities: { formats: ["article"], linkPositions: ["body"] },
  confirmCapabilities: true,
};
async function publish(f: Awaited<ReturnType<typeof ready>>) {
  const binding = (await f.app.invoke(
    "binding.save",
    bindingInput,
  )) as BrowserBinding;
  f.app.bit.open = async (b) => ({ opened: true, url: b.editorUrl });
  await f.app.invoke("publication.open", {
    draftId: f.draft.id,
    bindingId: binding.id,
  });
  await f.app.invoke("publication.mark", {
    draftId: f.draft.id,
    bindingId: binding.id,
    url: "https://mp.weixin.qq.com/s/qa-article",
    status: "published",
  });
  return {
    binding,
    publication: f.app
      .snapshot()
      .publications.find((p) => p.status === "published")!,
  };
}
const checkInput = (publication: Publication, overrides = {}) => ({
  publicationId: publication.id,
  status: "verified",
  position: "body",
  note: "从实际文章进入本人分享，配套文件一致且保存入口可以使用。",
  confirmed: true,
  ...overrides,
});

test("renaming a binding never renews an expired permission; changing the account window invalidates it until explicitly reconfirmed", async () => {
  const f = await ready();
  try {
    let b = (await f.app.invoke(
      "binding.save",
      bindingInput,
    )) as BrowserBinding;
    f.app.db.run(
      "UPDATE browser_bindings SET verified_at='2000-01-01T00:00:00.000Z' WHERE id=?",
      b.id,
    );
    b = f.app.repo.bindings()[0];
    const renamed = (await f.app.invoke("binding.save", {
      ...b,
      alias: "新别名",
      confirmCapabilities: false,
    })) as BrowserBinding;
    assert.equal(renamed.verifiedAt, b.verifiedAt);
    assert.equal(bindingVerificationState(renamed), "expired");
    await assert.rejects(f.app.contentPackage(f.draft.id, b.id, true), {
      code: "CHANNEL_LINK_BLOCKED",
    });
    const moved = (await f.app.invoke("binding.save", {
      ...renamed,
      windowId: "other-window",
      confirmCapabilities: false,
    })) as BrowserBinding;
    assert.equal(moved.verifiedAt, null);
    assert.equal(bindingVerificationState(moved), "pending");
    await assert.rejects(f.app.contentPackage(f.draft.id, b.id, false), {
      code: "CHANNEL_FORMAT_UNVERIFIED",
    });
    const confirmed = (await f.app.invoke("binding.save", {
      ...moved,
      confirmCapabilities: true,
    })) as BrowserBinding;
    assert.ok(confirmed.verifiedAt);
    assert.equal(bindingVerificationState(confirmed), "verified");
    assert.ok(
      (await f.app.contentPackage(f.draft.id, b.id, true)).includesOwnLink,
    );
  } finally {
    await f.cleanup();
  }
});

test("format-specific editor routes are validated, survive reload and are used by settings and publication navigation", async () => {
  const f = await ready("bilibili", "note");
  try {
    const b = (await f.app.invoke("binding.save", {
      ...bindingInput,
      platform: "bilibili",
      editorUrl: "https://member.bilibili.com/",
      linkPermission: "none",
      capabilities: {
        formats: ["note", "video-script"],
        linkPositions: [],
        editorUrls: {
          note: "https://member.bilibili.com/qa-note",
          "video-script": "https://member.bilibili.com/qa-video",
        },
      },
    })) as BrowserBinding;
    const opened: string[] = [];
    f.app.bit.open = async (input) => {
      opened.push(input.editorUrl);
      return { opened: true, url: input.editorUrl };
    };
    await f.app.invoke("publication.open", {
      draftId: f.draft.id,
      bindingId: b.id,
    });
    await f.app.invoke("binding.open", {
      id: b.id,
      contentFormat: "video-script",
    });
    assert.deepEqual(opened, [
      "https://member.bilibili.com/qa-note",
      "https://member.bilibili.com/qa-video",
    ]);
    assert.equal(bindingEditorUrl(f.app.repo.bindings()[0], "note"), opened[0]);
    await assert.rejects(
      f.app.invoke("binding.save", {
        ...b,
        capabilities: {
          ...b.capabilities,
          editorUrls: { note: "https://evil.example/write" },
        },
      }),
      { code: "INVALID_EDITOR_URL" },
    );
    await assert.rejects(
      f.app.invoke("binding.save", {
        ...b,
        capabilities: {
          ...b.capabilities,
          editorUrls: { longform: "https://member.bilibili.com/qa" },
        },
      }),
      { code: "CHANNEL_FORMAT_UNSUPPORTED" },
    );
    assert.equal(f.app.repo.bindings()[0].verifiedAt, b.verifiedAt);
    const changed = (await f.app.invoke("binding.save", {
      ...b,
      capabilities: {
        ...b.capabilities,
        editorUrls: { note: "https://member.bilibili.com/qa-note-updated" },
      },
      confirmCapabilities: false,
    })) as BrowserBinding;
    assert.equal(changed.verifiedAt, null);
    await assert.rejects(
      f.app.invoke("publication.open", {
        draftId: f.draft.id,
        bindingId: b.id,
      }),
      { code: "CHANNEL_FORMAT_UNVERIFIED" },
    );
  } finally {
    await f.cleanup();
  }
});

test("saving an unverified mapping does not imply verified account capabilities or remote access", async () => {
  const f = await ready();
  try {
    const b = (await f.app.invoke("binding.save", {
      ...bindingInput,
      confirmCapabilities: false,
    })) as BrowserBinding;
    assert.equal(b.verifiedAt, null);
    await assert.rejects(f.app.contentPackage(f.draft.id, b.id, false), {
      code: "CHANNEL_FORMAT_UNVERIFIED",
    });
    await assert.rejects(
      f.app.invoke("binding.save", {
        ...b,
        ruleNote: "",
        linkPermission: "none",
        confirmCapabilities: true,
      }),
      { code: "CHANNEL_RULE_REQUIRED" },
    );
    assert.equal(f.app.repo.calls().length, 0);
    assert.equal(f.app.snapshot().publications.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("manual delivery checks retain history separately from publication state, never call drive or platform APIs, and require an explicit confirmation", async () => {
  const f = await ready();
  try {
    const { publication } = await publish(f);
    assert.deepEqual(
      await f.app.invoke("publication.deliveryChecks", {
        publicationId: publication.id,
      }),
      [],
    );
    f.provider.identity = async () => {
      throw new Error("No remote account requests in a manual check");
    };
    f.provider.verifyShare = async () => {
      throw new Error("No remote share requests in a manual check");
    };
    await assert.rejects(
      f.app.invoke(
        "publication.deliveryCheck",
        checkInput(publication, { confirmed: false }),
      ),
    );
    const first = (await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication),
    )) as PublicationDeliveryCheck;
    assert.equal(first.shareUrl, f.provider.ownUrl);
    assert.equal(first.source, "manual");
    assert.equal(
      deliveryCheckIsStale(first, first.shareUrl, first.shareVersion),
      false,
    );
    assert.equal(
      deliveryCheckIsStale(first, first.shareUrl, first.shareVersion, {
        ready: false,
        ownerUid: first.ownerUid,
      }),
      true,
    );
    assert.equal(
      deliveryCheckIsStale(first, first.shareUrl, first.shareVersion, {
        ready: true,
        ownerUid: "changed-owner",
      }),
      true,
    );
    await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication, {
        status: "failed",
        note: "再次从文章打开资源入口，发现提取页面报错，暂时无法保存。",
      }),
    );
    await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication, {
        status: "not_provided",
        position: null,
        note: "核对文章后发现尚未实际挂载任何配套资料获取入口。",
      }),
    );
    const history = (await f.app.invoke("publication.deliveryChecks", {
      publicationId: publication.id,
    })) as PublicationDeliveryCheck[];
    assert.deepEqual(
      history.map((h) => h.status),
      ["not_provided", "failed", "verified"],
    );
    assert.equal(
      f.app.snapshot().publications.find((p) => p.id === publication.id)
        ?.status,
      "published",
    );
    assert.equal(f.app.repo.calls().length, 0);
    assert.equal(f.provider.shares, 1);
    const reopened = new Database(f.app.db.path);
    assert.equal(
      reopened.get<{ n: number }>(
        "SELECT COUNT(*) n FROM publication_delivery_checks",
      )!.n,
      3,
    );
    reopened.close();
  } finally {
    await f.cleanup();
  }
});

test("unpublished articles, stale shares, wrong owner and expired placement permissions cannot become verified resource delivery", async () => {
  const f = await ready();
  try {
    const { publication, binding } = await publish(f);
    const opened = f.app
      .snapshot()
      .publications.find((p) => p.status === "opened")!;
    await assert.rejects(
      f.app.invoke("publication.deliveryCheck", checkInput(opened)),
      { code: "PUBLICATION_NOT_PUBLISHED" },
    );
    await assert.rejects(
      f.app.invoke(
        "publication.deliveryCheck",
        checkInput(publication, { position: "description" }),
      ),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
    f.app.db.run(
      "UPDATE browser_bindings SET verified_at='2000-01-01' WHERE id=?",
      binding.id,
    );
    await assert.rejects(
      f.app.invoke("publication.deliveryCheck", checkInput(publication)),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
    f.app.db.run(
      "UPDATE browser_bindings SET verified_at=? WHERE id=?",
      new Date().toISOString(),
      binding.id,
    );
    const original = (await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication),
    )) as PublicationDeliveryCheck;
    f.app.db.run(
      "UPDATE copies SET share_version=share_version+1,share_url='https://pan.quark.cn/s/replaced' WHERE id=?",
      f.saved.copyId,
    );
    assert.equal(
      deliveryCheckIsStale(
        original,
        "https://pan.quark.cn/s/replaced",
        original.shareVersion + 1,
      ),
      true,
    );
    await assert.rejects(
      f.app.invoke("publication.deliveryCheck", checkInput(publication)),
      { code: "STALE_PUBLICATION_SHARE" },
    );
    await f.app.invoke("draft.review", { id: f.draft.id, reviewed: true });
    await assert.rejects(
      f.app.invoke("publication.deliveryCheck", checkInput(publication)),
      { code: "STALE_PUBLICATION_SHARE" },
    );
    f.app.db.run(
      "UPDATE accounts SET uid='different-user' WHERE id=?",
      f.account.id,
    );
    await assert.rejects(
      f.app.invoke("publication.deliveryCheck", checkInput(publication)),
      { code: "OWNERSHIP_UNVERIFIED" },
    );
    await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication, {
        status: "failed",
        note: "原本人分享已更新，文章中的旧入口暂时无法获取对应资料。",
      }),
    );
    assert.equal(f.app.repo.deliveryChecks(publication.id)[0].status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("v10 migration backs up once and preserves existing channel configuration before adding delivery evidence", async () => {
  const f = await ready();
  try {
    const path = join(f.dir, "legacy.db");
    f.app.db.run("VACUUM INTO ?", path);
    const old = new DatabaseSync(path);
    old.exec(removeV11 + "PRAGMA user_version=10;");
    old.close();
    const migrated = new Database(path);
    assert.equal(
      migrated.get<{ user_version: number }>("PRAGMA user_version")!
        .user_version,
      14,
    );
    assert.equal(
      migrated.get<{ id: string }>(
        "SELECT id FROM drafts WHERE id=?",
        f.draft.id,
      )!.id,
      f.draft.id,
    );
    migrated.close();
    new Database(path).close();
    const backups = (await readdir(f.dir)).filter((n) =>
      n.startsWith("legacy.db.before-v11-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(f.dir, backups[0]))).mode & 0o777, 0o600);
  } finally {
    await f.cleanup();
  }
});

test("backup and staged restore retain delivery evidence without credentials or a fabricated automatic verification", async () => {
  const f = await ready();
  try {
    const { publication } = await publish(f);
    const record = (await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication),
    )) as PublicationDeliveryCheck;
    f.ports.chooseDirectory = async () => f.dir;
    const folder = (await f.app.invoke("system.backup")) as string;
    const manifest = JSON.parse(
      await readFile(join(folder, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 14);
    const raw = new DatabaseSync(join(folder, "panxu.db"), { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM secrets").get()!.n, 0);
    const stored = JSON.parse(
      String(
        raw
          .prepare("SELECT data FROM publication_delivery_checks WHERE id=?")
          .get(record.id)!.data,
      ),
    );
    assert.equal(stored.source, "manual");
    assert.equal(stored.publicationId, publication.id);
    assert.equal(stored.shareUrl, record.shareUrl);
    raw.close();
    const preview = await inspectBackup(folder);
    const restored = await stageRestore(folder, f.dir, preview.databaseSha256);
    const restoredDb = new Database(join(restored.dataPath, "panxu.db"));
    try {
      const row = restoredDb.get<{ data: string }>(
        "SELECT data FROM publication_delivery_checks WHERE id=?",
        record.id,
      )!;
      assert.equal(JSON.parse(row.data).source, "manual");
      assert.equal(
        restoredDb.get<{ verified_at: string | null }>(
          "SELECT verified_at FROM browser_bindings",
        )!.verified_at,
        null,
      );
      assert.equal(
        restoredDb.get<{ n: number }>("SELECT COUNT(*) n FROM secrets")!.n,
        0,
      );
    } finally {
      restoredDb.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("split-resource delivery records keep the child share snapshot independently of the parent share", async () => {
  const f = await ready();
  try {
    const time = new Date().toISOString(),
      itemId = "qa-child-item";
    f.app.db.run(
      "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth,status,share_id,share_url,owner_uid,verified_at,share_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      itemId,
      f.saved.copyId,
      "own-file",
      JSON.stringify(f.app.repo.getCopy(f.saved.copyId).files[0]),
      "[]",
      "/练习资料/子资料.pdf",
      1,
      "ready",
      "child-share",
      "https://pan.quark.cn/s/child123",
      f.provider.uid,
      time,
      3,
    );
    f.app.db.run(
      "UPDATE drafts SET split_item_id=?,split_share_version=3 WHERE id=?",
      itemId,
      f.draft.id,
    );
    const binding = (await f.app.invoke(
      "binding.save",
      bindingInput,
    )) as BrowserBinding;
    f.app.db.run(
      "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,created_at) VALUES('child-open',?,?,?,'opened',?)",
      f.draft.id,
      f.draft.version,
      binding.id,
      time,
    );
    await f.app.invoke("publication.mark", {
      draftId: f.draft.id,
      bindingId: binding.id,
      url: "https://mp.weixin.qq.com/s/child-article",
      status: "published",
    });
    const publication = f.app
      .snapshot()
      .publications.find((p) => p.status === "published")!;
    const checked = (await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication),
    )) as PublicationDeliveryCheck;
    assert.equal(checked.splitItemId, itemId);
    assert.equal(checked.shareUrl, "https://pan.quark.cn/s/child123");
    assert.equal(checked.shareVersion, 3);
    f.app.db.run(
      "UPDATE copies SET share_version=share_version+1,share_url='https://pan.quark.cn/s/parent-replaced' WHERE id=?",
      f.saved.copyId,
    );
    assert.equal(
      (
        (await f.app.invoke(
          "publication.deliveryCheck",
          checkInput(publication),
        )) as PublicationDeliveryCheck
      ).shareUrl,
      checked.shareUrl,
    );
    f.app.db.run(
      "UPDATE split_items SET share_version=4,share_url='https://pan.quark.cn/s/child-replaced' WHERE id=?",
      itemId,
    );
    await f.app.invoke("draft.review", { id: f.draft.id, reviewed: true });
    await assert.rejects(
      f.app.invoke("publication.deliveryCheck", checkInput(publication)),
      { code: "STALE_PUBLICATION_SHARE" },
    );
    f.app.db.run(
      "UPDATE split_items SET share_url=NULL,status='failed' WHERE id=?",
      itemId,
    );
    const failed = (await f.app.invoke(
      "publication.deliveryCheck",
      checkInput(publication, {
        status: "failed",
        note: "子资料分享已失效且缺少入口，不能使用父资料链接代替。",
      }),
    )) as PublicationDeliveryCheck;
    assert.equal(failed.shareUrl, null);
    assert.equal(failed.shareVersion, 4);
    assert.equal(f.provider.shares, 1);
  } finally {
    await f.cleanup();
  }
});
