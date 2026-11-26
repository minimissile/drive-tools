import test from "node:test";
import assert from "node:assert/strict";
import { Database, now } from "../core/database";
import { DriveSync } from "../core/drive-sync";
import type { Account, RemoteFile } from "../shared/types";
import type { DriveProvider } from "../core/providers/provider";
import type { DriveListPage } from "../shared/drive-sync";
import { AppError } from "../core/errors";
import { createDriveSyncHandlers } from "../core/ipc/drive-sync";
import { ownedFileSource } from "../shared/owned-file-source";

function file(id: string, name = id, dir = false): RemoteFile {
  return { id, name, isDirectory: dir, size: dir ? null : 123, parentId: "0" };
}
function harness(
  read: (id: string, cursor: string) => Promise<DriveListPage> | DriveListPage,
) {
  const db = new Database(":memory:"),
    account = {
      id: "a",
      provider: "quark",
      alias: "本人",
      uid: "u",
      enabled: true,
      status: "connected",
    } as Account;
  db.run(
    "INSERT INTO accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES('a','quark','本人','u','connected',?,?)",
    now(),
    now(),
  );
  let environment = "native:a",
    changes = 0;
  const calls: { id: string; cursor: string }[] = [];
  const provider = {
    listPage: async (_: Account, id: string, cursor = "") => {
      calls.push({ id, cursor });
      return read(id, cursor);
    },
    list: async (_: Account, id: string) => (await read(id, "")).files,
  } as DriveProvider;
  const deps = {
    db,
    account: () => account,
    supported: () => true,
    environment: () => environment,
    withAccount: async <T>(
      _: string,
      action: (a: Account, p: DriveProvider) => Promise<T>,
    ) => action(account, provider),
    changed: () => {
      changes++;
    },
    intervalMs: 0,
  };
  const sync = new DriveSync(deps);
  return {
    db,
    account,
    sync,
    calls,
    deps,
    provider,
    setEnvironment: (v: string) => {
      environment = v;
    },
    close: () => {
      sync.close();
      db.close();
    },
  };
}

test("递归分页保存、全盘搜索与重复同步幂等，不调用任何写入接口", async () => {
  const h = harness((id, cursor) =>
    id === "0"
      ? cursor
        ? { files: [file("b", "同名.pdf")], next: null }
        : {
            files: [file("folder", "资料", true), file("a", "同名.pdf")],
            next: "2",
          }
      : { files: [file("child", "练习.pdf")], next: null },
  );
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "completed");
    assert.deepEqual(
      h.calls.map((c) => c.id),
      ["0", "0", "folder"],
    );
    const root = h.sync.index({ accountId: "a" });
    assert.equal(root.total, 3);
    assert.equal(h.sync.current("a")?.files, 3);
    const nested = h.sync.index({ accountId: "a", parentId: "folder" });
    assert.equal(nested.items[0].path, "/资料/练习.pdf");
    assert.deepEqual(nested.breadcrumbs, [{ id: "folder", name: "资料" }]);
    assert.equal(h.sync.index({ accountId: "a", search: "同名" }).total, 2);
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM drive_index_entries")!.n,
      4,
    );
    assert.ok(root.lastCompleteAt);
  } finally {
    h.close();
  }
});

test("部分失败不标记历史记录消失，重试仅扫描失败目录", async () => {
  let stage = 0;
  const h = harness((id) => {
    if (id === "0")
      return {
        files: [
          file("folder", "资料", true),
          ...(stage === 0 ? [file("old")] : []),
        ],
        next: null,
      };
    if (stage === 1)
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "列表格式变化 private-query-data",
      );
    return { files: [file("child")], next: null };
  });
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    stage = 1;
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "partial");
    const logs = h.sync.logs("a");
    assert.match(logs[0].message, /部分完成.*1 个目录/);
    assert.equal(logs[1].level, "warning");
    assert.match(logs[1].message, /资料.*读取失败/);
    assert.ok(
      logs.every((entry) => !entry.message.includes("private-query-data")),
    );
    assert.equal(
      h.sync.index({ accountId: "a", search: "old" }).items[0].missing,
      false,
    );
    stage = 2;
    h.calls.length = 0;
    h.sync.resume("a");
    await h.sync.settled("a");
    assert.deepEqual(
      h.calls.map((c) => c.id),
      ["folder"],
    );
    assert.equal(h.sync.current("a")?.status, "completed");
    assert.match(h.sync.logs("a")[1].message, /重试 1 个未完成目录/);
    const old = h.sync.index({ accountId: "a", search: "old" }).items[0];
    assert.equal(old.missing, true);
    assert.equal(old.state, "review");
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM drive_index_entries")!.n,
      3,
    );
  } finally {
    h.close();
  }
});

