import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function openNewDraftSettings(scope) {
  const toggle = scope.getByRole("button", { name: "新稿设置", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.dispatchEvent("click");
  await scope.getByLabel("新文章简书账号", { exact: true }).waitFor();
}

/** Production components with isolated, in-frame IPC. No shared-backend mutations. */
export async function run({ page, checkpoint, windowId }) {
  if (process.env.PANXU_JIANSHU_QA_SCOPE === "image-recovery")
    return runImageRecovery({ page, checkpoint, windowId });
  if (process.env.PANXU_JIANSHU_QA_SCOPE === "tieba-source")
    return runTiebaSource({ page, checkpoint, windowId });
  const evidence = await mkdtemp(join(tmpdir(), "panxu-jianshu-ui-"));
  console.log(JSON.stringify({ jianshuWindowId: windowId, evidence }));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-jianshu.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:60000});
  const frame = page.frameLocator('iframe[title="简书内容内存模拟页面"]');
  const main = frame.locator("main");
  const helper = (method, arg) =>
    main.evaluate(
      (_element, { method, arg }) => window.__jianshuQa[method](arg),
      { method, arg },
    );
  const button = (name) =>
    frame.getByRole("button", { name, exact: true }).filter({ visible: true });
  const click = (name) => button(name).dispatchEvent("click");
  const tab = (name) =>
    frame.getByRole("tab", { name, exact: true }).dispatchEvent("click");
  const fill = (label, value) =>
    frame.getByLabel(label, { exact: true }).evaluate((element, value) => {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  const choose = async (label, value, retainedValue = value) => {
    const control = frame.getByLabel(label, { exact: true });
    await control.dispatchEvent("click");
    const option = frame
      .getByRole("option")
      .and(frame.locator(`[data-value="${value}"]`))
      .filter({ visible: true });
    await option.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await option.dispatchEvent("click");
    assert.equal(await control.getAttribute("data-value"), retainedValue);
  };
  const count = async (method) =>
    (await helper("events")).filter((event) => event.method === method).length;
  const body = () => frame.getByLabel("简书文章正文", { exact: true });
  const title = () => frame.getByLabel("简书文章标题", { exact: true });
  const current = frame.getByRole("region", {
    name: "当前简书文章",
    exact: true,
  });
  const articles = frame.getByRole("complementary", {
    name: "简书文章列表",
    exact: true,
  });
  const checks = [];
  try {
    await frame
      .getByRole("heading", { name: "开始一篇文章", exact: true })
      .waitFor();
    await openNewDraftSettings(frame);
    assert.equal(
      await frame
        .getByLabel("新文章简书账号", { exact: true })
        .getAttribute("data-value"),
      "",
    );
    assert.equal(await button("使用所选内容创作").isEnabled(), false);
    await tab("发布记录");
    await frame
      .getByRole("heading", { name: "这里保存你的文章与发布记录", exact: true })
      .waitFor();
    await tab("创作发布");
    await tab("第三方采集");
    await frame
      .getByRole("heading", {
        name: "采集一批内容，再选择用于创作",
        exact: true,
      })
      .waitFor();
    checks.push("双页签、无账号仍可写稿、未选素材的禁用状态和本地空态");

    await helper("failCollect");
    await click("采集新内容");
    await frame
      .getByText("来源暂时无法读取，原采集记录已保留，请重试。", {
        exact: true,
      })
      .waitFor();
    await click("采集新内容");
    const selectedSource = frame.getByRole("checkbox", {
      name: "英语学习工具与练习安排",
      exact: true,
    });
    await selectedSource.waitFor();
    await selectedSource.dispatchEvent("click");
    assert.equal(await selectedSource.isChecked(), true);
    await click("查看素材");
    await frame.getByRole("dialog").waitFor();
    assert.ok((await frame.getByRole("dialog").innerText()).includes("原作者"));
    await click("关闭弹窗");
    await page.screenshot({
      path: join(evidence, "01-sources-1440.png"),
      fullPage: true,
    });
    checks.push(
      "第三方采集失败重试、素材选择、原文与来源预览；不访问真实第三方",
    );

    await helper("hold", "jianshu.create");
    const createBefore = await count("jianshu.create");
    await click("使用所选内容创作");
    await button("正在建立文章…").waitFor();
    await button("正在建立文章…").dispatchEvent("click");
    assert.equal(await count("jianshu.create"), createBefore + 1);
    await helper("release");
    await title().waitFor();
    assert.equal(await title().inputValue(), "英语学习工具与练习安排");
    assert.equal(await button("填写到简书").isEnabled(), false);
    checks.push("素材创建本地稿、双击去重、无账号不填写官网");

    await helper("enableAccount");
    await choose("文章简书账号", "web_jianshu_fixture");
    const original =
      "先区分资料目录中的词汇与阅读练习，再根据学习时间安排每日任务。每次只完成一个明确的小目标，结束后记录需要继续回顾的内容，避免一次选取过多资料。";
    await fill("简书文章正文", original);
    await fill("简书文章标题", "英语自学资料的使用顺序");
    await click("保存草稿");
    await frame.getByText("当前稿件已保存。", { exact: false }).waitFor();
    await click("复制标题");
    await frame.getByText("标题已复制。", { exact: false }).waitFor();
    assert.equal((await helper("clipboard")).title, "英语自学资料的使用顺序");
    await click("复制正文");
    await frame
      .getByText("正文已复制，包含资料入口与来源；配图可单独导出。", {
        exact: false,
      })
      .waitFor();
    const copied = (await helper("clipboard")).text;
    assert.ok(copied.includes(original));
    assert.ok(copied.includes("https://source.example.org/english"));
    await click("导出文章与配图");
    await frame.getByText("文章与配图已导出。", { exact: false }).waitFor();
    assert.equal((await helper("exports")).length, 1);
    checks.push("手动修改保存、复制标题/最终正文、保留真实来源字段及导出调用");

    await fill("简书补充要求", "突出适合零基础自学的人群，保持客观。");
    await helper("failGenerate");
    await click("按要求生成新版本");
    await frame
      .getByText("模拟模型暂时不可用，当前稿件和旧版本已保留。", {
        exact: true,
      })
      .waitFor();
    assert.equal(await body().inputValue(), original);
    await helper("hold", "jianshu.generate");
    const generateBefore = await count("jianshu.generate");
    await click("按要求生成新版本");
    await button("正在生成…").waitFor();
    await button("正在生成…").dispatchEvent("click");
    assert.equal(await count("jianshu.generate"), generateBefore + 1);
    await helper("release");
    await frame
      .getByText("新版本已生成，原稿已保留。", { exact: false })
      .waitFor();
    const latest = await helper("latest");
    assert.ok(latest.versions.some((version) => version.body === original));
    await choose(
      "简书历史版本",
      String(
        latest.versions.find((version) => version.body === original).revision,
      ),
      "current",
    );
    assert.equal(await body().inputValue(), original);
    checks.push("AI模拟失败保留原稿、成功生成新版本、恢复旧稿及生成双击去重");

    const unsaved = original + "\n本地暂存补充：先完成目录阅读，再开始练习。";
    await fill("简书文章正文", unsaved);
    await helper("leave");
    await frame
      .getByRole("heading", { name: "模拟切换到其他模块", exact: true })
      .waitFor();
    await click("返回简书测试工作区");
    await body().waitFor();
    assert.equal(await body().inputValue(), unsaved);
    assert.equal(
      await frame.getByLabel("简书补充要求", { exact: true }).inputValue(),
      "突出适合零基础自学的人群，保持客观。",
    );
    await helper("failSave");
    await click("保存草稿");
    await frame
      .getByText("稿件已在其他窗口更新，当前文字保留。", { exact: true })
      .waitFor();
    assert.equal(await body().inputValue(), unsaved);
    checks.push("切页重挂载后恢复未提交正文和补充要求，保存失败不清空输入");

    await helper("externalUpdate");
    await button("复制本地稿并读取后台版本").waitFor();
    assert.equal(await body().inputValue(), unsaved);
    await click("复制本地稿并读取后台版本");
    await frame
      .getByText("本地稿已复制，已读取后台版本。", { exact: false })
      .waitFor();
    assert.ok((await helper("clipboard")).title.includes(unsaved));
    assert.equal(await title().inputValue(), "其他窗口已保存的标题");
    assert.equal(await body().inputValue(), (await helper("latest")).body);
    checks.push("收到外部窗口更新仍保留本地输入；显式读取后台前先复制本地稿");

    await click("新建文章");
    await frame
      .getByRole("heading", { name: "开始一篇文章", exact: true })
      .waitFor();
    await tab("资源库");
    await openNewDraftSettings(frame);
    await choose("新文章简书账号", "web_jianshu_fixture");
    await button("展开搜索简书创作资源").dispatchEvent("click");
    const resourceOption = frame.getByRole("option", {
      name: "英语自学资料与阅读练习 · 资料账号",
      exact: true,
    });
    await resourceOption.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await resourceOption.dispatchEvent("click");
    await click("使用所选内容创作");
    await title().waitFor();
    const second = await helper("latest");
    const secondRow = articles.getByRole("button", {
      name: second.title,
      exact: true,
    });
    await secondRow.waitFor();
    assert.equal(await secondRow.getAttribute("aria-current"), "page");
    const search = articles.getByRole("searchbox", {
      name: "搜索简书文章",
      exact: true,
    });
    const untouched = `${second.body}\n\n本窗口尚未保存的资源稿补充。${"这条练习仅用于验证正文编辑区和滚动行为。".repeat(45)}`;
    await fill("简书文章正文", untouched);
    await search.fill("没有这篇简书文章");
    await secondRow.waitFor({ state: "hidden" });
    await articles
      .getByRole("heading", { name: "没有匹配的文章", exact: true })
      .waitFor();
    assert.equal(
      await body().inputValue(),
      untouched,
      "筛选列表不应关闭当前文章",
    );
    await search.fill("其他窗口");
    const firstRow = articles.getByRole("button", {
      name: "其他窗口已保存的标题",
      exact: true,
    });
    await firstRow.press("Enter");
    await firstRow.and(articles.locator('[aria-current="page"]')).waitFor();
    await title().waitFor();
    assert.equal(await firstRow.getAttribute("aria-current"), "page");
    assert.equal(await title().inputValue(), "其他窗口已保存的标题");
    assert.equal(await search.inputValue(), "其他窗口");
    await search.fill("");
    await secondRow.press("Enter");
    await secondRow.and(articles.locator('[aria-current="page"]')).waitFor();
    await title().waitFor();
    assert.equal(await secondRow.getAttribute("aria-current"), "page");
    assert.equal(
      await body().inputValue(),
      untouched,
      "切到另一篇文章再返回应保留未提交输入",
    );
    const settings = frame.locator('[aria-label="稿件设置"]');
    const actions = frame.locator('[aria-label="稿件操作"]');
    await settings.waitFor();
    await actions.waitFor();
    const widths = [
      (await body().boundingBox()).width,
      (await settings.boundingBox()).width,
    ];
    assert.ok(widths[0] > widths[1] * 1.4, "桌面正文区应明显宽于设置区");
    if ((await button("关闭提示").count()) === 1) await click("关闭提示");
    await body().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "07-draft-workspace-1440.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await body().scrollIntoViewIfNeeded();
    assert.equal(
      await main.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.ok(
      (await button("填写到简书").boundingBox()).y < 768,
      "较小桌面编辑时应可触达官网动作",
    );
    await page.screenshot({
      path: join(evidence, "08-draft-workspace-1366.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await fill("简书文章正文", second.body);
    checks.push(
      "可搜索文章列表、键盘打开文章、当前行状态、切换和筛选保留未提交输入；1440×900 正文主列及 1366×768 操作可达",
    );
    await click("添加本地图片");
    await frame
      .getByRole("img", { name: "英语资料封面（模拟）", exact: true })
      .waitFor();
    await click("预览最终文章");
    await frame.locator(".jianshu-article-preview").waitFor();
    const preview = await frame.locator(".jianshu-article-preview").innerText();
    assert.ok(preview.includes("https://pan.quark.cn/s/ownenglish1?pwd=ABCD"));
    assert.ok(!preview.includes("https://source.example.org/english"));
    assert.ok(!preview.includes("##"));
    const previewBody = frame.locator(".jianshu-preview-body");
    await previewBody
      .getByRole("heading", { name: "资料介绍", exact: true })
      .waitFor();
    await previewBody
      .getByRole("heading", { name: "资料获取", exact: true })
      .waitFor();
    const resourceLink = previewBody.getByRole("link", {
      name: "https://pan.quark.cn/s/ownenglish1?pwd=ABCD",
      exact: true,
    });
    assert.equal(
      await resourceLink.getAttribute("href"),
      "https://pan.quark.cn/s/ownenglish1?pwd=ABCD",
    );
    const pageUrl = page.url();
    const frameUrl = await main.evaluate(() => location.href);
    const currentArticle = await helper("latest");
    const externalBefore = await count("system.external");
    await resourceLink.dispatchEvent("click");
    assert.equal(await count("system.external"), externalBefore + 1);
    assert.deepEqual(
      (await helper("events"))
        .filter((event) => event.method === "system.external")
        .at(-1).args,
      { url: "https://pan.quark.cn/s/ownenglish1?pwd=ABCD" },
    );
    assert.equal(page.url(), pageUrl);
    assert.equal(await main.evaluate(() => location.href), frameUrl);
    assert.deepEqual(await helper("latest"), currentArticle);
    await previewBody
      .getByRole("heading", { name: "资料获取", exact: true })
      .waitFor();
    await click("复制正文");
    await frame
      .getByText("正文已复制，包含资料入口与来源；配图可单独导出。", {
        exact: false,
      })
      .waitFor();
    assert.ok(
      (await helper("clipboard")).text.includes(
        "https://pan.quark.cn/s/ownenglish1?pwd=ABCD",
      ),
    );
    await page.screenshot({
      path: join(evidence, "02-resource-delivery-1440.png"),
      fullPage: true,
    });
    checks.push(
      "资源库稿件的准确本人分享和提取信息进入最终预览与复制正文，无前篇来源串入",
    );

    await helper("prepareMode", "legacy");
    await helper("hold", "jianshu.prepare");
    const prepareBefore = await count("jianshu.prepare");
    await click("填写到简书");
    await button("正在填写…").waitFor();
    await button("正在填写…").dispatchEvent("click");
    assert.equal(await count("jianshu.prepare"), prepareBefore + 1);
    await helper("release");
    await current
      .getByText("待官网发布", { exact: true })
      .filter({ visible: true })
      .waitFor();
    assert.equal((await helper("latest")).stage, "prepared");
    await frame
      .getByText(
        "当前后端仅打开了简书，尚未自动填写。请点击顶部“应用更新并重启”加载新功能后再试；稿件已保留。",
        { exact: true },
      )
      .waitFor();
    assert.equal((await helper("latest")).preparedFill, undefined);
    assert.equal(
      await frame
        .getByText("标题和正文已填写到官网草稿。", { exact: false })
        .count(),
      0,
    );
    assert.equal(await button("填写到简书").isEnabled(), true);
    await helper("prepareMode", "partial");
    await click("填写到简书");
    await frame
      .getByText(
        "模拟配图上传中断，官网草稿已保留；可继续填写原草稿，不会新建文章。",
        { exact: true },
      )
      .waitFor();
    const partial = await helper("latest");
    assert.equal(partial.stage, "uncertain");
    assert.equal(partial.preparedFill.filled, false);
    assert.equal(partial.preparedFill.uploadedImages, 0);
    assert.equal(partial.preparedFill.totalImages, 1);
    await button("继续填写原草稿").waitFor();
    await frame
      .getByText(
        "官网草稿已保留，填写尚未完成。配图已上传 0 / 1 张。请继续填写原草稿，完成后再到简书核对并发布。",
        { exact: true },
      )
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "03-partial-fill-recovery-1440.png"),
      fullPage: true,
    });
    await helper("hold", "jianshu.prepare");
    await click("继续填写原草稿");
    await button("正在填写…").waitFor();
    await button("正在填写…").dispatchEvent("click");
    assert.equal(await count("jianshu.prepare"), prepareBefore + 3);
    await helper("release");
    await button("查看已填写草稿").waitFor();
    const filled = await helper("latest");
    assert.equal(filled.stage, "prepared");
    assert.equal(filled.preparedFill.filled, true);
    assert.equal(filled.editorUrl, partial.editorUrl);
    assert.equal(filled.preparedFill.uploadedImages, 1);
    assert.equal(filled.preparedFill.totalImages, 1);
    assert.equal(filled.receiptUrl, null);
    await frame
      .getByText(
        "标题和正文已填写到官网草稿。配图已上传 1 / 1 张。请在简书检查排版和配图，并由你点击发布。",
        { exact: true },
      )
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "04-fill-complete-1440.png"),
      fullPage: true,
    });
    const stats = await helper("prepareStats");
    const openBefore = await count("websiteAccounts.openDocument");
    const filledPrepareCount = await count("jianshu.prepare");
    await click("查看已填写草稿");
    await button("查看已填写草稿").waitFor();
    assert.equal(await count("jianshu.prepare"), filledPrepareCount);
    assert.equal(await count("websiteAccounts.openDocument"), openBefore + 1);
    assert.deepEqual(await helper("prepareStats"), stats);
    assert.equal((await helper("latest")).editorUrl, partial.editorUrl);
    checks.push(
      "填写主操作与双击去重、旧后端仅打开时明确提示应用更新、旧手工稿显式填写、配图失败保留同稿并继续、完成后重开不重复上传；尚未发布",
    );
    await click("查看发布核对");
    assert.equal(
      await frame
        .getByRole("region", { name: "核对官网发布结果" })
        .evaluate((section) => section.ownerDocument.activeElement === section),
      true,
    );
    await fill("简书发布文章链接", "https://www.jianshu.com/p/012345abcdef");
    await click("核对发布结果");
    await frame
      .getByText("读取结果尚未核实，请查看原页面；不会自动重发。", {
        exact: true,
      })
      .waitFor();
    assert.equal((await helper("latest")).stage, "uncertain");
    assert.equal(await count("jianshu.prepare"), prepareBefore + 3);
    assert.equal(await button("查看已填写草稿").count(), 0);
    assert.equal(await button("继续填写原草稿").count(), 0);
    await helper("verifyReceipt");
    await click("核对发布结果");
    await frame
      .getByText("已核实本人文章、正文和资源入口。", { exact: true })
      .waitFor();
    assert.equal((await helper("latest")).stage, "published");
    assert.equal((await helper("latest")).imageReviewRequired, true);
    await frame
      .getByText("官网正文与资料入口已核对，配图仍需你打开官网文章逐张检查。", {
        exact: false,
      })
      .waitFor();
    await click("我已检查官网配图");
    await frame
      .getByText("官网配图已由你人工核对。", { exact: true })
      .waitFor();
    assert.equal((await helper("latest")).imageReviewRequired, false);
    assert.ok((await helper("latest")).imageReviewedAt);
    await frame
      .getByText("官网配图已由你人工核对。", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "05-result-verification-1440.png"),
      fullPage: true,
    });
    await tab("发布记录");
    await frame.getByRole("table").waitFor();
    assert.ok((await frame.getByRole("table").innerText()).includes("已发布"));
    assert.ok(
      (await frame.getByRole("table").innerText()).includes("关联本人资源"),
    );
    await frame.getByRole("table").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "06-publishing-records-1440.png"),
      fullPage: true,
    });
    checks.push(
      "填写仅标待官网发布，核对未知不重发，已有回执禁止继续填写；明确模拟核验后仍须人工核对配图并记录确认时间",
    );

    await checkpoint();
    assert.equal(
      await main.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const summary = {
      windowId,
      evidence,
      checks,
      counts: {
        collect: await count("jianshu.collect"),
        create: await count("jianshu.create"),
        generate: await count("jianshu.generate"),
        prepare: await count("jianshu.prepare"),
        checkResult: await count("jianshu.checkResult"),
      },
      limitation:
        "任务专属窗口的独立iframe与内存IPC，验证实际组件状态及交互；不代表真实简书登录、模型、采集、上传或发布通过。",
    };
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(summary, null, 2),
    );
    return summary;
  } catch (error) {
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(evidence, "failure.txt"),
      String(error.stack || error),
    );
    throw error;
  } finally {
    await helper("cleanup").catch(() => {});
  }
}

