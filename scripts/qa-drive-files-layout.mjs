import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

// Browser plugin not available: use the project's exact-ID Playwright session.
async function layoutMock(method, args) {
  const qa = (window.__driveLayoutQa ??= {
    scene: sessionStorage.getItem("drive-layout-scene") || "completed",
    calls: [],
    base: null,
  });
  const time = "2026-11-24T08:00:00.000Z";
  if (method === "snapshot") {
    const base = (qa.base ??= await window.panxu.invoke(method, args));
    return {
      ...base,
      dataPath: base.dataPath + "/drive-files-layout-qa",
      accounts: [
        {
          id: "layout-a",
          provider: "quark",
          alias: "设计与编程学习资料归档账号",
          uid: "owner-a",
          status: "connected",
          enabled: true,
          isDefault: true,
          browserEngine: "electron",
          defaultDirectory: "/",
          resourceCopies: 12,
          error: null,
        },
        {
          id: "layout-b",
          provider: "uc",
          alias: "尚未同步的资料账号",
          uid: "owner-b",
          status: "expired",
          enabled: true,
          isDefault: true,
          browserEngine: "electron",
          defaultDirectory: "/",
          resourceCopies: 0,
          error: null,
        },
      ],
    };
  }
  const names = [
    "课程资料",
    "设计软件与常用素材",
    "项目文档与阶段交付归档",
    "设计系统使用说明与组件规范.pdf",
    "从零开始学习编程的练习与答案.docx",
    "桌面应用交互设计课程完整版.mp4",
    "产品需求与实现记录.md",
    "界面设计参考与阅读清单.pdf",
    "素材使用说明.txt",
    "排版示例与基础练习.zip",
    "图标与插画素材包.zip",
    "阶段总结与后续学习计划.docx",
    "项目文件归档目录清单.xlsx",
    "跨平台应用开发资源合集.zip",
    "文件管理与数据同步实践笔记.pdf",
  ];
  const files = names.map((name, i) => ({
    id: i < 3 ? `folder-${i}` : `file-${i}`,
    name,
    parentId: "@root",
    path: "/" + name,
    isDirectory: i < 3,
    size: i < 3 ? null : 1024 * 1024 * (i + 1),
    observedAt: time,
    missing: false,
    state: i % 4 === 0 ? "recorded" : i % 4 === 1 ? "review" : "unrecorded",
    resources:
      i % 4 === 0
        ? [
            { id: "r1", copyId: "c1", title: "学习资料与设计实践资源合集" },
            {
              id: "r2",
              copyId: "c2",
              title: "跨平台桌面应用工程与视觉规范长标题资料集",
            },
          ]
        : [],
  }));
  if (method.startsWith("driveSync.")) qa.calls.push({ method, args });
  if (method === "driveSync.index") {
    if (qa.scene === "error")
      throw Error("本地目录暂时无法读取，请重试；原有文件索引已保留。");
    const empty = args.accountId === "layout-b";
    const nested = args.parentId && args.parentId !== "@root";
    let items = empty
      ? []
      : nested
        ? files.slice(3).map((f) => ({
            ...f,
            parentId: args.parentId,
            path: "/课程资料/设计基础/" + f.name,
          }))
        : files;
    if (args.search?.trim())
      items = files.filter((f) => f.name.includes(args.search.trim()));
    if (args.foldersOnly)
      items = nested ? [] : items.filter((f) => f.isDirectory);
    if (args.state && args.state !== "all")
      items = items.filter((f) => f.state === args.state);
    const status = qa.scene;
    return {
      items,
      total: items.length,
      page: 1,
      pageSize: 50,
      ownerUid: empty ? "owner-b" : "owner-a",
      lastCompleteAt: empty ? null : time,
      breadcrumbs: nested
        ? [
            { id: "folder-0", name: "课程资料" },
            { id: "folder-deep", name: "设计基础与跨平台项目文件归档" },
          ]
        : [],
      run: empty
        ? null
        : {
            id: "layout-run",
            accountId: "layout-a",
            ownerUid: "owner-a",
            environment: "native",
            status,
            files: 1024,
            folders: 189,
            pending: status === "running" ? 74 : 0,
            failed: status === "partial" ? 2 : 0,
            message:
              status === "partial"
                ? "/课程资料/项目文件/设计与研发共享的历史交付资料：网络读取未完成，已保留原索引。请重试未完成目录。"
                : "",
            createdAt: time,
            updatedAt: time,
            completedAt: status === "completed" ? time : null,
          },
    };
  }
  if (
    method === "driveSync.start" ||
    method === "driveSync.resume" ||
    method === "driveSync.pause"
  ) {
    qa.scene = method === "driveSync.pause" ? "paused" : "running";
    sessionStorage.setItem("drive-layout-scene", qa.scene);
    return {};
  }
  if (method === "driveSync.register")
    return args.entries.map((e) => ({
      fileId: e.fileId,
      resourceId: "registered",
    }));
  if (method === "drive.directory")
    return {
      accountId: "layout-a",
      provider: "quark",
      path: args.path,
      folderId: "0",
      readAt: time,
      files: files.map((f) => ({ ...f, parentId: "0" })),
      capabilities: { rename: true, delete: true, upload: true },
      pending: null,
    };
  if (method.startsWith("drive.")) throw Error("布局验收不得提交网盘变更");
  return window.panxu.invoke(method, args);
}

