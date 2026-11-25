import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture, file } from "../tests/helpers.ts";

// Browser plugin not available. Dedicated Electron test session + isolated business fixture.
// Flow: saved share -> automatic receipt persistence -> local command copy -> independent share.
export async function run({ page, windowId }) {
  console.log(JSON.stringify({ windowId, phase: "started" }));
  page.setDefaultTimeout(15000);
  const f = await fixture();
  const copied = [],
    errors = [];
  const phrase = "@@囟梨霹稀勺轩且诈竌千#";
  const independent = "@@钱犁忐辣卡褒尺以乒庄#";
  try {
    const saved = await f.add(false, { title: "办公练习清单" });
    const uid = f.provider.uid;
    f.app.db.run(
      "UPDATE accounts SET provider='baidu' WHERE id=?",
      f.account.id,
    );
    f.app.db.run(
      "UPDATE resources SET provider='baidu' WHERE id=?",
      saved.resourceId,
    );
    f.app.db.run(
      "UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-25',files=?,folder_id='0',share_id='saved-share',share_url='https://pan.baidu.com/s/1saved',share_owner_uid=?,share_verified_at='2026-11-25' WHERE id=?",
      uid,
      JSON.stringify([file]),
      uid,
      saved.copyId,
    );
    f.provider.actual = [file];
    f.provider.findOwnShare = async () => null;
    f.provider.createShare = async () => ({
      id: "auto-own",
      url: "https://pan.baidu.com/s/1auto",
      code: "8002",
      ownerUid: uid,
      passphrase: phrase,
    });
    f.provider.createShareWithOptions = async (
      _a,
      _f,
      _t,
      options,
      onCreated,
    ) => {
      const share = {
        id: "independent-share",
        url: "https://pan.baidu.com/s/1independent",
        ownerUid: uid,
        code: options.extractionCode,
        passphrase: independent,
      };
      await onCreated?.(share);
      return share;
    };
    await f.app.shareCreation.createIndependent({
      copyId: saved.copyId,
      operationId: randomUUID(),
      expiresInDays: 0,
      extractionCode: "8002",
    });
    await page.exposeFunction("__sharePassphraseQa", async (method, args) => {
      if (method === "system.copyText") {
        copied.push(args.text);
        return true;
      }
      return f.app.invoke(method, args);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/api/client.ts*", async (route) => {
      const response = await route.fetch(),
        source = await response.text();
      const needle = "return window.panxu.invoke(method, args);";
      assert(source.includes(needle));
      await route.fulfill({
        response,
        body: source.replace(
          needle,
          'return method.startsWith("dev.") ? window.panxu.invoke(method, args) : window.__sharePassphraseQa(method, args);',
        ),
      });
    });
    const show = async () => {
      await page.reload();
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "资源库", exact: true })
        .click();
      await page
        .locator("button.resource-row")
        .filter({ hasText: "办公练习清单" })
        .click();
      return page.getByRole("region", { name: "本人分享" });
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    let own = await show();
    await own.getByText("中文口令 · 未获取", { exact: true }).waitFor();
    assert(
      await own
        .getByRole("button", { name: "复制口令", exact: true })
        .isDisabled(),
    );
    assert.equal(
      await own
        .getByRole("button", { name: "保存官方口令", exact: true })
        .count(),
      0,
    );
    await f.app.invoke("copy.createShare", { copyId: saved.copyId });
    own = await show();
    await own.getByText(phrase, { exact: true }).waitFor();
    await own.getByRole("button", { name: "复制口令", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "中文口令已复制。" })
      .waitFor();
    assert.deepEqual(copied, [phrase]);
    await mkdir("/private/tmp/panxu-share-passphrase", { recursive: true });
    await page.screenshot({
      path: "/private/tmp/panxu-share-passphrase/automatic-library.png",
    });
    await own.getByRole("button", { name: "创建新分享", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "创建新分享",
      exact: true,
    });
    await dialog.getByText(independent, { exact: true }).waitFor();
    assert.equal(
      await dialog.getByRole("textbox", { name: "App 官方分享内容" }).count(),
      0,
    );
    await dialog.getByRole("button", { name: "复制口令", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "中文口令已复制。" })
      .waitFor();
    assert.deepEqual(copied, [phrase, independent]);
    assert.deepEqual(
      await f.app.invoke("share.copyPassphrase", { copyId: saved.copyId }),
      { text: phrase },
    );
    await page.screenshot({
      path: "/private/tmp/panxu-share-passphrase/automatic-new-share.png",
    });
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    // A failed command step leaves a working link; retry must not create a share.
    f.app.db.run(
      "UPDATE accounts SET provider='quark' WHERE id=?",
      f.account.id,
    );
    f.app.db.run(
      "UPDATE resources SET provider='quark' WHERE id=?",
      saved.resourceId,
    );
    f.provider.createShare = async () => ({
      id: "quark-existing",
      url: "https://pan.quark.cn/s/owned",
      code: "8002",
      ownerUid: uid,
      passphraseIssue: "官方组件暂不可用，分享链接已保留。",
    });
    await f.app.invoke("copy.createShare", { copyId: saved.copyId });
    let lookups = 0;
    const quarkWord = "祄二七三一并词玄页娃枫汢";
    f.provider.readSharePassphrase = async (_a, share) => {
      lookups++;
      assert.equal(share.id, "quark-existing");
      return quarkWord;
    };
    f.provider.createShare = async () => assert.fail("重试口令不得重新建分享");
    own = await show();
    await own.getByText("中文口令 · 未获取", { exact: true }).waitFor();
    assert(
      await own
        .getByRole("button", { name: "复制口令", exact: true })
        .isDisabled(),
    );
    await own.getByRole("button", { name: "重试获取", exact: true }).click();
    await own.getByText(quarkWord, { exact: true }).waitFor();
    await own.getByRole("button", { name: "复制口令", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "中文口令已复制。" })
      .waitFor();
    assert.equal(lookups, 1);
    assert.deepEqual(copied, [phrase, independent, quarkWord]);
    await page.screenshot({
      path: "/private/tmp/panxu-share-passphrase/quark-retrieved.png",
    });
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        windowId,
        copied,
        pageErrors: errors,
        realSharesCreated: 0,
        viewport: "1440x900",
      }),
    );
  } finally {
    await f.cleanup();
  }
}
