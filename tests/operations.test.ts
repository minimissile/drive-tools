import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fixture, file, removeV5 } from "./helpers";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import type { DriveProvider, OwnShare } from "../core/providers/provider";
import type {
  Account,
  RemoteFile,
  SplitRun,
  TransferBatch,
} from "../shared/types";
import { stageRestore, fileHash } from "../core/backups";

async function setup() {
  const f = await fixture(),
    p = f.provider as DriveProvider,
    folders = new Map<string, RemoteFile[]>(),
    shares = new Map<string, { share: OwnShare; files: RemoteFile[] }>(),
    listed: string[] = [];
  let lost = false,
    noResult = false;
  p.inspect = async (_a, source, parentId = "0", page = 1) => ({
    shareKey: source.shareKey,
    title: "测试资料",
    files: [{ ...file, parentId }],
    hasMore: false,
    page,
    parentId,
  });
  p.ensureFolder = async (a, path) => {
    const key = a.provider === "baidu" ? path : `folder-${path}`;
    if (!folders.has(key)) folders.set(key, []);
    return key;
  };
  p.list = async (_a, parent) => {
    listed.push(parent);
    return folders.get(parent) ?? [];
  };
  p.transfer = async (a, _s, selected, parent, path) => {
    f.provider.transfers++;
    folders.set(
      parent,
      selected.map((entry) => ({
        ...entry,
        id: `${parent}/${entry.id}`,
        parentId: parent,
        path: `${path}/${entry.name}`,
      })),
    );
    return { taskId: null };
  };
  p.createShare = async (a, files) => {
    f.provider.shares++;
    if (noResult) throw new Error("响应丢失且未找到结果");
    const share: OwnShare = {
      id: `share-${f.provider.shares}`,
      url: `https://${a.provider === "baidu" ? "pan.baidu.com/s/1" : "pan.quark.cn/s/"}own-${f.provider.shares}`,
      ownerUid: f.provider.uid,
      code: "a123",
    };
    shares.set(share.id, { share, files });
    if (lost) throw new Error("分享响应丢失");
    return share;
  };
  p.verifyShare = async (_a, id, files) => {
    const actual = shares.get(id);
    return (
      !!actual &&
      actual.files.length === files.length &&
      files.every((entry) =>
        actual.files.some((candidate) => candidate.id === entry.id),
      )
    );
  };
  p.findOwnShare = async (a, files) => {
    for (const entry of shares.values())
      if (await p.verifyShare(a, entry.share.id, files)) return entry.share;
    return null;
  };
  p.recoverOwnShare = async (a, source, files) => {
    for (const entry of shares.values())
      if (
        entry.share.url === source.url &&
        (await p.verifyShare(a, entry.share.id, files))
      )
        return entry.share;
    throw new AppError("OWNERSHIP_UNVERIFIED", "不是本人的对应文件链接。");
  };
  return {
    ...f,
    p,
    folders,
    shares,
    listed,
    setLost: (value: boolean) => {
      lost = value;
    },
    setNoResult: (value: boolean) => {
      noResult = value;
    },
  };
}
async function readyTree(provider: "quark" | "baidu" = "quark") {
  const f = await setup();
  let account = f.account;
  if (provider === "baidu") {
    account = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "百度本人",
    })) as Account;
    await f.app.invoke("account.check", { id: account.id });
  }
  const saved = await f.add(
    true,
    provider === "baidu"
      ? {
          accountId: account.id,
          sourceText: "https://pan.baidu.com/s/1source123",
        }
      : {},
  );
  await f.app.queue.execute(saved.jobId);
  assert.equal(f.app.repo.getCopy(saved.copyId).status, "ready");
  const copy = f.app.repo.getCopy(saved.copyId),
    root = copy.folderId!,
    ref = (name: string) =>
      provider === "baidu" ? `${copy.directory}/${name}` : name;
  const node = (
    id: string,
    name: string,
    dir: boolean,
    parentId: string,
  ): RemoteFile => ({
    id,
    name,
    isDirectory: dir,
    parentId,
    size: dir ? null : 12,
    ...(provider === "baidu" ? { path: ref(name) } : {}),
  });
  const roots = [
    node("readme", "说明.txt", false, root),
    node("course", "课程", true, root),
    node("empty", "空目录", true, root),
  ];
  const children = [
    node("intro", "简介.txt", false, ref("课程")),
    node("chapter", "章节", true, ref("课程")),
  ];
  const third = [
    node("lesson", "第一课.mp4", false, ref("章节")),
    node("deep", "更深目录", true, ref("章节")),
  ];
  f.folders.set(root, roots);
  f.folders.set(provider === "baidu" ? ref("课程") : "course", children);
  f.folders.set(provider === "baidu" ? ref("章节") : "chapter", third);
  f.folders.set(provider === "baidu" ? ref("空目录") : "empty", []);
  f.folders.set(provider === "baidu" ? ref("更深目录") : "deep", [
    node("beyond", "第四层文件.txt", false, ref("更深目录")),
  ]);
  f.app.db.run(
    "UPDATE copies SET files=? WHERE id=?",
    JSON.stringify(roots),
    saved.copyId,
  );
  return { ...f, saved, account, roots, ref };
}
async function preview(
  f: Awaited<ReturnType<typeof readyTree>>,
  depth = 3,
  mode: "level" | "all" = "level",
) {
  const run = (await f.app.invoke("split.preview", {
    copyId: f.saved.copyId,
    depth,
    mode,
  })) as SplitRun;
  await f.app.queue.execute(run.jobId);
  return f.app.operations.split(run.id);
}
test("批量预检只读分享，权利确认后逐份建任务，重复开始不会重复创建", async () => {
  const f = await setup();
  try {
    const first = await f.add(false),
      second = await f.add(false, {
        sourceText: "https://pan.quark.cn/s/second123",
      });
    const batch = (await f.app.invoke("batch.preview", {
      copyIds: [first.copyId, second.copyId, first.copyId],
    })) as TransferBatch;
    assert.equal(batch.items.length, 2);
    for (const item of batch.items)
      await f.app.queue.execute(item.inspectJobId);
    const checked = f.app.operations.batch(batch.id);
    assert.ok(checked.items.every((i) => i.state === "ready"));
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
    await assert.rejects(
      f.app.invoke("batch.start", {
        id: batch.id,
        itemIds: checked.items.map((i) => i.id),
        rightsConfirmed: false,
      }),
    );
    const args = {
      id: batch.id,
      itemIds: checked.items.map((i) => i.id),
      rightsConfirmed: true,
    };
    assert.equal(((await f.app.invoke("batch.start", args)) as any).created, 2);
    assert.equal(((await f.app.invoke("batch.start", args)) as any).reused, 2);
    for (const item of f.app.operations.batch(batch.id).items)
      await f.app.queue.execute(item.transferJobId!);
    assert.equal(f.provider.transfers, 2);
    assert.equal(f.provider.shares, 2);
    assert.ok(
      f.app.operations
        .batch(batch.id)
        .items.every((i) => i.stage === "completed"),
    );
  } finally {
    await f.cleanup();
  }
});
test("批量预检单项登录或文件失败不影响其他项，超量和空选择不入队", async () => {
  const f = await setup();
  try {
    const first = await f.add(false),
      second = await f.add(false, {
        sourceText: "https://pan.quark.cn/s/bad123",
      });
    const original = f.p.inspect;
    f.p.inspect = async (a, s, parent, page) => {
      if (s.shareKey === "bad123") throw new AppError("BAD_CODE", "提取码错误");
      return original(a, s, parent, page);
    };
    const batch = (await f.app.invoke("batch.preview", {
      copyIds: [first.copyId, second.copyId],
    })) as TransferBatch;
    for (const item of batch.items)
      await f.app.queue.execute(item.inspectJobId);
    const result = f.app.operations.batch(batch.id);
    assert.equal(result.items[0].state, "ready");
    assert.equal(result.items[1].state, "failed");
    assert.equal(f.app.repo.getCopy(second.copyId).status, "draft");
    await f.app.invoke("batch.selection", {
      itemId: result.items[0].id,
      fileIds: [],
    });
    await assert.rejects(
      f.app.invoke("batch.start", {
        id: batch.id,
        itemIds: [result.items[0].id],
        rightsConfirmed: true,
      }),
      { code: "SELECTION_REQUIRED" },
    );
    assert.equal(
      f.app.repo.jobs().filter((j) => j.kind === "transfer").length,
      0,
    );
    await assert.rejects(
      f.app.invoke("batch.preview", {
        copyIds: Array.from({ length: 101 }, (_, i) => String(i)),
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test("批量预检分页未读完、根目录超过100项和重复记录均不伪造成功", async () => {
  for (const mode of ["too-many", "pages", "duplicate"]) {
    const f = await setup();
    try {
      const saved = await f.add(false, { selectedFiles: [] });
      f.p.inspect = async (_a, s, parentId = "0", page = 1) => ({
        shareKey: s.shareKey,
        title: "",
        files:
          mode === "too-many"
            ? Array.from({ length: 101 }, (_, i) => ({
                ...file,
                id: String(i),
              }))
            : mode === "duplicate"
              ? [file, file]
              : [],
        hasMore: mode === "pages",
        page,
        parentId,
      });
      const batch = (await f.app.invoke("batch.preview", {
        copyIds: [saved.copyId],
      })) as TransferBatch;
      await f.app.queue.execute(batch.items[0].inspectJobId);
      assert.equal(f.app.operations.batch(batch.id).items[0].state, "failed");
      assert.equal(f.provider.transfers, 0);
    } finally {
      await f.cleanup();
    }
  }
});
test("三级拆分保留浅层文件和空目录，深层目录整体作为节点且不读取第四层", async () => {
  for (const provider of ["quark", "baidu"] as const) {
    const f = await readyTree(provider);
    try {
      const run = await preview(f);
      assert.equal(run.status, "ready");
      assert.deepEqual(
        run.items.map((i) => i.file.id),
        ["readme", "intro", "lesson", "deep", "empty"],
      );
      assert.ok(run.items.every((i) => i.depth <= 3));
      assert.equal(
        f.listed.includes(provider === "baidu" ? f.ref("更深目录") : "deep"),
        false,
      );
      assert.equal(f.provider.transfers, 1);
      assert.equal(f.provider.shares, 1);
      if (provider === "baidu")
        assert.equal(f.listed.includes("course"), false);
      await assert.rejects(
        f.app.invoke("split.preview", {
          copyId: f.saved.copyId,
          depth: 4,
          mode: "level",
        }),
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("逐层模式保留父子条目，拆分开始支持勾选且重复预览复用相同子项", async () => {
  const f = await readyTree();
  try {
    const all = await preview(f, 3, "all");
    assert.equal(all.items.length, 7);
    const run = await preview(f);
    const repeat = await preview(f);
    assert.deepEqual(
      repeat.items.map((i) => i.id),
      run.items.map((i) => i.id),
    );
    const args = {
      id: run.id,
      itemIds: [run.items[0].id],
      rightsConfirmed: true,
    };
    await f.app.invoke("split.start", args);
    await f.app.invoke("split.start", args);
    const item = f.app.operations.split(run.id).items[0];
    assert.ok(item.jobId);
    assert.equal(
      f.app.repo.jobs().filter((j) => j.kind === "split_share").length,
      1,
    );
    await f.app.queue.execute(item.jobId!);
    assert.equal(f.provider.shares, 2);
    assert.equal(f.provider.transfers, 1);
    const link = (await f.app.invoke("split.link", { itemId: item.id })) as any;
    assert.match(link.text, /own-2/);
    assert.doesNotMatch(link.text, /source123/);
    assert.equal(f.app.repo.getCopy(f.saved.copyId).status, "ready");
    assert.equal(
      f.app.repo.getCopy(f.saved.copyId).shareUrl,
      "https://pan.quark.cn/s/own-1",
    );
  } finally {
    await f.cleanup();
  }
});
test("拆分请求响应丢失后只查本人记录；结果仍未知时不重复建链", async () => {
  for (const missing of [false, true]) {
    const f = await readyTree();
    try {
      const run = await preview(f, 1);
      await f.app.invoke("split.start", {
        id: run.id,
        itemIds: [run.items[0].id],
        rightsConfirmed: true,
      });
      const item = f.app.operations.split(run.id).items[0];
      f.setLost(!missing);
      f.setNoResult(missing);
      await f.app.queue.execute(item.jobId!);
      assert.equal(f.app.repo.getJob(item.jobId!).stage, "needs_review");
      assert.equal(f.provider.shares, 2);
      f.setLost(false);
      f.setNoResult(false);
      await f.app.invoke("job.retry", { id: item.jobId });
      await f.app.queue.execute(item.jobId!);
      assert.equal(f.provider.shares, 2);
      assert.equal(
        f.app.operations.splitItem(item.id).status,
        missing ? "needs_review" : "ready",
      );
      assert.equal(f.app.repo.getCopy(f.saved.copyId).status, "ready");
    } finally {
      await f.cleanup();
    }
  }
});
test("停止拆分预检与子链接任务保留父资料；停止后收到成功响应仍保留已建分享", async () => {
  const f = await readyTree();
  try {
    const run = await preview(f, 1);
    await f.app.invoke("split.start", {
      id: run.id,
      itemIds: [run.items[0].id],
      rightsConfirmed: true,
    });
    const item = f.app.operations.split(run.id).items[0];
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      }),
      original = f.p.createShare;
    f.p.createShare = async (...args) => {
      enter();
      await gate;
      return original(...args);
    };
    const work = f.app.queue.execute(item.jobId!);
    await entered;
    await f.app.invoke("job.cancel", { id: item.jobId });
    release();
    await work;
    assert.equal(f.app.repo.getJob(item.jobId!).stage, "cancelled");
    assert.equal(f.app.operations.splitItem(item.id).status, "ready");
    assert.equal(f.app.repo.getCopy(f.saved.copyId).status, "ready");
    const next = (await f.app.invoke("split.preview", {
      copyId: f.saved.copyId,
      depth: 2,
    })) as SplitRun;
    await f.app.invoke("job.cancel", { id: next.jobId });
    await f.app.queue.execute(next.jobId);
    assert.equal(f.app.operations.split(next.id).status, "cancelled");
  } finally {
    await f.cleanup();
  }
});
test("目录被替换、账号UID变化、来源链接冒充本人分享均禁止拆分分发", async () => {
  for (const mode of ["changed", "uid", "foreign"]) {
    const f = await readyTree();
    try {
      const run = await preview(f, 1);
      await f.app.invoke("split.start", {
        id: run.id,
        itemIds: [run.items[0].id],
        rightsConfirmed: true,
      });
      const item = f.app.operations.split(run.id).items[0];
      if (mode === "changed")
        f.folders.set(
          f.app.repo.getCopy(f.saved.copyId).folderId!,
          f.roots.map((row) => ({ ...row, id: "replaced-" + row.id })),
        );
      if (mode === "uid") f.provider.uid = "foreign-owner";
      if (mode === "foreign")
        f.p.createShare = async () => ({
          id: "foreign",
          url: "https://pan.quark.cn/s/source123",
          code: "",
          ownerUid: f.provider.uid,
        });
      await f.app.queue.execute(item.jobId!);
      assert.notEqual(f.app.operations.splitItem(item.id).status, "ready");
      await assert.rejects(f.app.invoke("split.link", { itemId: item.id }));
      assert.equal(f.app.repo.getCopy(f.saved.copyId).status, "ready");
    } finally {
      await f.cleanup();
    }
  }
});
test("导出和知识笔记只含已核验本人子链接，提取码受选项控制，备份恢复重置验证", async () => {
  const f = await readyTree();
  try {
    f.app.db.setSetting("vaultPath", join(f.dir, "vault"));
    const run = await preview(f, 1);
    await f.app.invoke("split.start", {
      id: run.id,
      itemIds: [run.items[0].id],
      rightsConfirmed: true,
    });
    const item = f.app.operations.split(run.id).items[0];
    await f.app.queue.execute(item.jobId!);
    const packaged = (await f.app.invoke("split.package", {
      id: run.id,
      itemIds: [item.id],
      includeCodes: false,
    })) as any;
    assert.match(packaged.text, /own-2/);
    assert.doesNotMatch(packaged.text, /a123|source123/);
    assert.match(
      (
        (await f.app.invoke("split.package", {
          id: run.id,
          itemIds: [item.id],
          includeCodes: true,
        })) as any
      ).text,
      /a123/,
    );
    const notePath = f.app.db.get<any>(
        "SELECT path FROM note_exports WHERE copy_id=?",
        f.saved.copyId,
      ).path,
      note = await readFile(notePath, "utf8");
    assert.match(note, /本人拆分链接/);
    assert.doesNotMatch(note, /a123/);
    f.ports.chooseDirectory = async () => f.dir;
    const folder = (await f.app.backup())!,
      restored = await stageRestore(
        folder,
        f.dir,
        await fileHash(join(folder, "panxu.db")),
      );
    const db = new Database(join(restored.dataPath, "panxu.db"));
    assert.equal(
      db.get<any>("SELECT verified_at FROM split_items").verified_at,
      null,
    );
    assert.equal(
      db.get<any>("SELECT status FROM split_items").status,
      "needs_review",
    );
    assert.equal(db.get<any>("SELECT count(*) n FROM secrets").n, 0);
    db.close();
  } finally {
    await f.cleanup();
  }
});
test("账号要求人工验证时暂停同账号待执行任务，不修改原资料状态", async () => {
  const f = await readyTree();
  try {
    const run = await preview(f, 1);
    await f.app.invoke("split.start", {
      id: run.id,
      itemIds: run.items.map((i) => i.id),
      rightsConfirmed: true,
    });
    const items = f.app.operations.split(run.id).items;
    f.p.findOwnShare = async () => {
      throw new AppError("USER_ACTION_REQUIRED", "账号需要人工验证");
    };
    await f.app.queue.execute(items[0].jobId!);
    assert.ok(
      items
        .slice(1)
        .every(
          (item) => f.app.repo.getJob(item.jobId!).stage === "needs_review",
        ),
    );
    assert.equal(f.provider.shares, 1);
    assert.equal(f.app.repo.getCopy(f.saved.copyId).status, "ready");
  } finally {
    await f.cleanup();
  }
});

test("大目录可预览超过100个候选，创建分享仍分批限制100项", async () => {
  const f = await readyTree();
  try {
    f.folders.set(
      "course",
      Array.from({ length: 150 }, (_, i) => ({
        ...file,
        id: `large-${i}`,
        name: `资料${i}.txt`,
        parentId: "course",
      })),
    );
    const run = await preview(f, 2);
    assert.equal(run.status, "ready");
    assert.equal(run.items.length, 152);
    await assert.rejects(
      f.app.invoke("split.start", {
        id: run.id,
        itemIds: run.items.slice(0, 101).map((i) => i.id),
        rightsConfirmed: true,
      }),
    );
    assert.equal(
      (
        (await f.app.invoke("split.start", {
          id: run.id,
          itemIds: run.items.slice(0, 100).map((i) => i.id),
          rightsConfirmed: true,
        })) as any
      ).created,
      100,
    );
    assert.equal(f.provider.shares, 1);
  } finally {
    await f.cleanup();
  }
});

test("明确被实名要求拒绝的拆分建链，处理后可重试；不会误当作结果未知永久拦截", async () => {
  const f = await readyTree();
  try {
    const run = await preview(f, 1);
    await f.app.invoke("split.start", {
      id: run.id,
      itemIds: [run.items[0].id],
      rightsConfirmed: true,
    });
    const item = f.app.operations.split(run.id).items[0],
      original = f.p.createShare;
    f.p.createShare = async () => {
      throw new AppError("USER_ACTION_REQUIRED", "夸克要求实名认证（32011）");
    };
    await f.app.queue.execute(item.jobId!);
    assert.equal(f.app.repo.getJob(item.jobId!).checkpoint, "new");
    f.p.createShare = original;
    await f.app.invoke("job.retry", { id: item.jobId });
    await f.app.queue.execute(item.jobId!);
    assert.equal(f.app.operations.splitItem(item.id).status, "ready");
    assert.equal(f.provider.shares, 2);
  } finally {
    await f.cleanup();
  }
});

test("v4升级前创建v5快照且保留原任务种类，重开不重复备份", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "old-v4.db");
    new Database(path).close();
    const old = new DatabaseSync(path);
    old.exec(removeV5 + "PRAGMA user_version=4");
    old.close();
    const db = new Database(path);
    assert.equal(db.get<any>("PRAGMA user_version").user_version, 5);
    db.close();
    new Database(path).close();
    const snapshots = (await readdir(f.dir)).filter((name) =>
      name.includes("old-v4.db.before-v5-"),
    );
    assert.equal(snapshots.length, 1);
  } finally {
    await f.cleanup();
  }
});
