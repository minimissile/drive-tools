import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { providerIds } from "../shared/providers";
import type { Account, ResourcePage } from "../shared/types";
import { readLibraryView, saveLibraryView } from "../src/library/view-state";

test("网盘筛选作用于全库分页与计数，并可组合分类、账号和搜索", async () => {
  const f = await fixture();
  try {
    const baidu = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "百度资料账号",
    })) as Account;
    for (let i = 0; i < 28; i++)
      await f.add(false, {
        title: `办公练习${i}`,
        sourceText: `https://pan.quark.cn/s/provider${i}`,
      });
    const migrated = await f.add(false, {
      title: "听力练习材料",
      sourceText: "https://pan.quark.cn/s/providerbaidu",
      category: "学习资料",
    });
    f.app.db.run(
      "UPDATE resources SET provider='baidu' WHERE id=?",
      migrated.resourceId,
    );
    f.app.db.run(
      "UPDATE copies SET account_id=? WHERE id=?",
      baidu.id,
      migrated.copyId,
    );
    const page = (args: Record<string, unknown>) =>
      f.app.invoke("resource.page", args) as Promise<ResourcePage>;
    assert.equal((await page({})).total, 29);
    const second = await page({ provider: "quark", page: 2 });
    assert.equal(second.total, 28);
    assert.equal(second.page, 2);
    assert.equal(second.items.length, 3);
    assert(second.items.every((r) => r.provider === "quark"));
    const filtered = await page({
      provider: "baidu",
      accountId: baidu.id,
      category: "学习资料",
      query: "听力练习",
      page: 999,
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.page, 1);
    assert.equal(filtered.items[0].id, migrated.resourceId);
    const empty = await page({
      provider: "baidu",
      accountId: f.account.id,
      page: 4,
    });
    assert.equal(empty.total, 0);
    assert.equal(empty.page, 1);
    assert.deepEqual(empty.items, []);
    assert.equal(
      (await page({ provider: "quark", query: "听力练习" })).total,
      0,
    );
    for (const provider of providerIds.filter(
      (id) => !["quark", "baidu"].includes(id),
    ))
      assert.equal((await page({ provider })).total, 0, provider);
    await assert.rejects(page({ provider: "unknown" }));
    assert.equal(f.provider.shares, 0);
    assert.equal(f.provider.transfers, 0);
  } finally {
    await f.cleanup();
  }
});

test("网盘筛选偏好兼容旧暂存、校验非法值并按工作空间保存", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const key = "panxu-library-view-v1:/workspace";
  storage.setItem(
    key,
    JSON.stringify({ query: "练习", accountId: "saved", page: 2 }),
  );
  const old = readLibraryView(storage, "/workspace");
  assert.equal(old.provider, "all");
  assert.equal(old.accountId, "saved");
  assert.equal(old.page, 2);
  for (const provider of providerIds) {
    saveLibraryView(storage, "/workspace", { ...old, provider });
    assert.equal(readLibraryView(storage, "/workspace").provider, provider);
  }
  assert.equal(readLibraryView(storage, "/other").provider, "all");
  storage.setItem(key, JSON.stringify({ provider: "unknown" }));
  assert.equal(readLibraryView(storage, "/workspace").provider, "all");
});
