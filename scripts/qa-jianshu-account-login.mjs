import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/** Page-local business responses. Shared app IPC and actual website accounts stay untouched. */
async function jianshuAccountMock(method, args) {
  const fixture = (window.__jianshuAccountsQa ??= {
    accounts: [],
    calls: [],
    environments: [
      {
        id: "env_jianshu_bit_qa",
        name: "简书指纹 QA",
        engine: "bitbrowser",
        profileId: "profile-jianshu-qa",
        accounts: [],
      },
      {
        id: "env_other_drive_qa",
        name: "已有网盘后台 QA",
        engine: "bitbrowser",
        profileId: "profile-other-drive-qa",
        accounts: [{ kind: "drive", id: "drive-qa", platform: "drive-quark" }],
      },
    ],
  });
  if (method === "snapshot") {
    const data = await window.panxu.invoke(method, args);
    return {
      ...data,
      dataPath: `${data.dataPath}/jianshu-account-qa/${window.panxu.windowId}`,
      accounts: [],
      resources: [],
      jobs: [],
      drafts: [],
      publications: [],
      bindings: [],
      tiebaDiscoveryTasks: [],
    };
  }
  if (method === "environments.list")
    return structuredClone(fixture.environments);
  if (method === "websiteAccounts.list")
    return structuredClone(
      fixture.accounts.filter(
        (account) => !args?.provider || args.provider === account.provider,
      ),
    );
  if (
    ["zhidao.accounts", "zhidao.activeRuns", "baiduDiscovery.list"].includes(
      method,
    )
  )
    return [];
  if (method === "websiteAccounts.add") {
    if (args.provider !== "jianshu") throw new Error("仅允许内存简书账号");
    fixture.calls.push({ method, args: structuredClone(args) });
    const ordinal = fixture.accounts.length + 1,
      id = `web_jianshu_qa_${ordinal}`,
      fingerprint = !!args.environmentId,
      environmentId = args.environmentId || `env_jianshu_native_qa_${ordinal}`;
    if (fingerprint && environmentId !== "env_jianshu_bit_qa")
      throw new Error("测试禁止使用其他指纹环境");
    if (!fingerprint)
      fixture.environments.push({
        id: environmentId,
        name: "简书内置 QA",
        engine: "electron",
        profileId: "persist:jianshu-native-qa",
        accounts: [],
      });
    fixture.environments
      .find((env) => env.id === environmentId)
      .accounts.push({
        kind: "website",
        id,
        platform: "jianshu",
        alias: args.alias || `简书 ${ordinal}`,
      });
    const account = {
      id,
      provider: "jianshu",
      alias: args.alias || `简书 ${ordinal}`,
      environmentId,
      uid: null,
      nickname: null,
      checkedAt: null,
      status: "disconnected",
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      windowOpen: false,
      message: "待核验简书身份",
    };
    fixture.accounts.push(account);
    return structuredClone(account);
  }
  if (
    method === "websiteAccounts.login" ||
    method === "websiteAccounts.check"
  ) {
    const account = fixture.accounts.find((item) => item.id === args.id);
    if (!account) throw new Error("仅允许本轮内存账号");
    fixture.calls.push({ method, args: structuredClone(args) });
    if (method === "websiteAccounts.login") {
      account.windowOpen = true;
      account.message = "已打开内置简书登录窗口，等待本人登录";
      return true;
    }
    const fingerprint = account.environmentId === "env_jianshu_bit_qa";
    Object.assign(account, {
      uid: fingerprint ? "abcdef123456" : "fedcba654321",
      nickname: fingerprint ? "简书指纹核验用户" : "简书内置核验用户",
      status: "connected",
      windowOpen: false,
      checkedAt: "2026-11-23T01:02:03Z",
      message: "已核实本轮内存账号身份",
    });
    return structuredClone(account);
  }
  if (
    /^(?:websiteAccounts\.|environments\.|account\.|drive\.|share\.|jianshu\.|zhidao\.|resource\.save|job\.)/.test(
      method,
    )
  )
    throw new Error(`测试阻止真实业务操作：${method}`);
  return window.panxu.invoke(method, args);
}

