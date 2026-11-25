import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import type { IpcValue } from "../shared/ipc";

const url = "https://pan.baidu.com/s/1dq1PRd0IzjcLtjiHCe8Ibg";

async function savedBaidu() {
  const f = await fixture();
  const saved = await f.add(false);
  const uid = f.app.repo.getAccount(f.account.id).uid;
  f.app.db.run("UPDATE accounts SET provider='baidu' WHERE id=?", f.account.id);
  f.app.db.run(
    "UPDATE resources SET provider='baidu',source_url='https://pan.baidu.com/s/1source' WHERE id=?",
    saved.resourceId,
  );
  f.app.db.run(
    "UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-25',files=?,share_id='own-share',share_url=?,share_owner_uid=?,share_verified_at='2026-11-25' WHERE id=?",
    uid,
    JSON.stringify([file]),
    url,
    uid,
    saved.copyId,
  );
  await f.app.secrets.set(`share:${saved.copyId}`, "8002");
  return { ...f, ...saved };
}

test("复制百度链接将本地提取码放入pwd参数，整个操作不访问网盘", async () => {
  const f = await savedBaidu();
  let remoteCalls = 0;
  f.provider.identity = f.provider.verifyShare = async () => {
    remoteCalls++;
    throw Error("离线");
  };
  try {
    const before = f.app.repo.getCopy(f.copyId);
    const result = (await f.app.invoke("copy.link", {
      copyId: f.copyId,
    })) as IpcValue<"copy.link">;
    assert.equal(result.text, `${url}?pwd=8002`);
    assert(!result.text.includes("\n"));
    assert.equal(remoteCalls, 0);
    assert.deepEqual(f.app.repo.getCopy(f.copyId), before);
    assert.equal(
      f.app.db.get(
        "SELECT copy_id FROM share_checks WHERE copy_id=?",
        f.copyId,
      ),
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});

test("分享曾被标记失效、登录过期或未做文件核验时仍可复制已有地址，不改写检查状态", async () => {
  const f = await savedBaidu();
  try {
    f.provider.verifyShare = async () => {
      throw Error("复制不应调用");
    };
    f.app.db.run(
      "UPDATE accounts SET status='expired' WHERE id=?",
      f.account.id,
    );
    f.app.db.run(
      "UPDATE copies SET verified_at=NULL,share_verified_at=NULL,files='[]' WHERE id=?",
      f.copyId,
    );
    f.app.db.run(
      "INSERT INTO share_checks(copy_id,status,checked_at,message) VALUES(?,'invalid','2026-11-25','已有检查结果')",
      f.copyId,
    );
    assert.deepEqual(await f.app.invoke("copy.link", { copyId: f.copyId }), {
      text: `${url}?pwd=8002`,
    });
    assert.equal(
      f.app.db.get<{ status: string }>(
        "SELECT status FROM share_checks WHERE copy_id=?",
        f.copyId,
      )?.status,
      "invalid",
    );
    assert.equal(f.app.repo.getCopy(f.copyId).shareVerifiedAt, null);
  } finally {
    await f.cleanup();
  }
});

test("无提取码不添加空pwd，旧链接内已有提取码可直接保留，本地码优先", async () => {
  const f = await savedBaidu();
  try {
    f.app.secrets.remove(`share:${f.copyId}`);
    assert.deepEqual(await f.app.invoke("copy.link", { copyId: f.copyId }), {
      text: url,
    });
    f.app.db.run(
      "UPDATE copies SET share_url=? WHERE id=?",
      `${url}?pwd=Ab12&from=old`,
      f.copyId,
    );
    assert.deepEqual(await f.app.invoke("copy.link", { copyId: f.copyId }), {
      text: `${url}?pwd=Ab12`,
    });
    await f.app.secrets.set(`share:${f.copyId}`, "8002");
    assert.deepEqual(await f.app.invoke("copy.link", { copyId: f.copyId }), {
      text: `${url}?pwd=8002`,
    });
  } finally {
    await f.cleanup();
  }
});

test("直接入库的自有分享无需核验即可复制；缺少分享与错盘链接仍报告本地资料错误", async () => {
  const f = await savedBaidu();
  try {
    f.app.db.run(
      "UPDATE resources SET source_kind='owned',source_url=? WHERE id=?",
      url,
      f.resourceId,
    );
    f.app.db.run(
      "UPDATE copies SET status='recorded',files='[]',verified_at=NULL,share_verified_at=NULL WHERE id=?",
      f.copyId,
    );
    assert.deepEqual(await f.app.invoke("copy.link", { copyId: f.copyId }), {
      text: `${url}?pwd=8002`,
    });
    f.app.db.run("UPDATE copies SET share_url=NULL WHERE id=?", f.copyId);
    await assert.rejects(f.app.invoke("copy.link", { copyId: f.copyId }), {
      code: "SHARE_NOT_READY",
    });
    f.app.db.run(
      "UPDATE copies SET share_url='https://pan.quark.cn/s/own' WHERE id=?",
      f.copyId,
    );
    await assert.rejects(f.app.invoke("copy.link", { copyId: f.copyId }), {
      code: "INVALID_LINK",
    });
    f.app.db.run("UPDATE copies SET share_url=? WHERE id=?", url, f.copyId);
    f.app.db.run(
      "UPDATE resources SET source_kind='share' WHERE id=?",
      f.resourceId,
    );
    await assert.rejects(f.app.invoke("copy.link", { copyId: f.copyId }), {
      code: "FOREIGN_SHARE_BLOCKED",
    });
  } finally {
    await f.cleanup();
  }
});

test("其他网盘保留原复制格式，也不联网预检", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false);
    f.app.db.run(
      "UPDATE copies SET share_url='https://pan.quark.cn/s/own123' WHERE id=?",
      saved.copyId,
    );
    await f.app.secrets.set(`share:${saved.copyId}`, "AB12");
    f.provider.verifyShare = async () => {
      throw Error("不应调用");
    };
    assert.deepEqual(
      await f.app.invoke("copy.link", { copyId: saved.copyId }),
      { text: "https://pan.quark.cn/s/own123\n提取码：AB12" },
    );
  } finally {
    await f.cleanup();
  }
});

test("百度导出仍显式核验，链接列和提取码列保持分离", async () => {
  const f = await savedBaidu();
  let checks = 0,
    loaded: { url: string; code: string | null } | undefined;
  try {
    f.provider.verifyShare = async () => {
      checks++;
      return true;
    };
    f.app.resourceExports.file = async (
      _run,
      _ids,
      _columns,
      _format,
      ownShare,
    ) => {
      loaded = await ownShare(f.copyId);
      return { name: "资源.csv", bytes: Buffer.from("fixture") };
    };
    await f.app.invoke("resourceExport.file", {
      runId: "run",
      ids: [f.resourceId],
      columns: [],
      format: "csv",
    });
    assert.equal(checks, 1);
    assert.deepEqual(loaded, { url, code: "8002" });
    f.provider.verifyShare = async () => false;
    await assert.rejects(
      f.app.invoke("resourceExport.file", {
        runId: "run",
        ids: [f.resourceId],
        columns: [],
        format: "csv",
      }),
      { code: "SHARE_INVALID" },
    );
  } finally {
    await f.cleanup();
  }
});