test("分页重复必须部分完成，不能把截断结果当作整盘成功", async () => {
  const h = harness(() => ({ files: [file("a")], next: "again" }));
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "partial");
    assert.match(h.sync.current("a")!.message, /分页/);
  } finally {
    h.close();
  }
});

test("暂停后从未完成目录第一页重读，进程恢复不自动执行", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let blocked = true;
  const h = harness(async (_id, cursor) => {
    if (blocked) {
      entered();
      await gate;
    }
    return { files: [file(cursor ? "b" : "a")], next: cursor ? null : "2" };
  });
  try {
    h.sync.start("a");
    await ready;
    h.sync.pause("a");
    h.sync.pause("a");
    release();
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "paused");
    assert.deepEqual(
      h.sync.logs("a").map((entry) => entry.message),
      [
        "已暂停。已发现 1 个文件、1 个目录，1 个待处理。",
        "正在暂停，等待当前目录请求结束。",
        "开始同步整个网盘。",
      ],
    );
    blocked = false;
    h.calls.length = 0;
    h.sync.resume("a");
    await h.sync.settled("a");
    assert.deepEqual(
      h.calls.map((c) => c.cursor),
      ["", "2"],
    );
    h.db.run("UPDATE drive_sync_runs SET status='running'");
    const calls = h.calls.length,
      recovered = new DriveSync(h.deps);
    assert.equal(recovered.current("a")?.status, "interrupted");
    assert.match(recovered.logs("a")[0].message, /上次同步已中断/);
    assert.equal(h.calls.length, calls);
    recovered.close();
  } finally {
    h.close();
  }
});

test("同步日志记录阶段与汇总进度，按账号和 UID 读取并保留最近一百条", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const h = harness((_, cursor) => {
    clock += 16_000;
    return { files: [file(cursor ? "two" : "one")], next: cursor ? null : "2" };
  });
  const handlers = createDriveSyncHandlers({ driveSync: h.sync });
  try {
    assert.deepEqual(handlers["driveSync.logs"]({ accountId: "a" }), []);
    assert.throws(() => handlers["driveSync.logs"]({ accountId: "" }));
    h.sync.start("a");
    await h.sync.settled("a");
    const initial = handlers["driveSync.logs"]({ accountId: "a" });
    assert.deepEqual(
      initial.map((entry) => entry.message),
      [
        "同步完成，共发现 2 个文件、1 个目录。",
        "正在同步。已发现 1 个文件、1 个目录，1 个待处理。",
        "开始同步整个网盘。",
      ],
    );
    assert.ok(
      initial.every(
        (entry) => entry.level === "info" && Date.parse(entry.at) > 0,
      ),
    );
    assert.deepEqual(handlers["driveSync.logs"]({ accountId: "other" }), []);
    h.account.uid = "other-uid";
    assert.deepEqual(handlers["driveSync.logs"]({ accountId: "a" }), []);
    h.account.uid = "u";
    h.sync.start("a");
    await h.sync.settled("a");
    const updated = handlers["driveSync.logs"]({ accountId: "a" });
    assert.deepEqual(updated.slice(-3), initial);
    assert.match(updated[2].message, /开始更新本地目录/);
    for (let run = 0; run < 33; run++) {
      h.sync.start("a");
      await h.sync.settled("a");
    }
    const retained = handlers["driveSync.logs"]({ accountId: "a" });
    assert.equal(retained.length, 100);
    assert.ok(
      retained.every(
        (entry, index) => index === 0 || entry.id < retained[index - 1].id,
      ),
    );
    assert.equal(
      h.db.get<{ n: number }>(
        "SELECT count(*) n FROM runtime_logs WHERE domain='drive-sync' AND account_id='a'",
      )!.n,
      100,
    );
  } finally {
    h.close();
  }
});

