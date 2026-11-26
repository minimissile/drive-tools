import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// Browser plugin not available. Use the project's exact-ID Playwright test session.
async function syncMock(method, args) {
  const state = (window.__driveSyncQa ??= JSON.parse(
    sessionStorage.getItem("driveSyncQa") || "null",
  ) ?? {
    calls: [],
    started: false,
    run: null,
    base: null,
    registered: false,
    logs: [],
    logsUnavailable: false,
    autoRegisterSupported: true,
    autoRegistered: false,
  });
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
  const log = (message, level = "info") => {
    const id = (state.logs[0]?.id ?? 0) + 1;
    state.logs.unshift({
      id,
      at: new Date(Date.parse(time) + (id - 1) * 1000).toISOString(),
      level,
      message,
    });
  };
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
    path:
      ({ folder: "/资料", "course-folder": "/资料/配套资料" }[parentId] ?? "") +
      "/" +
      name,
    size: dir ? null : 1048576,
    observedAt: time,
    missing: false,
    state: stateName,
    resources: [],
  });
  const autoRecord = (entry) =>
    !state.autoRegistered
      ? entry
      : {
          ...entry,
          state: "recorded",
          resources: [
            {
              id: `resource-${entry.id}`,
              title: entry.name,
              copyId: `copy-${entry.id}`,
            },
          ],
        };
  if (method === "driveSync.index") {
    const folderCrumb = { id: "folder", name: "资料" };
    const courseFolderCrumb = { id: "course-folder", name: "配套资料" };
    let items = !state.started
      ? []
      : args.parentId === "folder"
        ? [
            make("new", "新增文件.pdf", false, "review", "folder"),
            autoRecord(
              make("course-folder", "配套资料", true, "review", "folder"),
            ),
          ]
        : args.parentId === "course-folder"
          ? [
              autoRecord(
                make(
                  "exercise",
                  "练习答案.pdf",
                  false,
                  "review",
                  "course-folder",
                ),
              ),
            ]
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
      ...(state.autoRegisterSupported
        ? { autoRegisterSupported: true, autoRegisterIncludesFolders: true }
        : {}),
      lastCompleteAt: state.run?.status === "completed" ? time : null,
      breadcrumbs:
        args.parentId === "course-folder"
          ? [folderCrumb, courseFolderCrumb]
          : args.parentId === "folder"
            ? [folderCrumb]
            : [],
    };
  }
  if (method === "driveSync.logs") {
    if (args.accountId !== "index-qa") throw Error("日志请求使用了错误的账号");
    if (state.logsUnavailable) throw Error("本地日志暂时无法读取");
    return [...state.logs];
  }
  if (method === "driveSync.start") {
    if (args.autoRegister && !state.autoRegisterSupported)
      throw Error("后端未支持自动录入");
    if (
      args.autoRegister &&
      state.run?.autoRegister?.requiresRescan &&
      !args.restart
    )
      throw Error("旧录入规则需要从根目录重新扫描");
    state.started = true;
    state.run = {
      id: `run-${state.calls.length}`,
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
    if (args.autoRegister) {
      state.autoRegistered = true;
      state.run.autoRegister = { enabled: true, added: 2, skipped: 1 };
      log("已自动录入 2 项资源，跳过 1 项");
      return state.run;
    }
    log("开始同步网盘目录");
    log("已读取根目录");
    log("已发现 1 个文件、1 个目录，剩余 1 个目录");
    log("已读取学习资料目录");
    log("已发现 2 个文件、1 个目录，剩余 1 个目录");
    log("已读取练习目录");
    log("已发现 3 个文件、2 个目录，正在检查其余目录");
    log("已发现 3 个文件、2 个目录，剩余 1 个目录");
    return state.run;
  }
  if (method === "driveSync.pause") {
    state.run.status = "paused";
    log("已暂停同步", "warning");
    return state.run;
  }
  if (method === "driveSync.resume") {
    if (args.autoRegister && state.run.autoRegister?.requiresRescan)
      throw Error("旧录入规则需要从根目录重新扫描");
    state.run.status = "completed";
    state.run.pending = 0;
    state.run.completedAt = time;
    if (args.autoRegister === false && state.run.autoRegister)
      state.run.autoRegister.enabled = false;
    log("继续同步未完成目录");
    log("同步完成，共发现 3 个文件、2 个目录");
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

function syncChanges(listener) {
  const unsubscribe = window.panxu?.onChanged(listener);
  window.addEventListener("qa:drive-sync-changed", listener);
  return () => {
    unsubscribe?.();
    window.removeEventListener("qa:drive-sync-changed", listener);
  };
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
  // Simulate a background change in this page's drive sync subscriptions only.
  await page.route("**/src/api/useIpcQuery.ts*", async (route) => {
    const response = await route.fetch({ maxRetries: 2 }),
      body = await response.text();
    const next = body.replace(
      "window.panxu?.onChanged(() => {",
      '(method.startsWith("driveSync.") ? syncChanges : window.panxu?.onChanged)(() => {',
    );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: syncChanges.toString() + "\n" + next,
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
  const logTrigger = page.getByRole("button", {
    name: "同步日志",
    exact: true,
  });
  const dialog = page.getByRole("dialog", { name: "同步日志", exact: true });
  const log = dialog.getByRole("log", { name: "网盘同步日志", exact: true });
  const logTimes = () =>
    log
      .locator("time")
      .evaluateAll((nodes) => nodes.map((node) => node.dateTime));
  const closeLog = async () => {
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  const autoRegister = page.getByRole("checkbox", {
    name: "同步时自动录入资源库",
    exact: true,
  });
  const syncCommands = () =>
    page.evaluate(() =>
      window.__driveSyncQa.calls.filter(({ method }) =>
        ["driveSync.start", "driveSync.resume"].includes(method),
      ),
    );
  await autoRegister.waitFor();
  assert.equal(await autoRegister.isChecked(), false);
  await logTrigger.click();
  await dialog
    .getByRole("heading", { name: "暂无同步日志", exact: true })
    .waitFor();
  await closeLog();

  await page.getByRole("button", { name: "同步整个网盘", exact: true }).click();
  await page.getByRole("button", { name: "暂停同步", exact: true }).waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.start",
    args: { accountId: "index-qa" },
  });
  await page.evaluate(() => (window.__driveSyncQa.logsUnavailable = true));
  await logTrigger.click();
  await dialog
    .getByRole("heading", { name: "无法读取同步日志", exact: true })
    .waitFor();
  await page.evaluate(() => (window.__driveSyncQa.logsUnavailable = false));
  await dialog.getByRole("button", { name: "重试读取", exact: true }).click();
  await log.getByText("已发现 3 个文件、2 个目录，剩余 1 个目录").waitFor();
  assert.deepEqual(
    await logTimes(),
    Array.from(
      { length: 8 },
      (_, index) => `2026-11-24T08:00:0${7 - index}.000Z`,
    ),
  );
  assert.equal(await log.evaluate((element) => element.scrollTop), 0);
  await page.evaluate(() => {
    window.__driveSyncQa.logs.unshift({
      id: 9,
      at: "2026-11-24T08:00:08.000Z",
      level: "warning",
      message: "部分目录暂时无法读取，正在继续检查其余目录",
    });
    window.dispatchEvent(new Event("qa:drive-sync-changed"));
  });
  await log.getByText("部分目录暂时无法读取，正在继续检查其余目录").waitFor();
  assert.equal((await logTimes())[0], "2026-11-24T08:00:08.000Z");
  await log
    .getByText("开始同步网盘目录", { exact: true })
    .scrollIntoViewIfNeeded();
  const showLatest = dialog.getByRole("button", {
    name: "查看最新",
    exact: true,
  });
  await showLatest.waitFor();
  assert.ok((await log.evaluate((element) => element.scrollTop)) > 24);
  await showLatest.click();
  await showLatest.waitFor({ state: "hidden" });
  assert.equal(await log.evaluate((element) => element.scrollTop), 0);
  await page.screenshot({ path: output + "/sync-logs.png", fullPage: false });
  await closeLog();

  await page.getByRole("button", { name: "暂停同步", exact: true }).click();
  await page.getByRole("button", { name: "继续同步", exact: true }).waitFor();
  await autoRegister.check();
  await page
    .getByRole("button", { name: "重新扫描并录入", exact: true })
    .waitFor();
  await page.getByText(/将从根目录重新扫描/).waitFor();
  assert.equal((await syncCommands()).length, 1);
  await autoRegister.uncheck();
  await page.getByRole("button", { name: "继续同步", exact: true }).click();
  await page
    .getByRole("button", { name: "更新本地目录", exact: true })
    .waitFor();
  await logTrigger.click();
  await log.getByText("已暂停同步", { exact: true }).waitFor();
  await log.getByText("继续同步未完成目录", { exact: true }).waitFor();
  await log
    .getByText("同步完成，共发现 3 个文件、2 个目录", { exact: true })
    .waitFor();
  assert.equal((await logTimes())[0], "2026-11-24T08:00:11.000Z");
  assert.equal(await log.evaluate((element) => element.scrollTop), 0);
  await closeLog();
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
  await page
    .getByRole("row")
    .filter({ hasText: "新增文件.pdf" })
    .getByTitle("资源目录内新增内容", { exact: true })
    .waitFor();
  await page.screenshot({
    path: output + "/local-directory.png",
    fullPage: false,
  });
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
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.resume",
    args: { accountId: "index-qa", autoRegister: false },
  });

  const pauseSync = page.getByRole("button", { name: "暂停同步", exact: true });
  const continueSync = page.getByRole("button", {
    name: "继续同步",
    exact: true,
  });
  const updateIndex = page.getByRole("button", {
    name: "更新本地目录",
    exact: true,
  });
  const rescan = page.getByRole("button", {
    name: "重新扫描并录入",
    exact: true,
  });
  const recordScope = page.getByText(/文件夹和里面的文件会分别录入资源库。/);
  const oldRuleReason = page.getByText(
    /当前任务使用旧的录入规则，将从根目录重新扫描。/,
  );
  const useOldRule = () =>
    page.evaluate(() => {
      const state = window.__driveSyncQa;
      state.run = {
        ...state.run,
        status: "paused",
        pending: 1,
        completedAt: null,
        autoRegister: {
          enabled: true,
          added: 1,
          skipped: 0,
          requiresRescan: true,
        },
      };
      window.dispatchEvent(new Event("qa:drive-sync-changed"));
    });
  await updateIndex.click();
  await pauseSync.click();
  await continueSync.waitFor();
  await autoRegister.check();
  await recordScope.waitFor();
  await rescan.click();
  await pauseSync.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.start",
    args: { accountId: "index-qa", autoRegister: true, restart: true },
  });
  assert.equal(await autoRegister.isDisabled(), true);
  await page.getByText(/自动录入 2 项/).waitFor();
  await page.screenshot({
    path: output + "/auto-register.png",
    fullPage: false,
  });
  await logTrigger.click();
  await log
    .getByText("已自动录入 2 项资源，跳过 1 项", { exact: true })
    .waitFor();
  await closeLog();

  const courseFolder = page.getByRole("button", {
    name: "配套资料",
    exact: true,
  });
  const courseFolderRow = page.getByRole("row").filter({ has: courseFolder });
  await courseFolderRow.getByText("已录入", { exact: true }).waitFor();
  await courseFolderRow
    .getByRole("button", { name: "关联资源（1）：配套资料", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "查看资源：配套资料", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await courseFolderRow
    .getByRole("button", { name: "配套资料", exact: true })
    .click();
  const exerciseRow = page.getByRole("row").filter({ hasText: "练习答案.pdf" });
  await exerciseRow.getByText("已录入", { exact: true }).waitFor();
  await exerciseRow
    .getByRole("button", { name: "关联资源（1）：练习答案.pdf", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "查看资源：练习答案.pdf", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: output + "/auto-register-child.png",
    fullPage: false,
  });
  await page
    .getByRole("navigation", { name: "本地目录路径", exact: true })
    .getByRole("button", { name: "资料", exact: true })
    .click();
  await page.getByText("新增文件.pdf", { exact: true }).waitFor();

  await pauseSync.click();
  await continueSync.waitFor();
  assert.equal(await autoRegister.isChecked(), true);
  await autoRegister.uncheck();
  await continueSync.click();
  await updateIndex.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.resume",
    args: { accountId: "index-qa", autoRegister: false },
  });

  assert.equal(await autoRegister.isChecked(), false);
  await autoRegister.check();
  await page
    .getByRole("button", { name: "同步并自动录入", exact: true })
    .click();
  await pauseSync.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.start",
    args: { accountId: "index-qa", autoRegister: true },
  });
  await pauseSync.click();
  await continueSync.waitFor();
  assert.equal(await autoRegister.isChecked(), true);
  await continueSync.click();
  await updateIndex.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.resume",
    args: { accountId: "index-qa", autoRegister: true },
  });

  await useOldRule();
  await rescan.waitFor();
  await oldRuleReason.waitFor();
  assert.equal(await autoRegister.isChecked(), true);
  await autoRegister.uncheck();
  await oldRuleReason.waitFor({ state: "hidden" });
  await continueSync.click();
  await updateIndex.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.resume",
    args: { accountId: "index-qa", autoRegister: false },
  });

  await useOldRule();
  await rescan.waitFor();
  await oldRuleReason.waitFor();
  await recordScope.waitFor();
  await page.screenshot({
    path: output + "/auto-register-legacy-rescan.png",
    fullPage: false,
  });
  await rescan.click();
  await pauseSync.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.start",
    args: { accountId: "index-qa", restart: true, autoRegister: true },
  });
  await pauseSync.click();
  await continueSync.click();
  await updateIndex.waitFor();

  await page.evaluate(() => {
    const state = window.__driveSyncQa;
    state.autoRegisterSupported = false;
    delete state.run.autoRegister;
    window.dispatchEvent(new Event("qa:drive-sync-changed"));
  });
  await autoRegister.waitFor({ state: "hidden" });
  await updateIndex.click();
  await pauseSync.click();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.start",
    args: { accountId: "index-qa" },
  });
  await continueSync.click();
  await updateIndex.waitFor();
  assert.deepEqual((await syncCommands()).at(-1), {
    method: "driveSync.resume",
    args: { accountId: "index-qa" },
  });
  await page.evaluate(() =>
    sessionStorage.setItem("driveSyncQa", JSON.stringify(window.__driveSyncQa)),
  );
  await page.reload();
  await page.getByText("新增文件.pdf", { exact: true }).waitFor();
  assert.equal(await autoRegister.count(), 0);

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      windowId,
      output,
      checks:
        "offline account, sync/pause/resume, sync logs, search/tree, manual registration, persisted navigation, separate folder and child auto-registration, legacy rule rescan/opt-out, older backend compatibility",
      url: page.url(),
      title: await page.title(),
    }),
  );
}
