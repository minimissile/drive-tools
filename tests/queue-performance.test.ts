import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import { AppError } from "../core/errors";

test("单次转存全流程只持有一个浏览器会话，归档后释放，完成任务不再访问网盘", async () => {
  const f = await fixture();
  let sessions = 0,
    active = false,
    requests = 0;
  const methods = [
    "identity",
    "inspect",
    "ensureFolder",
    "list",
    "transfer",
    "poll",
    "createShare",
  ] as const;
  try {
    const saved = await f.add();
    f.app.driveBrowsers.isBound = (id) => id === f.account.id;
    f.app.driveBrowsers.withRequestSession = async (_id, action) => {
      sessions++;
      assert(!active);
      active = true;
      try {
        return await action();
      } finally {
        active = false;
      }
    };
    for (const method of methods) {
      const original = f.provider[method].bind(f.provider);
      Object.assign(f.provider, {
        [method]: async (...args: unknown[]) => {
          assert(active, `${method}应复用本次任务会话`);
          requests++;
          return Reflect.apply(original, f.provider, args);
        },
      });
    }
    const afterShare = f.app.resourceLinks.afterShareSaved.bind(
      f.app.resourceLinks,
    );
    f.app.resourceLinks.afterShareSaved = async (...args) => {
      assert(!active, "固定入口同步不占用网盘浏览器会话");
      return afterShare(...args);
    };
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
    assert.equal(sessions, 1);
    assert(requests > 8, "多次网盘读取和写入均在同一会话中完成");
    const count = requests;
    await f.app.queue.execute(saved.jobId);
    assert.equal(requests, count);
    assert.equal(sessions, 1);
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.provider.shares, 1);
  } finally {
    await f.cleanup();
  }
});

test("会话建立失败阻止转存，显式恢复时重新建立会话", async () => {
  const f = await fixture();
  let sessions = 0,
    fail = true;
  try {
    const saved = await f.add();
    f.app.driveBrowsers.isBound = () => true;
    f.app.driveBrowsers.withRequestSession = async (_id, action) => {
      sessions++;
      if (fail) throw new AppError("AUTH_EXPIRED", "登录已失效");
      return action();
    };
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "waiting_login");
    assert.equal(f.provider.transfers, 0);
    fail = false;
    await f.app.queue.execute(saved.jobId);
    assert.equal(sessions, 2);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
  } finally {
    await f.cleanup();
  }
});

for (const selectedPage of [1, 2])
  test(`预检在第${selectedPage}页找到全部所选文件后停止翻页`, async () => {
    const f = await fixture();
    const pages: number[] = [];
    try {
      f.provider.inspect = async (_a, source, parentId = "0", page = 1) => {
        pages.push(page);
        return {
          shareKey: source.shareKey,
          title: "资料",
          parentId,
          page,
          files: page === selectedPage ? [file] : [],
          hasMore: true,
        };
      };
      const saved = await f.add();
      await f.app.queue.execute(saved.jobId);
      assert.deepEqual(pages, selectedPage === 1 ? [1] : [1, 2]);
      assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
    } finally {
      await f.cleanup();
    }
  });

test("找不到所选文件时仍阻止转存，不能以减少翻页放过来源变化", async () => {
  const f = await fixture();
  try {
    f.provider.inspect = async (_a, source, parentId = "0", page = 1) => ({
      shareKey: source.shareKey,
      title: "资料",
      parentId,
      page,
      files: [],
      hasMore: false,
    });
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.provider.transfers, 0);
    assert.match(f.app.repo.getJob(saved.jobId).error!, /已选文件发生变化/);
  } finally {
    await f.cleanup();
  }
});

test("恢复未知转存结果时仅读取一次目标清单，并保留防重复提交保护", async () => {
  const f = await fixture();
  try {
    f.provider.failTransfer = true;
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    assert.equal(
      f.app.repo.getJob(saved.jobId).checkpoint,
      "transfer_requested",
    );
    let reads = 0;
    const list = f.provider.list.bind(f.provider);
    f.provider.list = async () => {
      reads++;
      return list();
    };
    f.provider.failTransfer = false;
    await f.app.queue.execute(saved.jobId);
    assert.equal(reads, 1);
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
  } finally {
    await f.cleanup();
  }
});

test("转存任务不先创建空入口，归档后一次同步到已验证的本人分享", async () => {
  let cloud: unknown = null;
  const puts: any[] = [];
  const f = await fixture(
    {},
    {
      resourceLinksFetch: async (url, init) => {
        if (init.method === "PUT") {
          const input = JSON.parse(String(init.body));
          puts.push(input);
          cloud = {
            ...input,
            id: new URL(url).pathname.split("/").at(-1),
            url: `https://panxu.site/r/${input.slug}`,
            revision: input.expectedRevision + 1,
            lastOperationId: input.operationId,
            updatedAt: new Date().toISOString(),
          };
        }
        return Response.json(cloud);
      },
    },
  );
  try {
    await f.app.resourceLinks.configure({
      enabled: true,
      baseUrl: "https://panxu.site",
      token: "x".repeat(32),
    });
    const saved = await f.add();
    assert.equal(puts.length, 0, "入队不等待固定入口服务");
    await f.app.resourceLinks.afterShareSaved(saved.copyId);
    assert.equal(puts.length, 0, "普通分享核验不顺带新建入口");
    await f.app.queue.execute(saved.jobId);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].targetUrl, f.provider.ownUrl);
    assert.equal(
      (await f.app.resourceLinks.context(saved.resourceId)).link?.state,
      "synced",
    );
    const logs = f.app.repo.getJob(saved.jobId).logs.map((l) => l.message);
    for (const label of ["预检", "转存", "校验文件", "本人分享", "本地归档"])
      assert(logs.includes(`开始${label}。`));
  } finally {
    await f.cleanup();
  }
});
