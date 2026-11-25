import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fixture, file } from "../tests/helpers.ts";

/** This window uses an isolated AppService; never touches real resources or clipboard. */
export async function run({ page, windowId }) {
  const f = await fixture();
  const calls = [], copied = [], errors = [];
  let remoteCalls = 0;
  try {
    const saved = await f.add(false, { title: "商务分析简历模板" });
    const uid = f.app.repo.getAccount(f.account.id).uid;
    f.app.db.run("UPDATE accounts SET provider='baidu',status='expired' WHERE id=?", f.account.id);
    f.app.db.run("UPDATE resources SET provider='baidu',source_url='https://pan.baidu.com/s/1source' WHERE id=?", saved.resourceId);
    f.app.db.run("UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-25',files=?,share_id='saved-share',share_url='https://pan.baidu.com/s/1dq1PRd0IzjcLtjiHCe8Ibg',share_owner_uid=?,share_verified_at=NULL WHERE id=?", uid, JSON.stringify([file]), uid, saved.copyId);
    f.app.db.run("INSERT INTO share_checks(copy_id,status,checked_at,message) VALUES(?,'unavailable','2026-11-25','网络检查未完成')", saved.copyId);
    await f.app.secrets.set(`share:${saved.copyId}`, "8002");
    f.provider.identity = f.provider.verifyShare = async () => { remoteCalls++; throw Error("离线"); };
    await page.exposeFunction("__copyLinkQa", async (method, args) => {
      calls.push(method);
      if (method === "system.copyText") { copied.push(args.text); return true; }
      return f.app.invoke(method, args);
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/src/api/client.ts*", async route => {
      const response = await route.fetch(), source = await response.text();
      const needle = "return window.panxu.invoke(method, args);";
      assert(source.includes(needle));
      await route.fulfill({ response, body: source.replace(needle,
        'return method.startsWith("dev.") ? window.panxu.invoke(method, args) : window.__copyLinkQa(method, args);') });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
    await page.locator("button.resource-row").filter({ hasText: "商务分析简历模板" }).click();
    const copy = page.getByRole("button", { name: "复制分享", exact: true });
    assert(await copy.isEnabled(), "登录过期和旧检查结果不阻止复制本地分享");
    assert.equal(await copy.getAttribute("title"), "复制已保存的分享链接和提取码");
    calls.length = 0;
    await copy.click();
    await page.getByRole("status").filter({ hasText: "分享链接已复制。" }).waitFor();
    assert.deepEqual(copied, ["https://pan.baidu.com/s/1dq1PRd0IzjcLtjiHCe8Ibg?pwd=8002"]);
    assert.equal(remoteCalls, 0);
    assert(!calls.includes("copies.check"));
    assert.equal(f.app.repo.getCopy(saved.copyId).shareVerifiedAt, null);
    await mkdir("/private/tmp/panxu-copy-link", { recursive: true });
    await page.screenshot({ path: "/private/tmp/panxu-copy-link/library.png" });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ windowId, copied, remoteCalls, pageErrors: errors }));
  } finally { await f.cleanup(); }
}
