import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// No Browser plugin is installed; use the shared backend's exact-ID test window.
async function cmccUiMock(method, args) {
  const state = (window.__cmccUi ??= {
    base: null,
    calls: [],
    created: sessionStorage.getItem("cmcc-ui-mode") === "files",
    connected: sessionStorage.getItem("cmcc-ui-mode") === "files",
    status: "completed",
  });
  const time = "2026-11-25T02:00:00Z";
  const account = {
    id: "cmcc-ui-account",
    provider: "cmcc",
    alias: state.connected ? "云端资料归档" : "移动云盘待登录账号",
    uid: state.connected ? "cmcc-owner" : null,
    status: state.connected ? "connected" : "disconnected",
    enabled: true,
    isDefault: true,
    browserEngine: "electron",
    defaultDirectory: "/",
    lastVerifiedAt: state.connected ? time : null,
    error: null,
    resourceCopies: 0,
    capacity: state.connected
      ? {
          ownerUid: "cmcc-owner",
          value: { totalBytes: 1024 ** 4, usedBytes: 1024 ** 3 },
          updatedAt: time,
          attemptedAt: time,
          error: null,
        }
      : null,
    membership: state.connected
      ? {
          ownerUid: "cmcc-owner",
          value: null,
          updatedAt: null,
          attemptedAt: time,
          error: "移动云盘会员状态与到期时间暂未接入，请在官网查看。",
        }
      : null,
  };
  if (method === "snapshot") {
    const base = (state.base ??= await window.panxu.invoke(method, args));
    return {
      ...base,
      dataPath: base.dataPath + "/cmcc-ui",
      accounts: state.created ? [account] : [],
      resources: [],
      jobs: [],
      drafts: [],
    };
  }
  if (method === "account.add") {
    state.calls.push({ method, args });
    state.created = true;
    return account;
  }
  if (method === "account.login") {
    state.calls.push({ method, args });
    return true;
  }
  if (method === "account.check") {
    state.calls.push({ method, args });
    state.connected = true;
    return {
      ...account,
      alias: "云端资料归档",
      uid: "cmcc-owner",
      status: "connected",
    };
  }
  if (method === "accountBatch.current") return null;
  const files = [
    {
      id: "cmcc-folder",
      name: "课程资料",
      parentId: "0",
      isDirectory: true,
      size: null,
    },
    {
      id: "cmcc-file",
      name: "使用说明.txt",
      parentId: "0",
      isDirectory: false,
      size: 100,
    },
  ];
  if (method === "driveSync.index")
    return {
      items: args.foldersOnly
        ? []
        : files.map((f) => ({
            ...f,
            path: "/" + f.name,
            observedAt: time,
            missing: false,
            state: "unrecorded",
            resources: [],
          })),
      total: args.foldersOnly ? 0 : 2,
      page: 1,
      pageSize: 50,
      ownerUid: "cmcc-owner",
      lastCompleteAt: time,
      breadcrumbs: [],
      run: {
        id: "cmcc-run",
        accountId: account.id,
        ownerUid: "cmcc-owner",
        environment: "native",
        status: state.status,
        files: 1,
        folders: 2,
        pending: state.status === "running" ? 1 : 0,
        failed: 0,
        message: "",
        createdAt: time,
        updatedAt: time,
        completedAt: time,
      },
    };
  if (method === "driveSync.start" || method === "driveSync.pause") {
    state.calls.push({ method, args });
    state.status = method === "driveSync.start" ? "running" : "paused";
    return {};
  }
  if (method === "drive.directory") {
    state.calls.push({ method, args });
    return {
      accountId: account.id,
      provider: "cmcc",
      path: "/",
      folderId: "0",
      readAt: time,
      files,
      capabilities: { rename: true, delete: true, upload: true },
      pending: null,
    };
  }
  if (method === "insertion.materials") return [];
  if (
    method.startsWith("account.") ||
    method.startsWith("drive.") ||
    method.startsWith("driveSync.")
  )
    throw Error(`未授权的界面模拟调用：${method}`);
  return window.panxu.invoke(method, args);
}
export async function run({ page, windowId }) {
  const mode = process.env.PANXU_CMCC_UI || "accounts",
    out = `/private/tmp/panxu-cmcc-ui/${mode}-${windowId}`;
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch({ maxRetries: 2 }),
      body = await response.text(),
      next = body.replace(
        /return window\.panxu\.invoke[^;]+;/,
        "return cmccUiMock(method,args);",
      );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: cmccUiMock.toString() + "\n" + next,
      contentType: "application/javascript",
    });
  });
  await page.evaluate(
    (mode) => sessionStorage.setItem("cmcc-ui-mode", mode),
    mode,
  );
  await page.reload();
  try {
    if (mode === "accounts") {
      await page.getByRole("button", { name: "新增账号", exact: true }).click();
      await page
        .getByRole("combobox", { name: "新增账号网盘", exact: true })
        .click();
      await page.getByRole("option", { name: "移动云盘", exact: true }).click();
      assert.equal(
        await page
          .getByRole("textbox", { name: "新增账号别名", exact: true })
          .inputValue(),
        "",
      );
      await page
        .getByText(
          "移动云盘通过内置浏览器登录，支持个人盘目录同步和新版个人盘文件管理。分享、转存、会员信息和分享统计暂未接入，请在官网处理。",
          { exact: true },
        )
        .waitFor();
      await page.screenshot({ path: out + "/creation.png", fullPage: false });
      await page.getByRole("button", { name: "添加账号", exact: true }).click();
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: "核验登录", exact: true }).click();
      await page.getByText("云端资料归档", { exact: true }).waitFor();
      await page.getByText("会员信息暂未接入", { exact: true }).waitFor();
      assert.ok(
        (await page.evaluate(() => window.__cmccUi.calls)).some(
          (c) =>
            c.method === "account.add" &&
            c.args.provider === "cmcc" &&
            c.args.alias === "" &&
            c.args.browser.engine === "electron",
        ),
      );
      await page.screenshot({ path: out + "/account.png", fullPage: false });
    } else {
      await page
        .getByRole("combobox", { name: "本人账号", exact: true })
        .click();
      await page
        .getByRole("option", { name: "云端资料归档 · 移动云盘", exact: true })
        .click();
      await page.getByRole("table").waitFor();
      await page
        .getByRole("button", { name: "更新本地目录", exact: true })
        .click();
      await page.getByRole("button", { name: "暂停同步", exact: true }).click();
      await page
        .getByRole("button", { name: "继续同步", exact: true })
        .waitFor();
      await page
        .getByRole("checkbox", { name: "选择 使用说明.txt", exact: true })
        .check();
      await page
        .getByRole("button", { name: "录入资源库", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "录入预览 · 1 项", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "收起预览", exact: true }).click();
      await page.getByRole("tab", { name: "实时网盘", exact: true }).click();
      await page.getByRole("button", { name: "读取目录", exact: true }).click();
      await page
        .getByRole("button", { name: "新建文件夹", exact: true })
        .waitFor();
      await page
        .getByRole("checkbox", { name: "选择 使用说明.txt", exact: true })
        .check();
      assert.equal(
        await page
          .getByRole("button", { name: "分别分享并归档", exact: true })
          .count(),
        0,
      );
      await page.screenshot({ path: out + "/files.png", fullPage: false });
    }
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    console.log(
      JSON.stringify({
        windowId,
        mode,
        out,
        checks:
          "cmcc channel, native login flow, automatic alias, directory sync and management presentation; page-only fixtures",
      }),
    );
  } catch (error) {
    await page
      .screenshot({ path: out + "/failure.png", fullPage: false })
      .catch(() => {});
    throw error;
  }
}