test("自动录入逐个登记文件和目录，读取已登记目录的子项并跳过重复来源和名称", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hold = false;
  const h = harness(async (id) => {
    if (id === "0")
      return {
        files: [
          file("first", "A.pdf"),
          file("same-title", "Ａ．pdf"),
          file("covered", "已有目录", true),
          file("free", "资料", true),
        ],
        next: null,
      };
    if (id === "covered") {
      if (hold) {
        entered();
        await gate;
      }
      return { files: [file("deep", "子目录", true)], next: null };
    }
    if (id === "deep") return { files: [file("covered-file")], next: null };
    return {
      files: [
        file("same-source", "改名后的文件.pdf"),
        file("nested", "练习.pdf"),
        file("same-title-later", "a.pdf"),
      ],
      next: null,
    };
  });
  try {
    const handlers = createDriveSyncHandlers({ driveSync: h.sync });
    assert.equal(
      handlers["driveSync.index"]({ accountId: "a" }).autoRegisterSupported,
      true,
    );
    assert.equal(
      handlers["driveSync.index"]({ accountId: "a" })
        .autoRegisterIncludesFolders,
      true,
    );
    handlers["driveSync.start"]({ accountId: "a" });
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.autoRegister, undefined);
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM resources")!.n,
      0,
    );
    await h.sync.register({
      accountId: "a",
      entries: [{ fileId: "covered", title: "已有目录" }],
    });
    h.db.run(
      "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,source_kind,created_at,updated_at) VALUES('old','旧文件',?,'same-source','quark','未分类','[]','','owned',?,?)",
      ownedFileSource("quark", "a", "u", "same-source"),
      now(),
      now(),
    );
    h.provider.list = async () => {
      throw new Error("自动录入不得重复读取目录");
    };
    h.calls.length = 0;
    hold = true;
    handlers["driveSync.start"]({ accountId: "a", autoRegister: true });
    await ready;
    const running = h.sync.current("a")!;
    assert.equal(running.status, "running");
    assert.deepEqual(running.autoRegister, {
      enabled: true,
      added: 2,
      skipped: 2,
    });
    assert.match(h.sync.logs("a")[0].message, /自动录入新增 2 项，跳过 2 项/);
    release();
    await h.sync.settled("a");
    assert.deepEqual(h.sync.current("a")?.autoRegister, {
      enabled: true,
      added: 5,
      skipped: 4,
    });
    const copy = h.db.get<{
      files: string;
      directory: string;
      status: string;
      owner_uid: string;
      share_url: null;
    }>(
      "SELECT c.files,c.directory,c.status,c.owner_uid,c.share_url FROM copies c JOIN resources r ON r.id=c.resource_id WHERE r.source_key='nested'",
    )!;
    assert.equal(copy.directory, "/资料");
    assert.equal(JSON.parse(copy.files)[0].path, "/资料/练习.pdf");
    assert.equal(copy.status, "recorded");
    assert.equal(copy.owner_uid, "u");
    assert.equal(copy.share_url, null);
    assert.equal(
      h.sync.index({ accountId: "a", parentId: "deep" }).items[0].state,
      "recorded",
    );
    const folderCopy = h.db.get<{ files: string; directory: string }>(
      "SELECT c.files,c.directory FROM copies c JOIN resources r ON r.id=c.resource_id WHERE r.source_key='deep'",
    )!;
    assert.equal(folderCopy.directory, "/已有目录");
    assert.deepEqual(
      JSON.parse(folderCopy.files).map(
        ({ id, isDirectory, path }: RemoteFile) => ({
          id,
          isDirectory,
          path,
        }),
      ),
      [{ id: "deep", isDirectory: true, path: "/已有目录/子目录" }],
    );
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM resources")!.n,
      7,
    );
    assert.deepEqual(
      h.calls.map((item) => item.id),
      ["0", "covered", "free", "deep"],
    );
  } finally {
    release();
    await h.sync.settled("a");
    h.close();
  }
});

test("自动录入暂停时保留已提交页面，重开继续读同一页也只计入一次", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness(async (id, cursor) => {
    if (id === "first") return { files: [file("child")], next: null };
    if (!cursor) {
      entered();
      await gate;
    }
    return {
      files: cursor ? [file("second")] : [file("first", "目录", true)],
      next: cursor ? null : "2",
    };
  });
  let reopened: DriveSync | undefined;
  try {
    h.sync.start("a", false, true);
    await ready;
    h.sync.pause("a");
    release();
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "paused");
    assert.match(h.sync.logs("a")[0].message, /自动录入新增 1 项，跳过 0 项/);
    reopened = new DriveSync(h.deps);
    assert.deepEqual(reopened.current("a")?.autoRegister, {
      enabled: true,
      added: 1,
      skipped: 0,
    });
    reopened.resume("a");
    await reopened.settled("a");
    assert.deepEqual(
      h.calls.map((item) => item.cursor),
      ["", "", "2", ""],
    );
    assert.deepEqual(reopened.current("a")?.autoRegister, {
      enabled: true,
      added: 3,
      skipped: 0,
    });
    reopened.resume("a");
    await reopened.settled("a");
    assert.equal(reopened.current("a")?.autoRegister, undefined);
  } finally {
    release();
    reopened?.close();
    h.close();
  }
});

