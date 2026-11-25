import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, file } from "./helpers";
import type { DriveProvider } from "../core/providers/provider";
import { SecretStore } from "../core/secrets";
import { readSharePassphrase } from "../core/share-passphrases";
import { removeResourceRecords } from "../core/resource-records";
import type { IpcValue } from "../shared/ipc";

const chinese = "祄五低诶及并词玄符一已汢";
const quarkUrl = "https://pan.quark.cn/s/259effdd6c9a";
const quarkText = `我用夸克网盘给你分享了「2024年Flu...(完结)」，点击链接或复制整段内容，打开「夸克APP」即可获取。\n${chinese}\n/~720e3cXFG4~:/\n链接：${quarkUrl}`;
async function prepared(provider: "baidu" | "quark" = "quark") {
  const f = await fixture();
  const saved = await f.add(false);
  const url =
    provider === "quark" ? quarkUrl : "https://pan.baidu.com/s/1owned";
  f.app.db.run(
    "UPDATE accounts SET provider=? WHERE id=?",
    provider,
    f.account.id,
  );
  f.app.db.run(
    "UPDATE resources SET provider=? WHERE id=?",
    provider,
    saved.resourceId,
  );
  f.app.db.run(
    "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at='2026-11-25',share_id='own-id',share_url=?,share_owner_uid=?,share_verified_at='2026-11-25' WHERE id=?",
    JSON.stringify([file]),
    f.provider.uid,
    url,
    f.provider.uid,
    saved.copyId,
  );
  await f.app.secrets.set(
    `share:${saved.copyId}`,
    provider === "baidu" ? "8002" : "",
  );
  return { ...f, saved, url, target: { copyId: saved.copyId } };
}

test("官方示例：保存完整夸克分享，加密落盘；单独复制只返回原样中文口令，无远端调用", async () => {
  const f = await prepared();
  try {
    f.provider.identity = f.provider.verifyShare = async () =>
      assert.fail("保存/复制不访问网盘");
    const value = (await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: quarkText,
    })) as IpcValue<"share.savePassphrase">;
    assert.equal(value.text, chinese);
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", f.target), {
      text: chinese,
    });
    const key = `share-passphrase:copy:${f.saved.copyId}`;
    const raw = f.app.db.get<{ value: string }>(
      "SELECT value FROM secrets WHERE key=?",
      key,
    )!;
    assert(!raw.value.includes(chinese));
    const original = JSON.parse((await f.app.secrets.get(key))!);
    assert.equal(
      original.original,
      quarkText,
      "短串、中文和完整原文均保留在加密记录中",
    );
    const reloaded = new SecretStore(f.app.db, f.codec);
    assert.equal(
      (
        await readSharePassphrase(reloaded, {
          key,
          provider: "quark",
          accountId: f.account.id,
          ownerUid: f.provider.uid,
          shareId: "own-id",
          url: f.url,
          code: "",
        })
      )?.text,
      chinese,
    );
    f.app.db.run(
      "UPDATE accounts SET status='expired' WHERE id=?",
      f.account.id,
    );
    assert.deepEqual(
      await f.app.invoke("share.copyPassphrase", f.target),
      { text: chinese },
      "登录过期仍可复制本地口令",
    );
  } finally {
    await f.cleanup();
  }
});

test("百度 App 标记符原样保留，口令与数字提取码分别保存", async () => {
  const f = await prepared("baidu");
  try {
    // Synthetic Baidu fixture: exercises delimiter preservation, not App recognition.
    const phrase = "@@分享内容中文口令#";
    await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: `通过百度网盘分享的文件：学习清单\n${phrase}\n链接：${f.url}?pwd=8002`,
    });
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", f.target), {
      text: phrase,
    });
    assert.equal(await f.app.secrets.get(`share:${f.saved.copyId}`), "8002");
    assert.deepEqual(await f.app.invoke("copy.link", f.target), {
      text: `${f.url}?pwd=8002`,
    });
  } finally {
    await f.cleanup();
  }
});

test("拒绝其他分享、错误提取码、纯链接或无法区分的多条中文口令，不覆盖原口令", async () => {
  const f = await prepared();
  try {
    await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: quarkText,
    });
    for (const text of [
      quarkText.replace(quarkUrl, "https://pan.quark.cn/s/foreign"),
      quarkText.replace(quarkUrl, `${quarkUrl}?pwd=wrong`),
      quarkUrl,
      `${quarkText}\n另一段中文口令`,
    ])
      await assert.rejects(() =>
        f.app.invoke("share.savePassphrase", { ...f.target, text }),
      );
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", f.target), {
      text: chinese,
    });
  } finally {
    await f.cleanup();
  }
});

