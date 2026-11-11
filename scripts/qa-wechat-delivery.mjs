import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Page-scoped business transport; never submits a real draft or changes shared data. */
export async function run({ page, windowId }) {
  const out = join(tmpdir(), `panxu-wechat-delivery-${windowId}`);
  await mkdir(out, { recursive: true });
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const source = await page.evaluate(async () => {
    const articles = await window.panxu.invoke("wechat.list");
    if (!articles.length) throw Error("需要一篇现有本地稿件作为界面数据");
    return window.panxu.invoke("wechat.get", { id: articles[0].id });
  });
  const account = {
    id: "delivery-account-one",
    provider: "wechat",
    alias: "微信公众号",
    nickname: "易搜网盘",
    uid: "gh_delivery123",
    status: "connected",
  };
  let available = [account];
  let detail = structuredClone(source);
  detail.article = {
    ...detail.article,
    id: `delivery-${windowId}`,
    stage: "editing",
    author: "",
    digest: "最近很火的恋爱趣味测试，了解自己在感情中的真实模样。",
    body: "## 阅读说明\n\n了解测试的适用范围，再按需查看结果。",
    coverUrl: "https://mmbiz.qpic.cn/cover.png",
    links: [],
    readMore: undefined,
    remote: null,
    pendingAccount: null,
    pendingDraft: null,
    edition: undefined,
    revision: 1,
  };
  detail.editions = undefined;
  detail.automaticVerification = true;
  detail.issues = [];
  detail.resources = [];
  detail.readMoreEntries = [];
  const calls = [];
  let mode = "success",
    release,
    openRelease,
    openFailure = false;
  await page.exposeFunction("__deliveryQaInvoke", async (method, args) => {
    if (method === "websiteAccounts.list") return available;
    if (method === "wechat.list")
      return [
        {
          ...detail.article,
          sentRevision: detail.article.remote?.revision ?? null,
        },
      ];
    if (method === "wechat.get") return detail;
    if (method === "wechat.open") {
      calls.push({ method, args });
      await new Promise((resolve) => {
        openRelease = resolve;
      });
      if (openFailure) throw Error("微信草稿暂时无法打开，请重试。");
      return true;
    }
    if (method === "wechat.save") {
      calls.push({ method, args });
      assert.equal(args.revision, detail.article.revision);
      const { id, revision, ...text } = args;
      Object.assign(detail.article, text, {
        revision: revision + 1,
        stage: "editing",
      });
      return detail;
    }
    if (method === "wechat.recheck") {
      calls.push({ method, args });
      throw Error("页面不得自动回查微信草稿并占用账号");
    }
    if (method === "wechat.send") {
      calls.push({ method, args });
      assert.equal(args.confirmed, true);
      assert.equal(args.revision, detail.article.revision);
      await new Promise((resolve) => {
        release = resolve;
      });
      if (mode === "failure") throw Error("图片上传暂时失败，请重试。");
      if (mode === "uncertain") {
        detail.article.stage = "uncertain";
        detail.article.pendingAccount = {
          id: args.accountId,
          uid: account.uid,
        };
        detail.article.message =
          "微信已返回草稿编号 900001，但保存后核对未通过，请核对微信草稿箱。";
      } else {
        detail.article.stage = "synced";
        detail.article.remote = {
          accountId: args.accountId,
          uid: account.uid,
          draftId: "900001",
          url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=900001",
          revision: args.revision,
          sentAt: new Date().toISOString(),
        };
      }
      return detail;
    }
    throw Error(`本界面验证未启用 ${method}`);
  });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      source = await response.text();
    const needle = "return window.panxu.invoke(method, args);";
    assert(source.includes(needle));
    await route.fulfill({
      response,
      body: source.replace(
        needle,
        'return (method.startsWith("wechat.") || method === "websiteAccounts.list") ? window.__deliveryQaInvoke(method, args) : window.panxu.invoke(method, args);',
      ),
    });
  });
  await page.evaluate(
    ({ windowId, dataPath, articleId }) => {
      localStorage.setItem(
        `panxu-window:${encodeURIComponent(windowId)}:panxu:wechat:${dataPath}:selection`,
        JSON.stringify({ url: "", selected: articleId, query: "", page: 1 }),
      );
    },
    { windowId, dataPath: snapshot.dataPath, articleId: detail.article.id },
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.reload();
  const editor = page.locator(".wechat-editor");
  const setup = page.getByRole("dialog", {
    name: "送到微信草稿箱",
    exact: true,
  });
  const submit = async (label) => {
    const previous = calls.filter(
      (call) => call.method === "wechat.send",
    ).length;
    await editor.getByRole("button", { name: label, exact: true }).click();
    await setup.waitFor();
    assert.equal(
      calls.filter((call) => call.method === "wechat.send").length,
      previous,
      "选择前不提交",
    );
    await setup.getByRole("button", { name: label, exact: true }).click();
  };
  try {
    await editor
      .getByRole("button", { name: "保存为新微信草稿", exact: true })
      .waitFor({ timeout: 10000 });
  } catch (cause) {
    await page.screenshot({ path: join(out, "initial-failure.png") });
    throw new Error(
      `送稿验收初始界面未就绪，截图：${out}/initial-failure.png`,
      { cause },
    );
  }
  await page.locator(".wechat-body-options summary").click();
  const author = page.getByRole("textbox", { name: /^作者/ });
  const digest = page.getByRole("textbox", { name: /^摘要/ });
  await author.scrollIntoViewIfNeeded();
  const first = await author.boundingBox(),
    second = await digest.boundingBox();
  assert(Math.abs(first.y - second.y) < 1, "作者输入框与摘要顶部对齐");
  const labels = await page
    .locator(".wechat-metadata > .field > span")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().y),
    );
  assert(Math.abs(labels[0] - labels[1]) < 1, "字段标签对齐");
  await page.screenshot({ path: join(out, "metadata.png") });
  await author.fill("编辑部");
  await submit("保存为新微信草稿");
  const pending = setup.getByRole("button", {
    name: "正在保存到微信…",
    exact: true,
  });
  await pending.waitFor();
  assert(await pending.isDisabled(), "发送期间禁止重复点击");
  assert.equal(
    await page.getByRole("dialog").count(),
    1,
    "同一设置弹窗内保存，不追加二次确认",
  );
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release);
  release();
  release = undefined;
  await editor
    .getByRole("button", { name: "查看微信草稿", exact: true })
    .waitFor();
  assert.deepEqual(
    calls.map((x) => x.method),
    ["wechat.save", "wechat.send"],
  );
  assert.equal(calls[0].args.author, "编辑部");
  assert.equal(
    await editor
      .getByText("正在后台确认微信保存结果", { exact: false })
      .count(),
    0,
    "有效成功回执不触发后台回读提示",
  );
  await editor.locator(".wechat-editor-bar").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, "saved-receipt.png") });
  const view = editor.getByRole("button", {
    name: "查看微信草稿",
    exact: true,
  });
  const opening = editor.getByRole("button", {
    name: "正在打开微信…",
    exact: true,
  });
  const openAndWait = async () => {
    await view.click();
    await opening.waitFor();
    assert(await opening.isDisabled(), "打开期间防止重复点击");
    assert.equal(await opening.getAttribute("aria-busy"), "true");
    assert.equal(
      await page.getByRole("dialog").count(),
      0,
      "直接打开，不弹保存结果窗口",
    );
    for (let i = 0; !openRelease && i < 30; i++) await page.waitForTimeout(50);
    assert(openRelease);
  };
  await openAndWait();
  await opening.evaluate((node) => {
    node.click();
    node.click();
  });
  assert.equal(calls.filter((call) => call.method === "wechat.open").length, 1);
  assert.deepEqual(calls.at(-1).args, {
    accountId: account.id,
    id: detail.article.id,
  });
  await page.screenshot({ path: join(out, "opening-draft.png") });
  openRelease();
  openRelease = undefined;
  await view.waitFor();
  openFailure = true;
  await openAndWait();
  openRelease();
  openRelease = undefined;
  await page
    .getByRole("alert")
    .filter({ hasText: "微信草稿暂时无法打开，请重试。" })
    .waitFor();
  assert(await view.isEnabled());
  assert.equal(await page.getByRole("dialog").count(), 0);
  openFailure = false;
  await openAndWait();
  openRelease();
  openRelease = undefined;
  await view.waitFor();
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: "微信草稿暂时无法打开" })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("checkbox", { name: /有权使用/ }).count(),
    0,
  );
  await digest.fill("了解测试的适用范围，按需查看结果。");
  await submit("更新本次微信草稿");
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release);
  release();
  release = undefined;
  await editor
    .getByRole("button", { name: "查看微信草稿", exact: true })
    .waitFor();
  assert.equal(calls.filter((x) => x.method === "wechat.send").length, 2);
  assert.equal(await page.getByRole("dialog").count(), 0);
  mode = "failure";
  await digest.fill("查看内容前，请先了解适用条件。");
  await submit("更新本次微信草稿");
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release);
  release();
  release = undefined;
  await page
    .getByRole("alert")
    .filter({ hasText: "图片上传暂时失败" })
    .waitFor();
  assert.equal(await setup.count(), 1, "发送失败保留设置和重试入口");
  mode = "uncertain";
  await setup
    .getByRole("button", { name: "更新本次微信草稿", exact: true })
    .click();
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release);
  release();
  release = undefined;
  await editor
    .getByRole("status")
    .filter({ hasText: "未收到有效的微信保存成功回执" })
    .waitFor();
  assert.equal(
    await page.getByRole("dialog").count(),
    0,
    "未知结果不再强制弹窗",
  );
  const uncertainView = editor.getByRole("button", {
    name: "查看微信草稿",
    exact: true,
  });
  assert(await uncertainView.isEnabled(), "未知结果仍可直接打开微信草稿");
  assert(
    await editor
      .getByRole("button", { name: "再发一篇", exact: true })
      .isDisabled(),
    "保留防重复送稿保护",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(300);
  assert.equal(
    calls.filter((call) => call.method === "wechat.recheck").length,
    0,
    "即使旧后端仍返回自动核对能力，载入与窗口聚焦也不触发后台回查",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "重新检查保存结果", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.getByRole("checkbox").count(), 0);
  await editor.locator(".wechat-verification-reason summary").click();
  assert.equal(
    await editor.getByText(detail.article.message, { exact: true }).count(),
    1,
  );
  await page.screenshot({ path: join(out, "recovery-inline.png") });
  await uncertainView.click();
  await opening.waitFor();
  for (let i = 0; !openRelease && i < 30; i++) await page.waitForTimeout(50);
  assert(openRelease);
  openRelease();
  openRelease = undefined;
  await uncertainView.waitFor();
  detail.article.stage = "synced";
  detail.article.pendingAccount = null;
  detail.article.pendingDraft = null;
  detail.article.remote.revision = detail.article.revision;
  detail.article.message = "已根据成功回执恢复微信草稿。";
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await editor
    .getByRole("status")
    .filter({ hasText: "未收到有效的微信保存成功回执" })
    .waitFor({ state: "hidden" });
  assert.equal(
    calls.filter((x) => x.method === "wechat.send").length,
    4,
    "恢复保存状态不重发",
  );
  assert.equal(
    calls.filter((call) => call.method === "wechat.recheck").length,
    0,
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  detail.article.stage = "editing";
  detail.article.remote = null;
  detail.article.pendingAccount = null;
  detail.article.coverUrl = "";
  detail.article.revision++;
  await page.reload();
  await editor
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加封面", exact: true })
    .waitFor();
  assert.equal(
    calls.filter((x) => x.method === "wechat.send").length,
    4,
    "内容不完整时不提交",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "继续编辑", exact: true })
    .click();
  detail.article.coverUrl = "https://mmbiz.qpic.cn/cover.png";
  detail.article.revision++;
  available = [
    { ...account, status: "disconnected" },
    { ...account, id: "delivery-account-two", nickname: "另一个公众号" },
  ];
  mode = "success";
  await page.reload();
  await editor
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .click();
  await setup.getByRole("combobox", { name: "目标公众号" }).click();
  await page.getByRole("option", { name: /易搜网盘/ }).click();
  await setup
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .click();
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release, "缓存登录状态不阻止显式发送，由后端重新核验");
  assert.equal(await setup.count(), 1);
  release();
  release = undefined;
  await editor
    .getByRole("button", { name: "查看微信草稿", exact: true })
    .waitFor();
  detail.article.remote = null;
  detail.article.stage = "editing";
  detail.article.revision++;
  await page.reload();
  await editor
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .click();
  await setup.getByRole("combobox", { name: "目标公众号" }).click();
  await page.getByRole("option", { name: "另一个公众号", exact: true }).click();
  await setup
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .click();
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release);
  release();
  release = undefined;
  await editor
    .getByRole("button", { name: "查看微信草稿", exact: true })
    .waitFor();
  assert.equal(calls.at(-1).args.accountId, "delivery-account-two");
  const report = {
    windowId,
    out,
    checks: [
      "作者与摘要标签及输入顶部对齐",
      "首次发送集中选择后一次提交",
      "先保存本地修改",
      "成功回执直接完成且不显示后台确认提示",
      "发送中防重复",
      "查看微信草稿直接打开无弹窗",
      "打开中loading与防重复",
      "打开失败可重试且目标账号稿件准确",
      "更新同稿选择后不追加确认",
      "失败保留正文并可重试",
      "历史未知结果不自动回查或抢占账号",
      "返回窗口不触发回查，恢复保存状态不重发",
      "缺封面不提交",
      "多账号在送稿弹窗选择",
      "缓存登录状态由发送时重新核验",
    ],
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
