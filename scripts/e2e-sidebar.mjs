// Browser plugin unavailable: validate only the current-source shell and navigation, with disposable local data.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-sidebar-"));
const dataPath = join(evidence, "data");
await mkdir(dataPath);
const identity = await fetch("http://127.0.0.1:5173/__panxu_dev").then((r) =>
  r.json(),
);
assert.equal(identity.root, process.cwd());
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:5173",
  PANXU_DEV_ROOT: process.cwd(),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [join(process.cwd(), "dist-dev")],
  env,
  timeout: 45000,
});
const checks = [],
  errors = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.fetch = async () => {
      throw Error("Sidebar QA: external services blocked");
    };
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const u = new URL(d.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:5173",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  const nav = page.getByRole("navigation", { name: "主导航" });
  const size = (w, h) =>
    app.evaluate(
      ({ BrowserWindow }, [w, h]) =>
        BrowserWindow.getAllWindows()[0].setSize(w, h),
      [w, h],
    );
  const shot = async (name) => {
    await page.mouse.move(500, 40);
    await page.waitForTimeout(200);
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(evidence, name + ".png"), Buffer.from(png, "base64"));
  };
  assert.equal(
    await page.getByRole("button", { name: "切换功能", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator(".sidebar .workspace, .sidebar .avatar").count(),
    0,
  );
  assert.equal(await nav.getByRole("button").count(), 14);
  assert.equal(await page.locator(".nav-group").count(), 4);
  checks.push(
    "删除页面下拉入口与工作空间身份块，保留全部 14 个导航入口和四个分组",
  );
  for (const [w, h] of [
    [1320, 900],
    [840, 760],
    [840, 600],
  ]) {
    await size(w, h);
    await nav.evaluate((el) => (el.scrollTop = 0));
    assert.equal(await nav.isVisible(), true);
    await shot(`sidebar-${w}-${h}`);
    const footer = await page.locator(".sidebar-footer").boundingBox();
    const box = await nav.boundingBox();
    assert.ok(box.y + box.height <= footer.y + 1);
    assert.equal(
      await page
        .locator(".sidebar")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
    const settings = nav.getByRole("button", {
      name: "连接与设置",
      exact: true,
    });
    await settings.focus();
    assert.equal(
      await settings.evaluate((el) => el === document.activeElement),
      true,
    );
    await settings.press("Enter");
    await page.locator('main[data-page="settings"] .settings-page').waitFor();
    assert.equal(await settings.getAttribute("aria-current"), "page");
    assert.equal(await nav.locator('[aria-current="page"]').count(), 1);
    await shot(`sidebar-bottom-${w}-${h}`);
    await nav.getByRole("button", { name: "资源库", exact: true }).click();
    await page.locator('main[data-page="library"] .resource-list').waitFor();
    assert.equal(
      await nav
        .getByRole("button", { name: "资源库", exact: true })
        .getAttribute("aria-current"),
      "page",
    );
  }
  checks.push(
    "1320px 与 840px/760px、600px 高度下导航可滚动，底部不遮挡，键盘切页和唯一选中态正确",
  );
  await size(840, 760);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await nav
    .getByRole("button", { name: "资源库", exact: true })
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.ok(duration.split(",").every((v) => v.trim() === "0s"));
  checks.push("导航复用公共键盘焦点及减少动态效果设置");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await size(1320, 900);
  await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.locator('main[data-page="settings"] .settings-page').waitFor();
  assert.equal(await nav.isVisible(), true);
  assert.equal(
    await page.getByRole("button", { name: "切换功能", exact: true }).count(),
    0,
  );
  await shot("sidebar-200-percent");
  checks.push("200% 缩放进入紧凑布局后导航仍可直接使用，不依赖已删除下拉按钮");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await app.close();
}
