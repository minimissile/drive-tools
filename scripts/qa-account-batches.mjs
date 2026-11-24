import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
async function batchMock(method, args) {
  const state = (window.__accountBatchQa ??= {
    calls: [],
    batch: null,
    complete: false,
    base: null,
  });
  const drives = [
    { id: "baidu-a", provider: "baidu", alias: "百度一" },
    { id: "baidu-b", provider: "baidu", alias: "百度二" },
    { id: "baidu-c", provider: "baidu", alias: "百度三" },
    {
      id: "baidu-disabled",
      provider: "baidu",
      alias: "百度已停用",
      enabled: false,
    },
    { id: "quark-a", provider: "quark", alias: "夸克一" },
  ].map((a) => ({
    enabled: true,
    status: "connected",
    uid: a.id,
    isDefault: true,
    defaultDirectory: "/",
    resourceCopies: 0,
    browserEngine: "electron",
    error: null,
    ...a,
  }));
  const websites = [
    { id: "web_tieba_a", provider: "tieba", alias: "贴吧一" },
    { id: "web_tieba_b", provider: "tieba", alias: "贴吧二" },
    { id: "web_wechat_a", provider: "wechat", alias: "公众号一" },
  ].map((a) => ({
    ...a,
    status: "connected",
    uid: a.id,
    windowOpen: false,
    message: "登录有效",
    createdAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
  }));
  if (method === "snapshot") {
    const base = (state.base ??= await window.panxu.invoke(method, args));
    return {
      ...base,
      dataPath: base.dataPath + "/account-batch-qa",
      accounts: drives,
      resources: [],
      jobs: [],
      drafts: [],
      publications: [],
      bindings: [],
    };
  }
  if (method === "websiteAccounts.list") return websites;
  if (method === "zhidao.accounts" || method === "environments.list") return [];
  if (method === "accountBatch.current") {
    if (state.complete && state.batch) {
      for (const [i, item] of state.batch.items.entries()) {
        if (item.status !== "running" && item.status !== "queued") continue;
        item.status = state.fail && i === 1 ? "failed" : "success";
        item.message =
          item.status === "failed"
            ? "fixture登录已失效，请重新登录"
            : "登录核验通过";
        item.finishedAt = new Date().toISOString();
      }
      state.batch.status =
        state.batch.status === "stopping" ? "cancelled" : "completed";
      state.batch.updatedAt = new Date().toISOString();
      state.complete = false;
    }
    return structuredClone(state.batch);
  }
  if (method === "accountBatch.start") {
    state.calls.push({ method, args });
    state.complete = false;
    state.fail =
      state.calls.filter((c) => c.method === "accountBatch.start").length === 1;
    const all = args.scope === "drive" ? drives : websites;
    const time = new Date().toISOString();
    state.batch = {
      id: `batch-${state.calls.length}`,
      scope: args.scope,
      provider: args.provider,
      providerName: {
        baidu: "百度",
        quark: "夸克",
        tieba: "百度贴吧",
        wechat: "微信公众号",
      }[args.provider],
      action: args.action,
      status: "running",
      createdAt: time,
      updatedAt: time,
      items: args.accountIds.map((id, i) => ({
        id,
        alias: all.find((a) => a.id === id).alias,
        status: i ? "queued" : "running",
        message: i ? "等待错峰启动" : "正在核验登录",
        startedAt: i ? null : time,
        finishedAt: null,
      })),
    };
    return structuredClone(state.batch);
  }
  if (method === "accountBatch.stop") {
    state.calls.push({ method, args });
    state.batch.status = "stopping";
    for (const item of state.batch.items)
      if (item.status === "queued") {
        item.status = "cancelled";
        item.message = "已停止排队，未执行此账号。";
      }
    state.batch.updatedAt = new Date().toISOString();
    return structuredClone(state.batch);
  }
  if (
    /^(?:account\.|websiteAccounts\.|zhidao\.account\.|drive\.|resource\.save|share\.|job\.)/.test(
      method,
    )
  )
    throw Error(`测试阻止真实业务：${method}`);
  return window.panxu.invoke(method, args);
}
export async function run({ page, windowId }) {
  const out = `/private/tmp/panxu-account-batches/${windowId}`;
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch({ maxRetries: 2 }),
      body = await response.text(),
      next = body.replace(
        /return window\.panxu\.invoke[^;]+;/,
        "return batchMock(method,args);",
      );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: batchMock.toString() + "\n" + next,
      contentType: "application/javascript",
    });
  });
  const finish = () =>
    page.evaluate(() => (window.__accountBatchQa.complete = true));
  const panel = () =>
    page.getByRole("region", { name: "账号批量操作", exact: true });
  try {
    await page.reload();
    await page
      .getByRole("heading", { name: "账号管理", exact: true })
      .waitFor();
    await panel()
      .getByRole("button", { name: /批量操作.*展开/ })
      .waitFor();
    assert.equal(
      await panel()
        .getByRole("button", { name: "批量核验登录", exact: true })
        .count(),
      0,
    );
    await panel()
      .getByRole("button", { name: /批量操作.*展开/ })
      .click();
    assert.equal(
      await panel()
        .getByRole("button", { name: "批量核验登录", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("tab", { name: /^百度\s+4$/ }).click();
    await page
      .getByRole("checkbox", { name: "选择百度一", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "选择百度二", exact: true })
      .check();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "选择百度已停用", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("searchbox", { name: "搜索网盘账号", exact: true })
      .fill("百度一");
    await panel().getByText("已选 2 个", { exact: true }).waitFor();
    await page
      .getByRole("searchbox", { name: "搜索网盘账号", exact: true })
      .fill("");
    await panel()
      .getByRole("button", { name: "批量核验登录", exact: true })
      .click();
    await panel()
      .getByRole("button", { name: "停止排队", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "选择百度一", exact: true })
        .isDisabled(),
      true,
    );
    await panel()
      .getByRole("button", { name: /批量操作.*收起/ })
      .click();
    assert.equal(
      await panel()
        .getByRole("list", { name: "批量账号逐项结果", exact: true })
        .count(),
      0,
    );
    await panel()
      .getByRole("button", { name: "停止排队", exact: true })
      .waitFor();
    await page.screenshot({
      path: `${out}/00-drive-batch-collapsed.png`,
      fullPage: false,
    });
    await panel()
      .getByRole("button", { name: /批量操作.*展开/ })
      .click();
    await page.screenshot({
      path: `${out}/01-drive-batch-running.png`,
      fullPage: true,
    });
    await finish();
    await panel()
      .getByRole("button", { name: "重试未完成项", exact: true })
      .waitFor();
    await panel()
      .getByRole("button", { name: "重试未完成项", exact: true })
      .click();
    let calls = await page.evaluate(() => window.__accountBatchQa.calls);
    assert.deepEqual(calls[1].args.accountIds, ["baidu-b"]);
    await finish();
    await panel()
      .getByText(/1\/1，0 个失败/)
      .waitFor();
    await page
      .getByRole("checkbox", { name: "全选当前筛选账号", exact: true })
      .check();
    await panel().getByText("已选 3 个", { exact: true }).waitFor();
    await panel()
      .getByRole("button", { name: "批量刷新容量和会员", exact: true })
      .click();
    await panel()
      .getByRole("button", { name: "停止排队", exact: true })
      .click();
    await panel()
      .getByRole("button", { name: "正在停止…", exact: true })
      .waitFor();
    assert.equal(await panel().getByText("未执行", { exact: true }).count(), 2);
    await finish();
    await panel()
      .getByText(/已停止排队/)
      .first()
      .waitFor();
    await page.getByRole("tab", { name: /^夸克\s+1$/ }).click();
    await panel().getByText("已选 0 个", { exact: true }).waitFor();
    await page
      .getByRole("checkbox", { name: "选择夸克一", exact: true })
      .check();
    await panel()
      .getByRole("button", { name: "批量核验登录", exact: true })
      .click();
    calls = await page.evaluate(() => window.__accountBatchQa.calls);
    const quark = calls.filter((c) => c.method === "accountBatch.start").at(-1);
    assert.equal(quark.args.provider, "quark");
    assert.deepEqual(quark.args.accountIds, ["quark-a"]);
    await finish();
    await panel()
      .getByText(/1\/1，0 个失败/)
      .waitFor();
    await page.getByRole("tab", { name: "其他账号", exact: true }).click();
    await panel()
      .getByRole("button", { name: /批量操作.*展开/ })
      .click();
    await page.getByRole("tab", { name: /^百度贴吧\s+2$/ }).waitFor();
    await page.getByRole("tab", { name: /^百度贴吧\s+2$/ }).click();
    await page
      .getByRole("checkbox", { name: "全选当前筛选账号", exact: true })
      .check();
    await panel()
      .getByRole("button", { name: "批量核验登录", exact: true })
      .click();
    await panel()
      .getByRole("button", { name: "停止排队", exact: true })
      .waitFor();
    await page.screenshot({
      path: `${out}/02-other-accounts-running.png`,
      fullPage: true,
    });
    calls = await page.evaluate(() => window.__accountBatchQa.calls);
    const other = calls.filter((c) => c.method === "accountBatch.start").at(-1);
    assert.equal(other.args.scope, "other");
    assert.equal(other.args.provider, "tieba");
    assert.deepEqual(other.args.accountIds, ["web_tieba_a", "web_tieba_b"]);
    await finish();
    await panel()
      .getByText(/2\/2，0 个失败/)
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
      path: `${out}/03-other-accounts-completed.png`,
      fullPage: true,
    });
    await page.reload();
    await panel()
      .getByRole("button", { name: /批量操作.*收起/ })
      .waitFor();
    await panel()
      .getByRole("button", { name: /批量操作.*收起/ })
      .click();
    await page.reload();
    await panel()
      .getByRole("button", { name: /批量操作.*展开/ })
      .waitFor();
    assert.equal(
      await panel()
        .getByRole("list", { name: "批量账号逐项结果", exact: true })
        .count(),
      0,
    );
    return {
      out,
      checks: [
        "默认收起与刷新恢复",
        "收起保留进度与停止操作",
        "同类型多选",
        "停用账号不参与",
        "筛选保留选择",
        "并发进度",
        "仅重试未完成项",
        "停止未启动项",
        "切换类型清空选择",
        "批量刷新容量会员",
        "其他账号批量核验",
        "无真实业务写入",
      ],
    };
  } finally {
    await page.unroute("**/src/api/client.ts*");
  }
}
