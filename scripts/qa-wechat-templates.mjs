import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wechatTemplateIds } from "../shared/wechat-templates.ts";
import { wechatArticleImages } from "../shared/wechat-markup.ts";

/** Page-scoped business transport only; no shared drafts, AI calls, or remote writes. */
export async function run({ page, windowId }) {
  const out = join(tmpdir(), `panxu-wechat-templates-${windowId}`);
  await mkdir(out, { recursive: true });
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const source = await page.evaluate(async () => {
    const list = await window.panxu.invoke("wechat.list");
    if (!list.length) throw Error("需要一篇现有本地稿件作为界面数据");
    return window.panxu.invoke("wechat.get", { id: list[0].id });
  });
  const detail = structuredClone(source);
  const image = wechatArticleImages(source.article.body)[0]?.url;
  const originalBody = [
    "这份资料整理了使用范围与操作说明，阅读时请保留**已有条件**，根据自己的实际需要查阅。",
    "## 阅读与使用步骤",
    "先查看资料介绍，再按已有顺序阅读相关内容。",
    "1. 阅读资料说明\n2. 核对适用范围\n3. 保留必要提醒",
    ...(image ? [`![内容配图](${image})`] : []),
    "> 结果仅供参考，请保留原文的条件与限制。",
    "## 资料获取",
    "入口链接：[查看资源](https://pan.quark.cn/s/template123?pwd=AB12)",
  ].join("\n\n");
  Object.assign(detail.article, {
    id: `template-${windowId}`,
    title: "从资料说明理解适用范围",
    body: originalBody,
    author: "",
    coverUrl: "https://mmbiz.qpic.cn/cover.png",
    templateId: undefined,
    readMore: undefined,
    remote: null,
    pendingAccount: null,
    pendingDraft: null,
    stage: "editing",
    revision: 1,
    links: [
      {
        id: "template-link",
        url: "https://pan.quark.cn/s/template123",
        ownUrl: "https://pan.quark.cn/s/template123",
        copyId: "template-copy",
        provider: "quark",
      },
    ],
  });
  detail.editions = undefined;
  detail.issues = [];
  detail.resources = [
    {
      linkId: "template-link",
      copyId: "template-copy",
      title: "资料附件",
      status: "ready",
      message: "本人分享已归档。",
      candidates: [],
    },
  ];
  detail.readMoreEntries = [
    {
      linkId: "template-link",
      title: "资料附件",
      driveUrl: "https://pan.quark.cn/s/template123",
      landingUrl: null,
      redirectUrl: null,
      landingIssue: "尚未发布落地页",
      redirectIssue: "尚未创建固定入口",
    },
  ];
  detail.templateSupport = true;
  detail.supportedTemplates = [...wechatTemplateIds];
  detail.article.source = {
    ...detail.article.source,
    title: detail.article.title,
    body: originalBody,
    author: "",
  };
  const calls = [];
  await page.exposeFunction("__templateQaInvoke", async (method, args) => {
    if (method === "websiteAccounts.list")
      return [
        {
          id: "template-account",
          provider: "wechat",
          alias: "微信公众号",
          nickname: "易搜网盘",
          uid: "gh_template123",
          status: "connected",
        },
      ];
    if (method === "wechat.list")
      return [{ ...detail.article, sentRevision: null }];
    if (method === "wechat.get") return detail;
    if (method === "wechat.save") {
      calls.push({ method, args: structuredClone(args) });
      assert.equal(args.revision, detail.article.revision);
      const { id, revision, ...text } = args;
      Object.assign(detail.article, text, { revision: revision + 1 });
      return detail;
    }
    if (method === "wechat.newEdition") {
      calls.push({ method, args });
      throw Error("旧后端不得接收未支持的模板字段");
    }
    throw Error(`模板验收未启用 ${method}`);
  });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      source = await response.text(),
      needle = "return window.panxu.invoke(method, args);";
    assert(source.includes(needle));
    await route.fulfill({
      response,
      body: source.replace(
        needle,
        'return (method.startsWith("wechat.") || method === "websiteAccounts.list") ? window.__templateQaInvoke(method,args) : window.panxu.invoke(method,args);',
      ),
    });
  });
  await page.evaluate(
    ({ windowId, dataPath, id }) =>
      localStorage.setItem(
        `panxu-window:${encodeURIComponent(windowId)}:panxu:wechat:${dataPath}:selection`,
        JSON.stringify({ url: "", selected: id, query: "", page: 1 }),
      ),
    { windowId, dataPath: snapshot.dataPath, id: detail.article.id },
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.reload();
  const editor = page.locator(".wechat-editor");
  const selector = editor.getByRole("combobox", {
    name: "排版模板",
    exact: true,
  });
  const body = editor.getByRole("textbox", { name: "文章正文", exact: true });
  const choose = async (control, name) => {
    await control.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await selector.waitFor();
  assert.equal(await selector.getAttribute("data-value"), "classic");
  const edited = originalBody + "\n\n保留这句未保存的补充说明。";
  await body.fill(edited);
  await choose(selector, "简约阅读");
  const preview = editor.locator("article.wechat-preview");
  await preview.waitFor();
  assert.equal(
    await preview
      .locator(":scope > section")
      .evaluate((node) => getComputedStyle(node).fontSize),
    "17px",
  );
  assert.match(await preview.innerText(), /保留这句未保存/);
  assert.equal(calls.length, 0, "换模板不调用AI、不写业务数据");
  assert.equal(
    await editor
      .locator(".wechat-body-toolbar")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  await page.screenshot({ path: join(out, "minimal-editor.png") });
  await editor.getByRole("button", { name: "全屏预览", exact: true }).click();
  const comparison = page.getByRole("dialog", {
    name: "全屏预览",
    exact: true,
  });
  const sourceSection = comparison.locator(
    "section[aria-labelledby='wechat-comparison-source']",
  );
  const current = comparison.locator(
    "section[aria-labelledby='wechat-comparison-current']",
  );
  const fullSelector = current.getByRole("combobox", {
    name: "排版模板",
    exact: true,
  });
  await choose(fullSelector, "清爽卡片");
  assert.equal(
    await current
      .locator("article.wechat-preview > section")
      .evaluate((node) => getComputedStyle(node).fontSize),
    "16px",
  );
  assert.equal(
    await sourceSection
      .locator("article.wechat-preview > section")
      .evaluate((node) => getComputedStyle(node).fontSize),
    "16px",
  );
  await page.screenshot({ path: join(out, "classic-comparison.png") });
  await choose(fullSelector, "简约阅读");
  assert.equal(
    await current
      .locator("article.wechat-preview > section")
      .evaluate((node) => getComputedStyle(node).fontSize),
    "17px",
  );
  await page.screenshot({ path: join(out, "minimal-comparison.png") });
  await choose(fullSelector, "冰蓝图文");
  assert.equal(
    await current
      .locator("article.wechat-preview > section")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(246, 252, 255)",
  );
  assert.equal(
    await current
      .locator("article.wechat-preview > section > section")
      .first()
      .evaluate((node) => getComputedStyle(node).borderTopLeftRadius),
    "20px",
  );
  assert.equal(
    await current
      .locator("article.wechat-preview h3 > span:not([aria-hidden])")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(45, 105, 156)",
  );
  assert.equal(
    await sourceSection
      .locator("article.wechat-preview > section")
      .evaluate((node) => getComputedStyle(node).fontSize),
    "16px",
  );
  assert.equal(calls.length, 0);
  await page.screenshot({ path: join(out, "ice-blue-comparison.png") });
  await current
    .getByText("夸克网盘资源", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, "ice-blue-resources.png") });
  await comparison
    .getByRole("button", { name: "退出全屏", exact: true })
    .click();
  await editor.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await body.inputValue(), edited);
  await editor
    .getByRole("button", { name: "保存本地草稿", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.wechat-editor button[aria-label="AI 生成标题"]')
        ?.disabled,
  );
  assert.equal(calls.at(-1).args.templateId, "ice-blue");
  assert.equal(calls.at(-1).args.body, edited);
  await page.reload();
  await selector.waitFor();
  assert.equal(await selector.getAttribute("data-value"), "ice-blue");
  assert.equal(await body.inputValue(), edited);
  detail.templateSupport = undefined;
  detail.supportedTemplates = undefined;
  detail.article.templateId = undefined;
  detail.article.revision++;
  await page.reload();
  await selector.waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".wechat-template-control .select-control")
        ?.getAttribute("data-value") === "classic",
  );
  await choose(selector, "简约阅读");
  const count = calls.length;
  await editor
    .getByRole("button", { name: "保存本地草稿", exact: true })
    .click();
  await editor
    .getByRole("alert")
    .filter({ hasText: "排版模板更新尚未加载" })
    .waitFor();
  assert.equal(calls.length, count, "旧后端不能静默丢掉新模板字段");
  assert.equal(await selector.getAttribute("data-value"), "minimal");
  await editor.getByRole("button", { name: "再发一篇", exact: true }).click();
  await editor
    .getByRole("alert")
    .filter({ hasText: "排版模板更新尚未加载" })
    .waitFor();
  assert.equal(calls.length, count, "旧后端不能在建稿时静默丢掉模板字段");
  detail.templateSupport = true;
  detail.supportedTemplates = ["classic", "minimal"];
  detail.article.revision++;
  await page.reload();
  await selector.waitFor();
  await editor
    .getByRole("button", { name: "载入最新版本", exact: true })
    .click();
  await choose(selector, "冰蓝图文");
  await editor
    .getByRole("button", { name: "保存本地草稿", exact: true })
    .click();
  await editor
    .getByRole("alert")
    .filter({ hasText: "排版模板更新尚未加载" })
    .waitFor();
  assert.equal(calls.length, count, "已支持旧模板的后端也不能误收新模板");
  const report = {
    windowId,
    out,
    checks: [
      "旧稿默认清爽卡片",
      "切换自动预览且无AI或业务调用",
      "1366×768工具栏不溢出",
      "全屏中可切换且原文列保持原样",
      "模板与未保存正文切换不丢失",
      "保存与刷新恢复选择",
      "冰蓝模板导语、标题和资源分区",
      "正文和全屏预览保持同一模板",
      "旧后端按支持列表拦截新增模板",
      "旧后端保存前明确拦截且保留选择",
    ],
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
