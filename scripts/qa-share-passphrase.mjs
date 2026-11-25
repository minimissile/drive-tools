import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture, file } from "../tests/helpers.ts";

/** Isolated business fixture bridged only into this task's renderer. No real share creation. */
export async function run({ page, windowId }) {
  console.log(JSON.stringify({ windowId, phase: "started" }));
  page.setDefaultTimeout(15000);
  const f = await fixture();
  const copied = [],
    errors = [];
  const phrase = "祄五低诶及并词玄符一已汢";
  const url = "https://pan.quark.cn/s/259effdd6c9a";
  const original = `我用夸克网盘给你分享了「2024年Flu...(完结)」，点击链接或复制整段内容，打开「夸克APP」即可获取。\n${phrase}\n/~720e3cXFG4~:/\n链接：${url}`;
  try {
    const saved = await f.add(false, { title: "办公练习清单" });
    const uid = f.provider.uid;
    f.app.db.run(
      "UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-25',files=?,share_id='saved-share',share_url=?,share_owner_uid=?,share_verified_at='2026-11-25' WHERE id=?",
      uid,
      JSON.stringify([file]),
      url,
      uid,
      saved.copyId,
    );
    f.provider.createShareWithOptions = async (_a, _f, _t, options) => ({
      id: "independent-share",
      url: "https://pan.quark.cn/s/independent",
      ownerUid: uid,
      code: options.extractionCode,
    });
    const operationId = randomUUID();
    await f.app.shareCreation.createIndependent({
      copyId: saved.copyId,
      operationId,
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "资源库", exact: true })
      .click();
    await page
      .locator("button.resource-row")
      .filter({ hasText: "办公练习清单" })
      .click();
    const own = page.getByRole("region", { name: "本人分享" });
    await own.getByText("中文口令 · 未获取", { exact: true }).waitFor();
    assert(
      await own
        .getByRole("button", { name: "复制口令", exact: true })
        .isDisabled(),
    );
    await own
      .getByRole("button", { name: "保存官方口令", exact: true })
      .click();
    await own
      .getByRole("textbox", { name: "App 官方分享内容", exact: true })
      .fill(original);
    await own.getByRole("button", { name: "保存口令", exact: true }).click();
    await own.getByText(phrase, { exact: true }).waitFor();
    await own.getByRole("button", { name: "复制口令", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "中文口令已复制。" })
      .waitFor();
    assert.deepEqual(copied, [phrase]);
    await own.getByRole("button", { name: "创建新分享", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "创建新分享",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "保存官方口令", exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: "App 官方分享内容", exact: true })
      .fill(original);
    await dialog.getByRole("button", { name: "保存口令", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "这段内容中的分享链接或提取码与当前分享不一致" })
      .waitFor();
    assert.equal(
      await dialog
        .getByRole("textbox", { name: "App 官方分享内容" })
        .inputValue(),
      original,
    );
    const independent = "独立分享中文口令";
    await dialog
      .getByRole("textbox", { name: "App 官方分享内容" })
      .fill(`${independent}\nhttps://pan.quark.cn/s/independent?pwd=8002`);
    await dialog.getByRole("button", { name: "保存口令", exact: true }).click();
    await dialog.getByRole("button", { name: "复制口令", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "中文口令已复制。" })
      .waitFor();
    assert.deepEqual(copied, [phrase, independent]);
    assert.equal(
      (await f.app.invoke("share.copyPassphrase", { copyId: saved.copyId }))
        .text,
      phrase,
    );
    await mkdir("/private/tmp/panxu-share-passphrase", { recursive: true });
    await page.screenshot({
      path: "/private/tmp/panxu-share-passphrase/new-share.png",
    });
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.screenshot({
      path: "/private/tmp/panxu-share-passphrase/library.png",
    });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        windowId,
        copied,
        pageErrors: errors,
        realSharesCreated: 0,
      }),
    );
  } finally {
    await f.cleanup();
  }
}
