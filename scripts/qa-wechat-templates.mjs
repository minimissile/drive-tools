import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  const originalBody =
    "## 先了解结果，再决定如何使用\n\n这份资料介绍了**适用范围**，可以结合自己的情况查阅。\n\n- 保留已有条件\n- 阅读必要提醒\n\n> 结果仅供参考。\n\n入口链接：[查看资源](https://pan.quark.cn/s/template123?pwd=AB12)";
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
  assert.equal(calls.at(-1).args.templateId, "minimal");
  assert.equal(calls.at(-1).args.body, edited);
  await page.reload();
  await selector.waitFor();
  assert.equal(await selector.getAttribute("data-value"), "minimal");
  assert.equal(await body.inputValue(), edited);
  detail.templateSupport = undefined;
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
      "旧后端保存前明确拦截且保留选择",
    ],
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