test("旧的未完成同步需从头开启自动录入，继续时可关闭且保留已录入数量", async () => {
  let fail = true;
  const h = harness((id) => {
    if (id === "0")
      return { files: [file("first"), file("dir", "目录", true)], next: null };
    if (fail) throw new AppError("INCOMPLETE_LIST", "分页异常");
    return { files: [file("second")], next: null };
  });
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    assert.throws(() => h.sync.resume("a", true), {
      code: "AUTO_REGISTER_RESTART_REQUIRED",
    });
    h.sync.start("a", true, true);
    await h.sync.settled("a");
    assert.match(h.sync.logs("a")[0].message, /部分完成.*自动录入新增 2 项/);
    fail = false;
    createDriveSyncHandlers({ driveSync: h.sync })["driveSync.resume"]({
      accountId: "a",
      autoRegister: false,
    });
    await h.sync.settled("a");
    assert.deepEqual(h.sync.current("a")?.autoRegister, {
      enabled: false,
      added: 2,
      skipped: 0,
    });
    assert.equal(
      h.sync.index({ accountId: "a", parentId: "dir" }).items[0].state,
      "review",
    );
    assert.match(h.sync.logs("a")[1].message, /已关闭自动录入/);
  } finally {
    h.close();
  }
});

test("早期文件自动录入任务需重新扫描才能补录目录和子项", async () => {
  let fail = true;
  const h = harness((id) => {
    if (id === "0")
      return {
        files: [file("first"), file("folder", "资料", true)],
        next: null,
      };
    if (fail) throw new AppError("INCOMPLETE_LIST", "分页异常");
    return { files: [file("child")], next: null };
  });
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    await h.sync.register({
      accountId: "a",
      entries: [{ fileId: "first", title: "first" }],
    });
    const prior = h.sync.current("a")!;
    assert.equal(prior.status, "partial");
    h.db.setSetting("drive-sync:auto-register:a", {
      runId: prior.id,
      enabled: true,
      added: 1,
      skipped: 0,
    });
    assert.deepEqual(h.sync.index({ accountId: "a" }).run?.autoRegister, {
      enabled: true,
      added: 1,
      skipped: 0,
      requiresRescan: true,
    });
    assert.throws(() => h.sync.resume("a"), {
      code: "AUTO_REGISTER_RESTART_REQUIRED",
    });
    assert.throws(() => h.sync.resume("a", true), {
      code: "AUTO_REGISTER_RESTART_REQUIRED",
    });
    fail = false;
    h.sync.resume("a", false);
    await h.sync.settled("a");
    assert.deepEqual(h.sync.current("a")?.autoRegister, {
      enabled: false,
      added: 1,
      skipped: 0,
    });
    assert.equal(
      h.sync.index({ accountId: "a", parentId: "folder" }).items[0].state,
      "unrecorded",
    );
    h.sync.start("a", true, true);
    await h.sync.settled("a");
    assert.deepEqual(h.sync.current("a")?.autoRegister, {
      enabled: true,
      added: 2,
      skipped: 1,
    });
    assert.deepEqual(
      h.db
        .all<{ source_key: string }>(
          "SELECT source_key FROM resources ORDER BY source_key",
        )
        .map((row) => row.source_key),
      ["child", "first", "folder"],
    );
  } finally {
    h.close();
  }
});

