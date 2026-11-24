import test from "node:test";
import assert from "node:assert/strict";
import { Database, now } from "../core/database";
import { DriveSync } from "../core/drive-sync";
import type { Account, RemoteFile } from "../shared/types";
import type { DriveProvider } from "../core/providers/provider";
import type { DriveListPage } from "../shared/drive-sync";
import { AppError } from "../core/errors";
import { createDriveSyncHandlers } from "../core/ipc/drive-sync";

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
      throw new AppError("REMOTE_SCHEMA_CHANGED", "列表格式变化");
    return { files: [file("child")], next: null };
  });
  try {
    h.sync.start("a");
    await h.sync.settled("a");
    stage = 1;
    h.sync.start("a");
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "partial");
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
    release();
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "paused");
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
    assert.equal(h.calls.length, calls);
    recovered.close();
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
    h.sync.start("a");
    await ready;
    h.setEnvironment("changed");
    release();
    await h.sync.settled("a");
    assert.equal(h.sync.current("a")?.status, "blocked");
    assert.equal(h.sync.index({ accountId: "a" }).total, 0);
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
