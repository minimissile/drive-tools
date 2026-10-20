import { openAccountForm } from "./e2e-account-form.mjs";
// Browser plugin unavailable. Current-source Electron, temporary DB, no remote writes.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { chooseOption } from "./e2e-select.mjs";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-controls-"));
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
  errors = [],
  measurements = [];
console.log(`Controls evidence: ${evidence}`);
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.fetch = async () => {
      throw Error("Controls QA: external services blocked");
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
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  const size = async (w, h) =>
    app.evaluate(
      ({ BrowserWindow }, { w, h }) =>
        BrowserWindow.getAllWindows()[0].setSize(w, h),
      { w, h },
    );
  const shot = async (name) => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a instanceof CSSTransition)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    const base64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      join(evidence, name + ".png"),
      Buffer.from(base64, "base64"),
    );
  };
  const boundary = async (locator) => {
    await locator.focus();
    await page.waitForFunction(
      (el) => getComputedStyle(el).outlineColor === "rgb(46, 97, 213)",
      await locator.elementHandle(),
    );
    return locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        color: s.outlineColor,
        width: s.outlineWidth,
        offset: s.outlineOffset,
        duration: s.transitionDuration,
        border: s.borderColor,
      };
    });
  };
  await size(1320, 900);
  await nav("账号管理").click();
  await openAccountForm(page);
  const provider = page.getByLabel("新增账号网盘");
  assert.match(await provider.innerText(), /夸克/);
  assert.equal(await provider.getAttribute("data-value"), "quark");
  await provider.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await provider.getAttribute("data-value"), "pikpak");
  assert.equal(
    await provider.evaluate((n) => n === document.activeElement),
    true,
  );
  await provider.press("Space");
  await page.getByRole("listbox").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("role") === "option",
  );
  await page.keyboard.press("Home");

  await page.keyboard.press("Enter");
  assert.equal(await provider.getAttribute("data-value"), "quark");
  await provider.click();
  await page.keyboard.press("Escape");
  assert.equal(
    await provider.evaluate((n) => n === document.activeElement),
    true,
  );
  await provider.click();
  const outside = await page.locator("h1").boundingBox();
  await page.mouse.click(outside.x + 5, outside.y + 5);
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  await chooseOption(provider, "baidu");
  const alias = page.getByLabel("新增账号别名");
  const initial = await alias.boundingBox();
  const normal = await boundary(alias);
  assert.deepEqual(await alias.boundingBox(), initial);
  assert.equal(normal.width, "2px");
  assert.equal(normal.offset, "-1px");
  assert.ok(
    normal.duration
      .split(",")
      .every((t) => Number.parseFloat(t) > 0 && Number.parseFloat(t) <= 0.16),
  );
  await alias.fill("控件验收本人账号");
  await shot("account-input-focus-1320");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  checks.push(
    "下拉初始标签、空值约定、真实鼠标选择、方向键/Home/End、Enter、Esc焦点恢复、外部关闭",
  );
  await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "本人主账号",
    });
    for (let i = 0; i < 42; i++)
      await window.panxu.invoke("resource.save", {
        title: `控件验收资料 ${i}`,
        sourceText: `https://pan.quark.cn/s/controls-${i}`,
        category:
          `分类 ${String(i).padStart(2, "0")}` +
          (i === 41
            ? " · 长分类名称检查弹层文字换行与操作可达性".repeat(2)
            : ""),
        tags: [],
        summary: "临时模拟数据",
        accountId: a.id,
        directory: "/测试",
        rightsConfirmed: false,
        enqueue: false,
      });
    return a;
  });
  await nav("资源库").click();
  const search = page.getByRole("searchbox");
  await search.focus();
  const frame = page.locator(".library-filters .input-frame");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".library-filters .input-frame"))
        .outlineColor === "rgb(46, 97, 213)",
  );
  assert.equal(
    await search.evaluate((n) => getComputedStyle(n).outlineStyle),
    "none",
  );
  const finalCompound = await frame.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      color: s.outlineColor,
      width: s.outlineWidth,
      offset: s.outlineOffset,
      border: s.borderColor,
    };
  });
  for (const k of Object.keys(finalCompound))
    assert.equal(finalCompound[k], normal[k]);
  const category = page.getByLabel("分类筛选");
  const selectFocus = await boundary(category);
  for (const k of ["color", "width", "offset", "border"])
    assert.equal(selectFocus[k], normal[k]);
  await category.click();
  const popup = page.locator(".select-popup");
  await page.getByRole("listbox").waitFor();
  await page.waitForFunction(() => {
    const n = document.querySelector(".select-popup");
    return n && n.scrollHeight > n.clientHeight;
  });
  await page.getByRole("option").last().scrollIntoViewIfNeeded();
  const popupBox = await popup.boundingBox();
  assert.ok(
    popupBox.x >= 0 &&
      popupBox.x + popupBox.width <= (await page.evaluate(() => innerWidth)),
  );
  await shot("library-dropdown-long-options-1320");
  await page.keyboard.press("Escape");
  await chooseOption(category, "分类 05");
  await page.waitForFunction(
    () => document.querySelectorAll(".resource-row").length === 1,
  );
  assert.match(
    await page.locator(".resource-row").innerText(),
    /控件验收资料 5/,
  );
  await chooseOption(category, "all");
  await nav("流量发现").click();
  const source = page.getByRole("combobox", { name: "关联资源", exact: true });
  // SearchSelect has a server-backed query, unlike fixed select lists.
  const resourceInput = (await source.count())
    ? source
    : page.locator(".search-select input").first();
  await resourceInput.fill("控件验收资料 17");
  await page
    .getByRole("option")
    .filter({ hasText: "控件验收资料 17" })
    .first()
    .click();
  assert.match(await resourceInput.inputValue(), /控件验收资料 17/);
  const pages = page.getByLabel("每词查询页数", { exact: true });
  await chooseOption(pages, "2");
  assert.equal(await pages.getAttribute("data-value"), "2");
  checks.push(
    "42项长列表滚动与超长文案、筛选生效、搜索下拉远程读取、数字值迁移",
  );
  await nav("录入资源").click();
  const categoryText = page.getByLabel("分类", { exact: true });
  await categoryText.fill("设计");
  await page.getByRole("option", { name: "设计素材", exact: true }).click();
  assert.equal(await categoryText.inputValue(), "设计素材");
  await categoryText.fill("自定义业务分类");
  await page.getByLabel("资源标题", { exact: true }).click();
  assert.equal(await categoryText.inputValue(), "自定义业务分类");
  const textareaFocus = await boundary(page.getByLabel("资源说明"));
  for (const k of ["color", "width", "offset", "border"])
    assert.equal(textareaFocus[k], normal[k]);
  await chooseOption(page.getByLabel("网盘类型", { exact: true }), "uc");
  const missingAccount = page.getByLabel("转存与分享账号", { exact: true });
  assert.equal(await missingAccount.getAttribute("data-value"), "");
  assert.equal((await missingAccount.innerText()).trim(), "选择本人账号");
  await missingAccount.click();
  const disabledOption = page.getByRole("option", {
    name: "选择本人账号",
    exact: true,
  });
  await disabledOption.waitFor();
  assert.equal(await disabledOption.getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await missingAccount.getAttribute("data-value"), "");
  await nav("连接与设置").click();
  const model = page.locator(".ai-purpose-card input").first();
  await model.fill("qa/manual-model-not-in-catalog");
  await page.getByLabel("比特接口地址").click();
  assert.equal(await model.inputValue(), "qa/manual-model-not-in-catalog");
  const windowId = page.getByLabel("比特窗口ID", { exact: true });
  await windowId.fill("offline-manual-window");
  await page.getByLabel("发布账号别名", { exact: true }).click();
  assert.equal(await windowId.inputValue(), "offline-manual-window");
  const password = page.locator('input[type="password"]').first();
  await password.scrollIntoViewIfNeeded();
  const passwordFocus = await boundary(password);
  for (const k of ["color", "width", "offset", "border"])
    assert.equal(passwordFocus[k], normal[k]);
  await shot("settings-password-focus-1320");
  checks.push(
    "空值与禁用占位、分类建议选择与自由输入、模型/窗口ID离线手填、普通/密码/多行/复合/下拉统一单层焦点",
  );
  await nav("搜索运营").click();
  await page
    .getByRole("button", { name: "新建选题", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "新建搜索选题" });
  const intent = dialog.getByLabel("目标平台", { exact: true });
  await intent.click();
  await page.getByRole("option").last().click();
  await intent.click();
  await page.getByRole("listbox").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("role") === "option",
  );
  await page.keyboard.press("c");
  await page.keyboard.press("Enter");
  assert.equal(await intent.getAttribute("data-value"), "csdn");
  await dialog.getByLabel("目标关键词", { exact: true }).focus();
  assert.equal(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
    true,
  );
  await shot("dialog-custom-select-1320");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  checks.push("表单隐式标签仍可访问；模态弹窗内选择、字母匹配与焦点约束");
  await nav("账号管理").click();
  await openAccountForm(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await boundary(page.getByLabel("新增账号别名"));
  assert.ok(reduced.duration.split(",").every((t) => parseFloat(t) === 0));
  assert.equal(reduced.color, normal.color);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await size(840, 900);
  await nav("资源库").click();
  await page.locator(".resource-row").first().waitFor();
  await category.click();
  await page.getByRole("option").last().scrollIntoViewIfNeeded();
  const small = await popup.boundingBox();
  assert.ok(
    small.x >= 0 &&
      small.x + small.width <= (await page.evaluate(() => innerWidth)),
  );
  await shot("library-dropdown-840");
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await category.click();
  await page.getByRole("listbox").waitFor();
  const zoomOption = page.getByRole("option").last();
  await zoomOption.scrollIntoViewIfNeeded();
  const zoomPopup = await popup.boundingBox();
  const zoomViewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.ok(
    zoomPopup.x >= 0 && zoomPopup.x + zoomPopup.width <= zoomViewport.width,
  );
  assert.ok(
    zoomPopup.y >= 0 && zoomPopup.y + zoomPopup.height <= zoomViewport.height,
  );
  await shot("library-dropdown-840-zoom200");
  const zoomValue = await zoomOption.getAttribute("data-value");
  await zoomOption.click();
  assert.equal(await category.getAttribute("data-value"), zoomValue);
  await page.waitForFunction(
    () => document.querySelectorAll(".resource-row").length === 1,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await size(1320, 900);
  for (const name of [
    "资源库",
    "AI 资源导出",
    "录入资源",
    "批量录入",
    "批量转存",
    "资料拆分",
    "转存任务",
    "搜索运营",
    "流量发现",
    "内容工作室",
    "发布准备",
    "分享统计",
    "账号管理",
    "连接与设置",
  ]) {
    await nav(name).click();
    await page.locator("main h1").waitFor();
    assert.equal(
      await page.locator("select:visible,datalist").count(),
      0,
      name,
    );
    const controls = await page.locator(".select-control").count();
    measurements.push({ page: name, controls });
    assert.ok(
      await page
        .locator("main")
        .evaluate((n) => n.scrollWidth <= n.clientWidth),
      name,
    );
  }
  checks.push(
    "减少动态效果保留焦点且关闭过渡；840px/200%实际捕获；14模块无可见系统下拉与页面横向溢出",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ checks, measurements, errors, evidence }, null, 2),
  );
} catch (e) {
  console.error(
    "Controls failure:",
    await page
      ?.evaluate(() => ({
        heading: document.querySelector("h1")?.innerText,
        focus: document.activeElement?.outerHTML.slice(0, 600),
        body: document.body.innerText.slice(-1700),
      }))
      .catch(() => null),
  );
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw e;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, measurements, errors }, null, 2),
  );
  await app.close();
}