export async function run({ page, windowId, checkpoint }) {
  const stage = process.env.PANXU_DRIVE_LAYOUT_STAGE || "after";
  const out = `/private/tmp/panxu-drive-files-layout/${stage}-${windowId}`;
  await mkdir(out, { recursive: true });
  console.log(JSON.stringify({ stage, windowId, out }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch({ maxRetries: 2 }),
      body = await response.text(),
      next = body.replace(
        /return window\.panxu\.invoke[^;]+;/,
        "return layoutMock(method,args);",
      );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: layoutMock.toString() + "\n" + next,
      contentType: "application/javascript",
    });
  });
  const scene = async (name) => {
    await page.evaluate(
      (name) => sessionStorage.setItem("drive-layout-scene", name),
      name,
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "网盘文件", exact: true })
      .waitFor();
  };
  const top = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll("*"))
        if (el.scrollTop) el.scrollTop = 0;
    });
  const measure = () =>
    page.evaluate(() => {
      const table = document.querySelector(".drive-index-table");
      const rows = [...(table?.querySelectorAll("tbody tr") ?? [])];
      const clip = table
        ?.closest(".drive-index-table-wrap")
        ?.getBoundingClientRect();
      return {
        tableTop: table?.getBoundingClientRect().top,
        visibleRows: rows.filter((r) => {
          const b = r.getBoundingClientRect();
          return (
            b.top >= Math.max(0, clip?.top ?? 0) &&
            b.bottom <= Math.min(innerHeight, clip?.bottom ?? innerHeight)
          );
        }).length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
  try {
    await page.reload();
    await page
      .getByRole("heading", { name: "网盘文件", exact: true })
      .waitFor();
    await page.getByRole("combobox", { name: "本人账号", exact: true }).click();
    await page
      .getByRole("option", {
        name: "设计与编程学习资料归档账号 · 夸克",
        exact: true,
      })
      .click();
    await page.getByRole("table").waitFor();
    await top();
    const metrics = await measure();
    await page.screenshot({ path: out + "/local-1366.png", fullPage: false });
    if (stage === "before") {
      await writeFile(out + "/metrics.json", JSON.stringify(metrics, null, 2));
      console.log(JSON.stringify({ metrics, out }));
      return;
    }
    assert.ok(metrics.visibleRows >= 4, `首屏只显示 ${metrics.visibleRows} 行`);
    assert.equal(metrics.horizontalOverflow, false);
    await page
      .getByRole("button", { name: "关联资源（2）：课程资料", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: "查看资源：跨平台桌面应用工程与视觉规范长标题资料集",
        exact: true,
      })
      .waitFor();
    await page.screenshot({
      path: out + "/resource-menu-1366.png",
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await page
      .locator(".drive-index-table-wrap")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    const scroll = await page
      .locator(".drive-index-table-wrap")
      .evaluate((el) => ({
        scrolled: el.scrollTop > 0,
        headerTop: el.querySelector("th").getBoundingClientRect().top,
        clipTop: el.getBoundingClientRect().top,
      }));
    assert.equal(scroll.scrolled, true);
    assert.ok(Math.abs(scroll.headerTop - scroll.clipTop) < 2);
    await top();
    await page
      .getByRole("table")
      .getByRole("button", { name: "课程资料", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "本地目录路径", exact: true })
      .getByRole("button", {
        name: "设计基础与跨平台项目文件归档",
        exact: true,
      })
      .waitFor();
    assert.ok(
      await page
        .locator(".drive-index-breadcrumb")
        .evaluate((el) => el.getBoundingClientRect().height <= 48),
    );
    await page
      .getByRole("navigation", { name: "本地目录路径", exact: true })
      .getByRole("button", { name: "全部文件", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "本地目录路径", exact: true })
      .waitFor({ state: "hidden" });
    await page
      .getByRole("searchbox", { name: "搜索本地目录", exact: true })
      .fill("设计系统");
    await page
      .getByRole("table")
      .getByText("设计系统使用说明与组件规范.pdf", { exact: true })
      .waitFor();
    await page
      .getByRole("searchbox", { name: "搜索本地目录", exact: true })
      .fill("");
    await page
      .getByRole("checkbox", {
        name: "选择 产品需求与实现记录.md",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "录入资源库", exact: true }).click();
    await page
      .getByRole("heading", { name: "录入预览 · 1 项", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "/产品需求与实现记录.md", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.screenshot({ path: out + "/preview-1366.png", fullPage: false });
    await page.getByRole("button", { name: "收起预览", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "录入资源库", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await checkpoint();
    await scene("running");
    await page.getByRole("button", { name: "暂停同步", exact: true }).waitFor();
    await top();
    await page.screenshot({ path: out + "/running-1366.png", fullPage: false });
    await scene("partial");
    await page
      .getByRole("button", { name: "重试未完成目录", exact: true })
      .waitFor();
    await top();
    await page.screenshot({ path: out + "/partial-1366.png", fullPage: false });
    await page.getByRole("tab", { name: "实时网盘", exact: true }).click();
    await page.getByRole("button", { name: "读取目录", exact: true }).click();
    await page
      .getByRole("button", { name: "新建文件夹", exact: true })
      .waitFor();
    await top();
    await page.screenshot({ path: out + "/remote-1366.png", fullPage: false });
    await page.getByRole("tab", { name: "本地目录", exact: true }).click();
    await page.getByRole("combobox", { name: "本人账号", exact: true }).click();
    await page
      .getByRole("option", { name: "尚未同步的资料账号 · UC", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "先同步网盘目录", exact: true })
      .waitFor();
    await top();
    await page.screenshot({ path: out + "/empty-1366.png", fullPage: false });
    await page.getByRole("combobox", { name: "本人账号", exact: true }).click();
    await page
      .getByRole("option", {
        name: "设计与编程学习资料归档账号 · 夸克",
        exact: true,
      })
      .click();
    await scene("completed");
    await page.getByRole("table").waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await top();
    await page.screenshot({ path: out + "/local-1440.png", fullPage: false });
    await scene("error");
    await page.getByRole("button", { name: "重试读取", exact: true }).waitFor();
    await top();
    await page.screenshot({ path: out + "/error-1440.png", fullPage: false });
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    await writeFile(out + "/metrics.json", JSON.stringify(metrics, null, 2));
    console.log(
      JSON.stringify({
        metrics,
        out,
        checks:
          "local,selection,search,running,partial,remote,empty,error,desktop",
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          overlay: !!document.querySelector("vite-error-overlay"),
          inputs: [...document.querySelectorAll("input")].map((el) => ({
            value: el.value,
            label: el.closest("label")?.textContent,
          })),
        })),
      ),
    );
    await page
      .screenshot({ path: out + "/failure.png", fullPage: false })
      .catch(() => {});
    throw error;
  }
}
