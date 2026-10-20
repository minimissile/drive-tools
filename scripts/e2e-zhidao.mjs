// Browser plugin not available. Exercise the source Electron app with isolated
// data and intercepted external transports; never query paid or real services.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chooseOption } from "./e2e-select.mjs";
const require = createRequire(import.meta.url);
const dataPath = await mkdtemp(join(tmpdir(), "panxu-zhidao-ui-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-zhidao-evidence-")));
await mkdir(evidence, { recursive: true });
const port = process.env.PANXU_DEV_PORT ?? "5173";
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_PORT: port,
  PANXU_DEV_URL: `http://127.0.0.1:${port}`,
  PANXU_DEV_ROOT: process.cwd(),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [join(process.cwd(), "dist-dev")],
  env,
  timeout: 45000,
});
const errors = [],
  checks = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.evaluate(() =>
    window.panxu.invoke("updater.configure", { autoCheck: false }),
  );
  assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${port}`);
  const identity = await page.evaluate(() => window.panxu.invoke("dev.status"));
  assert.equal(identity.root, process.cwd());
  await app.evaluate(() => {
    globalThis.__zhidaoQA = { requests: 0, sources: 0, external: 0 };
    globalThis.fetch = async (url, init) => {
      const state = globalThis.__zhidaoQA;
      if (new URL(String(url)).hostname === "movie.douban.com") {
        state.sources++;
        return new Response(
          JSON.stringify({
            subjects: Array.from({ length: 40 }, (_, i) => ({
              title: `隔离电影作品${String(i + 1).padStart(2, "0")}`,
            })),
          }),
        );
      }
      if (new URL(String(url)).hostname === "piaofang.maoyan.com") {
        state.sources++;
        return new Response('<p class="first-line">隔离电影作品01</p>');
      }
      if (String(url) === "https://openrouter.ai/api/v1/models")
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "qa/zhidao",
                supported_parameters: ["structured_outputs"],
                pricing: { prompt: "0.0000001", completion: "0.0000001" },
              },
            ],
          }),
        );
      if (String(url) === "https://openrouter.ai/api/v1/chat/completions") {
        state.requests++;
        return new Response(
          JSON.stringify({
            usage: { cost: 0.0002 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer:
                      "这是隔离测试生成的回答。先整理文件目录，再按名称与日期归档，最后检查分享权限。此内容用于界面验证，不会发布到任何平台。",
                  }),
                },
              },
            ],
          }),
        );
      }
      state.external++;
      throw new Error("隔离测试禁止外部请求");
    };
  });
  checks.push("源码开发窗口身份、默认工作台与外部调用隔离");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: join(evidence, "workbench-1440.png") });
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "百度知道运营", exact: true })
      .getByRole("button", { name, exact: true });
  await page.getByRole("button", { name: /资源采集.*按关键词/ }).click();
  await page.getByRole("heading", { name: "资源采集", exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "关键词列表" })
    .fill("测试软件A\n测试软件B");
  await nav("智能问答").click();
  await nav("资源采集").click();
  assert.equal(
    await page.getByRole("textbox", { name: "关键词列表" }).inputValue(),
    "测试软件A\n测试软件B",
  );
  await page.reload();
  await page.getByRole("heading", { name: "资源采集", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "关键词列表" }).inputValue(),
    "测试软件A\n测试软件B",
  );
  checks.push("采集表单切页和刷新恢复，未触发采集请求");
  await nav("热门挖词").click();
  await chooseOption(
    page.getByRole("combobox", { name: "资源领域", exact: true }),
    "电影",
  );
  await page.getByRole("spinbutton", { name: /目标数量/ }).fill("40");
  await page.getByRole("button", { name: "开始挖词", exact: true }).click();
  await page.getByText(/实际采集40\/40条/).waitFor();
  await page
    .getByRole("checkbox", { name: "选择本页结果", exact: true })
    .check();
  const resultPages = page.getByRole("navigation", {
    name: "运营结果分页",
    exact: true,
  });
  await resultPages
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "选择本页结果", exact: true })
    .check();
  await page
    .getByText("已选40项，跨页保留，最多100项", { exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "词池名称", exact: true })
    .fill("隔离电影选题");
  await page.getByRole("button", { name: "保存到词池", exact: true }).click();
  await page.getByText("已保存到现有词池", { exact: false }).waitFor();
  const { pools } = await page.evaluate(() => window.panxu.invoke("snapshot"));
  assert.ok(pools.some((pool) => pool.name === "隔离电影选题"));
  await page.getByRole("button", { name: "用所选词采集", exact: true }).click();
  assert.equal(
    (
      await page.getByRole("textbox", { name: "关键词列表" }).inputValue()
    ).split("\n").length,
    40,
  );
  checks.push("模拟榜单40条逐项入库、跨页选择、接入现有词池和采集关键词交接");
  for (const [entry, heading] of [
    ["热门挖词", "热门挖词"],
    ["问答模板", "问答模板"],
    ["发布任务", "发布任务"],
    ["网盘文件", "网盘文件"],
    ["知道账号", "知道账号"],
  ]) {
    await nav(entry).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
  }
  await page
    .getByRole("textbox", { name: "账号备注", exact: true })
    .fill("隔离知道账号");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByText("隔离知道账号", { exact: true }).waitFor();
  checks.push("全部运营入口可达，知道账号本地添加和权限空态");
  await page.locator("summary").filter({ hasText: "使用已有 Cookie" }).click();
  await page
    .getByLabel("百度知道 Cookie", { exact: false })
    .fill("QA_SECRET_DO_NOT_PERSIST");
  await nav("热门挖词").click();
  await page.getByRole("checkbox", { name: /补充公开搜索候选/ }).check();
  await nav("知道账号").click();
  await page.locator("summary").filter({ hasText: "使用已有 Cookie" }).click();
  assert.equal(
    await page.getByLabel("百度知道 Cookie", { exact: false }).inputValue(),
    "",
  );
  await nav("热门挖词").click();
  assert.equal(
    await page.getByRole("checkbox", { name: /补充公开搜索候选/ }).isChecked(),
    false,
  );
  checks.push("凭据和付费挖词授权不随切页恢复");
  await page.evaluate(async () => {
    await window.panxu.invoke("secret.save", {
      kind: "openrouter",
      value: "qa-local-key",
    });
    await window.panxu.invoke("ai.models");
    await window.panxu.invoke("settings.save", {
      model: "qa/zhidao",
      exportCodes: false,
      bitUrl: "",
      aiModels: { copy: "qa/zhidao", analysis: "qa/zhidao", vision: "" },
      dailyAiBudgetMicros: 1000000,
    });
  });
  await nav("智能问答").click();
  await page
    .getByRole("textbox", { name: "你的问题" })
    .fill("如何整理本人学习资料？");
  await page.getByRole("button", { name: "生成回答", exact: true }).click();
  await page
    .getByText("这是隔离测试生成的回答。", { exact: false })
    .first()
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.__zhidaoQA.requests), 1);
  checks.push("真实IPC接续现有AI服务、费用台账与逐项结果显示（模型响应模拟）");
  await page.getByRole("button", { name: /编辑 如何整理/ }).click();
  await page
    .getByRole("textbox", { name: "回答内容", exact: true })
    .fill("这是一条经过人工编辑的隔离测试回答，用于验证保存与审核恢复。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByText("这是一条经过人工编辑的隔离测试回答，用于验证保存与审核恢复。", {
      exact: false,
    })
    .first()
    .waitFor();
  await page.getByRole("button", { name: /编辑 如何整理/ }).click();
  await page
    .getByRole("checkbox", { name: "我已核对事实、链接与发布内容" })
    .check();
  await page
    .getByRole("button", { name: "保存并确认审核", exact: true })
    .click();
  await page.getByText("已审核", { exact: true }).waitFor();
  checks.push("结果编辑、保存后重新审核与审核标记");
  await page.getByRole("tab", { name: "自动回答", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "开始自动回答", exact: true })
      .isDisabled(),
    true,
  );
  await nav("发布任务").click();
  const selectedAnswer = page.getByRole("checkbox", {
    name: "选择 如何整理本人学习资料？",
    exact: true,
  });
  await selectedAnswer.check();
  await page.getByRole("checkbox", { name: /我已审核所选1条问答/ }).check();
  await nav("问答模板").click();
  await nav("发布任务").click();
  assert.equal(await selectedAnswer.isChecked(), true);
  assert.equal(
    await page
      .getByRole("checkbox", { name: /我已审核所选1条问答/ })
      .isChecked(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "上传所选问答", exact: true })
      .isDisabled(),
    true,
  );
  checks.push("发布选择恢复、自动提交和上传授权不随表单恢复");
  const importedRun = await page.evaluate(() =>
    window.panxu.invoke("zhidao.import.resources", {
      rows: [
        ["资源名称", "网盘链接", "提取码"],
        ["隔离资料一", "https://pan.baidu.com/s/1qaResourceOne", "a1b2"],
        ["隔离资料二", "https://pan.baidu.com/s/1qaResourceTwo", "c3d4"],
      ],
      authorized: true,
    }),
  );
  await page.evaluate(async (id) => {
    const { dataPath } = await window.panxu.invoke("snapshot");
    localStorage.setItem(
      `panxu-operation-focus:${dataPath}:collect`,
      JSON.stringify({ id }),
    );
  }, importedRun.id);
  await nav("资源采集").click();
  const rights = page.getByRole("checkbox", {
    name: "我有权保存和分享所选资源",
    exact: true,
  });
  await rights.check();
  await page
    .getByRole("checkbox", { name: "选择本页结果", exact: true })
    .check();
  assert.equal(await rights.isChecked(), false);
  await rights.check();
  await page
    .getByRole("textbox", { name: "目标父目录", exact: true })
    .fill("/隔离验收目录");
  assert.equal(await rights.isChecked(), false);
  await rights.check();
  await page
    .getByRole("checkbox", { name: "选择 隔离资料一", exact: true })
    .uncheck();
  assert.equal(await rights.isChecked(), false);
  checks.push("资源选择和转存目录变更均撤销先前权利确认");
  await nav("发布任务").click();
  const closeToasts = async () => {
    while (
      await page.getByRole("button", { name: "关闭提示", exact: true }).count()
    )
      await page
        .getByRole("button", { name: "关闭提示", exact: true })
        .first()
        .click();
    await page.evaluate(() => document.activeElement?.blur());
  };
  await closeToasts();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000),
  );
  await page.screenshot({ path: join(evidence, "publishing-1440.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 650),
  );
  await page.screenshot({ path: join(evidence, "publishing-840.png") });
  await page
    .getByRole("button", { name: "上传所选问答", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "publishing-actions-840.png") });
  await nav("资源采集").click();
  await page
    .getByRole("textbox", { name: "关键词列表" })
    .scrollIntoViewIfNeeded();
  await page
    .getByRole("textbox", { name: "关键词列表" })
    .fill("测试软件A\n测试软件B");
  await closeToasts();
  await page.screenshot({ path: join(evidence, "collection-840.png") });
  await page
    .getByRole("button", { name: "开始采集", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "collection-actions-840.png") });
  await nav("网盘文件").click();
  await page.getByRole("heading", { name: "网盘文件", exact: true }).waitFor();
  await closeToasts();
  await page.screenshot({ path: join(evidence, "drive-files-840.png") });
  await page
    .getByRole("button", { name: "工作台", exact: true })
    .first()
    .click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await closeToasts();
  await page.screenshot({ path: join(evidence, "workbench-840.png") });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false);
  assert.equal(await app.evaluate(() => globalThis.__zhidaoQA.external), 0);
  assert.deepEqual(errors, []);
  checks.push(
    "1440×1000和840×650布局、主操作可滚动到达、无控制台错误、无真实远端请求",
  );
  console.log(JSON.stringify({ checks, evidence, dataPath, errors }, null, 2));
} catch (error) {
  const page = await app.firstWindow();
  await page
    .screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  console.error(
    JSON.stringify(
      {
        checks,
        evidence,
        dataPath,
        errors,
        visibleText: (await page.locator("body").innerText()).slice(-12000),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
