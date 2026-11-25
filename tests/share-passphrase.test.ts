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

test("建链回执自动加密保存独立口令，重复提交同一操作不重新建链且不覆盖原分享", async () => {
  const f = await prepared("baidu");
  try {
    f.provider.actual = [file];
    const phrase = "@@囟梨霹稀勺轩且诈竌千#";
    let creates = 0;
    (f.provider as DriveProvider).createShareWithOptions = async (
      _a,
      _files,
      _title,
      options,
      onCreated,
    ) => {
      creates++;
      const share = {
        id: "new-with-command",
        url: "https://pan.baidu.com/s/1new",
        code: options.extractionCode!,
        ownerUid: f.provider.uid,
        passphrase: phrase,
      };
      await onCreated?.(share);
      return share;
    };
    const input = {
      ...f.target,
      operationId: randomUUID(),
      expiresInDays: 0,
      extractionCode: "8002",
    };
    const receipt = await f.app.shareCreation.createIndependent(input);
    assert.equal(receipt.state, "success");
    const target = { ...f.target, operationId: input.operationId };
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", target), {
      text: phrase,
    });
    assert.equal(await f.app.invoke("share.passphrase", f.target), null);
    assert.equal(f.app.repo.getCopy(f.saved.copyId).shareUrl, f.url);
    await f.app.shareCreation.createIndependent(input);
    assert.equal(creates, 1);
    const record = f.app.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key=?",
      `share-creation:${input.operationId}`,
    )!;
    assert(!record.value.includes(phrase), "公开操作凭据中没有口令明文");
    const encrypted = f.app.db.get<{ value: string }>(
      "SELECT value FROM secrets WHERE key=?",
      `share-passphrase:creation:${input.operationId}`,
    )!;
    assert(!encrypted.value.includes(phrase));
  } finally {
    await f.cleanup();
  }
});

test("资源补建分享自动保存口令；缺少口令仍保存链接，不制造中文口令或重复建链", async () => {
  for (const passphrase of ["@@囟梨霹稀勺轩且诈竌千#", undefined]) {
    const f = await prepared("baidu");
    try {
      f.app.db.run(
        "UPDATE copies SET folder_id='0' WHERE id=?",
        f.saved.copyId,
      );
      f.provider.actual = [file];
      f.provider.findOwnShare = async () => null;
      let creates = 0;
      f.provider.createShare = async () => {
        creates++;
        return {
          id: "new-own",
          url: "https://pan.baidu.com/s/1new",
          code: "8002",
          ownerUid: f.provider.uid,
          passphrase,
        };
      };
      await f.app.invoke("copy.createShare", f.target);
      assert.equal(creates, 1);
      assert.equal(
        f.app.repo.getCopy(f.saved.copyId).shareUrl,
        "https://pan.baidu.com/s/1new",
      );
      const saved = (await f.app.invoke(
        "share.passphrase",
        f.target,
      )) as IpcValue<"share.passphrase">;
      assert.equal(saved?.text, passphrase);
      if (passphrase) {
        f.provider.identity = async () => assert.fail("复制口令不访问网盘");
        assert.deepEqual(await f.app.invoke("share.copyPassphrase", f.target), {
          text: passphrase,
        });
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("转存归档自动保存平台口令，重复执行已完成任务不重复转存或建链", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    const phrase = "祄五低诶及并词玄符一已汢";
    const original = f.provider.createShare.bind(f.provider);
    f.provider.createShare = async (...args) => ({
      ...(await original(...args)),
      passphrase: phrase,
    });
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
    assert.deepEqual(
      await f.app.invoke("share.copyPassphrase", { copyId: saved.copyId }),
      { text: phrase },
    );
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.provider.shares, 1);
    assert.equal(f.provider.transfers, 1);
  } finally {
    await f.cleanup();
  }
});

test("自动保存口令失败保留已返回链接与操作凭据，同一操作不会重建分享", async () => {
  const f = await prepared("baidu");
  try {
    f.provider.actual = [file];
    const phrase = "@@囟梨霹稀勺轩且诈竌千#";
    const encrypt = f.codec.encrypt;
    f.codec.encrypt = async (value) => {
      if (value.includes(phrase)) throw Error("fixture secure storage failure");
      return encrypt(value);
    };
    let creates = 0;
    (f.provider as DriveProvider).createShareWithOptions = async (
      _a,
      _files,
      _t,
      options,
      onCreated,
    ) => {
      creates++;
      const share = {
        id: "returned",
        url: "https://pan.baidu.com/s/1returned",
        ownerUid: f.provider.uid,
        code: options.extractionCode!,
        passphrase: phrase,
      };
      await onCreated?.(share);
      return share;
    };
    const input = {
      ...f.target,
      operationId: randomUUID(),
      expiresInDays: 0,
      extractionCode: "8002",
    };
    const receipt = await f.app.shareCreation.createIndependent(input);
    assert.equal(receipt.state, "uncertain");
    assert.equal(receipt.url, "https://pan.baidu.com/s/1returned");
    assert.match(receipt.message, /中文口令未能保存/);
    await f.app.shareCreation.createIndependent(input);
    assert.equal(creates, 1);
    assert.equal(f.app.repo.getCopy(f.saved.copyId).shareUrl, f.url);
  } finally {
    await f.cleanup();
  }
});

test("已有夸克分享直接获取并加密保存口令，不验证文件、不重复创建分享，复制保持离线", async () => {
  const f = await prepared();
  try {
    let fetched = 0;
    (f.provider as DriveProvider).readSharePassphrase = async (_a, share) => {
      fetched++;
      assert.equal(share.url, f.url);
      return chinese;
    };
    f.provider.createShare = async () => assert.fail("获取口令不得建分享");
    f.provider.verifyShare = async () => assert.fail("获取口令不检查文件清单");
    await f.app.invoke("share.fetchPassphrase", f.target);
    assert.equal(fetched, 1);
    assert.deepEqual(await f.app.invoke("share.copyPassphrase", f.target), {
      text: chinese,
    });
    assert.equal(fetched, 1);
  } finally {
    await f.cleanup();
  }
});

test("获取口令期间原分享变化，不将旧请求的口令绑定到新分享", async () => {
  const f = await prepared();
  try {
    let release!: () => void;
    (f.provider as DriveProvider).readSharePassphrase = () =>
      new Promise((resolve) => {
        release = () => resolve(chinese);
      });
    const fetching = f.app.invoke("share.fetchPassphrase", f.target);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    f.app.db.run(
      "UPDATE copies SET share_id='changed',share_url='https://pan.quark.cn/s/changed' WHERE id=?",
      f.saved.copyId,
    );
    release();
    await assert.rejects(fetching, { code: "SHARE_CHANGED" });
    assert.equal(await f.app.invoke("share.passphrase", f.target), null);
  } finally {
    await f.cleanup();
  }
});