test("自动录入写入失败时目录索引、资源、计数和该页进度一起回滚", async () => {
  const h = harness(() => ({
    files: [file("first"), file("broken")],
    next: null,
  }));
  try {
    h.db.db.exec(`CREATE TRIGGER broken_copy BEFORE INSERT ON copies
      WHEN json_extract(NEW.files,'$[0].id')='broken'
      BEGIN SELECT RAISE(ABORT,'测试写入异常'); END`);
    h.sync.start("a", false, true);
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "partial");
    assert.deepEqual(h.sync.current("a")?.autoRegister, {
      enabled: true,
      added: 0,
      skipped: 0,
    });
    assert.equal(h.sync.index({ accountId: "a" }).total, 0);
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM resources")!.n,
      0,
    );
    h.db.db.exec("DROP TRIGGER broken_copy");
    h.sync.resume("a");
    await h.sync.settled("a");
    assert.deepEqual(h.sync.current("a")?.autoRegister, {
      enabled: true,
      added: 2,
      skipped: 0,
    });
  } finally {
    h.close();
  }
});

test("环境或 UID 在读取期间变化，返回的数据不得写入旧索引", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const h = harness(async () => {
    entered();
    await gate;
    return { files: [file("wrong")], next: null };
  });
  try {
    h.sync.start("a", false, true);
    await ready;
    h.setEnvironment("changed");
    release();
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "blocked");
    assert.equal(h.sync.index({ accountId: "a" }).total, 0);
    assert.equal(h.sync.current("a")?.autoRegister?.added, 0);
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM resources")!.n,
      0,
    );
    assert.throws(() => h.sync.resume("a"), /身份或环境/);
  } finally {
    h.close();
  }
});

test("资源关联使用目标文件 ID 和 UID，源文件、同名文件和目录新增内容不误认", async () => {
  const h = harness((id) => ({
    files:
      id === "0"
        ? [file("folder", "资料", true), file("other", "旧文件")]
        : [file("known", "旧文件"), file("new", "新增文件")],
    next: null,
  }));
  try {
    h.db.run(
      "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES('r','资料','https://pan.quark.cn/s/abc','abc','quark','资料','[]','',?,?)",
      now(),
      now(),
    );
    h.db.run(
      "INSERT INTO copies(id,resource_id,account_id,directory,folder_id,files,selected_files,status,owner_uid,verified_at,created_at,updated_at) VALUES('c','r','a','/资料','folder',?,?,'ready','u',?,?,?)",
      JSON.stringify([file("known")]),
      JSON.stringify([file("other")]),
      now(),
      now(),
      now(),
    );
    h.sync.start("a");
    await h.sync.settled("a");
    const rows = h.sync.index({ accountId: "a", search: "/" }).items;
    assert.equal(rows.find((e) => e.id === "known")!.state, "recorded");
    assert.equal(rows.find((e) => e.id === "other")!.state, "unrecorded");
    assert.equal(rows.find((e) => e.id === "new")!.state, "review");
    h.db.run("UPDATE copies SET owner_uid='someone-else' WHERE id='c'");
    assert.equal(
      h.sync
        .index({ accountId: "a", search: "旧文件" })
        .items.every((e) => e.state === "unrecorded"),
      true,
    );
  } finally {
    h.close();
  }
});

test("无分享登记重新核对远端，重复提交幂等，副本未就绪且不创建分享", async () => {
  const h = harness(() => ({
    files: [file("a", "实用资料.pdf"), file("b", "另份资料.pdf")],
    next: null,
  }));
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    const input = {
      accountId: "a",
      entries: [{ fileId: "a", title: "实用资料" }],
    };
    const first = await h.sync.register(input),
      second = await h.sync.register(input);
    assert.equal(first[0].resourceId, second[0].resourceId);
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM resources")!.n,
      1,
    );
    const copy = h.db.get<{
      status: string;
      share_id: string | null;
      owner_uid: string;
    }>("SELECT * FROM copies")!;
    assert.equal(copy.status, "recorded");
    assert.equal(copy.share_id, null);
    assert.equal(copy.owner_uid, "u");
    assert.equal(
      h.sync.index({ accountId: "a" }).items.find((e) => e.id === "a")!.state,
      "recorded",
    );
    const conflict = await h.sync.register({
      accountId: "a",
      entries: [{ fileId: "b", title: "实用资料" }],
    });
    assert.match(conflict[0].error!, /保存/);
    h.db.run("DELETE FROM copies");
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM drive_resource_entries")!
        .n,
      0,
    );
  } finally {
    h.close();
  }
});

