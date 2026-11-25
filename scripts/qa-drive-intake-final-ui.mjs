import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

/** Read only UI verification in one task-owned workbench. */
export async function run({ page, windowId }) {
  const ids = JSON.parse(
    await readFile("/private/tmp/panxu-cmcc-intake-result.json", "utf8"),
  );
  const resource = await page.evaluate(
    (id) => window.panxu.invoke("resource.get", { id }),
    ids.resourceId,
  );
  assert.equal(
    resource.copies.find((c) => c.id === ids.copyId)?.status,
    "ready",
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("searchbox", { name: "搜索标题、标签或资源说明…", exact: true })
    .fill(resource.title);
  const row = page
    .locator("button.resource-row")
    .filter({ hasText: resource.title });
  await row.waitFor();
  await row.click();
  const detail = page.getByRole("region", { name: "当前资源档案" });
  await detail
    .getByRole("region", { name: "本人分享" })
    .locator(".link-box")
    .filter({ hasText: "yun.139.com/shareweb/" })
    .waitFor();
  assert.ok(
    await detail
      .getByRole("button", { name: "复制分享", exact: true })
      .isEnabled(),
  );
  await mkdir("/private/tmp/panxu-drive-intake-final", { recursive: true });
  await page.screenshot({
    path: "/private/tmp/panxu-drive-intake-final/cmcc-library.png",
  });
  const thunderIds = JSON.parse(
    await readFile(
      "/private/tmp/panxu-xunlei-shared-intake-result.json",
      "utf8",
    ),
  );
  const thunder = await page.evaluate(async (id) => {
    const resource = await window.panxu.invoke("resource.get", { id });
    const cover = await window.panxu.invoke("cover.get", {
      id: resource.coverId,
    });
    return {
      resource,
      coverReadable:
        /^data:image\/webp;base64,/.test(cover) && cover.length > 1000,
    };
  }, thunderIds.resourceId);
  assert.ok(thunder.coverReadable);
  assert.equal(
    thunder.resource.copies.find((c) => c.id === thunderIds.copyId)?.status,
    "ready",
  );
  await page
    .getByRole("searchbox", { name: "搜索标题、标签或资源说明…", exact: true })
    .fill(thunder.resource.title);
  await page
    .locator("button.resource-row")
    .filter({ hasText: thunder.resource.title })
    .click();
  await detail
    .getByRole("region", { name: "本人分享" })
    .locator(".link-box")
    .filter({ hasText: "pan.xunlei.com/s/" })
    .waitFor();
  assert.ok(
    await detail
      .getByRole("button", { name: "复制分享", exact: true })
      .isEnabled(),
  );
  await page.screenshot({
    path: "/private/tmp/panxu-drive-intake-final/xunlei-library.png",
  });
  const sync = JSON.parse(
    await readFile("/private/tmp/panxu-xunlei-sync-intake-result.json", "utf8"),
  );
  await page.getByRole("button", { name: "网盘文件", exact: true }).click();
  await page.getByRole("combobox", { name: "网盘类型", exact: true }).click();
  await page.getByRole("option", { name: "迅雷网盘", exact: true }).click();
  await page.getByRole("combobox", { name: "本人账号", exact: true }).click();
  await page.getByRole("option", { name: /130\*{4}1208/ }).click();
  const local = page.getByRole("region", { name: "本地网盘目录" });
  await local
    .locator(".drive-index-status strong[data-state=completed]")
    .waitFor();
  assert.ok(
    (await local.locator(".drive-index-status").innerText()).includes(
      `发现 ${sync.files} 个文件 · ${sync.folders} 个目录 · 0 个待处理`,
    ),
  );
  await page.screenshot({
    path: "/private/tmp/panxu-drive-intake-final/xunlei-index.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      windowId,
      cmcc: {
        resourceId: resource.id,
        status: "ready",
        shareCopyEnabled: true,
      },
      xunlei: {
        resourceId: thunder.resource.id,
        resourceStatus: "ready",
        coverReadable: thunder.coverReadable,
        status: "completed",
        files: sync.files,
        foldersIncludingRoot: sync.folders,
      },
      pageErrors: errors,
    }),
  );
}
