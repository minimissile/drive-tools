import { chooseOption } from "./e2e-select.mjs";
// Browser plugin not available; existing isolated Electron/Playwright workflow.
// All external calls are intercepted; no personal accounts, live AI or 5118 usage.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  dataPath = await mkdtemp(join(tmpdir(), "panxu-ideas-e2e-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-ideas-qa-")));
await mkdir(evidence, { recursive: true });
const dev = process.env.PANXU_E2E_DEV === "1";
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  ...(dev
    ? { PANXU_DEV_URL: "http://127.0.0.1:8070", PANXU_DEV_ROOT: process.cwd() }
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
  await app.evaluate(() => {
    globalThis.__ideasQa = {
      requests: 0,
      external: 0,
      mode: "ok",
      payload: null,
    };
    globalThis.fetch = async (url, init) => {
      const state = globalThis.__ideasQa;
      if (String(url) === "https://openrouter.ai/api/v1/models")
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "qa/ideas",
                supported_parameters: ["structured_outputs"],
                pricing: { prompt: "0.0000001", completion: "0.0000001" },
              },
            ],
          }),
        );
      if (String(url) !== "https://openrouter.ai/api/v1/chat/completions") {
        state.external++;
        throw new Error("外部请求已阻止");
      }
      state.requests++;
      state.payload = JSON.parse(init.body);
      const input = JSON.parse(state.payload.messages[1].content);
      const ref =
        state.mode === "invalid"
          ? "made-up-reference"
          : input.references[0]?.id;
      const item = (word, kind, cluster, intent, question) => ({
        word,
        kind,
        cluster,
        intent,
        priority: "high",
        reason: "与知识管理的真实使用场景和资料范围相关",
        angle: "用可复现步骤和适用条件解释问题，配合模板示例",
        answerQuestion: question,
        evidenceNeeded: "补充本人操作截图、系统版本与官方说明",
        localRefIds: ref ? [ref] : [],
      });
      return new Response(
        JSON.stringify({
          usage: { cost: 0.0002 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  strategy:
                    "围绕新手入门与使用决策组织内容。先提供直接答案，再补充步骤与证据；选词后用5118核验实际需求。",
                  candidates: [
                    item(
                      "Obsidian 新手入门",
                      "seed",
                      "入门教程",
                      "learn",
                      "新手如何开始使用Obsidian？",
                    ),
                    item(
                      "Obsidian Windows 安装后无法启动怎么办",
                      "longtail",
                      "入门教程",
                      "troubleshoot",
                      "Windows安装后无法启动，应先检查哪些条件？",
                    ),
                    item(
                      "Obsidian 与 Notion 怎样按离线需求选择？",
                      "question",
                      "工具决策",
                      "compare",
                      "离线记笔记时应如何选择这两个工具？",
                    ),
                  ],
                }),
              },
            },
          ],
        }),
      );
    };
  });
  const seeded = await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "联想测试本人",
    });
    const saved = await window.panxu.invoke("resource.save", {
      title: "Obsidian 入门资料",
      sourceText: "https://pan.quark.cn/s/idea-test",
      category: "软件教程",
      tags: ["Obsidian"],
      summary: "本人整理的安装步骤与模板说明。",
      accountId: a.id,
      directory: "/盘序资源",
      rightsConfirmed: false,
      enqueue: false,
    });
    const other = await window.panxu.invoke("resource.save", {
      title: "其他资料",
      sourceText: "https://pan.quark.cn/s/idea-other",
      category: "软件教程",
      tags: [],
      summary: "另一资源",
      accountId: a.id,
      directory: "/盘序资源",
      rightsConfirmed: false,
      enqueue: false,
    });
    await window.panxu.invoke("pool.manual", {
      name: "Obsidian 历史长尾词",
      resourceId: saved.resourceId,
      words: "Obsidian 安装教程\nObsidian 模板怎么使用\n无关装修资料",
    });
    await window.panxu.invoke("secret.save", {
      kind: "openrouter",
      value: "test-only-fake-key",
    });
    await window.panxu.invoke("ai.models");
    await window.panxu.invoke("settings.save", {
      model: "qa/ideas",
      exportCodes: false,
      bitUrl: "",
      dailyAiBudgetMicros: 100000,
    });
    return { saved, other };
  });
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await nav("流量发现").click();
  await page.getByLabel("当前资源", { exact: true }).fill("Obsidian 入门资料");
  await page
    .getByRole("option", { name: "Obsidian 入门资料", exact: true })
    .click();
  await page.getByLabel("查询种子词").fill("Obsidian");
  await page.getByRole("button", { name: "配置与联想", exact: true }).click();
  assert.equal(
    await page.getByLabel("AI联想主题", { exact: true }).inputValue(),
    "Obsidian",
  );
  await page.getByLabel("AI联想目标受众").fill("需要离线管理知识的职场新人");
  await page
    .getByLabel("AI联想内容目标")
    .fill("用完整教程吸引读者，提供原创模板作为补充");
  await chooseOption(page.getByLabel("AI联想策略", { exact: true }), "balanced");
  await page.getByRole("button", { name: "查看本地参考", exact: true }).click();
  await page.getByText(/本次参考：2 个相关词/).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__ideasQa.requests), 0);
  await page.getByRole("button", { name: "生成候选词", exact: true }).click();
  await page.getByRole("region", { name: "AI联想结果" }).waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /选择AI候选/ }).count(),
    3,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "送入5118查询框", exact: true })
      .isDisabled(),
    true,
  );
  const payload = await app.evaluate(() => globalThis.__ideasQa.payload);
  assert.match(payload.messages[0].content, /GEO|SEO|本地/);
  assert.doesNotMatch(
    payload.messages[1].content,
    /idea-test|test-only-fake-key/,
  );
  await page
    .getByRole("checkbox", { name: "选择AI候选Obsidian 新手入门", exact: true })
    .check();
  await page
    .getByRole("checkbox", {
      name: "选择AI候选Obsidian Windows 安装后无法启动怎么办",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "送入5118查询框", exact: true })
    .click();
  assert.equal(
    (await page.getByLabel("查询种子词").inputValue()).split("，").length,
    3,
  );
  assert.equal(await app.evaluate(() => globalThis.__ideasQa.external), 0);
  checks.push(
    "local references → bounded SEO/GEO request → grouped ideas → explicit selection → append-only 5118 handoff without query",
  );
  await page
    .getByRole("region", { name: "AI联想结果" })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "ideas-desktop.png") });
  await page.getByLabel("当前资源", { exact: true }).fill("其他资料");
  await page.getByRole("option", { name: "其他资料", exact: true }).click();
  await page.getByLabel("AI候选词池名称").fill("待验证的SEO与GEO词池");
  await page
    .getByRole("button", { name: "保存待验证词池", exact: true })
    .click();
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot")),
    pool = snapshot.pools.find((p) => p.name === "待验证的SEO与GEO词池");
  assert.equal(pool.resourceId, seeded.saved.resourceId);
  assert.equal(pool.keywords.length, 2);
  assert.deepEqual(pool.keywords[0].metrics, {});
  assert.match(pool.keywords[0].source, /待5118验证/);
  assert.ok(pool.keywords[0].idea.evidenceNeeded);
  checks.push(
    "saving retains original resource binding, unverified provenance and empty metrics after resource changes",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page
    .getByRole("region", { name: "AI联想结果" })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "ideas-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.reload();
  await page.getByRole("button", { name: "配置与联想", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择AI候选Obsidian 新手入门", exact: true })
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.__ideasQa.requests), 1);
  await chooseOption(page.getByLabel("AI候选词类型"), "question");
  assert.equal(
    await page.getByRole("checkbox", { name: /选择AI候选/ }).count(),
    1,
  );
  await page.getByRole("button", { name: "选中可见项", exact: true }).click();
  assert.equal(
    await page.getByRole("checkbox", { name: /选择AI候选/ }).isChecked(),
    true,
  );
  checks.push(
    "840px no overflow; reload/history reads offline; type filter and visible selection stay accurate",
  );
  await app.evaluate(() => {
    globalThis.__ideasQa.mode = "invalid";
  });
  await page.getByRole("button", { name: "生成候选词", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "本地引用不符合要求" })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.panxu.invoke("ai.ideas.history"))).length,
    1,
  );
  assert.equal(await app.evaluate(() => globalThis.__ideasQa.requests), 2);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:8070");
  else assert.match(page.url(), /dist\/index.html/);
  assert.match(await page.title(), /盘序/);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  checks.push(
    "invalid AI citation rejected with fee retained, previous history intact, no blank renderer or console errors",
  );
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, evidence, dataPath, errors },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "failure.png") });
  throw error;
} finally {
  await app.close();
}