test("分享 ID、地址、提取码任一变化即不再返回旧口令；账号变更拒绝读取", async () => {
  const f = await prepared();
  try {
    await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: quarkText,
    });
    for (const [column, value] of [
      ["share_id", "new-id"],
      ["share_url", "https://pan.quark.cn/s/new"],
    ]) {
      f.app.db.run(
        `UPDATE copies SET ${column}=? WHERE id=?`,
        value,
        f.saved.copyId,
      );
      assert.equal(await f.app.invoke("share.passphrase", f.target), null);
      await assert.rejects(
        () => f.app.invoke("share.copyPassphrase", f.target),
        { code: "PASSPHRASE_NOT_SAVED" },
      );
      f.app.db.run(
        "UPDATE copies SET share_id='own-id',share_url=? WHERE id=?",
        f.url,
        f.saved.copyId,
      );
    }
    await f.app.secrets.set(`share:${f.saved.copyId}`, "1234");
    assert.equal(await f.app.invoke("share.passphrase", f.target), null);
    f.app.db.run(
      "UPDATE accounts SET uid='different' WHERE id=?",
      f.account.id,
    );
    await assert.rejects(() => f.app.invoke("share.copyPassphrase", f.target), {
      code: "ACCOUNT_UID_MISMATCH",
    });
  } finally {
    await f.cleanup();
  }
});

test("独立分享口令按操作保存，重复读取、跨副本误读不串改原分享", async () => {
  const f = await prepared();
  try {
    await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: quarkText,
    });
    (f.provider as DriveProvider).createShareWithOptions = async (
      _a,
      _files,
      _title,
      options,
    ) => ({
      id: "independent",
      url: "https://pan.quark.cn/s/independent",
      ownerUid: f.provider.uid,
      code: options.extractionCode!,
    });
    const operationId = randomUUID();
    const receipt = await f.app.shareCreation.createIndependent({
      ...f.target,
      operationId,
      expiresInDays: 0,
      extractionCode: "8002",
    });
    assert.equal(receipt.state, "success");
    const target = { ...f.target, operationId };
    const phrase = "独立分享中文口令";
    await f.app.invoke("share.savePassphrase", {
      ...target,
      text: `${phrase}\nhttps://pan.quark.cn/s/independent?pwd=8002`,
    });
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", target), {
      text: phrase,
    });
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", f.target), {
      text: chinese,
    });
    const other = await f.add(false, {
      title: "另一份资源",
      sourceText: "https://pan.quark.cn/s/another-source",
    });
    await assert.rejects(
      () =>
        f.app.invoke("share.passphrase", { copyId: other.copyId, operationId }),
      { code: "NOT_FOUND" },
    );
    assert.equal(f.app.repo.getCopy(f.saved.copyId).shareUrl, f.url);
  } finally {
    await f.cleanup();
  }
});

test("系统加密失败不报告保存成功，既有分享链接保留", async () => {
  const f = await prepared();
  try {
    f.codec.available = () => false;
    await assert.rejects(
      () =>
        f.app.invoke("share.savePassphrase", { ...f.target, text: quarkText }),
      { code: "ENCRYPTION_UNAVAILABLE" },
    );
    assert.equal(f.app.repo.getCopy(f.saved.copyId).shareUrl, f.url);
    assert.equal(
      f.app.db.get(
        "SELECT key FROM secrets WHERE key=?",
        `share-passphrase:copy:${f.saved.copyId}`,
      ),
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});

test("删除资源同时移除对应口令密文，其他资源的口令保留", async () => {
  const f = await prepared();
  try {
    await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: quarkText,
    });
    const operationId = randomUUID();
    f.app.db.setSetting(`share-creation:${operationId}`, {
      receipt: { copyId: f.saved.copyId },
    });
    await f.app.secrets.set(
      `share-passphrase:creation:${operationId}`,
      "独立口令密文内容",
    );
    await f.app.secrets.set("share-passphrase:copy:unrelated", "另一资源口令");
    f.app.db.transaction(() =>
      removeResourceRecords(
        f.app.db,
        f.app.repo.getResource(f.saved.resourceId),
      ),
    );
    assert.equal(
      f.app.secrets.has(`share-passphrase:copy:${f.saved.copyId}`),
      false,
    );
    assert.equal(
      f.app.secrets.has(`share-passphrase:creation:${operationId}`),
      false,
    );
    assert.equal(
      await f.app.secrets.get("share-passphrase:copy:unrelated"),
      "另一资源口令",
    );
  } finally {
    await f.cleanup();
  }
});

test("异步解密期间分享变化时拒绝复制旧口令", async () => {
  const f = await prepared();
  try {
    await f.app.invoke("share.savePassphrase", {
      ...f.target,
      text: quarkText,
    });
    const get = f.app.secrets.get.bind(f.app.secrets);
    f.app.secrets.get = async (key) => {
      const value = await get(key);
      if (key === `share-passphrase:copy:${f.saved.copyId}`)
        f.app.db.run(
          "UPDATE copies SET share_id='replacement' WHERE id=?",
          f.saved.copyId,
        );
      return value;
    };
    await assert.rejects(() => f.app.invoke("share.copyPassphrase", f.target), {
      code: "SHARE_CHANGED",
    });
  } finally {
    await f.cleanup();
  }
});