test("离线索引分页不要求登录，IPC 拒绝超量登记和无效页码", async () => {
  const h = harness(() => ({
    files: Array.from({ length: 125 }, (_, i) => file(String(i), `文件${i}`)),
    next: null,
  }));
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    h.account.status = "expired";
    assert.equal(h.sync.index({ accountId: "a", page: 2 }).items.length, 50);
    assert.equal(h.sync.index({ accountId: "a", page: 3 }).items.length, 25);
    const handlers = createDriveSyncHandlers({ driveSync: h.sync });
    assert.throws(() =>
      handlers["driveSync.index"]({ accountId: "a", page: 0 }),
    );
    assert.throws(() =>
      handlers["driveSync.register"]({
        accountId: "a",
        entries: Array.from({ length: 51 }, () => ({
          fileId: "a",
          title: "a",
        })),
      }),
    );
  } finally {
    h.close();
  }
});

test("同一目录改名会更新已索引子路径，文件 ID 和资源关联保持稳定", async () => {
  let name = "原目录";
  const h = harness((id) => ({
    files:
      id === "0" ? [file("folder", name, true)] : [file("child", "资料.pdf")],
    next: null,
  }));
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    name = "新目录";
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(
      h.sync.index({ accountId: "a", search: "资料.pdf" }).items[0].path,
      "/新目录/资料.pdf",
    );
    assert.equal(
      h.db.get<{ n: number }>("SELECT count(*) n FROM drive_index_entries")!.n,
      2,
    );
  } finally {
    h.close();
  }
});

test("目录层级循环不能被记为整盘成功", async () => {
  const h = harness((id) => ({
    files: [file(id === "0" ? "a" : id === "a" ? "b" : "a", "目录", true)],
    next: null,
  }));
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "partial");
    assert.match(h.sync.current("a")!.message, /循环/);
  } finally {
    h.close();
  }
});

test("十万级文件索引分页查询，不将全盘数据返回渲染器", () => {
  const h = harness(() => ({ files: [], next: null }));
  try {
    const time = now(),
      put = h.db.db.prepare(
        "INSERT INTO drive_index_entries(account_id,owner_uid,file_id,parent_id,name,path,is_directory,size,last_seen,observed_at) VALUES('a','u',?,'@root',?,?,0,1,'run',?)",
      );
    h.db.transaction(() => {
      for (let i = 0; i < 100000; i++)
        put.run(String(i), `文件${i}.pdf`, `/文件${i}.pdf`, time);
    });
    const start = performance.now(),
      page = h.sync.index({ accountId: "a", page: 1000 });
    assert.equal(page.items.length, 50);
    assert.equal(page.total, 100000);
    assert.equal(
      h.sync.index({ accountId: "a", search: "文件99999" }).items.length,
      1,
    );
    assert.ok(performance.now() - start < 5000, "本地分页与查询应保持可用");
  } finally {
    h.close();
  }
});

test("独立原生账号同步最多并发三个，等待时不阻断已开始的目录请求", async () => {
  const db = new Database(":memory:");
  const accounts = new Map<string, Account>();
  for (let i = 0; i < 4; i++) {
    const account = {
      id: `native-${i}`,
      provider: "uc",
      uid: `uid-${i}`,
      enabled: true,
    } as Account;
    accounts.set(account.id, account);
    db.run(
      "INSERT INTO accounts(id,provider,alias,uid,created_at,updated_at) VALUES(?,'uc',?,?,?,?)",
      account.id,
      account.id,
      account.uid,
      now(),
      now(),
    );
  }
  let release!: () => void,
    reached!: () => void,
    live = 0,
    peak = 0;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    three = new Promise<void>((r) => {
      reached = r;
    });
  const provider = {
    listPage: async () => {
      await gate;
      return { files: [], next: null };
    },
  } as unknown as DriveProvider;
  const sync = new DriveSync({
    db,
    account: (id) => accounts.get(id)!,
    supported: () => true,
    environment: (id) => id,
    intervalMs: 0,
    changed: () => {},
    withAccount: async (id, action) => {
      live++;
      peak = Math.max(peak, live);
      if (live === 3) reached();
      try {
        return await action(accounts.get(id)!, provider);
      } finally {
        live--;
      }
    },
  });
  try {
    for (const account of accounts.values()) sync.start(account.id);
    await three;
    assert.equal(peak, 3);
    release();
    await Promise.all([...accounts.keys()].map((id) => sync.settled(id)));
    assert.equal(peak, 3);
    assert.ok(
      [...accounts.keys()].every(
        (id) => sync.current(id)?.status === "completed",
      ),
    );
  } finally {
    release();
    sync.close();
    db.close();
  }
});