async function runTiebaSource({ page, checkpoint, windowId }) {
  const evidence = await mkdtemp(join(tmpdir(), "panxu-jianshu-tieba-ui-"));
  console.log(JSON.stringify({ jianshuWindowId: windowId, evidence }));
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-jianshu.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  const frame = page.frameLocator('iframe[title="简书内容内存模拟页面"]');
  const main = frame.locator("main");
  const helper = (method, arg) =>
    main.evaluate(
      (_element, { method, arg }) => window.__jianshuQa[method](arg),
      { method, arg },
    );
  const events = async (method) =>
    (await helper("events")).filter((event) => event.method === method);
  const button = (name) =>
    frame.getByRole("button", { name, exact: true }).filter({ visible: true });
  const click = (name) => button(name).dispatchEvent("click");
  const checkbox = (name) => frame.getByRole("checkbox", { name, exact: true });
  const canonicalUrl = "https://tieba.baidu.com/p/9063569462";
  const variedUrl = `${canonicalUrl}?pn=2&pid=918273#918273`;
  const oldTitle = "英语学习工具与练习安排";
  const threadTitle = "一键共享打印机的使用方法";
  const selectionCount = frame.getByText("已选 1 项 / 最多 20 项", {
    exact: true,
  });
  const filter = frame.getByLabel("筛选已采集素材", { exact: true });
  const address = frame.getByLabel("贴吧帖子链接", { exact: true });
  const fill = (locator, value) =>
    locator.evaluate((input, text) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  try {
    assert.equal(new URL(page.url()).pathname, "/__qa-jianshu.html");
    assert.equal(await page.title(), "简书内容 · 专用界面验收");
    await frame
      .getByRole("heading", { name: "开始一篇文章", exact: true })
      .waitFor();
    await helper("seedSourceHistory");
    await frame
      .getByRole("tab", { name: "第三方采集", exact: true })
      .dispatchEvent("click");
    const sourceSelect = frame.getByLabel("采集来源", { exact: true });
    await sourceSelect.dispatchEvent("click");
    const tiebaOption = frame.getByRole("option", {
      name: "百度贴吧 · 单帖",
      exact: true,
    });
    await tiebaOption.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await tiebaOption.dispatchEvent("click");
    await address.waitFor();
    assert.equal(await sourceSelect.getAttribute("data-value"), "tieba");
    assert.equal(await button("采集新内容").isEnabled(), false);
    await fill(filter, "英语");
    await checkbox(oldTitle).dispatchEvent("click");
    await selectionCount.waitFor();
    await click("下一页");
    await checkbox("英语学习素材 7").waitFor();
    await fill(address, canonicalUrl);

    await helper("failCollect");
    await click("采集新内容");
    await frame
      .getByText("来源暂时无法读取，原采集记录已保留，请重试。", {
        exact: true,
      })
      .waitFor();
    assert.equal(await address.inputValue(), canonicalUrl);
    assert.equal(await filter.inputValue(), "英语");
    assert.equal(await selectionCount.isVisible(), true);
    assert.equal(await checkbox("英语学习素材 7").isVisible(), true);
    assert.equal(await checkbox(threadTitle).count(), 0);
    await checkpoint();

    await click("采集新内容");
    await checkbox(threadTitle).waitFor();
    assert.equal(await filter.inputValue(), "英语");
    assert.equal(await checkbox(oldTitle).isChecked(), true);
    assert.equal(await checkbox(threadTitle).isChecked(), false);
    assert.equal(await selectionCount.isVisible(), true);
    await fill(filter, "");
    await checkbox(threadTitle).waitFor();
    await fill(address, variedUrl);
    await click("采集新内容");
    await frame.getByText(/本次采集 · 百度贴吧/).waitFor();
    assert.equal(await checkbox(threadTitle).count(), 1);
    assert.deepEqual(
      (await events("jianshu.collect")).map(({ args }) => args),
      [
        { provider: "tieba", url: canonicalUrl, limit: 1 },
        { provider: "tieba", url: canonicalUrl, limit: 1 },
        { provider: "tieba", url: variedUrl, limit: 1 },
      ],
    );
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.equal(await frame.locator("vite-error-overlay").count(), 0);
    await page.screenshot({
      path: join(evidence, "01-tieba-source-1440.png"),
      fullPage: true,
    });

    await frame
      .locator(".jianshu-source-row")
      .filter({ hasText: threadTitle })
      .getByRole("button", { name: "查看素材", exact: true })
      .dispatchEvent("click");
    const detail = frame.getByRole("dialog", { name: "来源素材", exact: true });
    await detail.waitFor();
    assert.equal(
      await detail
        .getByText("百度贴吧 · windows11吧 · 工具分享者", { exact: false })
        .isVisible(),
      true,
    );
    assert.equal(
      await detail.locator("time").getAttribute("datetime"),
      "2024-06-23T09:00:45.000Z",
    );
    assert.equal(
      await detail.locator(".jianshu-source-body").textContent(),
      "楼主整理了局域网打印机的共享方法。\n\n先打开工具，再选择要共享的打印机。",
    );
    assert.equal(
      await detail.getByText("2 张，可在原帖查看", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await detail.getByText("外部分享线索", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await detail.getByText("123云盘", { exact: false }).isVisible(),
      true,
    );
    assert.equal(await detail.getByRole("img").count(), 0);
    assert.equal(await detail.getByRole("link").count(), 0);
    assert.equal((await events("system.external")).length, 0);
    await page.screenshot({
      path: join(evidence, "02-tieba-details-1440.png"),
      fullPage: true,
    });
    await click("查看原文");
    assert.deepEqual(
      (await events("system.external")).map(({ args }) => args),
      [{ url: canonicalUrl }],
    );
    await click("关闭弹窗");
    await checkbox(threadTitle).dispatchEvent("click");
    assert.equal(await checkbox(oldTitle).isChecked(), true);
    await click("使用所选内容创作");
    await click("预览最终文章");
    const preview = await frame.locator(".jianshu-article-preview").innerText();
    assert.ok(preview.includes(canonicalUrl));
    assert.ok(!preview.includes("123pan.com"));
    assert.equal((await events("jianshu.generate")).length, 0);
    assert.deepEqual(pageErrors, []);
    await checkpoint();

    const result = {
      windowId,
      evidence,
      viewport: "1440×900",
      checks: [
        "来源选择、空网址禁用、明确的单帖 IPC 请求",
        "读取失败保留输入、分页、筛选与选择；重试后直接定位到结果",
        "同帖覆盖新旧列表视图时只渲染一行，原选择仍保留",
        "素材保留作者、发布时间、段落、图片引用与 123 云盘外部线索",
        "详情不加载图片或打开外部链接；明确查看原帖使用规范网址",
        "选入稿件后保留原帖出处，预览没有外部网盘入口",
      ],
    };
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } catch (error) {
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(evidence, "failure.txt"),
      String(error.stack || error),
    );
    throw error;
  } finally {
    await helper("cleanup").catch(() => {});
  }
}

/** Focused recovery check; PANXU_JIANSHU_QA_SCOPE=image-recovery skips the full workflow. */
async function runImageRecovery({ page, checkpoint, windowId }) {
  const evidence = await mkdtemp(
    join(tmpdir(), "panxu-jianshu-image-recovery-"),
  );
  console.log(JSON.stringify({ jianshuWindowId: windowId, evidence }));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-jianshu.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:60000});
  const frame = page.frameLocator('iframe[title="简书内容内存模拟页面"]');
  const main = frame.locator("main");
  const helper = (method, arg) =>
    main.evaluate(
      (_element, { method, arg }) => window.__jianshuQa[method](arg),
      { method, arg },
    );
  const button = (name) =>
    frame.getByRole("button", { name, exact: true }).filter({ visible: true });
  const click = (name) => button(name).dispatchEvent("click");
  const events = (method) =>
    helper("events").then((all) =>
      all.filter((event) => event.method === method),
    );
  const notice = frame.getByText(
    "上一张图片上传结果未确认，请先在官网检查。确认未上传后可允许重新上传。",
    { exact: true },
  );
  try {
    await frame
      .getByRole("heading", { name: "开始一篇文章", exact: true })
      .waitFor();
    const seeded = await helper("seedImageRecovery");
    await frame
      .getByRole("complementary", { name: "简书文章列表", exact: true })
      .getByRole("button", { name: seeded.title, exact: true })
      .dispatchEvent("click");
    await notice.waitFor();
    assert.equal(await button("继续填写原草稿").isEnabled(), false);
    const initialStats = await helper("prepareStats");
    await click("查看官网草稿");
    await button("确认图片未上传，返回重试").waitFor({ state: "visible" });
    assert.equal((await events("jianshu.prepare")).length, 0);
    assert.equal((await events("websiteAccounts.openDocument")).length, 1);
    assert.deepEqual((await events("websiteAccounts.openDocument"))[0].args, {
      id: seeded.accountId,
      url: seeded.editorUrl,
    });
    assert.deepEqual(await helper("prepareStats"), initialStats);
    await click("确认图片未上传，返回重试");
    await frame.getByRole("dialog").waitFor();
    assert.equal((await events("jianshu.resolve")).length, 0);
    await page.screenshot({
      path: join(evidence, "01-explicit-confirmation-1440.png"),
      fullPage: true,
    });
    await click("取消");
    await frame.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal((await events("jianshu.resolve")).length, 0);
    assert.equal(
      (await helper("latest")).preparedFill.pendingImageSha256,
      seeded.images[0].sha256,
    );

    await click("确认图片未上传，返回重试");
    await frame.getByRole("dialog").waitFor();
    await helper("remount");
    await notice.waitFor();
    await frame.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal((await events("jianshu.resolve")).length, 0);

    await click("确认图片未上传，返回重试");
    await frame.getByRole("dialog").waitFor();
    await helper("hold", "jianshu.resolve");
    await click("已检查，确认未上传");
    await button("正在确认…").waitFor();
    await button("正在确认…").dispatchEvent("click");
    assert.equal((await events("jianshu.resolve")).length, 1);
    assert.deepEqual((await events("jianshu.resolve"))[0].args, {
      id: seeded.id,
      revision: seeded.revision,
      notPublished: true,
      imageNotUploaded: true,
    });
    await helper("release");
    await frame.getByRole("dialog").waitFor({ state: "hidden" });
    await button("重新填写原草稿").waitFor();
    const restored = await helper("latest");
    assert.equal(restored.stage, "editing");
    assert.equal(restored.preparedFill.pendingImageSha256, null);
    assert.equal(restored.editorUrl, seeded.editorUrl);
    assert.equal(restored.preparedUid, seeded.preparedUid);
    assert.deepEqual(await helper("prepareStats"), initialStats);
    assert.equal(await button("确认图片未上传，返回重试").count(), 0);

    await click("重新填写原草稿");
    await button("查看已填写草稿").waitFor();
    assert.equal((await events("jianshu.prepare")).length, 1);
    const filled = await helper("latest");
    assert.equal(filled.stage, "prepared");
    assert.equal(filled.preparedFill.filled, true);
    assert.equal(filled.editorUrl, seeded.editorUrl);
    assert.deepEqual(await helper("prepareStats"), {
      draftCreations: 0,
      imageUploads: 1,
    });
    await click("查看已填写草稿");
    await button("查看已填写草稿").waitFor();
    assert.equal((await events("jianshu.prepare")).length, 1);
    assert.equal((await events("websiteAccounts.openDocument")).length, 2);
    assert.deepEqual(await helper("prepareStats"), {
      draftCreations: 0,
      imageUploads: 1,
    });
    await frame
      .getByText(
        "标题和正文已填写到官网草稿。配图已上传 1 / 1 张。请在简书检查排版和配图，并由你点击发布。",
        { exact: true },
      )
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "02-recovered-same-draft-1440.png"),
      fullPage: true,
    });
    const resolvesBefore = (await events("jianshu.resolve")).length;
    await click("改用新草稿");
    await frame
      .getByRole("dialog", { name: "改用新的官网草稿", exact: true })
      .waitFor();
    assert.equal((await events("jianshu.resolve")).length, resolvesBefore);
    await page.screenshot({path:join(evidence,"03-new-draft-confirm-1440.png"),fullPage:true});
    await click("取消");
    await button("查看已填写草稿").waitFor();
    assert.equal((await events("jianshu.resolve")).length, resolvesBefore);
    await click("改用新草稿");
    await frame
      .getByRole("dialog", { name: "改用新的官网草稿", exact: true })
      .waitFor();
    await click("确认未发布，改用新草稿");
    await button("填写到简书").waitFor();
    const changed = (await events("jianshu.resolve")).at(-1);
    assert.equal(changed.args.newDraft, true);
    assert.equal(changed.args.notPublished, true);
    assert.equal(
      (await events("jianshu.prepare")).length,
      1,
      "解除关联不自动创建或填写",
    );
    assert.equal(
      (await frame.getByLabel("简书文章正文", { exact: true }).inputValue()).length > 0,
      true,
      "解除关联保留本地正文",
    );
    await checkpoint();
    const result = {
      windowId,
      evidence,
      checks: [
        "结果未知时禁止直接重传，可通过原账号只读打开官网草稿",
        "二次确认前及取消、重新挂载后不清上传状态；确认双击只提交一次显式 imageNotUploaded",
        "确认只解除限制，显式重试复用同稿上传一次；完成后查看只调用 openDocument，不再次 prepare 或上传",
        "改用新草稿须明确二次确认；取消不解除关联，确认后保留本地正文且不自动创建",
      ],
      limitation:
        "独立 iframe 内存 IPC 验证恢复交互，不调用真实上传、账号或发布。",
    };
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } catch (error) {
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await helper("cleanup").catch(() => {});
  }
}
