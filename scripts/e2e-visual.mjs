import { navigateTo } from "./e2e-navigation.mjs";
import { chooseOption } from "./e2e-select.mjs";
// Current-source Electron visual QA. Browser plugin unavailable; isolated profile, blocked external requests.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-visual-"));
const dataPath = join(evidence, "data");
await mkdir(dataPath);
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:8070",
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
  geometry = [];
console.log(`Visual evidence: ${evidence}`);
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.fetch = async () => {
      throw new Error("Visual QA: external request blocked");
    };
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const u = new URL(d.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:8070",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  const seed = await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "夸克主账号",
    });
    const names = [
      "霞鹜文楷轻便版 | 开源字体实测",
      "产品设计交付规范与组件状态清单",
      "AI 办公模板：会议纪要与项目管理",
      "前端工程化实践 · TypeScript 与组件设计",
      "摄影后期素材与色彩管理参考",
      "阅读笔记与个人知识库整理方法",
    ];
    const rows = [];
    for (let i = 0; i < 31; i++)
      rows.push(
        await window.panxu.invoke("resource.save", {
          title:
            names[i] ??
            `项目资料 ${String(i + 1).padStart(2, "0")} · 设计与内容运营参考`,
          sourceText: "https://pan.quark.cn/s/visual-qa-" + i,
          category: i === 0 ? "设计素材" : "学习资料",
          tags:
            i === 0 ? ["开源字体", "霞鹜文楷", "实测"] : ["工作参考", "资料"],
          summary:
            i === 0
              ? "霞鹜文楷轻便版，来源：https://www.100font.com/thread-1481.htm；作者项目：https://github.com/lxgw/LxgwWenKai-Lite。适合版面设计与应用字体嵌入。按作者项目的 SIL OFL 1.1 许可使用，再分发须附带 OFL.txt，不单独售卖字体文件。"
              : "用于整理设计、开发与内容运营中的资料。保留来源记录，并使用本人账号完成归档和分享核验。".repeat(
                  i === 1 ? 25 : 1,
                ),
          accountId: a.id,
          directory: "/盘序资源",
          rightsConfirmed: false,
          enqueue: false,
        }),
      );
    return { a, rows };
  });
  const db = new DatabaseSync(join(dataPath, "panxu.db"));
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE accounts SET uid='visual-owner',status='connected',verified_at=?",
  ).run(now);
  for (const [i, r] of seed.rows.entries()) {
    db.prepare("UPDATE resources SET updated_at=? WHERE id=?").run(
      new Date(Date.now() - i * 60000).toISOString(),
      r.resourceId,
    );
    if (i < 6)
      db.prepare(
        "UPDATE copies SET status='ready',owner_uid='visual-owner',verified_at=?,share_url=?,share_owner_uid='visual-owner',share_verified_at=?,share_id=?,share_version=1 WHERE id=?",
      ).run(
        now,
        "https://pan.quark.cn/s/own-visual-" + i,
        now,
        "own-visual-" + i,
        r.copyId,
      );
  }
  db.close();
  await page.evaluate(
    ({ seed, dataPath }) => {
      localStorage.setItem(
        "panxu-ui-v1",
        JSON.stringify({
          page: "library",
          resourceId: seed.rows[0].resourceId,
          copyId: seed.rows[0].copyId,
        }),
      );
    },
    { seed, dataPath },
  );
  await page.reload();
  await page.locator(".resource-row").first().waitFor();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  const size = async (w, h) => {
    await app.evaluate(
      ({ BrowserWindow }, { w, h }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.setZoomFactor(1);
        win.setSize(w, h);
      },
      { w, h },
    );
    await page.waitForFunction((w) => innerWidth === w, w);
  };
  const shot = async (name) => {
    await page.screenshot({ path: join(evidence, name + ".png") });
  };
  const sample = async (name) => {
    geometry.push(
      await page.evaluate(
        (name) => ({
          name,
          width: innerWidth,
          height: innerHeight,
          main: document.querySelector("main").getBoundingClientRect().toJSON(),
          overflow: document.documentElement.scrollWidth > innerWidth,
          controls: [
            ...document.querySelectorAll(
              ".toolbar .select-control,.toolbar .button,.toolbar .search",
            ),
          ].map((n) => ({
            class: n.className,
            height: n.getBoundingClientRect().height,
          })),
        }),
        name,
      ),
    );
  };
  await size(1600, 1000);
  await page.getByRole("searchbox").fill("字体");
  await chooseOption(page.getByLabel("分类筛选"), "设计素材");
  await chooseOption(page.getByLabel("资源账号筛选"), seed.a.id);
  await page.waitForFunction(
    () => document.querySelectorAll(".resource-row").length === 1,
  );
  await page.getByRole("searchbox").focus();
  await shot("library-filtered-1600");
  await sample("library-filtered-1600");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".resource-row").length === 25,
  );
  await page.locator(".resource-row").first().click();
  await shot("library-1600");
  await sample("library-1600");
  if (!process.env.PANXU_VISUAL_BASELINE) {
    const focus = await page.getByRole("searchbox").evaluate((n) => {
      n.focus();
      return {
        input: getComputedStyle(n).outlineStyle,
        frame: getComputedStyle(n.parentElement).outlineStyle,
      };
    });
    assert.equal(focus.input, "none");
    assert.notEqual(focus.frame, "none");
    const sizes = await page
      .locator(".library-filters")
      .evaluate((n) =>
        [...n.querySelectorAll(".search,.select-control,.button")].map((x) =>
          Math.round(x.getBoundingClientRect().height),
        ),
      );
    assert.equal(new Set(sizes).size, 1, JSON.stringify(sizes));
    const thumb = await page
      .locator(".resource-row .resource-cover.placeholder")
      .first()
      .evaluate((n) => ({
        text: n.textContent,
        icon: n.querySelector("svg").getBoundingClientRect().height,
      }));
    assert.equal(thumb.text, "");
    assert.ok(thumb.icon >= 18);
    const detail = page.locator(".library-layout .resource-detail");
    for (const label of ["复制分享", "创建搜索选题", "编辑资料"]) {
      const rect = await detail
        .getByRole("button", { name: label, exact: true })
        .boundingBox();
      assert.ok(
        rect &&
          rect.y >= 0 &&
          rect.y + rect.height < (await page.evaluate(() => innerHeight)),
        label,
      );
    }
    const mainScroll = await page
      .locator("main")
      .evaluate((n) => n.scrollHeight - n.clientHeight);
    assert.ok(mainScroll < 2, `library page scroll ${mainScroll}`);
    await page.getByRole("button", { name: "展开说明", exact: true }).click();
    await page.getByRole("button", { name: "收起说明", exact: true }).click();
    checks.push(
      "复合搜索统一外框焦点、筛选等高、缩略图无挤压文字、详情与核心操作首屏可达",
    );
  }
  if (!process.env.PANXU_VISUAL_BASELINE) {
    const more = page.getByRole("button", {
      name: "更多资源操作",
      exact: true,
    });
    await more.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("menu", { name: "更多资源操作", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("menuitem").count(), 4);
    assert.equal(
      await page
        .getByRole("menuitem", { name: "打开笔记", exact: true })
        .getAttribute("aria-disabled"),
      "true",
    );
    await shot("library-actions-menu");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    assert.equal(
      await more.evaluate((n) => n === document.activeElement),
      true,
    );
    await page
      .locator(".resource-list-body")
      .evaluate((n) => n.scrollTo(0, n.scrollHeight));
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".resource-row").length === 6,
    );
    assert.equal(
      await page.locator(".resource-list-body").evaluate((n) => n.scrollTop),
      0,
    );
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".resource-row").length === 25,
    );
    await page.getByRole("searchbox").fill("肯定不存在的视觉审核资料");
    await page.getByRole("heading", { name: "没有找到匹配资源" }).waitFor();
    assert.equal(await page.locator(".resource-detail").count(), 0);
    assert.equal(
      await page.locator(".library-layout").getAttribute("data-has-detail"),
      "false",
    );
    await shot("library-no-results");
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await page.locator(".resource-row").first().waitFor();
    checks.push(
      "次要操作菜单键盘开关、禁用与焦点恢复，翻页回到列表顶部，筛选空态释放详情列",
    );
    for (const [w, h] of [
      [1366, 768],
      [1920, 1080],
      [1024, 768],
    ]) {
      await size(w, h);
      await shot(`library-${w}`);
      if (w > 1100) {
        for (const name of ["复制分享", "创建搜索选题", "编辑资料"]) {
          const r = await page
            .locator(".resource-detail-footer")
            .getByRole("button", { name, exact: true })
            .boundingBox();
          assert.ok(
            r && r.y + r.height <= (await page.evaluate(() => innerHeight)),
            `${w}: ${name}`,
          );
        }
      }

      assert.ok(
        await page
          .locator("main")
          .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
      );
    }
    checks.push("1366×768、1920×1080与1024×768原生窗口布局");
  }
  await size(1320, 900);
  for (const name of [
    "资源库",
    "录入资源",
    "批量录入",
    "批量转存",
    "资料拆分",
    "转存任务",
    "搜索运营",
    "流量发现",
    "分享统计",
    "内容工作室",
    "发布准备",
    "账号管理",
    "连接与设置",
    "AI 资源导出",
  ]) {
    await navigateTo(page, name);
    await page.locator("main h1").waitFor();
    await shot("desktop-" + name);
    await sample(name);
    if (!process.env.PANXU_VISUAL_BASELINE && name === "录入资源") {
      const scroll = await page.locator(".workspace-scroll").boundingBox();
      const footer = await page
        .getByRole("group", { name: "资源保存操作" })
        .boundingBox();
      assert.ok(
        scroll && footer && scroll.y + scroll.height <= footer.y,
        "footer must never overlap form",
      );
      await page
        .locator(".workspace-scroll")
        .evaluate((n) => n.scrollTo(0, n.scrollHeight));
      await shot("intake-bottom-actions");
      assert.equal(
        await page.getByText("我有权保存和分享该资源", { exact: true }).count(),
        0,
      );
      checks.push(
        "录入表单滚动区与底部保存栏物理分离，已移除权利勾选且底部操作可达",
      );
    }
    if (!process.env.PANXU_VISUAL_BASELINE && name === "分享统计") {
      assert.equal(await page.locator(".share-stats-toolbar").count(), 0);
      assert.equal(await page.locator(".share-stats-summary").count(), 0);
      const accountHeading = await page
        .getByRole("heading", { name: "账号同步情况", exact: true })
        .boundingBox();
      assert.ok(
        accountHeading &&
          accountHeading.y < (await page.evaluate(() => innerHeight)),
      );
      checks.push("统计首次使用不显示空指标与无效筛选，账号同步进入首屏");
    }
    if (!process.env.PANXU_VISUAL_BASELINE && name === "内容工作室") {
      await page
        .getByRole("button", { name: "新建手工草稿", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "内容正文", exact: true })
        .waitFor();
      await page.locator("main").evaluate((n) => n.scrollTo(0, 0));
      await shot("studio-editor-desktop");
      await page
        .getByRole("textbox", { name: "内容正文", exact: true })
        .fill(
          "适用场景：版面设计与个人知识库。\n\n使用前核对作者项目的许可证与再分发要求。",
        );
      await page.getByRole("button", { name: "保存修改", exact: true }).click();
      await page.getByLabel("已人工审阅", { exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('input[aria-label="已人工审阅"]')?.checked,
      );
      checks.push("紧凑渠道选择、手工编辑、暂存、保存版本与人工审阅流程");
    }
  }
  await size(840, 760);
  await nav("资源库").click();
  await page.locator(".resource-row").first().waitFor();
  await shot("library-840");
  await page.locator(".resource-row").first().click();
  await page.getByRole("dialog", { name: "资源档案", exact: true }).waitFor();
  await shot("library-detail-840");
  if (!process.env.PANXU_VISUAL_BASELINE) {
    const footer = await page.locator(".resource-detail-footer").boundingBox();
    assert.ok(
      footer &&
        footer.y + footer.height <= (await page.evaluate(() => innerHeight)),
    );
    checks.push("840 原生窗口档案对话框操作区始终可达");
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.ok(
    await page.evaluate(() => document.activeElement?.matches(".resource-row")),
  );
  for (const name of [
    "录入资源",
    "流量发现",
    "内容工作室",
    "发布准备",
    "账号管理",
    "连接与设置",
  ]) {
    await navigateTo(page, name);
    await page.locator("main h1").waitFor();
    await shot("compact-" + name);
    await sample("840-" + name);
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await page.getByRole("button", { name: "切换功能", exact: true }).click();
  await nav("资源库").click();
  await page.locator(".resource-row").first().waitFor();
  const zoomHeading = await page.locator("main h1").boundingBox();
  assert.ok(
    zoomHeading && zoomHeading.y < (await page.evaluate(() => innerHeight)),
    "compact navigation must leave main content visible at 200%",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "切换功能", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  const zoomGeometry = await page.locator("main").evaluate((n) => ({
    client: n.clientWidth,
    scroll: n.scrollWidth,
    innerWidth,
    height: innerHeight,
    font: getComputedStyle(n.querySelector("h1")).fontSize,
  }));
  assert.ok(
    zoomGeometry.scroll <= zoomGeometry.client + 1,
    JSON.stringify(zoomGeometry),
  );
  const nativeZoom = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64"),
  );
  await writeFile(
    join(evidence, "library-200-percent.png"),
    Buffer.from(nativeZoom, "base64"),
  );
  geometry.push({ name: "200% native capture", ...zoomGeometry });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  checks.push("原生840与200%缩放无页面横向溢出，关闭档案返回选中行");
  assert.deepEqual(errors, []);
  assert.ok(geometry.every((x) => !x.overflow));
  console.log(JSON.stringify({ evidence, checks, errors }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, geometry }, null, 2),
  );
  await app.close();
}
