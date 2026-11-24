import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// Browser plugin not available. Use the project's exact-ID Playwright test session.
async function syncMock(method, args) {
  const state = (window.__driveSyncQa ??= JSON.parse(
    sessionStorage.getItem("driveSyncQa") || "null",
  ) ?? { calls: [], started: false, run: null, base: null, registered: false });
  if (method === "snapshot") {
    const base = (state.base ??= await window.panxu.invoke(method, args));
    return {
      ...base,
      dataPath: base.dataPath + "/drive-sync-ui-qa",
      accounts: [
        {
          id: "index-qa",
          provider: "quark",
          alias: "夸克离线目录账号",
          uid: "owner",
          status: "expired",
          enabled: true,
          isDefault: true,
          defaultDirectory: "/",
          resourceCopies: 1,
          browserEngine: "electron",
          error: null,
        },
      ],
    };
  }
  if (method.startsWith("driveSync.")) state.calls.push({ method, args });
  const time = "2026-11-24T08:00:00.000Z";
  const make = (
    id,
    name,
    dir = false,
    stateName = "unrecorded",
    parentId = "@root",
  ) => ({
    id,
    name,
    parentId,
    isDirectory: dir,
    path: (parentId === "@root" ? "" : "/资料") + "/" + name,
    size: dir ? null : 1048576,
    observedAt: time,
    missing: false,
    state: stateName,
    resources: [],
  });
  if (method === "driveSync.index") {
    let items = !state.started
      ? []
      : args.parentId === "folder"
        ? [make("new", "新增文件.pdf", false, "review", "folder")]
        : [
            make("folder", "资料", true, "recorded"),
            make(
              "file",
              "学习资料与配套练习完整版本.pdf",
              false,
              state.registered ? "recorded" : "unrecorded",
            ),
            make("recorded", "已有资源.pdf", false, "recorded"),
          ];
    if (args.foldersOnly) items = items.filter((e) => e.isDirectory);
    if (args.search?.trim())
      items = items.filter((e) => e.name.includes(args.search.trim()));
    if (args.state && args.state !== "all")
      items = items.filter((e) => e.state === args.state);
    return {
      items,
      total: items.length,
      page: 1,
      pageSize: 50,
      ownerUid: "owner",
      run: state.run,
      lastCompleteAt: state.run?.status === "completed" ? time : null,
      breadcrumbs:
        args.parentId === "folder" ? [{ id: "folder", name: "资料" }] : [],
    };
  }
  if (method === "driveSync.start") {
    state.started = true;
    state.run = {
      id: "run",
      accountId: "index-qa",
      ownerUid: "owner",
      environment: "native",
      status: "running",
      files: 3,
      folders: 2,
      pending: 1,
      failed: 0,
      message: "",
      createdAt: time,
      updatedAt: time,
      completedAt: null,
    };
    return state.run;
  }
  if (method === "driveSync.pause") {
    state.run.status = "paused";
    return state.run;
  }
  if (method === "driveSync.resume") {
    state.run.status = "completed";
    state.run.pending = 0;
    state.run.completedAt = time;
    return state.run;
  }
  if (method === "driveSync.register") {
    state.registered = true;
    return args.entries.map((e) => ({
      fileId: e.fileId,
      resourceId: "resource",
    }));
  }
  if (method.startsWith("drive.")) throw Error("UI 模拟不得访问真实网盘");
  return window.panxu.invoke(method, args);
}
export async function run({ page, windowId, checkpoint }) {
  console.log(JSON.stringify({ windowId, phase: "opened" }));
  const output = `/private/tmp/panxu-drive-sync-ui/${windowId}`;
  await mkdir(output, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch({ maxRetries: 2 }),
      body = await response.text();
    const next = body.replace(
      /return window\.panxu\.invoke[^;]+;/,
      "return syncMock(method,args);",
    );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: syncMock.toString() + "\n" + next,
      contentType: "application/javascript",
    });
  });
  await page.reload();
  await page.getByRole("heading", { name: "网盘文件", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "本人账号", exact: true }).click();
  await page
    .getByRole("option", { name: "夸克离线目录账号 · 夸克", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "先同步网盘目录", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "同步整个网盘", exact: true }).click();
  await page.getByRole("button", { name: "暂停同步", exact: true }).waitFor();
  await page.getByRole("button", { name: "暂停同步", exact: true }).click();
  await page.getByRole("button", { name: "继续同步", exact: true }).waitFor();
  await page.getByRole("button", { name: "继续同步", exact: true }).click();
  await page
    .getByRole("button", { name: "更新本地目录", exact: true })
    .waitFor();
  await checkpoint();
  await page
    .getByRole("checkbox", {
      name: "选择 学习资料与配套练习完整版本.pdf",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "录入资源库", exact: true }).click();
  await page
    .getByRole("heading", { name: "录入预览 · 1 项", exact: true })
    .waitFor();
  await page
    .getByRole("textbox", {
      name: "/学习资料与配套练习完整版本.pdf",
      exact: true,
    })
    .fill("学习资料与配套练习");
  await page.screenshot({
    path: output + "/registration.png",
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "核对网盘并保存资源", exact: true })
    .click();
  await page.waitForFunction(() => window.__driveSyncQa.registered, undefined, {
    timeout: 10000,
  });
  await page
    .getByRole("heading", { name: "录入预览 · 1 项", exact: true })
    .waitFor({ state: "hidden" });
  const search = page.getByRole("searchbox", {
    name: "搜索本地目录",
    exact: true,
  });
  await search.fill("不存在的文件");
  await page
    .getByRole("heading", { name: "此处没有匹配内容", exact: true })
    .waitFor();
  await search.fill("");
  await page.getByRole("table").waitFor();
  await page
    .getByRole("complementary", { name: "本地目录树", exact: true })
    .getByRole("button", { name: "全部文件", exact: true })
    .waitFor();
  await page
    .getByRole("cell")
    .filter({ has: page.getByRole("button", { name: "资料", exact: true }) })
    .getByRole("button", { name: "资料", exact: true })
    .click();
  await page.getByText("新增文件.pdf", { exact: true }).waitFor();
  await page.getByTitle("资源目录内新增内容", { exact: true }).waitFor();
  await page.screenshot({
    path: output + "/local-directory.png",
    fullPage: false,
  });
  await page.evaluate(() =>
    sessionStorage.setItem("driveSyncQa", JSON.stringify(window.__driveSyncQa)),
  );
  await page.reload();
  await page.getByText("新增文件.pdf", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__driveSyncQa.calls);
  assert.ok(
    calls.some(
      (c) =>
        c.method === "driveSync.register" &&
        c.args.entries[0].title === "学习资料与配套练习",
    ),
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      windowId,
      output,
      checks:
        "offline account, sync/pause/resume, search, tree, registration, persisted navigation, no console errors",
      url: page.url(),
      title: await page.title(),
    }),
  );
}
