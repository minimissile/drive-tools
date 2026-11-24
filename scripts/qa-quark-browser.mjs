import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// Renderer-scoped business fixtures; all writes are contained in this test page.
async function quarkMock(method, args) {
  const fixture = (window.__quarkBrowserQa ??= {
    calls: [],
    accounts: [],
    legacy: true,
  });
  const native = {
    id: "quark-native-qa",
    provider: "quark",
    alias: "内置夸克测试",
    uid: "native-user",
    enabled: true,
    status: "connected",
    browserEngine: "electron",
    defaultDirectory: "/",
    isDefault: true,
  };
  const preview = {
    provider: "quark",
    token: "00000000-0000-4000-8000-000000000001",
    profileId: "quark-profile-10",
    profileName: "夸克测试窗口",
    uid: "quark-browser-user",
    nickname: "夸克指纹测试用户",
    exitIp: "203.0.113.10",
    requireProxy: false,
    headless: true,
  };
  if (method === "snapshot") {
    const data = await window.panxu.invoke(method, args);
    return {
      ...data,
      dataPath: data.dataPath + "/quark-browser-ui-qa",
      accounts: [native, ...fixture.accounts],
      resources: [],
      jobs: [],
      drafts: [],
      publications: [],
      bindings: [],
    };
  }
  if (method === "environments.list")
    return [
      {
        id: "env-shared-qa",
        engine: "bitbrowser",
        profileId: preview.profileId,
        accounts: [{ kind: "drive", id: "baidu-qa", platform: "drive-baidu" }],
      },
      {
        id: "env-occupied-qa",
        engine: "bitbrowser",
        profileId: "quark-occupied",
        accounts: [
          { kind: "drive", id: "other-quark-qa", platform: "drive-quark" },
        ],
      },
    ];
  if (method === "bit.profiles")
    return {
      connectorKey: "http://127.0.0.1:54345",
      windows: [
        { id: preview.profileId, name: preview.profileName, seq: 10 },
        { id: "quark-occupied", name: "已用夸克窗口", seq: 11 },
      ],
    };
  if (method === "driveBrowser.previewNew") {
    fixture.calls.push({ method, args });
    if (fixture.legacy) {
      const { provider, ...legacy } = preview;
      return legacy;
    }
    return preview;
  }
  if (method === "account.add") {
    fixture.calls.push({ method, args });
    const account = {
      ...native,
      id: "quark-bit-qa",
      browserEngine: "bitbrowser",
      alias: args.alias || preview.nickname,
      uid: preview.uid,
      browser: { ...preview, environmentId: "env-shared-qa" },
    };
    fixture.accounts.push(account);
    return account;
  }
  if (method === "driveBrowser.preview") {
    fixture.calls.push({ method, args });
    return { ...preview, accountId: args.accountId };
  }
  if (method === "driveBrowser.bind") {
    fixture.calls.push({ method, args });
    return { ...preview, accountId: "quark-bit-qa" };
  }
  if (method === "websiteAccounts.list") return [];
  if (
    /^(?:account\.|driveBrowser\.|drive\.|share\.|resource\.save|job\.)/.test(
      method,
    )
  )
    throw new Error(`测试阻止真实操作：${method}`);
  return window.panxu.invoke(method, args);
}

export async function run({ page, windowId }) {
  const out = `/private/tmp/panxu-quark-browser-ui/${windowId}`;
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const replaced = original.replace(
      /return window\.panxu\.invoke[^;]+;/,
      "return quarkMock(method,args);",
    );
    assert.notEqual(replaced, original);
    await route.fulfill({
      response,
      body: quarkMock.toString() + "\n" + replaced,
      contentType: "application/javascript",
    });
  });
  try {
    await page.reload();
    await page
      .getByRole("heading", { name: "账号管理", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "新增账号", exact: true }).click();
    const choose = async (label, name) => {
      await page.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    const form = page.getByRole("form", {
      name: "添加本人网盘账号",
      exact: true,
    });
    await choose("新增账号网盘", "夸克");
    await choose("新增账号浏览器方式", "比特指纹浏览器");
    await form
      .getByRole("button", { name: "读取比特环境", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "比特浏览器环境", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("option", { name: /#11.*已关联账号/ })
        .getAttribute("aria-disabled"),
      "true",
    );
    await page.getByRole("option", { name: /#10.*共用环境/ }).click();
    const submit = form.getByRole("button", { name: "添加账号", exact: true });
    assert.equal(await submit.isDisabled(), true);
    await page
      .getByRole("checkbox", { name: "要求代理并固定出口 IP", exact: true })
      .uncheck();
    await form
      .getByRole("button", { name: "读取登录账号", exact: true })
      .click();
    await page
      .getByText("后台尚未加载此网盘的指纹支持，请应用更新并重启后重试。", {
        exact: true,
      })
      .waitFor();
    assert.equal(await submit.isDisabled(), true);
    await page.evaluate(() => (window.__quarkBrowserQa.legacy = false));
    await form
      .getByRole("button", { name: "读取登录账号", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "核对夸克账号", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("新增账号别名", { exact: true }).inputValue(),
      "",
    );
    assert.equal(await submit.isEnabled(), true);
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    await page.screenshot({ path: `${out}/01-quark-preview.png` });
    await submit.click();
    const dialog = page.getByRole("dialog", {
      name: "夸克网盘 · 指纹浏览器管理",
      exact: true,
    });
    await dialog.waitFor();
    assert.equal(
      await dialog.getByText("比特环境：夸克测试窗口", { exact: true }).count(),
      1,
    );
    await page.screenshot({ path: `${out}/02-quark-management.png` });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const manage = page.getByRole("button", {
      name: "管理夸克指纹测试用户的浏览器环境",
      exact: true,
    });
    await manage.waitFor();
    assert.equal(
      await manage
        .locator("xpath=ancestor::*[contains(@class,'account-action-cell')]")
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "管理内置夸克测试的浏览器环境",
          exact: true,
        })
        .count(),
      0,
    );
    await page.screenshot({ path: `${out}/03-quark-account.png` });
    const calls = await page.evaluate(() => window.__quarkBrowserQa.calls);
    const create = calls.find((c) => c.method === "account.add");
    assert.equal(create.args.provider, "quark");
    assert.equal(create.args.browser.engine, "bitbrowser");
    assert.equal(create.args.alias, "");
    assert.ok(
      calls
        .filter((c) => c.method === "driveBrowser.previewNew")
        .every((c) => c.args.provider === "quark"),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    return {
      screenshots: out,
      checks: [
        "夸克指纹方式可选",
        "同类环境占用拦截",
        "旧后台提示",
        "读取后可提交",
        "留空别名",
        "固定环境管理",
        "操作列归位",
        "内置账号保留原方式",
        "无横向溢出或运行异常",
      ],
    };
  } finally {
    await page.unroute("**/src/api/client.ts*");
  }
}
