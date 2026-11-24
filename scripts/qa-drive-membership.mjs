import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
async function membershipMock(method, args) {
  const state = (window.__membershipQa ??= { calls: [], accounts: null });
  if (!state.accounts) {
    const providers = ["baidu", "quark", "uc", "xunlei", "guangya", "pikpak"],
      names = [
        "百度超级会员的长期归档账号名称换行验收",
        "夸克会员测试",
        "UC普通账号",
        "迅雷过期会员",
        "光鸭未知会员",
        "PikPak日期缺失",
      ];
    state.accounts = providers.map((provider, i) => {
      const value = [
        {
          status: "active",
          tier: "超级会员",
          expiresAt: "2030-12-10T08:30:00Z",
        },
        {
          status: "active",
          tier: "超级会员",
          expiresAt: "2030-12-10T08:30:00Z",
        },
        { status: "none", tier: null, expiresAt: null },
        {
          status: "expired",
          tier: "超级会员",
          expiresAt: "2026-01-10T08:30:00Z",
        },
        { status: "unknown", tier: null, expiresAt: null },
        { status: "active", tier: "白金会员", expiresAt: null },
      ][i];
      return {
        id: `member-${provider}`,
        provider,
        alias: names[i],
        uid: `uid-${provider}`,
        enabled: true,
        status: "connected",
        isDefault: true,
        browserEngine: "electron",
        defaultDirectory: "/",
        resourceCopies: 0,
        lastVerifiedAt: "2026-11-23T10:00:00Z",
        error: null,
        capacity: {
          ownerUid: `uid-${provider}`,
          value: { totalBytes: 2 ** 40, usedBytes: 2 ** 38 },
          updatedAt: "2026-11-23T10:00:00Z",
          attemptedAt: "2026-11-23T10:00:00Z",
          error: null,
        },
        membership: {
          ownerUid: `uid-${provider}`,
          value,
          updatedAt: "2026-11-23T10:00:00Z",
          attemptedAt: "2026-11-23T10:00:00Z",
          error: i === 5 ? "会员接口暂不可用" : null,
        },
      };
    });
    state.accounts[0].membership = null;
    state.accounts.push({
      ...state.accounts[2],
      id: "member-failed",
      alias: "首次读取受阻",
      status: "expired",
      error: "登录已失效，请在原账号窗口重新登录。",
      membership: {
        ownerUid: "uid-uc",
        value: null,
        updatedAt: null,
        attemptedAt: "2026-11-23T10:00:00Z",
        error: "登录已失效，请在原账号窗口重新登录。",
      },
    });
  }
  if (method === "snapshot") {
    const data = (state.base ??= await window.panxu.invoke(method, args));
    return structuredClone({
      ...data,
      dataPath: data.dataPath + "/membership-qa",
      accounts: state.accounts,
      resources: [],
      jobs: [],
      drafts: [],
      publications: [],
      bindings: [],
    });
  }
  if (method === "account.capacity" || method === "account.check") {
    state.calls.push({ method, args });
    const a = state.accounts.find((a) => a.id === args.id);
    if (a.provider === "quark")
      a.membership = {
        ...a.membership,
        value: {
          status: "active",
          tier: "超级会员",
          expiresAt: "2031-12-10T08:30:00Z",
        },
        updatedAt: "2026-11-23T11:00:00Z",
        error: null,
      };
    const result = structuredClone(a);
    if (state.legacy) delete result.membership;
    return result;
  }
  if (method === "websiteAccounts.list" || method === "environments.list")
    return [];
  if (
    /^(?:account\.|driveBrowser\.|drive\.|share\.|resource\.save|job\.)/.test(
      method,
    )
  )
    throw Error(`测试禁止真实操作：${method}`);
  return window.panxu.invoke(method, args);
}
export async function run({ page, windowId }) {
  const out = `/private/tmp/panxu-membership-ui/${windowId}`;
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      body = await response.text(),
      next = body.replace(
        /return window\.panxu\.invoke[^;]+;/,
        "return membershipMock(method,args);",
      );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: membershipMock.toString() + "\n" + next,
      contentType: "application/javascript",
    });
  });
  try {
    await page.reload();
    await page
      .getByRole("heading", { name: "账号管理", exact: true })
      .waitFor();
    await page
      .getByRole("article", { name: "夸克会员测试", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator(".accounts-column-head")
        .getByText("会员信息", { exact: true })
        .count(),
      1,
    );
    const rows = page.locator(".account-row");
    assert.equal(await rows.count(), 7);
    const member = (alias) =>
      page.getByRole("region", { name: `${alias}会员信息`, exact: true });
    assert.match(await member("夸克会员测试").innerText(), /超级会员/);
    assert.match(await member("UC普通账号").innerText(), /非VIP会员/);
    assert.match(await member("迅雷过期会员").innerText(), /会员已到期/);
    assert.match(
      await member("光鸭未知会员").innerText(),
      /平台未提供会员状态/,
    );
    assert.match(
      await member("百度超级会员的长期归档账号名称换行验收").innerText(),
      /会员信息尚未读取/,
    );
    assert.match(await member("首次读取受阻").innerText(), /会员信息读取受阻/);
    assert.match(await member("首次读取受阻").innerText(), /到期时间：未取得/);
    assert.equal(
      await member("首次读取受阻")
        .getByText("平台未提供会员状态", { exact: true })
        .count(),
      0,
    );
    assert.match(await member("PikPak日期缺失").innerText(), /平台未提供/);
    assert.match(await member("PikPak日期缺失").innerText(), /上次记录/);
    assert.equal(
      await member("光鸭未知会员")
        .getByText("非VIP会员", { exact: true })
        .count(),
      0,
    );
    for (const row of await rows.all()) {
      const positions = await row.evaluate((node) =>
        [
          ".account-identity",
          ".account-capacity",
          ".account-membership",
          ".account-action-cell",
        ].map(
          (selector) => node.querySelector(selector).getBoundingClientRect().x,
        ),
      );
      assert.ok(
        positions.every((x, i) => !i || x > positions[i - 1]),
        JSON.stringify(positions),
      );
      assert.equal(
        await row.locator("button:not(.account-action-cell button)").count(),
        0,
      );
    }
    await page.screenshot({
      path: `${out}/01-six-membership-states.png`,
      fullPage: true,
    });
    const quark = page.getByRole("article", {
      name: "夸克会员测试",
      exact: true,
    });
    await quark
      .getByRole("button", { name: "刷新容量和会员信息", exact: true })
      .click();
    await member("夸克会员测试").getByText(/2031/).waitFor();
    await page
      .getByRole("article", { name: "PikPak日期缺失", exact: true })
      .getByRole("button", { name: "刷新容量和会员信息", exact: true })
      .click();
    const warning = page.getByRole("alert").filter({
      hasText: "部分账号信息暂未更新，具体原因及上次数据已保留在列表。",
    });
    await warning.waitFor();
    assert.equal(await warning.getAttribute("data-tone"), "warning");
    assert.match(await member("PikPak日期缺失").innerText(), /白金会员/);
    const calls = await page.evaluate(() => window.__membershipQa.calls);
    assert.equal(calls.length, 2);
    await page.evaluate(() => (window.__membershipQa.legacy = true));
    await quark
      .getByRole("button", { name: "刷新容量和会员信息", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "容量已刷新；会员信息需要应用更新并重启后读取。" })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: `${out}/02-refresh-and-error.png`,
      fullPage: true,
    });
    return {
      out,
      checks: [
        "六家会员列与到期日期",
        "非VIP与未知区分",
        "过期会员",
        "缺失日期",
        "刷新会员信息",
        "读取失败保留旧值并警告",
        "全部按钮仍在操作列",
        "1366桌面无横向溢出",
      ],
    };
  } finally {
    await page.unroute("**/src/api/client.ts*");
  }
}
