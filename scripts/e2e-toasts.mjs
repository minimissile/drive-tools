import { openAccountForm } from "./e2e-account-form.mjs";
// Browser plugin unavailable. Real source UI actions, disposable DB, mocked failures and local knowledge.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-toasts-"));
const dataPath = join(evidence, "data");
await mkdir(dataPath);
const identity = await fetch("http://127.0.0.1:5173/__panxu_dev").then((r) =>
  r.json(),
);
assert.equal(identity.root, process.cwd());
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:5173",
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
  colors = [];
let page;
console.log(`Toast evidence: ${evidence}`);
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.__toastExternal = 0;
    globalThis.fetch = async () => {
      globalThis.__toastExternal++;
      throw Error("Toast QA blocks external services");
    };
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const u = new URL(d.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:5173",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  await page.addInitScript(() => {
    window.__toastMode = "";
    window.__toastAddCalls = 0;
  });
  const client = await fetch("http://127.0.0.1:5173/src/api/client.ts").then(
    (r) => r.text(),
  );
  const source = client.replace(
    "return window.panxu.invoke",
    `
    if (method === "account.add") {
      window.__toastAddCalls++;
      if (window.__toastMode === "error") return Promise.reject(new Error("模拟保存失败：本地数据库暂不可写，请检查文件权限后重试。"));
      if (window.__toastMode === "long-error") return Promise.reject(new Error("模拟保存失败：" + "本地数据库暂不可写，请检查工作空间文件权限后重试。".repeat(30) + " / "+"long-workspace-path/".repeat(15)));
      if (window.__toastMode === "refresh-warning") return window.panxu.invoke(method,args).then(value => {window.__toastMode="snapshot-fail";return value});
    }
    if (method === "account.update" && window.__toastMode === "dialog-error") return Promise.reject(new Error("模拟账号设置保存失败，请检查本地文件权限后重试。"));
    if (method === "snapshot" && window.__toastMode === "snapshot-fail") {window.__toastMode="";return Promise.reject(new Error("模拟提交后读取失败"))}
    if (method === "traffic.knowledge.list") return Promise.resolve({total:1,page:1,pageSize:25,items:[{id:"local-keyword",queryId:"local-query",kind:"keyword",word:"本地验收关键词",platform:null,source:"模拟本地记录",metrics:{},observedAt:null,sourceUpdatedAt:null,observations:1}],queries:[],summary:{queries:1,responses:1,words:1,hotspots:0,observations:1,legacy:0},seeds:[],patterns:[]});
    return window.panxu.invoke`,
  );
  assert.notEqual(source, client);
  await page.route("**/src/api/client.ts*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: source }),
  );
  await page.reload();
  await page.locator(".resource-list").waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1320, 900),
  );
  await page.clock.install();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  const toast = page.locator(".toast");
  const dismiss = async () => {
    await toast.getByRole("button", { name: "关闭提示", exact: true }).click();
    await toast.waitFor({ state: "detached" });
  };
  const shot = async (name) => {
    await toast.evaluate((n) => n.getAnimations().forEach((a) => a.finish()));
    await page.clock.runFor(40);
    await page.waitForTimeout(120);
    const data = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(evidence, name + ".png"), Buffer.from(data, "base64"));
  };
  const inspect = async (tone, role) => {
    await page.locator(`.toast[data-tone="${tone}"]`).waitFor();
    assert.equal(await toast.getAttribute("role"), role);
    assert.equal(await toast.locator(".toast-icon").count(), 1);
    assert.equal(
      await toast
        .locator(".toast-close")
        .evaluate((n) => getComputedStyle(n).color),
      await toast.evaluate((n) => getComputedStyle(n).color),
    );
    assert.ok(
      await toast.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return document
          .elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          .some((e) => e === n || n.contains(e));
      }),
    );
    const value = await toast.evaluate((n) => ({
      tone: n.dataset.tone,
      color: getComputedStyle(n).color,
      background: getComputedStyle(n).backgroundColor,
    }));
    const luminance = (c) =>
      c
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map((v) => Number(v) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    value.contrast =
      (luminance(value.background) + 0.05) / (luminance(value.color) + 0.05);
    assert.ok(value.contrast >= 4.5, JSON.stringify(value));
    colors.push(value);
  };
  const add = async (alias) => {
    await openAccountForm(page);
    await page.getByLabel("新增账号别名").fill(alias);
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
  };
  await nav("账号管理").click();
  await add("Toast 状态验收本人账号");
  await inspect("success", "status");
  assert.equal(colors.at(-1).color, "rgb(35, 122, 94)");
  await shot("success-green-1320");
  await toast.hover();
  await page.clock.runFor(9000);
  assert.equal(await toast.count(), 1);
  await page.mouse.move(100, 100);
  await page.clock.runFor(6600);
  await toast.waitFor({ state: "detached" });
  checks.push("创建账号的完成提示为绿色，悬停暂停自动关闭，移出后正常关闭");
  await add("重复消息计时验收账号");
  await inspect("success", "status");
  await page.mouse.move(100, 100);
  await page.clock.runFor(4000);
  await add("相同完成文案的新账号");
  await page.clock.runFor(3000);
  assert.equal(await toast.count(), 1);
  await toast.getByRole("button", { name: "关闭提示" }).focus();
  await page.clock.runFor(9000);
  assert.equal(await toast.count(), 1);
  await page.keyboard.press("Enter");
  await toast.waitFor({ state: "detached" });
  checks.push("相同文案的连续操作重新计时；键盘聚焦暂停，Enter 可关闭");
  await nav("录入资源").click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("invalid cover"),
  });
  await inspect("warning", "alert");
  assert.equal(colors.at(-1).color, "rgb(148, 101, 28)");
  await page.clock.runFor(13000);
  assert.equal(await toast.count(), 1);
  await shot("warning-amber-1320");
  await dismiss();
  checks.push("附件限制使用琥珀色警告，持续可读并可手动关闭");
  await nav("账号管理").click();
  await page.evaluate(() => {
    window.__toastMode = "error";
  });
  await add("模拟保存失败");
  await inspect("error", "alert");
  assert.equal(colors.at(-1).color, "rgb(185, 72, 78)");
  await page.clock.runFor(13000);
  assert.equal(await toast.count(), 1);
  await shot("error-red-1320");
  await dismiss();
  checks.push("操作异常使用红色错误，保留错误原因与恢复指引，不提前消失");
  const row = page.locator(".account-row").first();
  await row.getByRole("button", { name: "管理", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.evaluate(() => {
    window.__toastMode = "dialog-error";
  });
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  await inspect("error", "alert");
  assert.equal(await dialog.locator(".toast").count(), 1);
  await toast.getByRole("button", { name: "关闭提示" }).focus();
  assert.ok(await toast.evaluate((n) => n.contains(document.activeElement)));
  await shot("dialog-error-red-1320");
  await page.keyboard.press("Enter");
  await toast.waitFor({ state: "detached" });
  await dialog.getByRole("button", { name: "保存设置", exact: true }).focus();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  checks.push(
    "弹窗内的保存失败可见，Toast 进入当前弹窗焦点范围，键盘关闭不离开弹窗",
  );
  await page.evaluate(() => {
    window.__toastMode = "refresh-warning";
  });
  const before = await page.evaluate(() => window.__toastAddCalls);
  await add("操作完成但读取失败的账号");
  await inspect("warning", "alert");
  assert.match(await toast.innerText(), /操作已完成.*避免重复提交/);
  assert.equal(await page.evaluate(() => window.__toastAddCalls), before + 1);
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page
    .getByRole("heading", { name: "操作完成但读取失败的账号", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.__toastAddCalls), before + 1);
  await dismiss();
  checks.push("提交成功、刷新失败显示警告；重试只恢复读取，不重复创建账号");
  await nav("流量发现").click();
  await page.getByRole("tab", { name: "本地知识库", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择知识库词 本地验收关键词", exact: true })
    .check();
  await page
    .getByRole("button", { name: "带入找词 / AI联想", exact: true })
    .click();
  await inspect("info", "status");
  assert.equal(colors.at(-1).color, "rgb(46, 97, 213)");
  await shot("info-blue-1320");
  await dismiss();
  checks.push("知识库带入查询的下一步指引用蓝色信息，未执行外部查询");
  await nav("账号管理").click();
  await page.evaluate(() => {
    window.__toastMode = "long-error";
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 900),
  );
  await add("长内容与小窗口验收");
  await inspect("error", "alert");
  const assertBounds = async () => {
    const bounds = await toast.evaluate((n) => {
      const r = n.getBoundingClientRect();
      const c = n.querySelector(".toast-close").getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        closeRight: c.right,
        closeBottom: c.bottom,
      };
    });
    assert.ok(
      bounds.left >= 0 &&
        bounds.right <= bounds.width &&
        bounds.bottom <= bounds.height &&
        bounds.closeRight <= bounds.width &&
        bounds.closeBottom <= bounds.height,
      JSON.stringify(bounds),
    );
  };
  await assertBounds();
  assert.ok(
    await toast
      .locator(".toast-message")
      .evaluate((n) => n.scrollHeight > n.clientHeight),
  );
  await shot("long-error-840");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await assertBounds();
  await toast.getByRole("button", { name: "关闭提示" }).focus();
  await shot("long-error-840-zoom200");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await toast.evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  await page.keyboard.press("Enter");
  await toast.waitFor({ state: "detached" });
  checks.push(
    "840px、200% 和超长中文/路径可换行滚动；关闭可达，减少动态效果停止入场动画",
  );
  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(() => globalThis.__toastExternal), 0);
  console.log(JSON.stringify({ checks, colors, errors, evidence }, null, 2));
} catch (error) {
  console.error(
    await page
      ?.evaluate(() => document.body.innerText.slice(-1500))
      .catch(() => null),
  );
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, colors, errors, dataPath }, null, 2),
  );
  await app.close();
}
