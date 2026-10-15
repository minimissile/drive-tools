import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url),
  dataPath = await mkdtemp(join(tmpdir(), "panxu-e2e-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-evidence-")));
await mkdir(evidence, { recursive: true });
const env = { ...process.env, PANXU_DATA_DIR: dataPath };
delete env.ELECTRON_RUN_AS_NODE;
let app = await electron.launch({
  executablePath: process.env.PANXU_ELECTRON_PATH ?? require("electron"),
  args: [process.cwd()],
  env,
  timeout: 45000,
});
const errors = [],
  checks = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.locator(".resource-list").waitFor();
  assert.match(await page.title(), /盘序/);
  assert.match(page.url(), /dist\/index.html/);
  checks.push("启动身份与首屏");
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(evidence, "01-empty.png") });
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  const navIcons = await page
    .locator('nav[aria-label="主导航"] button > svg')
    .evaluateAll((icons) => icons.map((icon) => icon.getAttribute("class")));
  assert.equal(navIcons.length, 11);
  assert.equal(new Set(navIcons).size, 11);
  checks.push("11个侧边栏入口均使用不同且对应功能的图标");
  await nav("账号管理").click();
  for (const alias of ["联调夸克主账号", "联调夸克备用账号"]) {
    await page.getByRole("textbox", { name: "新增账号别名" }).fill(alias);
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    await page.getByRole("heading", { name: alias, exact: true }).waitFor();
  }
  await page.getByLabel("新增账号网盘").selectOption("baidu");
  await page
    .getByRole("textbox", { name: "新增账号别名" })
    .fill("联调百度账号");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page
    .getByRole("heading", { name: "联调百度账号", exact: true })
    .waitFor();
  const primary = page.locator(".account-row").filter({
    has: page.getByRole("heading", { name: "联调夸克主账号", exact: true }),
  });
  await primary.getByRole("button", { name: "切换使用", exact: true }).click();
  await primary.getByText("当前使用", { exact: true }).waitFor();
  checks.push("同网盘多账号与工作账号切换");
  await page.screenshot({ path: join(evidence, "02-accounts.png") });
  await nav("录入资源").click();
  await page
    .getByRole("textbox", { name: "网盘分享链接", exact: true })
    .fill("https://pan.quark.cn/s/e2e-local-draft");
  await page
    .getByRole("textbox", { name: "资源标题", exact: true })
    .fill("自制AI办公练习清单");
  await page
    .getByRole("textbox", { name: "资源说明" })
    .fill("本地交互验证资料，仅用于测试草稿录入和检索，不请求远端转存。");
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 270;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#2e61d5";
      ctx.fillRect(0, 0, 480, 270);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 30px sans-serif";
      ctx.fillText("AI 办公练习清单", 38, 145);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
  await page.getByAltText("待保存封面").waitFor();
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      dt = new DataTransfer();
    dt.items.add(new File([bytes], "pasted-cover.png", { type: "image/png" }));
    document.querySelector('[aria-label="资源标题"]').dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png.toString("base64"));
  await page.getByAltText("待保存封面").waitFor();
  await page.getByRole("button", { name: "保存资料草稿", exact: true }).click();
  await page.waitForTimeout(250);
  console.log("录入提示:", await page.locator(".toast").allTextContents());
  await page.locator(".resource-row").first().waitFor();
  assert.match(
    await page.locator(".resource-detail").innerText(),
    /联调夸克主账号/,
  );
  checks.push("资源、上传及粘贴封面、账号归属与SQLite落库");
  await page.getByRole("searchbox").fill("办公练习");
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".resource-row").count(), 1);
  await page.getByRole("searchbox").fill("不存在的查询");
  await page.getByRole("heading", { name: "没有找到匹配资源" }).waitFor();
  assert.equal(await page.locator(".resource-row").count(), 0);
  await page.getByRole("searchbox").fill("");
  await page.locator(".resource-row").first().waitFor();
  checks.push("中文全文检索与空结果");
  await page.screenshot({ path: join(evidence, "03-library.png") });
  await page.getByRole("button", { name: "继续录入", exact: true }).click();
  await page
    .getByRole("textbox", { name: "资源标题", exact: true })
    .fill("自制AI办公练习清单·修订");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await page
    .getByRole("heading", { name: "自制AI办公练习清单·修订", exact: true })
    .waitFor();
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  assert.equal(snapshot.resources.length, 1);
  assert.equal(snapshot.resources[0].copies.length, 1);
  assert.equal(snapshot.jobs.length, 0);
  assert.ok(snapshot.resources[0].coverId);
  checks.push("编辑同副本不重复创建或转存");
  await nav("内容工作室").click();
  await page.getByRole("button", { name: "新建手工草稿", exact: true }).click();
  await page
    .getByRole("textbox", { name: "内容正文", exact: true })
    .fill("先整理一页会议记录，再按清单检查遗漏项。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByLabel("已人工审阅", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="已人工审阅"]')?.checked,
  );
  await page.getByRole("button", { name: "准备发布", exact: true }).click();
  await page.getByText("本人分享尚未生成", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "打开指定比特窗口" }).isDisabled(),
    true,
  );
  checks.push("手工写稿、版本、审阅与未核验分享发布拦截");
  await nav("流量发现").click();
  await page.getByRole("tab", { name: "调用与费用" }).click();
  await page.getByRole("heading", { name: "最近500笔调用记录" }).waitFor();
  await page.getByText("还没有调用记录", { exact: true }).waitFor();
  await nav("转存任务").click();
  await page.getByRole("heading", { name: "暂时没有转存任务" }).waitFor();
  await nav("连接与设置").click();
  await page
    .getByRole("heading", { name: "5118：各接口分别配置", exact: true })
    .waitFor();
  checks.push("流量、账单、任务、连接页面无虚假成功记录");
  // Test responses stay inside this isolated Electron process. No paid service is contacted.
  await app.evaluate(() => {
    globalThis.__panxuQaRequests = { suggest: 0, ai: 0 };
    globalThis.fetch = async (url) => {
      if (String(url) === "https://apis.5118.com/suggest/list") {
        globalThis.__panxuQaRequests.suggest++;
        return new Response(
          JSON.stringify(
            globalThis.__panxuQaRequests.suggest === 1
              ? { errcode: 200104, errmsg: "数据分析中" }
              : {
                  errcode: 0,
                  data: [{ promote_word: "办公清单", platform: "xiaohongshu" }],
                },
          ),
          { status: 200 },
        );
      }
      if (String(url) === "https://openrouter.ai/api/v1/models")
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "qa/structured",
                supported_parameters: ["structured_outputs"],
                pricing: { prompt: "0.0000001", completion: "0.0000002" },
              },
            ],
          }),
          { status: 200 },
        );
      if (String(url) === "https://openrouter.ai/api/v1/chat/completions") {
        globalThis.__panxuQaRequests.ai++;
        return new Response(
          JSON.stringify({
            usage: { cost: 0.000037 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    keywords: [{ word: "AI办公", intent: "了解清单" }],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error("QA已阻止未声明的外部请求");
    };
  });
  await page.evaluate(async () => {
    await window.panxu.invoke("secret.save", {
      kind: "5118:suggest",
      value: "qa-placeholder-key",
    });
    await window.panxu.invoke("api.plan", {
      endpoint: "suggest",
      enabled: true,
      unitPriceMicros: 3000,
      dailyUnits: 2,
      dailyBudgetMicros: 6000,
    });
    await window.panxu.invoke("secret.save", {
      kind: "openrouter",
      value: "qa-placeholder-key",
    });
    await window.panxu.invoke("ai.models");
    await window.panxu.invoke("settings.save", {
      model: "qa/structured",
      exportCodes: false,
      bitUrl: "",
      dailyAiBudgetMicros: 100000,
    });
  });
  await nav("流量发现").click();
  await page.getByLabel("找词方法", { exact: true }).selectOption("suggest");
  await page.getByLabel("查询种子词").fill("办公");
  await page.getByRole("button", { name: "查询关键词", exact: true }).click();
  await page
    .getByRole("heading", { name: "已保存的下拉词分析", exact: true })
    .waitFor();
  const continueQuery = () =>
    page.getByRole("button", { name: "继续查询（可能计费）", exact: true });
  assert.equal(await continueQuery().isDisabled(), true);
  assert.equal(
    (await page.evaluate(() => window.panxu.invoke("snapshot")))
      .suggestionQueries[0].status,
    "pending",
  );
  await page.getByRole("button", { name: "查询关键词", exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.panxu.invoke("snapshot")).apiUsage.cny.requestCount === 1,
  );
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaRequests.suggest),
    1,
  );
  await page.reload();
  await page.getByLabel("找词方法", { exact: true }).selectOption("suggest");
  await page
    .getByRole("heading", { name: "已保存的下拉词分析", exact: true })
    .waitFor();
  await page
    .locator("section.panel")
    .filter({
      has: page.getByRole("heading", {
        name: "已保存的下拉词分析",
        exact: true,
      }),
    })
    .screenshot({ path: join(evidence, "05-suggestion-pending.png") });
  const acceptQuery = () =>
    page.getByRole("checkbox", {
      name: "我已核对上次调用，接受继续查询可能再次计费",
      exact: true,
    });
  await acceptQuery().check();
  await continueQuery().click();
  await page.locator(".toast").filter({ hasText: "至少间隔60秒" }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaRequests.suggest),
    1,
  );
  await app.evaluate(() => {
    globalThis.__panxuQaDateNow = Date.now;
    Date.now = () => globalThis.__panxuQaDateNow() + 61000;
  });
  await acceptQuery().check();
  await continueQuery().click();
  await page
    .getByRole("button", { name: "查看已存结果", exact: true })
    .waitFor();
  assert.equal(await page.locator(".toast.danger").count(), 0);
  await app.evaluate(() => {
    Date.now = globalThis.__panxuQaDateNow;
  });
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaRequests.suggest),
    2,
  );
  await nav("资源库").click();
  await nav("流量发现").click();
  await page.getByLabel("找词方法", { exact: true }).selectOption("suggest");
  await page.getByRole("button", { name: "查看已存结果", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择办公清单", exact: true })
    .waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaRequests.suggest),
    2,
  );
  checks.push(
    "下拉词分析记录持久化、重复提交合并、计费确认、60秒限频与离线结果",
  );
  await page.getByRole("button", { name: "AI提取种子词", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="查询种子词"]')?.value === "AI办公",
  );
  await page.getByRole("tab", { name: "调用与费用", exact: true }).click();
  await page.getByText("$0.000037", { exact: true }).first().waitFor();
  const usage = (await page.evaluate(() => window.panxu.invoke("snapshot")))
    .apiUsage;
  assert.equal(usage.cny.requestCount, 2);
  assert.equal(usage.cny.pendingCount, 1);
  assert.equal(usage.usd.confirmedMicros, 37);
  assert.equal(usage.usd.requestCount, 1);
  await page.screenshot({ path: join(evidence, "06-usage.png") });
  checks.push("人民币估算与美元实费分列、微小金额精度、未知实费及待核预留");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page.screenshot({ path: join(evidence, "07-usage-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await nav("资源库").click();
  await page.screenshot({ path: join(evidence, "04-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  checks.push("840px桌面最小窗口布局");
  await page.reload();
  await page.locator(".resource-row").first().waitFor();
  assert.match(await page.locator(".resource-row").innerText(), /修订/);
  checks.push("重载后数据持久化");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  await nav("批量录入").click();
  await page
    .getByLabel("批量资源CSV")
    .fill(
      "标题,链接,分类,标签,说明\n批量夸克资料,https://pan.quark.cn/s/qa-bulk,批量测试,办公；清单,本地资料说明\n批量百度资料,https://pan.baidu.com/s/1qa-bulk,批量测试,,本地资料说明\n重复,https://pan.quark.cn/s/qa-bulk,批量测试,,\n无效,https://example.com,批量测试,,",
    );
  await page.getByRole("button", { name: "预检CSV", exact: true }).click();
  await page
    .getByRole("heading", { name: "预检结果 · 4行", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("选择CSV第4行").isDisabled(), true);
  assert.equal(await page.getByLabel("选择CSV第5行").isDisabled(), true);
  await page.screenshot({ path: join(evidence, "08-bulk-preview.png") });
  await page
    .getByRole("button", { name: "导入所选2份资料草稿", exact: true })
    .click();
  await page
    .getByText("已新增2份草稿，跳过0份，失败0份。", { exact: true })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.panxu.invoke("snapshot"))).jobs.length,
    0,
  );
  checks.push("批量CSV预检、错行与重复拦截、仅落本地草稿");
  await nav("流量发现").click();
  await page.getByLabel("手工词池名称", { exact: true }).fill("本地整理词池");
  await page
    .getByLabel("手工词池关键词", { exact: true })
    .fill("办公清单，内容整理\n办公清单");
  await page.getByRole("button", { name: "保存手工词池", exact: true }).click();
  await page
    .locator(".pool-list")
    .getByText("本地整理词池", { exact: true })
    .waitFor();
  const poolSnapshot = await page.evaluate(() =>
    window.panxu.invoke("snapshot"),
  );
  assert.equal(poolSnapshot.pools[0].keywords.length, 2);
  await page.getByRole("button", { name: "复制编辑", exact: true }).click();
  assert.equal(
    await page.getByLabel("手工词池名称", { exact: true }).inputValue(),
    "本地整理词池 副本",
  );
  checks.push("手工词池去重、资源关联及复制编辑");
  await nav("内容工作室").click();
  for (const [name, fragment] of [
    ["抖音", "演示分镜"],
    ["快手", "操作演示"],
    ["小红书", "我的实际使用记录"],
    ["公众号", "为什么整理这份资料"],
    ["微博", "一个值得记录的发现"],
    ["百度贴吧", "问题背景"],
    ["豆瓣", "与本组主题的关系"],
    ["X / Twitter", "最有用的一个要点"],
    ["知乎", "先回答问题"],
    ["CSDN", "环境与前置条件"],
  ]) {
    await page
      .getByRole("navigation", { name: "内容平台" })
      .getByRole("button", { name, exact: true })
      .click();
    await page
      .getByRole("button", { name: "使用本地平台模板", exact: true })
      .click();
    await page.waitForFunction(
      (fragment) =>
        document
          .querySelector('[aria-label="内容正文"]')
          ?.value.includes(fragment),
      fragment,
    );
    assert.equal(
      await page.getByLabel("已人工审阅", { exact: true }).isChecked(),
      false,
    );
  }
  await page.screenshot({ path: join(evidence, "09-local-template.png") });
  assert.equal(await app.evaluate(() => globalThis.__panxuQaRequests.ai), 1);
  await page.getByLabel("已人工审阅", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="已人工审阅"]')?.checked,
  );
  await page.getByRole("button", { name: "准备发布", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "导出内容包", exact: true })
      .isDisabled(),
    true,
  );
  checks.push("十个平台本地模板、初始未审阅、无AI请求及未核验分享导出拦截");
  // Only fixture files are selected by these dialog stubs; no personal workspace is accessed.
  const summaryPath = join(dataPath, "summary.txt");
  await writeFile(summaryPath, "本地文件补充的、可核实的资源说明。");
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, summaryPath);
  await nav("资源库").click();
  await page.getByRole("searchbox").fill("办公练习");
  await page.locator(".resource-row").first().waitFor();
  await page.getByRole("button", { name: "继续录入", exact: true }).click();
  await page
    .getByRole("button", { name: "从本地TXT / Markdown载入说明", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("textarea.tall")?.value.includes("本地文件补充"),
  );
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await page.locator(".resource-row").first().waitFor();
  checks.push("本地说明文件经对话框导入并保存");
  // Seed a large isolated library to exercise selection beyond the recent snapshot.
  const seed = new DatabaseSync(join(dataPath, "panxu.db"));
  const insertResource = seed.prepare(
    "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const insertCopy = seed.prepare(
    "INSERT INTO copies(id,resource_id,account_id,directory,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  );
  seed.exec("BEGIN");
  const time = new Date().toISOString();
  for (let i = 0; i < 510; i++) {
    insertResource.run(
      `qa-old-${i}`,
      `历史资料${i}`,
      `https://pan.quark.cn/s/qa-old-${i}`,
      `qa-old-${i}`,
      "quark",
      i === 0 ? "历史分类" : "大库分类",
      "[]",
      i === 0 ? "深层旧档唯一词" : "普通历史资料",
      i === 0 ? "2020-01-01" : time,
      i === 0 ? "2020-01-01" : time,
    );
    insertCopy.run(
      `qa-old-copy-${i}`,
      `qa-old-${i}`,
      snapshot.accounts.find((a) => a.alias === "联调夸克主账号").id,
      `/盘序资源/qa-${i}`,
      time,
      time,
    );
  }
  seed.exec("COMMIT");
  const insertDraft = seed.prepare(
    "INSERT INTO drafts(id,resource_id,copy_id,platform,title,body,tags,resource_revision,share_version,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insertDraft.run(
    "qa-old-draft",
    "qa-old-0",
    "qa-old-copy-0",
    "xiaohongshu",
    "历史资料0旧稿",
    "旧稿保留的实际资料说明。",
    "[]",
    1,
    0,
    "manual",
    "2020-01-01",
    "2020-01-01",
  );
  for (let i = 0; i < 501; i++)
    insertDraft.run(
      `qa-draft-${i}`,
      snapshot.resources[0].id,
      snapshot.resources[0].copies[0].id,
      "xiaohongshu",
      `新近稿${i}`,
      "本地回归稿",
      "[]",
      1,
      0,
      "manual",
      time,
      time,
    );
  seed.close();
  await page.reload();
  await page.getByLabel("分类筛选").selectOption("大库分类");
  await page.getByText("共 509 份资源", { exact: true }).waitFor();
  assert.equal(await page.locator(".resource-row").count(), 25);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 2 / 21 页 · 每页 25 份", { exact: true }).waitFor();
  await page.getByLabel("分类筛选").selectOption("all");
  await page.getByRole("searchbox").fill("深层旧档唯一词");
  await page.getByText("共 1 份资源", { exact: true }).waitFor();
  await page.locator(".resource-row").click();
  await page.getByRole("button", { name: "继续录入", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "资源标题", exact: true })
      .inputValue(),
    "历史资料0",
  );
  await nav("内容工作室").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="内容正文"]')?.value ===
      "旧稿保留的实际资料说明。",
  );
  await page
    .getByRole("button", { name: "使用本地平台模板", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="内容标题"]')?.value === "历史资料0",
  );
  checks.push(
    "超过500份的分类统计、分页、全文检索、准确编辑、历史稿读取及创作绑定",
  );
  const qaAccount = snapshot.accounts.find(
    (a) => a.alias === "联调夸克主账号",
  ).id;
  await app.evaluate(({ session }, accountId) => {
    const row = (fid, file_name, dir = false) => ({
      fid,
      file_name,
      dir: dir ? 1 : 0,
      size: dir ? 0 : 12,
      share_fid_token: `token-${fid}`,
    });
    const source = [
      row("src-course", "课程", true),
      row("src-readme", "说明.txt"),
      row("src-empty", "空目录", true),
    ];
    const folders = new Map([
      ["0", []],
      [
        "own-course",
        [row("own-intro", "简介.txt"), row("own-chapter", "章节", true)],
      ],
      [
        "own-chapter",
        [row("own-video", "视频.mp4"), row("own-deep", "更深目录", true)],
      ],
      ["own-empty", []],
      ["own-deep", [row("own-beyond", "第四层文件.txt")]],
    ]);
    const shares = new Map();
    globalThis.__panxuQaDrive = { transfers: 0, shares: 0, deepReads: 0 };
    let sequence = 0;
    session.fromPartition(`persist:panxu-${accountId}`).fetch = async (
      text,
      init = {},
    ) => {
      const url = new URL(String(text)),
        path = url.pathname.replace("/1/clouddrive/", ""),
        body = init.body ? JSON.parse(String(init.body)) : {};
      const response = (data) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ok = (data) => response({ code: 0, status: 200, data });
      if (url.pathname === "/account/info")
        return response({
          code: "OK",
          success: true,
          data: { user_id: "qa-owner", nickname: "本地测试本人" },
        });
      if (path === "file/sort") {
        const parent = url.searchParams.get("pdir_fid");
        if (parent === "own-deep") globalThis.__panxuQaDrive.deepReads++;
        return ok({ list: folders.get(parent) ?? [] });
      }
      if (path === "file") {
        const fid = `qa-folder-${++sequence}`;
        folders.set(fid, []);
        folders.set(body.pdir_fid, [
          ...(folders.get(body.pdir_fid) ?? []),
          row(fid, body.file_name, true),
        ]);
        return ok({ fid });
      }
      if (path === "share/sharepage/token") return ok({ stoken: "qa-token" });
      if (path === "share/sharepage/detail") {
        const key = url.searchParams.get("pwd_id"),
          share = [...shares.values()].find((s) => s.key === key);
        return ok({
          list: share ? share.files : source,
          share: { title: "本地目录测试" },
        });
      }
      if (path === "share/sharepage/save") {
        globalThis.__panxuQaDrive.transfers++;
        folders.set(
          body.to_pdir_fid,
          body.fid_list.map((fid) => ({
            ...source.find((f) => f.fid === fid),
            fid: fid.replace("src-", "own-"),
          })),
        );
        return ok({ task_id: "qa-transfer-task" });
      }
      if (path === "task") return ok({ status: 2 });
      if (path === "share") {
        globalThis.__panxuQaDrive.shares++;
        const id = `qa-share-${globalThis.__panxuQaDrive.shares}`,
          key = `qa-own-${globalThis.__panxuQaDrive.shares}`,
          files = body.fid_list.map((fid) =>
            [...folders.values()].flat().find((f) => f.fid === fid),
          );
        if (files.some((f) => !f)) throw new Error("测试分享包含未知文件");
        shares.set(id, { id, key, files });
        return ok({ share_id: id });
      }
      if (path === "share/mypage/detail")
        return ok({
          list: [...shares.values()].map((s) => ({
            share_id: s.id,
            file_num: s.files.length,
            first_fid: s.files[0].fid,
            fid_list: s.files.map((f) => f.fid),
            status: 1,
          })),
        });
      if (path === "share/password") {
        const share = shares.get(body.share_id);
        return ok({
          share_url: `https://pan.quark.cn/s/${share.key}`,
          passcode: "a123",
        });
      }
      throw new Error(`QA已阻止未声明的网盘请求：${path}`);
    };
  }, qaAccount);
  await page.evaluate(
    (id) => window.panxu.invoke("account.check", { id }),
    qaAccount,
  );
  await nav("批量转存").click();
  await page.getByRole("searchbox").fill("批量夸克资料");
  await page
    .getByRole("checkbox", { name: "批量选择批量夸克资料", exact: true })
    .check();
  await page
    .getByRole("button", { name: "读取并预检所选资料", exact: true })
    .click();
  await page.getByText("预检通过，待确认", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaDrive.transfers),
    0,
  );
  const startBatch = page.getByRole("button", {
    name: "开始批量转存（1份）",
    exact: true,
  });
  assert.equal(await startBatch.isDisabled(), true);
  await page.getByLabel("批量转存权利确认", { exact: true }).check();
  await startBatch.click();
  await page.waitForFunction(async () => {
    const batches = await window.panxu.invoke("batch.list");
    const batch = await window.panxu.invoke("batch.get", { id: batches[0].id });
    return batch.items[0].transferJobId && batch.items[0].stage === "completed";
  });
  await page.screenshot({ path: join(evidence, "11-batch-transfer.png") });
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaDrive.transfers),
    1,
  );
  checks.push(
    "批量转存只读预检、权利确认、同账号队列、本人建链和完整归档（本地网盘响应）",
  );
  await nav("资源库").click();
  await page.getByRole("searchbox").fill("批量夸克资料");
  await page.getByText("共 1 份资源", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "拆分为多个链接", exact: true })
    .click();
  await page.getByRole("button", { name: "读取三级目录", exact: true }).click();
  let splitRunId;
  await page.waitForFunction(async () => {
    const resources = await window.panxu.invoke("resource.search", {
        query: "批量夸克资料",
      }),
      runs = await window.panxu.invoke("split.list", {
        copyId: resources[0].copies[0].id,
      });
    if (!runs.length) return false;
    const run = await window.panxu.invoke("split.get", { id: runs[0].id });
    return run.status === "ready" && run.items.length === 7;
  });
  const run = await page.evaluate(async () => {
    const resources = await window.panxu.invoke("resource.search", {
        query: "批量夸克资料",
      }),
      runs = await window.panxu.invoke("split.list", {
        copyId: resources[0].copies[0].id,
      });
    return window.panxu.invoke("split.get", { id: runs[0].id });
  });
  splitRunId = run.id;
  const tree = page.getByRole("tree", { name: "资源目录树" });
  await tree.getByRole("treeitem").last().waitFor();
  assert.equal(await tree.getByRole("treeitem").count(), 7);
  assert.equal(await tree.locator('[aria-level="3"]').count(), 2);
  assert.equal(await tree.getByRole("checkbox", { checked: true }).count(), 0);
  await page.getByRole("button", { name: "第3层", exact: true }).click();
  assert.equal(await tree.getByRole("checkbox", { checked: true }).count(), 5);
  assert.equal(
    await page
      .getByRole("checkbox", { name: "拆分选择空目录", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "拆分选择说明.txt", exact: true })
      .isChecked(),
    true,
  );
  await page.getByRole("button", { name: "清空", exact: true }).click();
  const choose = (fileId) =>
    page.getByRole("checkbox", {
      name: `拆分选择${run.items.find((i) => i.file.id === fileId).path}`,
      exact: true,
    });
  await choose("own-course").check();
  assert.equal(await choose("own-video").isChecked(), false);
  await choose("own-video").check();
  await page.getByText("已同时选择父文件夹与子项", { exact: false }).waitFor();
  await choose("own-course").uncheck();
  await choose("own-deep").check();
  await page.getByRole("button", { name: "全部收起", exact: true }).click();
  assert.equal(await tree.getByRole("treeitem").count(), 3);
  assert.equal(await page.locator(".split-selected-list li").count(), 2);
  await page
    .getByRole("searchbox", { name: "搜索拆分目录", exact: true })
    .fill("视频.mp4");
  assert.equal(await tree.getByRole("treeitem").count(), 3);
  assert.equal(await choose("own-video").isChecked(), true);
  await page
    .getByRole("searchbox", { name: "搜索拆分目录", exact: true })
    .fill("没有这个文件");
  await page.getByText("没有匹配的资源", { exact: true }).waitFor();
  await page
    .getByRole("searchbox", { name: "搜索拆分目录", exact: true })
    .fill("");
  assert.equal(await tree.getByRole("treeitem").count(), 3);
  await page.getByRole("button", { name: "全部展开", exact: true }).click();
  assert.equal(await tree.getByRole("treeitem").count(), 7);
  const courseRow = tree.locator('[data-node-id="own-course"]');
  await courseRow.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await tree.getByRole("treeitem").count(), 3);
  await page.keyboard.press("ArrowRight");
  assert.equal(await tree.getByRole("treeitem").count(), 7);
  await page.screenshot({ path: join(evidence, "12-split-tree-selected.png") });
  checks.push(
    "三级树状目录、逐项独立勾选、按层保留浅层文件/空目录、父子重叠提示、收起/搜索保留选择及键盘展开",
  );
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaDrive.deepReads),
    0,
  );
  const startSplit = page.getByRole("button", {
    name: "生成所选2个本人链接",
    exact: true,
  });
  assert.equal(await startSplit.isDisabled(), true);
  await page.getByLabel("拆分分享权利确认", { exact: true }).check();
  await startSplit.click();
  await page.waitForFunction(async (id) => {
    const run = await window.panxu.invoke("split.get", { id });
    return run.items
      .filter((i) => ["own-video", "own-deep"].includes(i.file.id))
      .every((i) => i.status === "ready");
  }, splitRunId);
  await page
    .getByRole("button", { name: "导出本人链接CSV", exact: true })
    .click({ trial: true });
  assert.equal(
    await app.evaluate(() => globalThis.__panxuQaDrive.transfers),
    1,
  );
  assert.equal(await app.evaluate(() => globalThis.__panxuQaDrive.shares), 3);
  await page
    .locator("section.panel")
    .filter({
      has: page.getByRole("heading", {
        name: "资源目录与独立链接",
        exact: true,
      }),
    })
    .screenshot({ path: join(evidence, "12-split-links.png") });
  checks.push(
    "三级拆分保留浅层文件和空目录、不读取第四层、只为所选文件/目录建本人链接",
  );
  const exportPath = join(dataPath, "split-links.csv");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page
    .getByRole("button", { name: "导出本人链接CSV", exact: true })
    .click();
  await page
    .locator(".toast")
    .filter({ hasText: "本人链接清单已导出" })
    .waitFor();
  const exported = await readFile(exportPath, "utf8");
  assert.match(exported, /qa-own-2/);
  assert.match(exported, /qa-own-3/);
  assert.doesNotMatch(exported, /qa-bulk|a123/);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page.screenshot({ path: join(evidence, "13-split-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  checks.push("拆分结果归属复核导出、默认不导出提取码、840px新页面布局");
  await nav("连接与设置").click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, dataPath);
  const backup = await page.evaluate(() =>
    window.panxu.invoke("system.backup"),
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backup);
  await page
    .getByRole("button", { name: "选择备份并预检", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "备份预检通过", exact: true })
    .waitFor();
  const restoreButton = page.getByRole("button", {
    name: "恢复到新工作空间并重启",
    exact: true,
  });
  assert.equal(await restoreButton.isDisabled(), true);
  await page
    .getByRole("checkbox", {
      name: "已保存正在编辑的内容，同意恢复到新工作空间并重启",
      exact: true,
    })
    .check();
  assert.equal(await restoreButton.isDisabled(), false);
  await page
    .locator(".restore-preview")
    .screenshot({ path: join(evidence, "10-restore-preview.png") });
  const previewDb = new DatabaseSync(join(backup, "panxu.db"), {
    readOnly: true,
  });
  assert.equal(previewDb.prepare("SELECT count(*) n FROM secrets").get().n, 0);
  previewDb.close();
  checks.push("一致性备份导出、凭据排除、恢复预检及重启确认门槛");
  const prepareRestart = () =>
    app.evaluate(({ app }) => {
      globalThis.__panxuQaRelaunch = false;
      globalThis.__panxuQaExit = false;
      // Keep lifecycle control in the test runner; assert that production requested both calls.
      app.relaunch = () => {
        globalThis.__panxuQaRelaunch = true;
      };
      app.exit = () => {
        globalThis.__panxuQaExit = true;
      };
    });
  const switchedPath = async (previous) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await app.evaluate(() => ({
        path: process.env.PANXU_DATA_DIR,
        relaunch: globalThis.__panxuQaRelaunch,
        exit: globalThis.__panxuQaExit,
      }));
      if (result.path !== previous && result.relaunch && result.exit)
        return result.path;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("没有收到工作空间切换及应用重启请求");
  };
  const reopen = async (path) => {
    await app.close();
    app = await electron.launch({
      executablePath: process.env.PANXU_ELECTRON_PATH ?? require("electron"),
      args: [process.cwd()],
      env: { ...env, PANXU_DATA_DIR: path },
      timeout: 45000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.getByRole("navigation", { name: "主导航" }).waitFor();
    return page.evaluate(() => window.panxu.invoke("snapshot"));
  };
  await prepareRestart();
  await restoreButton.click();
  const restoredPath = await switchedPath(dataPath);
  const restoredSnapshot = await reopen(restoredPath);
  assert.equal(restoredSnapshot.resourceTotals.resources, 513);
  assert.equal(restoredSnapshot.settings.openrouterConfigured, false);
  assert.equal(restoredSnapshot.settings.dailyAiBudgetMicros, 0);
  assert.equal(restoredSnapshot.settings.previousWorkspace, true);
  assert.equal(
    restoredSnapshot.accounts.every(
      (account) => account.status === "disconnected",
    ),
    true,
  );
  await nav("连接与设置").click();
  await prepareRestart();
  await page
    .getByRole("button", { name: "切回恢复前工作空间", exact: true })
    .click();
  assert.equal(await switchedPath(restoredPath), dataPath);
  const originalSnapshot = await reopen(dataPath);
  assert.equal(originalSnapshot.settings.openrouterConfigured, true);
  assert.equal(originalSnapshot.resourceTotals.resources, 513);
  assert.equal(originalSnapshot.settings.previousWorkspace, false);
  checks.push(
    "恢复空间启动、凭据与预算重置、切回原空间及原数据保留（测试器接管重启进程）",
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  checks.push("无空白、框架覆盖层或前端异常");
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, dataPath, evidence, errors },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "failure.png") });
  console.error(
    "QA证据目录:",
    evidence,
    "前端错误:",
    errors,
    "提示:",
    page ? await page.locator(".toast").allTextContents() : [],
  );
  throw error;
} finally {
  await app.close();
}
