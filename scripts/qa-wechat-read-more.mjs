import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Page-scoped business transport only; no shared records or remote writes. */
export async function run({ page, windowId }) {
  const out = join(tmpdir(), `panxu-wechat-read-more-${windowId}`);
  await mkdir(out, { recursive: true });
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const source = await page.evaluate(async () => {
    const articles = await window.panxu.invoke("wechat.list");
    if (!articles.length) throw Error("需要一篇现有本地稿件作为界面数据");
    return window.panxu.invoke("wechat.get", { id: articles[0].id });
  });
  const detail = structuredClone(source);
  Object.assign(detail.article, {
    id: `read-more-${windowId}`,
    title: "从七宗罪测试认识自己的内在特质",
    body: "## 从结果了解自己\n\n测试结果可以作为观察自身特质的参考。\n\n[测试入口](https://pan.quark.cn/s/first?pwd=1234)\n\n[配套资料](https://pan.quark.cn/s/second?pwd=5678)",
    author: "",
    coverUrl: "https://mmbiz.qpic.cn/cover.png",
    links: ["first", "second"].map((id) => ({
      id,
      url: `https://pan.quark.cn/s/${id}`,
      ownUrl: `https://pan.quark.cn/s/${id}`,
      copyId: `copy-${id}`,
      provider: "quark",
    })),
    readMore: undefined,
    remote: null,
    pendingAccount: null,
    pendingDraft: null,
    edition: undefined,
    revision: 1,
    stage: "editing",
  });
  detail.readMoreEntries = ["first", "second"].map((id, index) => ({
    linkId: id,
    title: index ? "七宗罪测试配套资料" : "七宗罪测试入口",
    driveUrl: `https://pan.quark.cn/s/${id}`,
    landingUrl: index ? null : `https://panxu.site/r/${id}`,
    redirectUrl: `https://panxu.site/go/${id}`,
    landingIssue: index ? "尚未发布资源落地页，请先在资源库发布。" : null,
    redirectIssue: null,
  }));
  detail.resources = detail.article.links.map((link, index) => ({
    linkId: link.id,
    copyId: link.copyId,
    title: detail.readMoreEntries[index].title,
    status: "ready",
    message: "本人分享已归档。",
    candidates: [],
  }));
  detail.editions = undefined;
  detail.issues = [];
  const saves = [],
    sends = [];
  let release;
  await page.exposeFunction("__readMoreQaInvoke", async (method, args) => {
    if (method === "websiteAccounts.list")
      return [
        {
          id: "read-more-account",
          provider: "wechat",
          alias: "微信公众号",
          nickname: "易搜网盘",
          uid: "gh_isolated123",
          status: "connected",
        },
        {
          id: "read-more-second",
          provider: "wechat",
          alias: "另一个公众号",
          nickname: "另一个公众号",
          uid: "gh_second123",
          status: "connected",
        },
      ];
    if (method === "wechat.list")
      return [{ ...detail.article, sentRevision: null }];
    if (method === "wechat.get") return detail;
    if (method === "wechat.save") {
      assert.equal(args.revision, detail.article.revision);
      saves.push(structuredClone(args));
      const { id, revision, ...text } = args;
      Object.assign(detail.article, text, { revision: revision + 1 });
      return detail;
    }
    if (method === "wechat.send") {
      assert.equal(args.revision, detail.article.revision);
      assert.equal(args.confirmed, true);
      sends.push(structuredClone(args));
      await new Promise((resolve) => {
        release = resolve;
      });
      detail.article.stage = "synced";
      detail.article.remote = {
        accountId: args.accountId,
        uid: "gh_second123",
        revision: args.revision,
        draftId: "900001",
        url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=900001",
        sentAt: new Date().toISOString(),
      };
      return detail;
    }
    throw Error(`隔离界面验证不允许操作 ${method}`);
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
        'return (method.startsWith("wechat.") || method === "websiteAccounts.list") ? window.__readMoreQaInvoke(method,args) : window.panxu.invoke(method,args);',
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
  const setup = page.getByRole("dialog", {
    name: "送到微信草稿箱",
    exact: true,
  });
  const mode = setup.getByRole("combobox", { name: "原文链接", exact: true });
  const resource = setup.getByRole("combobox", {
    name: "链接对应资源",
    exact: true,
  });
  const account = setup.getByRole("combobox", {
    name: "目标公众号",
    exact: true,
  });
  const choose = async (control, name) => {
    await control.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const open = async () => {
    await editor
      .getByRole("button", { name: "保存为新微信草稿", exact: true })
      .click();
    await setup.waitFor();
  };
  const close = async () => {
    await setup.getByRole("button", { name: "继续编辑", exact: true }).click();
    await setup.waitFor({ state: "hidden" });
  };
  await editor
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .waitFor();
  assert.equal(
    await editor
      .getByRole("combobox", { name: "原文链接", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await editor
      .getByRole("combobox", { name: "目标公众号", exact: true })
      .count(),
    0,
  );
  await page.screenshot({ path: join(out, "editor.png") });
  const body = editor.getByRole("textbox", { name: "文章正文", exact: true });
  const originalBody = await body.inputValue();
  await open();
  assert.equal(sends.length, 0);
  assert.equal(saves.length, 0);
  assert.equal(await mode.getAttribute("data-value"), "drive");
  assert.match(
    await setup.locator(".wechat-read-more-address").innerText(),
    /first\?pwd=1234/,
  );
  await choose(mode, "资源落地页");
  assert.match(
    await setup.locator(".wechat-read-more-address").innerText(),
    /https:\/\/panxu.site\/r\/first/,
  );
  await close();
  assert.equal(sends.length, 0, "取消选择不送稿");
  assert.equal(saves.length, 0, "取消不写共享稿件");
  assert.equal(await body.inputValue(), originalBody);
  await editor
    .getByRole("button", { name: "保存本地草稿", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.wechat-editor button[aria-label="AI 生成标题"]')
        ?.disabled === false,
  );
  assert.equal(saves.at(-1).readMore.kind, "landing");
  await page.reload();
  await open();
  assert.equal(await mode.getAttribute("data-value"), "landing");
  await choose(mode, "短链接（直达）");
  await choose(resource, "七宗罪测试配套资料");
  assert.match(
    await setup.locator(".wechat-read-more-address").innerText(),
    /https:\/\/panxu.site\/go\/second/,
  );
  await page.screenshot({ path: join(out, "delivery-options.png") });
  assert.equal(
    await setup
      .locator(".wechat-read-more")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  await close();
  await editor.getByRole("button", { name: "排版预览", exact: true }).click();
  assert.equal(
    await editor
      .getByText("点击文末“阅读原文”打开资源", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await editor.getByText("复制链接到浏览器打开", { exact: true }).count(),
    1,
  );
  await open();
  await choose(mode, "资源落地页");
  await setup
    .getByRole("status")
    .filter({ hasText: "尚未发布资源落地页" })
    .waitFor();
  assert(
    await setup
      .getByRole("button", { name: "保存为新微信草稿", exact: true })
      .isDisabled(),
  );
  assert.equal(sends.length, 0);
  await page.screenshot({ path: join(out, "unavailable-landing.png") });
  await choose(resource, "七宗罪测试入口");
  await choose(mode, "网盘链接");
  await close();
  await editor.getByRole("button", { name: "继续编辑", exact: true }).click();
  await body.fill("移除资源链接后的正文。");
  await open();
  await setup
    .getByRole("status")
    .filter({ hasText: "所选资源已不在正文" })
    .waitFor();
  await choose(resource, "自动选择正文第一条资源");
  assert.match(
    await setup.locator(".wechat-read-more-address").innerText(),
    /暂不设置链接/,
  );
  await close();
  await body.fill(originalBody);
  await open();
  await choose(mode, "短链接（直达）");
  await choose(resource, "七宗罪测试配套资料");
  await choose(account, "另一个公众号");
  await setup
    .getByRole("button", { name: "保存为新微信草稿", exact: true })
    .click();
  const pending = setup.getByRole("button", {
    name: "正在保存到微信…",
    exact: true,
  });
  await pending.waitFor();
  assert(await pending.isDisabled());
  assert.equal(await pending.getAttribute("aria-busy"), "true");
  assert.equal(
    await page.getByRole("dialog").count(),
    1,
    "同一弹窗提交，无额外确认",
  );
  assert.equal(await page.getByRole("checkbox").count(), 0);
  for (let i = 0; !release && i < 30; i++) await page.waitForTimeout(50);
  assert(release);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].accountId, "read-more-second");
  assert.deepEqual(saves.at(-1).readMore, {
    kind: "redirect",
    linkId: "second",
  });
  assert.equal(saves.at(-1).body, originalBody);
  await page.screenshot({ path: join(out, "sending.png") });
  release();
  await editor
    .getByRole("button", { name: "查看微信草稿", exact: true })
    .waitFor();
  assert.equal(await setup.count(), 0);
  await body.fill(originalBody + "\n\n补充阅读说明。");
  await editor
    .getByRole("button", { name: "更新本次微信草稿", exact: true })
    .click();
  await setup.waitFor();
  assert(await account.isDisabled(), "已送稿固定原公众号");
  assert.equal(await account.getAttribute("data-value"), "read-more-second");
  assert.equal(await mode.getAttribute("data-value"), "redirect");
  await close();
  const report = {
    windowId,
    out,
    checks: [
      "编辑页移除公众号和原文链接选择",
      "点击送稿才弹窗且不自动提交",
      "两项设置集中选择",
      "取消不送稿不写共享数据",
      "默认网盘链接保留提取码",
      "三种链接可切换且多资源可选",
      "保存后刷新恢复",
      "正文卡片提示与所选资源一致",
      "不可用入口阻止提交",
      "删除资源后可清除旧绑定",
      "一次提交同时保存本地选择与公众号",
      "loading防重复且没有追加确认",
      "成功自动关闭，更新同稿固定原公众号",
      "1366×768无横向溢出",
    ],
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
