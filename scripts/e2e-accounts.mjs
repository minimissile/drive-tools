import { chooseOption } from "./e2e-select.mjs";
import { openAccountForm } from "./e2e-account-form.mjs";
// Browser plugin unavailable. Current source, isolated SQLite, local fixtures and blocked remote services.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-accounts-"));
const dataPath = join(evidence, "data");
await mkdir(dataPath);
const identity = await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) =>
  r.json(),
);
assert.equal(identity.root, process.cwd());
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
  errors = [];
let page;
console.log(`Account evidence: ${evidence}`);
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.__accountExternal = 0;
    globalThis.fetch = async () => {
      globalThis.__accountExternal++;
      throw Error("Account QA blocks external services");
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
  const accounts = await page.evaluate(async () => {
    const rows = [];
    for (const [provider, alias] of [
      ["quark", "夸克主账号"],
      ["baidu", "百度资料归档"],
      ["uc", "UC 素材账号"],
      ["xunlei", "迅雷备用账号"],
      ["guangya", "光鸭工作账号"],
      ["pikpak", "PikPak 国际素材"],
      ["quark", "夸克团队共享素材与长期归档备用账号 · 超长名称布局验收"],
    ])
      rows.push(await window.panxu.invoke("account.add", { provider, alias }));
    return rows;
  });
  const db = new DatabaseSync(join(dataPath, "panxu.db"));
  const timestamp = "2026-10-17T02:30:00.000Z";
  const states = [
    "connected",
    "expired",
    "disconnected",
    "disabled",
    "connected",
    "connected",
    "connected",
  ];
  accounts.forEach((a, i) => {
    const uid = i === 2 ? null : `local-owner-${i}-1289067832`;
    db.prepare(
      "UPDATE accounts SET uid=?,status=?,enabled=?,verified_at=?,error=? WHERE id=?",
    ).run(
      uid,
      states[i],
      i === 3 ? 0 : 1,
      i === 2 ? null : timestamp,
      i === 1 ? "登录已过期，请在官方窗口重新登录后核验。" : null,
      a.id,
    );
    if (uid)
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(
        `account:capacity:${a.id}`,
        JSON.stringify({
          ownerUid: uid,
          value: {
            totalBytes: 2 * 1024 ** 4,
            usedBytes: Math.round(
              (i === 5 ? 1.92 : i === 1 ? 0.8 : 0.45) * 1024 ** 4,
            ),
          },
          updatedAt: timestamp,
          attemptedAt: timestamp,
          error: i === 1 ? "登录已过期，保留上次读取结果。" : null,
        }),
      );
  });
  db.close();
  await page.addInitScript(() => {
    window.__accountCalls = { login: 0, verify: 0, capacity: 0, add: 0 };
    window.__holdCapacity = false;
    window.__holdAdd = false;
  });
  const client = await fetch("http://127.0.0.1:8070/src/api/client.ts").then(
    (r) => r.text(),
  );
  const instrumented = client.replace(
    "return window.panxu.invoke",
    `
  if(method === "account.login") { window.__accountCalls.login++;return Promise.resolve(true); }
  if(method === "account.check") {window.__accountCalls.verify++;return window.panxu.invoke("snapshot").then(s=>{const a=s.accounts.find(a=>a.id===args.id);if(a.status!=="connected")throw Error("模拟尚未完成官方登录，请完成后再核验。");return a;});}
  if(method === "account.capacity") {window.__accountCalls.capacity++;const read=()=>window.panxu.invoke("snapshot").then(s=>s.accounts.find(a=>a.id===args.id));return window.__holdCapacity ? new Promise(resolve=>{window.__releaseCapacity=()=>read().then(resolve)}) : read();}
  if(method === "account.add") {window.__accountCalls.add++;if(window.__holdAdd)return new Promise(resolve=>{window.__releaseAdd=()=>window.panxu.invoke(method,args).then(resolve)});}
  return window.panxu.invoke`,
  );
  assert.notEqual(client, instrumented);
  await page.route("**/src/api/client.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: instrumented,
    }),
  );
  await page.reload();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await nav("账号管理").click();
  await page.locator(".account-row").first().waitFor();
  const size = (w, h = 900) =>
    app.evaluate(
      ({ BrowserWindow }, [w, h]) =>
        BrowserWindow.getAllWindows()[0].setSize(w, h),
      [w, h],
    );
  const shot = async (name) => {
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(evidence, name + ".png"), Buffer.from(png, "base64"));
  };
  await size(1440);
  await shot(
    process.env.PANXU_ACCOUNTS_BASELINE ? "before-1440" : "accounts-1440",
  );
  if (!process.env.PANXU_ACCOUNTS_BASELINE) {
    const byAlias = (alias) =>
      page.locator(".account-row").filter({
        has: page.getByRole("heading", { name: alias, exact: true }),
      });
    const all = () => page.getByRole("tab", { name: /^全部网盘/ }).click();
    const filter = (name) =>
      page.getByRole("tab", { name: new RegExp("^" + name + "\\s") }).click();
    const search = page.getByRole("searchbox", { name: "搜索网盘账号" });
    const snap = () => page.evaluate(() => window.panxu.invoke("snapshot"));
    const dismiss = async () => {
      const close = page.getByRole("button", { name: "关闭提示", exact: true });
      if (await close.isVisible()) await close.click();
    };
    const writeAccount = (id, fields) => {
      const d = new DatabaseSync(join(dataPath, "panxu.db"));
      try {
        d.prepare(
          `UPDATE accounts SET ${Object.keys(fields)
            .map((k) => k + "=?")
            .join(",")} WHERE id=?`,
        ).run(...Object.values(fields), id);
      } finally {
        d.close();
      }
    };
    const writeCapacity = (account, error = null) => {
      const d = new DatabaseSync(join(dataPath, "panxu.db"));
      try {
        d.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(
          `account:capacity:${account.id}`,
          JSON.stringify({
            ownerUid: account.uid,
            value: {
              totalBytes: 2 * 1024 ** 4,
              usedBytes: Math.round(0.45 * 1024 ** 4),
            },
            updatedAt: timestamp,
            attemptedAt: timestamp,
            error,
          }),
        );
      } finally {
        d.close();
      }
    };
    assert.equal(await page.locator(".account-row").count(), 7);
    assert.equal(await page.getByLabel("新增账号别名").isVisible(), false);
    const icons = await page
      .locator(".accounts-provider-filter img")
      .evaluateAll((images) =>
        images.map((i) => ({
          loaded: i.complete && i.naturalWidth > 0,
          url: i.src,
        })),
      );
    assert.equal(icons.length, 6);
    assert.ok(
      icons.every(
        (i) =>
          i.loaded &&
          (i.url.startsWith("http://127.0.0.1:8070/") ||
            i.url.startsWith("data:")),
      ),
    );
    await page.getByRole("tab", { name: /^全部网盘/ }).focus();
    await page.keyboard.press("End");
    await page.getByRole("tab", { name: /^PikPak/, selected: true }).waitFor();
    assert.equal(await page.locator(".account-row").count(), 1);
    await page.keyboard.press("Home");
    await page
      .getByRole("tab", { name: /^全部网盘/, selected: true })
      .waitFor();
    await filter("夸克");
    assert.equal(await page.locator(".account-row").count(), 2);
    await search.fill("local-owner-6");
    assert.equal(await page.locator(".account-row").count(), 1);
    await search.fill("不存在的别名");
    await page
      .getByRole("heading", { name: "没有找到匹配的账号", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    assert.equal(await page.locator(".account-row").count(), 7);
    checks.push(
      "六家真实 Logo 随源码本地加载；网盘筛选、键盘 Home/End、完整 UID 搜索和空结果恢复",
    );
    await filter("夸克");
    const backup = byAlias(accounts[6].alias),
      main = byAlias(accounts[0].alias);
    await backup.getByRole("button", { name: "切换使用", exact: true }).click();
    await backup.getByText("当前使用", { exact: true }).waitFor();
    assert.equal(await main.getByText("默认账号", { exact: true }).count(), 1);
    assert.equal(
      (await snap()).accounts.find((a) => a.id === accounts[0].id).isDefault,
      true,
    );
    await page.reload();
    await nav("账号管理").click();
    await filter("夸克");
    await backup.getByText("当前使用", { exact: true }).waitFor();
    await backup.getByRole("button", { name: "管理", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "设为默认", exact: true }).click();
    await dialog
      .getByRole("button", { name: "已设为默认", exact: true })
      .waitFor();
    assert.equal(
      (await snap()).accounts.filter(
        (a) => a.provider === "quark" && a.isDefault,
      ).length,
      1,
    );
    await dialog
      .getByLabel("账号别名", { exact: true })
      .fill("夸克备用资料账号（已调整）");
    await dialog.getByLabel("默认转存目录").fill("/运营资料/已归档");
    await shot("manage-account-1440");
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      (await snap()).accounts.find((a) => a.id === accounts[6].id)
        .defaultDirectory,
      "/运营资料/已归档",
    );
    await byAlias("夸克备用资料账号（已调整）")
      .getByRole("button", { name: "管理", exact: true })
      .waitFor();
    checks.push(
      "当前使用与新任务默认账号独立；切换刷新保持、默认设置唯一、别名和目录可保存",
    );
    await all();
    const disabled = byAlias(accounts[3].alias);
    assert.equal(
      await disabled
        .getByRole("button", { name: "登录本人账号", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await disabled
        .getByRole("button", { name: "刷新容量", exact: true })
        .isDisabled(),
      true,
    );
    await disabled.getByRole("button", { name: "管理", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("checkbox", { name: "启用此账号", exact: true })
      .check();
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await disabled
      .getByRole("button", { name: "登录本人账号", exact: true })
      .waitFor();
    assert.equal(
      (await snap()).accounts.find((a) => a.id === accounts[3].id).status,
      "expired",
    );
    checks.push(
      "停用账号不展示无效登录操作；重新启用保留身份并要求重新登录核验",
    );
    const guangya = byAlias(accounts[4].alias);
    await guangya.getByRole("button", { name: "管理", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "移除本地凭据", exact: true })
      .click();
    await dialog
      .getByRole("group", { name: "确认移除本地凭据", exact: true })
      .waitFor();
    assert.equal(
      (await snap()).accounts.find((a) => a.id === accounts[4].id).status,
      "connected",
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "保留凭据", exact: true })
        .evaluate((n) => n === document.activeElement),
      true,
    );
    await dialog.getByRole("button", { name: "保留凭据", exact: true }).click();
    await dialog
      .getByRole("button", { name: "移除本地凭据", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "确认移除本地凭据", exact: true })
      .click();
    await dialog.waitFor({ state: "detached" });
    const cleared = (await snap()).accounts.find(
      (a) => a.id === accounts[4].id,
    );
    assert.equal(cleared.status, "disabled");
    assert.equal(cleared.enabled, false);
    assert.equal(cleared.uid, "local-owner-4-1289067832");
    checks.push(
      "移除本地凭据先展示范围与确认；取消不改数据，确认保留 UID 和历史归属",
    );
    await dismiss();
    await filter("百度");
    await search.fill("暂时没有匹配项");
    await openAccountForm(page);
    await chooseOption(page.getByLabel("新增账号网盘"), "uc");
    await page.getByLabel("新增账号别名").fill("UC 新增本人账号");
    await page.evaluate(() => {
      window.__holdAdd = true;
    });
    await page.getByLabel("新增账号别名").press("Enter");
    await page.waitForFunction(() => !!window.__releaseAdd);
    assert.equal(
      await page
        .getByRole("button", { name: "正在添加…", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await page.evaluate(() => window.__accountCalls.add), 1);
    await page.evaluate(() => {
      window.__holdAdd = false;
      window.__releaseAdd();
    });
    const created = byAlias("UC 新增本人账号");
    await created.waitFor();
    await page.getByRole("tab", { name: /^UC/, selected: true }).waitFor();
    assert.equal(await page.getByLabel("新增账号别名").isVisible(), false);
    assert.equal(await search.inputValue(), "");
    assert.equal(
      await created
        .getByRole("button", { name: "登录本人账号", exact: true })
        .evaluate((n) => n === document.activeElement),
      true,
    );
    assert.equal(await page.evaluate(() => window.__accountCalls.login), 0);
    await created
      .getByRole("button", { name: "登录本人账号", exact: true })
      .click();
    await page.locator('.toast[data-tone="info"]').waitFor();
    assert.equal(await page.evaluate(() => window.__accountCalls.login), 1);
    const added = (await snap()).accounts.find(
      (a) => a.alias === "UC 新增本人账号",
    );
    writeAccount(added.id, {
      uid: "qa-verified-owner",
      status: "connected",
      verified_at: timestamp,
    });
    await created
      .getByRole("button", { name: "核验登录", exact: true })
      .click();
    await created.getByText("已登录", { exact: true }).waitFor();
    checks.push(
      "跨网盘筛选下创建账号可见；Enter 提交防重复，成功收起并聚焦登录；登录和 UID 核验均显式触发，使用模拟结果",
    );
    await all();
    const connected = byAlias(accounts[0].alias);
    await page.evaluate(() => {
      window.__holdCapacity = true;
    });
    const capacity = connected.getByRole("region", {
      name: accounts[0].alias + "网盘容量",
    });
    // The section is labelled, so it is a landmark region in the accessible tree.
    await connected
      .getByRole("button", { name: "刷新容量", exact: true })
      .click();
    await page.waitForFunction(() => !!window.__releaseCapacity);
    assert.equal(await capacity.getAttribute("aria-busy"), "true");
    assert.match(await capacity.innerText(), /460.8 GB/);
    writeCapacity(
      (await snap()).accounts.find((a) => a.id === accounts[0].id),
      "模拟容量响应失败，保留已有容量。",
    );
    await page.evaluate(() => {
      window.__holdCapacity = false;
      window.__releaseCapacity();
    });
    await connected.getByText("上次记录", { exact: true }).waitFor();
    await page.locator('.toast[data-tone="warning"]').waitFor();
    writeCapacity((await snap()).accounts.find((a) => a.id === accounts[0].id));
    await connected
      .getByRole("button", { name: "刷新容量", exact: true })
      .click();
    await page.locator('.toast[data-tone="success"]').waitFor();
    assert.equal(
      await connected.getByText("上次记录", { exact: true }).count(),
      0,
    );
    checks.push(
      "容量慢响应保留数值、展示局部忙碌；失败保留上次容量并提示警告，手动刷新可恢复",
    );
    await dismiss();
    await openAccountForm(page);
    await page.getByLabel("新增账号别名").fill("尚未提交的账号别名");
    await page.getByRole("button", { name: "收起添加", exact: true }).click();
    await openAccountForm(page);
    assert.equal(
      await page.getByLabel("新增账号别名").inputValue(),
      "尚未提交的账号别名",
    );
    await nav("资源库").click();
    await nav("账号管理").click();
    await openAccountForm(page);
    assert.equal(
      await page.getByLabel("新增账号别名").inputValue(),
      "尚未提交的账号别名",
    );
    await page.getByRole("button", { name: "收起添加", exact: true }).click();
    checks.push(
      "新增表单按需展开；收起、切页后恢复未提交别名，不恢复或触发远端操作",
    );
    const overflow = async () =>
      assert.ok(
        await page
          .locator("main")
          .evaluate((n) => n.scrollWidth <= n.clientWidth),
        "main horizontal overflow",
      );
    await size(1320);
    await overflow();
    await shot("accounts-1320");
    await size(1024);
    await overflow();
    await shot("accounts-1024");
    await size(840);
    await overflow();
    await shot("accounts-840");
    await filter("夸克");
    await byAlias("夸克备用资料账号（已调整）")
      .getByRole("button", { name: "管理", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await shot("manage-account-840");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
    );
    await overflow();
    await shot("accounts-840-zoom200");
    await openAccountForm(page);
    await overflow();
    await page.getByLabel("新增账号别名").scrollIntoViewIfNeeded();
    await shot("add-account-840-zoom200");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.ok(
      (
        await page
          .getByLabel("新增账号别名")
          .evaluate((n) => getComputedStyle(n).transitionDuration)
      )
        .split(",")
        .every((d) => parseFloat(d) === 0),
    );
    checks.push(
      "1440/1320/1024/840 宽度及 200% 缩放无横向溢出，长名称和管理/新增入口可达；减少动态效果沿用公共控件契约",
    );
  }
  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(() => globalThis.__accountExternal), 0);
  console.log(JSON.stringify({ checks, errors, evidence, dataPath }, null, 2));
} catch (e) {
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw e;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, dataPath }, null, 2),
  );
  await app.close();
}