export async function run({ page, windowId }) {
  const out = `/private/tmp/panxu-jianshu-accounts/${windowId}`;
  console.log(JSON.stringify({ windowId }));
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const replaced = original.replace(
      /return window\.panxu\.invoke[^;]+;/,
      "return jianshuAccountMock(method,args);",
    );
    assert.notEqual(replaced, original, "仅拦截此测试页的 IPC 客户端");
    await route.fulfill({
      response,
      body: `${jianshuAccountMock.toString()}\n${replaced}`,
      contentType: "application/javascript",
    });
  });
  try {
    await page.reload();
    await page
      .getByRole("heading", { name: "账号管理", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => Object.isFrozen(window.panxu)),
      true,
    );
    await page
      .getByRole("button", { name: "新增账号", exact: true })
      .and(page.locator("[aria-expanded]"))
      .click();
    await page
      .getByRole("combobox", { name: "其他账号平台", exact: true })
      .click();
    await page.getByRole("option", { name: "简书", exact: true }).click();
    const form = page.getByRole("region", {
      name: "新增其他账号",
      exact: true,
    });
    const fingerprintSwitch = form.getByRole("switch", {
      name: "关联指纹浏览器",
      exact: true,
    });
    assert.equal(await fingerprintSwitch.getAttribute("aria-checked"), "true");
    const fingerprintAdd = form.getByRole("button", {
      name: "关联并检查登录",
      exact: true,
    });
    assert.equal(
      await fingerprintAdd.isDisabled(),
      true,
      "缺少指纹环境时不能添加",
    );
    await form
      .getByRole("combobox", { name: "指纹浏览器环境", exact: true })
      .click();
    assert.equal(
      await page.getByRole("option", { name: /已有网盘后台 QA/ }).count(),
      0,
      "简书不占用网盘专用环境",
    );
    await page
      .getByRole("option", { name: "简书指纹 QA", exact: true })
      .click();
    assert.equal(await fingerprintAdd.isEnabled(), true);
    await page.screenshot({ path: `${out}/01-fingerprint-choice.png` });
    await fingerprintAdd.click();
    const bitRow = page.locator(".website-account-row").filter({
      has: page.getByRole("heading", {
        name: "简书指纹核验用户",
        exact: true,
      }),
    });
    await bitRow.waitFor();
    assert.match(
      await bitRow.locator(".website-account-environment").innerText(),
      /指纹浏览器\s*·\s*简书指纹 QA/,
    );
    assert.equal(
      await bitRow.getByText("UID abcdef123456", { exact: true }).count(),
      1,
    );
    let calls = await page.evaluate(() =>
      structuredClone(window.__jianshuAccountsQa.calls),
    );
    assert.equal(calls[0].method, "websiteAccounts.add");
    assert.equal(calls[0].args.provider, "jianshu");
    assert.equal(calls[0].args.environmentId, "env_jianshu_bit_qa");
    assert.equal(calls[0].args.alias, undefined, "备注留空由后端生成默认备注");
    assert.equal(calls[1].method, "websiteAccounts.check");
    assert.equal(
      calls.some((call) => call.method === "websiteAccounts.login"),
      false,
    );

    await page
      .getByRole("button", { name: "新增账号", exact: true })
      .and(page.locator("[aria-expanded]"))
      .click();
    assert.equal(
      await form
        .getByRole("combobox", { name: "其他账号平台", exact: true })
        .getAttribute("data-value"),
      "jianshu",
    );
    assert.equal(await fingerprintSwitch.getAttribute("aria-checked"), "true");
    await fingerprintSwitch.click();
    assert.equal(await fingerprintSwitch.getAttribute("aria-checked"), "false");
    assert.equal(
      await form
        .getByRole("combobox", { name: "指纹浏览器环境", exact: true })
        .count(),
      0,
    );
    await page.screenshot({ path: `${out}/02-native-choice.png` });
    await form.getByRole("button", { name: "登录新账号", exact: true }).click();
    const nativeRow = page.locator(".website-account-row").filter({
      has: page.getByRole("heading", { name: "简书 2", exact: true }),
    });
    await nativeRow.waitFor();
    assert.match(
      await nativeRow.locator(".website-account-environment").innerText(),
      /内置浏览器\s*·\s*简书内置 QA/,
    );
    calls = await page.evaluate(() =>
      structuredClone(window.__jianshuAccountsQa.calls),
    );
    assert.equal(calls[2].method, "websiteAccounts.add");
    assert.equal(calls[2].args.provider, "jianshu");
    assert.equal(calls[2].args.environmentId, undefined);
    assert.equal(calls[3].method, "websiteAccounts.login");
    await nativeRow
      .getByRole("button", { name: "检查登录", exact: true })
      .click();
    const nativeChecked = page.locator(".website-account-row").filter({
      has: page.getByRole("heading", {
        name: "简书内置核验用户",
        exact: true,
      }),
    });
    await nativeChecked.waitFor();
    assert.equal(
      await nativeChecked
        .getByText("UID fedcba654321", { exact: true })
        .count(),
      1,
    );
    assert.match(
      await nativeChecked.locator(".website-account-environment").innerText(),
      /内置浏览器\s*·\s*简书内置 QA/,
    );
    assert.match(
      await bitRow.locator(".website-account-environment").innerText(),
      /指纹浏览器\s*·\s*简书指纹 QA/,
    );
    assert.equal(await page.locator(".website-account-row").count(), 2);
    await page.screenshot({ path: `${out}/03-both-accounts-verified.png` });
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    assert.equal(
      await page.getByText("任务读取失败", { exact: true }).count(),
      0,
    );
    const localJianshuAccounts = await page.evaluate(async () => {
      try {
        const accounts = await window.panxu.invoke("websiteAccounts.list", {
          provider: "jianshu",
        });
        return {
          accounts: accounts.map((account) => ({
            id: account.id,
            status: account.status,
            environmentId: account.environmentId,
            hasUid: !!account.uid,
          })),
        };
      } catch (error) {
        return {
          unavailable: true,
          reason:
            error instanceof Error
              ? error.message.slice(0, 180)
              : "本地后台尚未提供简书账号列表",
        };
      }
    });
    return {
      screenshots: out,
      localJianshuAccounts,
      checks: [
        "简书平台可选",
        "默认指纹",
        "空环境拦截",
        "网盘环境不可选",
        "指纹添加后检查",
        "备注选填",
        "内置添加后登录",
        "内置手动核验",
        "两种身份与环境独立展示",
        "无横向溢出或运行异常",
      ],
    };
  } finally {
    await page.unroute("**/src/api/client.ts*");
  }
}
