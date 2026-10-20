// Browser plugin not available. Current source in an isolated Electron window; all remote services blocked.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  root = process.cwd(),
  evidence = await mkdtemp(join(tmpdir(), "panxu-intake-ui-")),
  dataPath = join(evidence, "data");
await mkdir(dataPath);
assert.equal(
  (await fetch("http://127.0.0.1:5173/__panxu_dev").then((r) => r.json())).root,
  root,
);
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:5173",
  PANXU_DEV_ROOT: root,
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [join(root, "dist-dev")],
  env,
  timeout: 45000,
});
console.log("Intake evidence:", evidence);
const errors = [],
  checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.fetch = async () => {
      throw Error("No real services in intake QA");
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
  const accounts = await page.evaluate(async () => {
    const result = [];
    for (const [provider, alias, directory] of [
      ["quark", "夸克测试本人", "/夸克资料"],
      ["baidu", "百度测试本人", "/百度资料"],
    ]) {
      const a = await window.panxu.invoke("account.add", { provider, alias });
      await window.panxu.invoke("account.update", {
        id: a.id,
        alias,
        enabled: true,
        defaultDirectory: directory,
      });
      result.push(a);
    }
    return result;
  });
  const client = await fetch("http://127.0.0.1:5173/src/api/client.ts").then(
    (r) => r.text(),
  );
  const instrumented = client.replace(
    "return window.panxu.invoke",
    `if(method === "share.parse") { if(args.text.includes("延迟响应")) return new Promise(resolve=>{window.__releaseIntakeParse=()=>window.panxu.invoke(method,args).then(resolve);}); }
 if(method === "share.inspect") {window.__intakeInspects=(window.__intakeInspects??0)+1;return Promise.resolve({shareKey:"fixture",title:"小文件",files:[{id:"fixture-file",name:"本人资料.txt",isDirectory:false,size:16,parentId:"0"}],parentId:"0",page:1,hasMore:false});}
 return window.panxu.invoke`,
  );
  assert.notEqual(client, instrumented);
  await page.route("**/src/api/client.ts*", (r) =>
    r.fulfill({ contentType: "application/javascript", body: instrumented }),
  );
  await page.reload();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await nav("录入资源").click();
  const link = page.getByLabel("网盘分享链接", { exact: true });
  await link.fill(
    "这是百度资料 https://pan.baidu.com/s/1source123?pwd=1234 提取码：1234",
  );
  await page.getByLabel("资源标题", { exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="网盘分享链接"]').value ===
      "https://pan.baidu.com/s/1source123",
  );
  assert.equal(
    await page.getByLabel("提取码", { exact: true }).inputValue(),
    "1234",
  );
  assert.equal(
    await page
      .getByLabel("转存与分享账号", { exact: true })
      .getAttribute("data-value"),
    accounts[1].id,
  );
  assert.equal(
    await page.getByLabel("目标目录", { exact: true }).inputValue(),
    "/百度资料",
  );
  assert.equal(await page.evaluate(() => window.__intakeInspects ?? 0), 0);
  checks.push(
    "失焦提取链接/提取码，自动切到百度账号与默认目录，无自动远端读取",
  );
  await page.getByRole("button", { name: "新增分类", exact: true }).click();
  await page.getByLabel("新分类", { exact: true }).fill("SEO 与内容营销素材");
  await page.getByRole("button", { name: "保存选项", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="分类"]').value ===
      "SEO 与内容营销素材",
  );
  await page.getByRole("button", { name: "新增目标目录", exact: true }).click();
  await page
    .getByLabel("新目标目录", { exact: true })
    .fill("/营销资源/课程资料");
  await page.getByRole("button", { name: "保存选项", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="目标目录"]').value ===
      "/营销资源/课程资料",
  );
  await page.reload();
  await nav("录入资源").click();
  assert.equal(
    await page.getByLabel("分类", { exact: true }).inputValue(),
    "SEO 与内容营销素材",
  );
  assert.equal(
    await page.getByLabel("目标目录", { exact: true }).inputValue(),
    "/营销资源/课程资料",
  );
  const options = await page.evaluate(
    (id) => window.panxu.invoke("resource.intakeOptions", { accountId: id }),
    accounts[1].id,
  );
  assert.ok(options.categories.includes("SEO 与内容营销素材"));
  assert.ok(options.directories.includes("/营销资源/课程资料"));
  checks.push("表单直接新增分类与账号目录，刷新恢复并沉淀为可选项");
  await link.fill("延迟响应 https://pan.baidu.com/s/1oldsource?pwd=0000");
  await page.getByLabel("资源标题", { exact: true }).click();
  await page.waitForFunction(
    () => typeof window.__releaseIntakeParse === "function",
  );
  await link.fill("夸克新链接 https://pan.quark.cn/s/newsource123?pwd=abcd");
  await page.getByLabel("资源标题", { exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="网盘分享链接"]').value ===
      "https://pan.quark.cn/s/newsource123",
  );
  await page.evaluate(() => window.__releaseIntakeParse());
  assert.equal(await link.inputValue(), "https://pan.quark.cn/s/newsource123");
  assert.equal(
    await page.getByLabel("提取码", { exact: true }).inputValue(),
    "abcd",
  );
  assert.equal(
    await page
      .getByLabel("转存与分享账号", { exact: true })
      .getAttribute("data-value"),
    accounts[0].id,
  );
  assert.equal(
    await page.getByLabel("目标目录", { exact: true }).inputValue(),
    "/夸克资料",
  );
  checks.push("旧链接解析延迟返回时，不覆盖后来输入的新网盘链接与保存位置");
  await link.fill("不是网盘链接");
  await page.getByLabel("资源标题", { exact: true }).click();
  await page
    .getByText("支持百度、夸克、UC、迅雷、光鸭和 PikPak 分享链接。", {
      exact: true,
    })
    .waitFor();
  await link.fill("https://pan.quark.cn/s/newsource123?pwd=abcd");
  await page
    .getByLabel("资源标题", { exact: true })
    .fill("录入表单实际效果与较长标题验证");
  await page.getByRole("button", { name: "读取分享内容", exact: true }).click();
  await page.getByLabel("选择本人资料.txt", { exact: true }).check();
  assert.equal(
    await page.getByText("我有权保存和分享该资源", { exact: true }).count(),
    0,
  );
  assert.ok(
    await page.getByRole("button", { name: /保存并开始转存/ }).isEnabled(),
  );
  for (const width of [1440, 840]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setSize(width, 960);
    }, width);
    await page.locator(".workspace-scroll").evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, `intake-top-${width}.png`) });
    await page
      .locator(".workspace-scroll")
      .evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.screenshot({
      path: join(evidence, `intake-bottom-${width}.png`),
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  checks.push("无权利勾选，选定文件即可转存；桌面和840px操作栏可达");
  await page.getByRole("button", { name: "保存资料草稿", exact: true }).click();
  await page
    .locator(".resource-row")
    .filter({ hasText: "录入表单实际效果与较长标题验证" })
    .waitFor();
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const resource = snapshot.resources.find(
    (r) => r.title === "录入表单实际效果与较长标题验证",
  );
  assert.equal(resource.provider, "quark");
  assert.equal(resource.copies[0].accountId, accounts[0].id);
  assert.ok(resource.copies[0].directory.startsWith("/夸克资料/"));
  checks.push("保存草稿使用已识别链接的账号和目录");
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "checks.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ evidence, checks, errors }, null, 2));
} finally {
  await app.close();
}
