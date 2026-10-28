// Browser plugin is unavailable; use Playwright with the existing source server.
// All collection responses are simulated, the database is disposable, no publishing.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { fixture } from "../tests/helpers.ts";
import { PipixClient } from "../core/pipix/client.ts";
import { PipixSources } from "../core/pipix/service.ts";
import { TikHubPipixDiscovery } from "../core/pipix/discovery.ts";
import { pipixHtml, pipixImage, pipixItemId } from "../tests/pipix-fixture.ts";
const url = "http://127.0.0.1:8070";
assert.equal(
  (await fetch(`${url}/__panxu_dev`).then((r) => r.json())).root,
  process.cwd(),
);
const evidence = await mkdtemp(join(tmpdir(), "panxu-pipix-e2e-"));
const f = await fixture();
const errors = [],
  checks = [],
  collectRequests = [],
  discoveryRequests = [];
let failDiscovery = false;
let browser,
  page,
  failList = false,
  rejectImage = false,
  failImport = false,
  holdHistory = false,
  missingHistory = false,
  releaseHistory,
  enteredHistory;
let previewImage = pipixImage;
const sources = new PipixSources(
  {
    db: f.app.db,
    dataPath: f.dir,
    ports: f.ports,
    secrets: f.app.secrets,
    changed() {},
    destinations: {
      zhihu: (material) => f.app.zhihu.saveSource(material),
      weibo: (material, accountId) =>
        f.app.weiboPosts.saveSource(material, accountId),
    },
  },
  new PipixClient(async (address) => {
    const u = new URL(String(address));
    if (u.hostname.endsWith("byteimg.com"))
      return rejectImage
        ? new Response(null, { status: 403 })
        : new Response(previewImage);
    collectRequests.push(u.pathname);
    if (u.pathname === "/s/invalid/")
      return new Response("请验证", { status: 403 });
    const id = u.pathname.match(/\/item\/(\d+)/)?.[1] ?? pipixItemId;
    return new Response(pipixHtml({ id, images: 2 }));
  }),
  new TikHubPipixDiscovery(async (address) => {
    const u = new URL(String(address));
    discoveryRequests.push(u.href);
    if (failDiscovery) return new Response("模拟服务故障", { status: 503 });
    const more = u.searchParams.get("offset") === "20";
    return Response.json({
      code: 200,
      data: {
        cell_list: [
          {
            item: {
              item_id_str: "7595847114874165561",
              content:
                "模拟列表：生活里的小发现，认真观察就能发现身边的趣事。".repeat(
                  4,
                ),
              author: { name: "本地模拟作者" },
              note: { multi_image: [{}] },
            },
          },
          {
            item: {
              item_id_str: "7595847114874165562",
              content: "模拟列表：一张图记录平凡日常",
              author: { name: "图文作者" },
              note: { multi_image: [{}] },
            },
          },
          {
            item: {
              item_id_str: "7595847114874165563",
              content: "模拟视频，不作为图文配图",
              item_type: 2,
            },
          },
          ...(more
            ? [
                {
                  item: {
                    item_id_str: "7595847114874165564",
                    content: "模拟列表：下一页的文字趣事",
                    author: { name: "文字作者" },
                  },
                },
              ]
            : []),
        ],
        offset: more ? "0" : "20",
        has_more: !more,
      },
    });
  }),
);
try {
  const weiboAccount = f.app.websiteAccounts.add("weibo", "素材测试微博");
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {},
    status: async () => ({
      hasSession: true,
      uid: "1234567890",
      windowOpen: false,
      error: null,
    }),
    verify: async () => ({
      hasSession: true,
      uid: "1234567890",
      windowOpen: false,
      error: null,
    }),
  };
  await f.app.websiteAccounts.verify(weiboAccount.id);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PANXU_QA_BROWSER ||
      join(
        process.env.HOME,
        "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
  });
  const imagePage = await browser.newPage();
  previewImage = Buffer.from(
    await imagePage.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e9f1ed";
      ctx.fillRect(0, 0, 600, 720);
      ctx.fillStyle = "#325a4c";
      ctx.font = "bold 38px sans-serif";
      ctx.fillText("模拟采集图片", 60, 130);
      ctx.font = "24px sans-serif";
      ctx.fillText("日常生活的小发现", 60, 200);
      ctx.fillStyle = "#c4d7cc";
      ctx.fillRect(60, 260, 480, 300);
      ctx.fillStyle = "#325a4c";
      ctx.fillText("用于界面验收", 205, 415);
      ctx.font = "20px sans-serif";
      ctx.fillText("来源：本地模拟服务", 60, 655);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await imagePage.close();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === url ||
    route.request().url().startsWith("data:")
      ? route.continue()
      : route.abort(),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.exposeFunction("invokeQa", async (method, args) => {
    if (method === "updater.state")
      return { phase: "idle", channel: "stable", autoCheck: false };
    if (method === "pipix.collect") return sources.collect(args.text);
    if (method === "pipix.discover") return sources.discover(args);
    if (method === "pipix.probeCapacity")
      return sources.probeCapacity(args.keyword);
    if (method === "weiboPosts.list" && holdHistory)
      await new Promise((resolve) => {
        releaseHistory = resolve;
        enteredHistory?.();
      });
    if (method === "weiboPosts.list" && missingHistory) return [];

    if (method === "pipix.export" && failImport)
      throw Error("模拟导入失败，请重试");
    if (method === "pipix.list" && failList)
      throw Error("模拟采集记录读取失败");
    return f.app.invoke(method, args);
  });
  await page.addInitScript(() => {
    window.panxu = {
      invoke: (method, args) => window.invokeQa(method, args),
      onChanged: () => () => {},
      onUpdateChanged: () => () => {},
    };
    localStorage.setItem("panxu-ui-v1", JSON.stringify({ page: "workbench" }));
  });
  await page.goto(url);
  await page.getByRole("button", { name: /^皮皮虾采集/ }).click();
  await page.getByText("还没有采集记录", { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "empty-1440.png"),
    fullPage: true,
  });
  assert.equal(discoveryRequests.length, 0);
  await page.getByRole("combobox", { name: "列表来源", exact: true }).click();
  await page
    .getByRole("option", { name: "关键词 · 图文搜索", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "获取列表并入库", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("tab", { name: "分享链接", exact: true }).click();
  const input = page.getByLabel("皮皮虾分享链接", { exact: true });
  await input.fill(
    `有趣的一天 https://h5.pipix.com/ppx/item/${pipixItemId}\nhttps://h5.pipix.com/s/invalid/`,
  );
  await page.getByRole("button", { name: "开始采集", exact: true }).click();
  await page.getByRole("button", { name: "重试失败项", exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "已采集 · 1", exact: true })
    .waitFor();
  await page.getByRole("img").first().waitFor();
  await page.getByRole("button", { name: "重试第 2 项", exact: true }).click();
  await page
    .getByRole("button", { name: "重试第 2 项", exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "开始采集", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    collectRequests.filter((v) => v.includes(pipixItemId)).length,
    1,
  );
  assert.equal(collectRequests.filter((v) => v === "/s/invalid/").length, 2);
  assert.equal(await page.locator(".pipix-results li").count(), 2);
  assert.equal(
    await page.locator(".pipix-result-copy small").last().innerText(),
    "第 2 项 · https://h5.pipix.com/s/invalid/",
  );

  const comment = page.getByRole("checkbox", { name: /换个角度/ });
  await comment.check();
  await page.getByLabel("素材标题", { exact: true }).fill("发现生活里的小惊喜");
  await page.getByRole("checkbox", { name: "配图 2", exact: true }).uncheck();
  await writeFile(
    join(evidence, "image-layout.json"),
    JSON.stringify(
      await page.locator(".pipix-image img").evaluateAll((nodes) =>
        nodes.map((n) => ({
          rect: n.getBoundingClientRect().toJSON(),
          width: getComputedStyle(n).width,
          height: getComputedStyle(n).height,
          parent: n.parentElement.getBoundingClientRect().toJSON(),
        })),
      ),
      null,
      2,
    ),
  );
  await page
    .getByRole("heading", { name: "皮皮虾采集", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "source-1440.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "送入知乎素材池", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "selection-1440.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: /^皮皮虾采集/ }).click();
  assert.equal(await comment.isChecked(), true);
  assert.equal(
    await page.getByLabel("素材标题", { exact: true }).inputValue(),
    "发现生活里的小惊喜",
  );
  await page.reload();
  await page.getByRole("button", { name: /^皮皮虾采集/ }).click();
  assert.equal(await comment.isChecked(), true);
  assert.equal(
    await page.getByLabel("素材标题", { exact: true }).inputValue(),
    "发现生活里的小惊喜",
  );
  assert.equal((await input.inputValue()).includes("/s/invalid/"), true);
  checks.push(
    "混合批量采集逐条展示结果及链接，单项重试保留其他结果；选择与标题切页、刷新恢复",
  );
  failList = true;
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await page.getByText("模拟采集记录读取失败", { exact: true }).waitFor();
  assert.equal(await page.getByRole("img").count(), 2);
  await page.screenshot({
    path: join(evidence, "read-error-1440.png"),
    fullPage: true,
  });
  failList = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page
    .getByText("模拟采集记录读取失败", { exact: true })
    .waitFor({ state: "hidden" });
  failImport = true;
  await page
    .getByRole("button", { name: "送入知乎素材池", exact: true })
    .click();
  const importFailure = page.getByText(
    "模拟导入失败，请重试 选择已保留，可修正后重试。",
    { exact: true },
  );
  await importFailure.waitFor();
  assert.equal(await importFailure.count(), 1);
  const failureRect = await importFailure.boundingBox();
  assert.equal(failureRect.y >= 48 && failureRect.y < 900, true);
  assert.equal(await comment.isChecked(), true);
  assert.equal(f.app.zhihu.snapshot().contents.length, 0);
  await page.screenshot({
    path: join(evidence, "import-error-1440.png"),
    fullPage: true,
  });
  ((failImport = false),
    (holdHistory = false),
    (missingHistory = false),
    releaseHistory,
    enteredHistory);
  await page
    .getByRole("button", { name: "送入知乎素材池", exact: true })
    .click();
  await page
    .getByRole("button", { name: "打开知乎运营", exact: true })
    .waitFor();
  let content = f.app.zhihu.snapshot().contents[0];
  assert.equal(content.reviewed, false);
  assert.equal(content.images.length, 1);
  assert.equal(content.source.comments.length, 1);
  assert.equal(f.app.zhihu.snapshot().tasks.length, 0);
  const duplicate = await sources.export({
    channel: "zhihu",
    id: pipixItemId,
    title: "重复内容",
    imageIds: [],
    commentIds: [],
  });
  assert.equal(duplicate.existing, true);
  assert.equal(f.app.zhihu.snapshot().contents.length, 1);
  await page.getByRole("button", { name: "打开知乎运营", exact: true }).click();
  await page.getByRole("tab", { name: /素材池/ }).click();
  await page.getByRole("button", { name: /发现生活里的小惊喜/ }).click();
  await page.getByText(/素材来源：皮皮虾/).waitFor();
  await page.screenshot({
    path: join(evidence, "imported-1440.png"),
    fullPage: true,
  });
  checks.push(
    "导入失败就近显示单次错误并保留选择；成功导入保持待审核，重复导入复用素材，没有排队发布",
  );
  await page.getByRole("button", { name: "公共素材采集", exact: true }).click();
  await page.getByRole("combobox", { name: "目标渠道", exact: true }).click();
  await page.getByRole("option", { name: "微博草稿", exact: true }).click();
  await page.getByRole("combobox", { name: "微博账号", exact: true }).click();
  await page.getByRole("option", { name: "素材测试微博", exact: true }).click();
  await page.getByRole("button", { name: "创建微博草稿", exact: true }).click();
  await page
    .getByRole("button", { name: "打开微博草稿", exact: true })
    .waitFor();
  const post = f.app.weiboPosts.list(weiboAccount.id)[0];
  assert.equal(post.stage, "editing");
  assert.equal(post.visibility, "self");
  assert.equal(post.images.length, 1);
  assert.equal(post.images[0].asset.file, content.images[0].file);
  const manualKey = `weibo-composer:${f.dir}:${weiboAccount.id}`;
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          id: "",
          text: "原有未保存的手写草稿",
          visibility: "self",
        }),
      ),
    manualKey,
  );
  holdHistory = true;
  const historyStarted = new Promise((resolve) => {
    enteredHistory = resolve;
  });
  await page.getByRole("button", { name: "打开微博草稿", exact: true }).click();
  await historyStarted;
  assert.equal(
    await page.getByLabel("直接发布微博文案", { exact: true }).isDisabled(),
    true,
  );
  await page.getByText("正在定位指定微博草稿…", { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "weibo-loading-1440.png"),
    fullPage: true,
  });
  holdHistory = false;
  releaseHistory();
  await page
    .getByText("正在定位指定微博草稿…", { exact: true })
    .waitFor({ state: "hidden" });

  await page.getByRole("dialog", { name: "发布微博", exact: true }).waitFor();
  await page
    .getByLabel("直接发布微博文案", { exact: true })
    .fill("微博单独编辑，保留知乎和原帖内容。");
  await page.getByRole("button", { name: "保存本地草稿", exact: true }).click();
  await page
    .getByText("正在保存草稿…", { exact: true })
    .waitFor({ state: "hidden" });
  await page.screenshot({
    path: join(evidence, "weibo-composer-1440.png"),
    fullPage: true,
  });
  await page
    .getByRole("dialog", { name: "发布微博", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  assert.equal(
    JSON.parse(
      await page.evaluate((key) => localStorage.getItem(key), manualKey),
    ).text,
    "原有未保存的手写草稿",
  );
  assert.equal(
    f.app.weiboPosts.get(post.id).text,
    "微博单独编辑，保留知乎和原帖内容。",
  );
  assert.equal(f.app.zhihu.snapshot().contents.length, 1);
  assert.equal(f.app.zhihu.snapshot().contents[0].body, content.body);
  missingHistory = true;
  await page.getByRole("button", { name: "打开微博草稿", exact: true }).click();
  await page
    .getByText(
      "此微博草稿暂未找到，请重新读取；如已删除，请返回采集页检查去向记录。",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByLabel("直接发布微博文案", { exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(evidence, "weibo-missing-1440.png"),
    fullPage: true,
  });
  missingHistory = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page
    .getByText("正在定位指定微博草稿…", { exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("dialog", { name: "发布微博", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  const second = f.app.websiteAccounts.add("weibo", "已移除的第二微博");
  f.app.db.run(
    "UPDATE website_accounts SET uid='1234567891',status='connected' WHERE id=?",
    second.id,
  );
  await sources.export({
    id: pipixItemId,
    title: "供第二账号使用",
    channel: "weibo",
    accountId: second.id,
    imageIds: [],
    commentIds: [],
  });
  await f.app.websiteAccounts.remove(second.id);
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await page.getByRole("combobox", { name: "目标渠道", exact: true }).click();
  await page.getByRole("option", { name: "知乎素材池", exact: true }).click();
  await page
    .locator(".pipix-deliveries")
    .getByText(/素材测试微博 · UID 1234567890/)
    .waitFor();
  await page
    .locator(".pipix-deliveries")
    .getByText(/已移除的第二微博 · UID 1234567891/)
    .waitFor();
  checks.push(
    "指定微博草稿读取前锁定编辑、缺失后可重试；切回知乎仍可区分两个微博去向，删除账号后保留名称与 UID",
  );
  await page.screenshot({
    path: join(evidence, "shared-destinations-1440.png"),
    fullPage: true,
  });
  checks.push(
    "独立公共入口与知乎快捷入口可达，同一采集记录同时创建知乎素材和微博草稿；微博原编辑器继续编辑且不覆盖其他未保存草稿",
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({
    path: join(evidence, "source-1366.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page
    .getByRole("heading", { name: "已使用的去向", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "exports-bottom-1366.png"),
    fullPage: true,
  });
  rejectImage = true;
  await page.getByRole("tab", { name: "分享链接", exact: true }).click();
  await input.fill("https://h5.pipix.com/ppx/item/7505930959192070451");
  await page.getByRole("button", { name: "开始采集", exact: true }).click();
  await page.getByText("图片采集失败", { exact: true }).first().waitFor();
  await page
    .getByRole("button", { name: "开始采集", exact: true })
    .waitFor({ state: "visible" });
  await page.getByRole("checkbox", { name: "配图 1", exact: true }).check();
  assert.equal(
    await page
      .getByRole("button", { name: "送入知乎素材池", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(evidence, "image-error-1366.png"),
    fullPage: true,
  });
  checks.push(
    "本地读取失败保留内容并可重试；图片失败明确提示且阻止含缺失图片导入；1440/1366 界面无横向溢出",
  );
  rejectImage = false;
  await page.getByRole("tab", { name: "获取数据列表", exact: true }).click();
  await page
    .getByRole("button", { name: "前往数据源设置", exact: true })
    .click();
  const sourceSettings = page.locator("#settings-sources");
  await sourceSettings
    .getByRole("heading", { name: "TikHub · 内容数据源", exact: true })
    .waitFor();
  await sourceSettings
    .getByLabel("pipix:tikhub密钥", { exact: true })
    .fill("Bearer qa+local/only=token~valid");
  await sourceSettings
    .getByRole("button", { name: "保存Key", exact: true })
    .click();
  await sourceSettings.getByText("已保存Key", { exact: true }).waitFor();
  await sourceSettings.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "settings-tikhub-1366.png"),
    fullPage: true,
  });
  assert.equal(
    await sourceSettings
      .getByLabel("pipix:tikhub密钥", { exact: true })
      .inputValue(),
    "",
  );
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: /^皮皮虾采集/ }).click();
  assert.equal(discoveryRequests.length, 0);
  await page.getByLabel("搜索关键词", { exact: true }).fill("生活趣事");
  assert.equal(discoveryRequests.length, 0);
  await page
    .getByRole("button", { name: "获取列表并入库", exact: true })
    .click();
  await page.getByText(/知识库 3 条 · 归档响应 1 份 · 当前结果 2 条/).waitFor();
  assert.equal(discoveryRequests.length, 1);
  await page.getByRole("checkbox", { name: "选择本页", exact: true }).check();
  await page
    .getByRole("button", { name: "刷新本地", exact: true })
    .click({ trial: true });
  await page
    .getByRole("heading", { name: "皮皮虾采集", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "discovery-1366.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: join(evidence, "discovery-1440.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "采集所选 2 条", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "discovery-actions-1440.png"),
    fullPage: true,
  });
  failDiscovery = true;
  await page
    .getByRole("button", { name: "获取下一页并入库", exact: true })
    .click();
  await page.getByText(/列表读取失败（HTTP 503）/).waitFor();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "选择本页", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(discoveryRequests.length, 2);
  await page
    .getByRole("button", { name: "重新请求未完成页", exact: true })
    .click({ trial: true });
  await page.screenshot({
    path: join(evidence, "discovery-error-1440.png"),
    fullPage: true,
  });
  failDiscovery = false;
  await page
    .getByRole("button", { name: "重新请求未完成页", exact: true })
    .click();
  await page.getByText(/知识库 4 条 · 归档响应 3 份 · 当前结果 3 条/).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "获取下一页并入库", exact: true })
      .count(),
    0,
  );
  assert.equal(discoveryRequests.length, 3);
  await page
    .getByRole("button", { name: "采集所选 2 条", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "已采集 · 4", exact: true })
    .waitFor();
  assert.equal(
    sources.list().some((v) => v.id === "7595847114874165561"),
    true,
  );
  assert.equal(discoveryRequests.length, 3);
  await page.reload();
  await page.getByRole("button", { name: /^皮皮虾采集/ }).click();
  assert.equal(
    await page.getByLabel("搜索关键词", { exact: true }).inputValue(),
    "生活趣事",
  );
  assert.equal(discoveryRequests.length, 3);
  assert.equal(
    await page.getByLabel("pipix:tikhub密钥", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes("qa+local/only=token~valid"),
    ),
    false,
  );
  await page.getByRole("combobox", { name: "列表来源", exact: true }).click();
  await page.getByRole("option", { name: "作者作品", exact: true }).click();
  await page.getByLabel("作者 ID", { exact: true }).fill("invalid-id");
  await page
    .getByRole("button", { name: "获取列表并入库", exact: true })
    .click();
  await page
    .getByText("请填写作者或话题的数字 ID。", { exact: true })
    .waitFor();
  assert.equal(discoveryRequests.length, 3);
  await page.getByRole("combobox", { name: "列表来源", exact: true }).click();
  await page.screenshot({
    path: join(evidence, "discovery-source-menu-1440.png"),
    fullPage: true,
  });
  await page.getByRole("option", { name: "话题作品", exact: true }).click();
  await page.getByLabel("话题 ID", { exact: true }).fill("132414");
  await page.getByRole("combobox", { name: "列表来源", exact: true }).click();
  await page.getByRole("option", { name: "首页推荐", exact: true }).click();
  assert.equal(await page.getByLabel("话题 ID", { exact: true }).count(), 0);
  assert.equal(discoveryRequests.length, 3);
  checks.push(
    "列表配置与输入不发查询；图文筛选、长内容、手动分页去重、失败保留选择、批量送入公共采集通过；刷新恢复条件但不恢复 Key、不自动计费",
  );
  await page.getByRole("combobox", { name: "列表来源", exact: true }).click();
  await page
    .getByRole("option", { name: "本地知识库 · 无需请求", exact: true })
    .click();
  await page.getByLabel("搜索本地内容", { exact: true }).fill("");
  await page.getByText(/知识库 4 条 · 归档响应 3 份 · 当前结果 3 条/).waitFor();
  await page.getByRole("button", { name: "刷新本地", exact: true }).click();
  await page.getByRole("button", { name: "重建本地索引", exact: true }).click();
  await page.getByText(/本地重建完成：2 份响应已入库，0 份仍待解析/).waitFor();
  assert.equal(discoveryRequests.length, 3);
  await page
    .getByRole("button", { name: "刷新本地", exact: true })
    .click({ trial: true });
  await page
    .getByRole("heading", { name: "皮皮虾采集", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "knowledge-local-1440.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "前往数据源设置", exact: true })
    .click();
  await page.locator("#settings-sources summary").click();
  await page
    .locator("#settings-sources")
    .getByRole("button", { name: "实测单页容量", exact: true })
    .click();
  await page.getByText(/本次测试最大实际返回 3 条/).waitFor();
  assert.equal(discoveryRequests.length, 6);
  await page
    .locator("#settings-sources")
    .getByRole("button", { name: "实测单页容量", exact: true })
    .click();
  await page
    .getByText(/本地复用/)
    .first()
    .waitFor();
  assert.equal(discoveryRequests.length, 6);
  await page.getByText(/测试关键词：生活趣事 · 测试时间：/).waitFor();
  await page.locator("#settings-sources").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "settings-capacity-1440.png"),
    fullPage: true,
  });
  await page
    .getByLabel("容量测试关键词", { exact: true })
    .fill("尚未测试的新关键词");
  await page
    .getByText(/历史结果（与当前输入关键词不同） · 测试关键词：生活趣事/)
    .waitFor();
  assert.equal(discoveryRequests.length, 6);
  await page.screenshot({
    path: join(evidence, "settings-capacity-history-1440.png"),
    fullPage: true,
  });
  checks.push(
    "本地知识库刷新和重建不发远端请求；设置中的容量实测三次参数请求全部归档，重复实测复用已有响应；报告显示实际关键词与时间，输入改变后标明历史结果且不请求",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ evidence, checks, errors }, null, 2));
} catch (error) {
  await page?.screenshot({
    path: join(evidence, "failure.png"),
    fullPage: true,
  });
  console.error({ evidence, errors });
  throw error;
} finally {
  releaseHistory?.();
  sources.close();
  await browser?.close();
  await f.cleanup();
}
