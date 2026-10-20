import { chooseOption } from "./e2e-select.mjs";
// Browser plugin not available; use the project's isolated Electron/Playwright workflow.
// AI and external network calls are mocked. Save dialogs write only to this temporary QA directory.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  dataPath = await mkdtemp(join(tmpdir(), "panxu-export-e2e-")),
  evidence = await mkdtemp(join(tmpdir(), "panxu-export-qa-"));
const dev = process.env.PANXU_E2E_DEV === "1";
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  ...(dev
    ? { PANXU_DEV_URL: "http://127.0.0.1:5173", PANXU_DEV_ROOT: process.cwd() }
    : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: process.env.PANXU_ELECTRON_PATH ?? require("electron"),
  args: [dev ? join(process.cwd(), "dist-dev") : process.cwd()],
  env,
  timeout: 45000,
});
let page;
const errors = [],
  checks = [];
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  await page.evaluate(() =>
    window.panxu.invoke("updater.configure", { autoCheck: false }),
  );
  await app.evaluate(({ dialog }, evidence) => {
    globalThis.__exportQa = {
      calls: 0,
      external: 0,
      phase: "",
      images: 0,
      invalid: false,
      save: null,
    };
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.__exportQa.save = options;
      return {
        canceled: false,
        filePath: `${evidence}/${options.defaultPath}`,
      };
    };
    globalThis.fetch = async (url, init) => {
      const qa = globalThis.__exportQa;
      if (String(url) === "https://openrouter.ai/api/v1/models")
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "qa/export",
                name: "模拟视觉模型",
                architecture: { input_modalities: ["text", "image"] },
                supported_parameters: ["structured_outputs"],
                pricing: { prompt: "0.0000001", completion: "0.0000001" },
              },
            ],
          }),
        );
      if (String(url) !== "https://openrouter.ai/api/v1/chat/completions") {
        qa.external++;
        throw new Error("禁止外部请求");
      }
      qa.calls++;
      const payload = JSON.parse(init.body),
        content = payload.messages[1].content,
        input = JSON.parse(
          typeof content === "string" ? content : content[0].text,
        ),
        phase = payload.response_format.json_schema.name;
      qa.phase = phase;
      qa.images +=
        typeof content === "string"
          ? 0
          : content.filter((v) => v.type === "image_url").length;
      let result;
      if (phase === "resource_export_plan")
        result = {
          title: "英语教学资料清单",
          criteria: "英语教学资料，包括口语和语法",
          columns: [
            { label: "课程名称", field: "title" },
            { label: "课程分类", field: "category" },
            { label: "价格", field: "blank" },
          ],
          articleBrief: "面向英语教师写300字介绍",
          warnings: ["截图中的价格在本地没有记录，留空"],
        };
      else if (phase === "resource_export_match") {
        await new Promise((r) => setTimeout(r, 400));
        result = {
          decisions: input.resources.map((r, i) => ({
            id: qa.invalid && i === 0 ? "fake-id" : r.id,
            match: r.title.includes("英语"),
            reason: r.title.includes("英语")
              ? "标题明确为英语教学资料"
              : "数学主题，与英语教学不符",
          })),
        };
      } else
        result = {
          title: "给英语教师的备课资料介绍",
          body: `围绕教学任务选择资料。[${input.resources[0].title}](resource:${input.resources[0].id})适合先核对目录再安排课堂活动。这里基于资源说明整理，未阅读文件正文。`,
          resourceIds: [input.resources[0].id],
        };
      return new Response(
        JSON.stringify({
          usage: { cost: 0.0002 },
          choices: [{ message: { content: JSON.stringify(result) } }],
        }),
      );
    };
  }, evidence);
  await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "导出测试账号",
    });
    for (let i = 0; i < 33; i++)
      await window.panxu.invoke("resource.save", {
        title: i < 5 ? `英语教学${i + 1}` : `数学教学${i}`,
        sourceText: `https://pan.quark.cn/s/export${i}`,
        category: "教学资料",
        tags: [i < 5 ? "英语" : "数学"],
        summary: "本人整理的教学资料目录与说明。",
        accountId: a.id,
        directory: "/盘序资源",
        rightsConfirmed: false,
        enqueue: false,
      });
    await window.panxu.invoke("secret.save", {
      kind: "openrouter",
      value: "test-export-only-key",
    });
    await window.panxu.invoke("ai.models");
    await window.panxu.invoke("settings.save", {
      model: "qa/export",
      exportCodes: false,
      bitUrl: "",
      dailyAiBudgetMicros: 100000,
    });
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "AI 资源导出", exact: true })
    .click();
  await page.getByRole("heading", { name: "先说你想整理什么" }).waitFor();
  await page
    .getByLabel("导出需求", { exact: true })
    .fill("导出所有英语教学资料，按截图表头整理，并写主题短文");
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 540;
    c.height = 110;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 540, 110);
    ctx.fillStyle = "#1d2b42";
    ctx.font = "22px sans-serif";
    ctx.fillText("课程名称     课程分类     价格", 25, 45);
    ctx.font = "16px sans-serif";
    ctx.fillText("参考表头 · 示例行不是本地资源", 25, 82);
    return c.toDataURL("image/png");
  });
  const imagePath = join(evidence, "reference.png");
  await writeFile(imagePath, Buffer.from(png.split(",")[1], "base64"));
  await page.locator('input[type="file"]').setInputFiles(imagePath);
  await page.getByRole("img", { name: /参考截图1/ }).waitFor();
  await page.screenshot({ path: join(evidence, "01-request.png") });
  await page
    .getByRole("button", { name: "解析需求与表头", exact: true })
    .click();
  await page.getByLabel("第1列表头").waitFor();
  assert.equal(await page.getByLabel("第1列表头").inputValue(), "课程名称");
  assert.equal(await page.getByLabel("第3列数据").getAttribute("data-value"), "blank");
  await page.getByLabel("第1列表头").fill("资源标题");
  await page.getByRole("button", { name: "下移第1列", exact: true }).click();
  assert.equal(await page.getByLabel("第1列表头").inputValue(), "课程分类");
  assert.equal(await app.evaluate(() => globalThis.__exportQa.images), 1);
  checks.push("文字与截图组合输入 → 视觉模型解析 → 表头改名、映射及调序");
  await page
    .getByRole("button", { name: "确认并开始筛选", exact: true })
    .click();
  await page
    .getByRole("button", { name: "当前批次后暂停", exact: true })
    .click();
  await page.getByRole("button", { name: "继续筛选", exact: true }).waitFor();
  let history = await page.evaluate(() =>
    window.panxu.invoke("resourceExport.history"),
  );
  assert.equal(history[0].scanned, 30);
  assert.equal(history[0].total, 33);
  await page.reload();
  await page.getByRole("button", { name: "继续筛选", exact: true }).click();
  await page
    .getByText("全量筛选已完成，可以勾选导出。", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /^导出英语教学/ }).count(),
    5,
  );
  assert.match(
    await page.getByLabel("资源筛选进度").getAttribute("value"),
    /33/,
  );
  checks.push("33份全库分批 → 暂停 → 页面重载读取检查点 → 完成筛选与匹配依据");
  await page.getByRole("button", { name: "导出所选资源", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "已导出 5 份资源" })
    .waitFor();
  const save = await app.evaluate(() => globalThis.__exportQa.save);
  assert.equal(save.filters[0].extensions[0], "xlsx");
  const excel = await readFile(join(evidence, "英语教学资料清单.xlsx"));
  assert.equal(excel.readUInt32LE(0), 0x04034b50);
  await chooseOption(page.getByLabel("资源导出格式"), "csv");
  await page.getByRole("button", { name: "导出所选资源", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /csv/ }).waitFor();
  const csv = await readFile(join(evidence, "英语教学资料清单.csv"), "utf8");
  assert.match(csv, /^\uFEFF"课程分类","资源标题","价格"/);
  assert.match(csv, /英语教学1/);
  assert.doesNotMatch(csv, /数学教学|https:\/\//);
  checks.push("真实保存对话框端口 → XLSX与CSV落盘 → 核对列序、中文与筛选范围");
  await page.getByRole("checkbox", { name: /查看未匹配资源/ }).check();
  await page
    .getByRole("checkbox", { name: /^导出数学教学/ })
    .first()
    .check();
  assert.match(
    await page.locator(".export-result-column").innerText(),
    /6 份已选/,
  );
  await page.getByRole("checkbox", { name: /查看未匹配资源/ }).uncheck();
  await page.getByRole("button", { name: "生成主题短文", exact: true }).click();
  await page.getByLabel("短文标题").waitFor();
  await page.getByLabel("短文标题").fill("我的英语备课资料介绍");
  await page.getByRole("button", { name: "保存短文修改", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "短文修改已保存" })
    .waitFor();
  await page.getByRole("button", { name: "导出 MD 短文", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /短文已导出/ })
    .waitFor();
  const article = await readFile(join(evidence, "主题短文.md"), "utf8");
  assert.match(article, /我的英语备课资料介绍/);
  assert.match(article, /资源依据/);
  assert.doesNotMatch(article, /resource:resource_/);
  await page
    .getByRole("checkbox", { name: /^导出英语教学/ })
    .first()
    .uncheck();
  await page
    .getByText("资源选择已变化，请重新生成短文后导出。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "导出 MD 短文", exact: true })
      .isDisabled(),
    true,
  );
  checks.push(
    "未匹配资料手工补选 → 选中资源生成短文 → 编辑导出 → 选择变更提示重新生成",
  );
  await page
    .locator(".export-column-editor")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "02-results-desktop.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page
    .locator(".export-column-editor")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "03-results-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.reload();
  await page.getByLabel("短文标题").waitFor();
  assert.equal(
    await page.getByLabel("短文标题").inputValue(),
    "我的英语备课资料介绍",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "导出 MD 短文", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(await app.evaluate(() => globalThis.__exportQa.calls), 4);
  assert.equal(await app.evaluate(() => globalThis.__exportQa.external), 0);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:5173");
  else assert.match(page.url(), /dist\/index.html/);
  assert.match(await page.title(), /盘序/);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  checks.push(
    "1320px与840px布局、历史离线回看、页面身份、无框架覆盖层及前端异常",
  );
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, evidence, dataPath, errors },
      null,
      2,
    ),
  );
} catch (e) {
  if (page) await page.screenshot({ path: join(evidence, "failure.png") });
  throw e;
} finally {
  await app.close();
}
