import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function run({ page, windowId, checkpoint }) {
  const out = `/tmp/panxu-publishing-workflow/${windowId}`;
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      body = await response.text();
    const next =
      'import { publishingMock } from "/scripts/qa-zhidao-publishing-mock.mjs";\n' +
      body.replace(
        /return window\.panxu\.invoke[^;]+;/,
        "return publishingMock(method,args);",
      );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: next,
      contentType: "application/javascript",
    });
  });
  await page.reload();
  const read = () =>
    page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("zhidao-publishing-qa")),
    );
  const find = (state, title) =>
    Object.values(state.records).find(
      (record) => record.resource.title === title,
    );
  const button = (name) => page.getByRole("button", { name, exact: true });
  const next = (name) => button(`下一步：${name}`);
  const firstQuestion = page.getByLabel("第1条问题标题", { exact: true });
  const firstAnswer = page.getByLabel("第1条回答内容", { exact: true });
  const confirm = () =>
    page
      .getByRole("button", { name: "确认并保存本份问答", exact: true })
      .click();
  try {
    await page
      .getByRole("heading", { name: "问答发布", exact: true })
      .waitFor();
    const heading = await page
      .locator(".publishing-workflow-heading")
      .boundingBox();
    assert.ok(heading.height <= 40, `页头高度${heading.height}`);
    await page
      .getByRole("combobox", { name: "搜索资源库", exact: true })
      .fill("办公");
    await page
      .getByRole("option", { name: "办公表格练习 · 效率办公", exact: true })
      .click();
    await button("录入库外资源").click();
    await page.getByLabel("第2行名称", { exact: true }).evaluate((node) => {
      const data = new DataTransfer();
      data.setData(
        "text/plain",
        "预算整理练习\thttps://pan.baidu.com/s/budget\t效率办公\t包含月度预算表和核对清单，适用于日常账目整理。",
      );
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(
      await page.getByLabel("第2行链接", { exact: true }).inputValue(),
      "https://pan.baidu.com/s/budget",
    );
    await next("检查关键词").click();
    await page.getByText(/已跳过重复检查/).waitFor();
    assert.equal(await page.locator(".publishing-saved-words li").count(), 2);
    await page.getByRole("button", { name: /2\. 预算整理练习/ }).click();
    await page.getByLabel("搜索词", { exact: true }).fill("预算整理");
    await button("检索流量词").click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="候选关键词"]')
        .value.includes("预算表格练习"),
    );
    await page
      .getByLabel("候选关键词", { exact: true })
      .fill(
        Array.from({ length: 25 }, (_, i) => `预算整理主题${i + 1}`).join("\n"),
      );
    await button("确认这份资源的关键词").click();
    await page.evaluate(() => {
      window.__publishingGenerationFail = true;
    });
    await next("AI 生成问答").click();
    await page
      .locator(".publishing-review-panel")
      .getByText(/模型连接中断/)
      .waitFor();
    assert.equal(
      (await read()).calls.filter((call) => /prepare|shares/.test(call.method))
        .length,
      0,
    );
    await page.evaluate(() => {
      window.__publishingGenerationFail = false;
    });
    await button("上一步").click();
    await next("AI 生成问答").click();
    await firstQuestion.waitFor();
    const generated = await read();
    assert.equal(find(generated, "预算整理练习").rows.length, 20);
    assert.equal(
      generated.calls.filter((call) => /prepare|shares/.test(call.method))
        .length,
      0,
    );
    assert.equal(await next("转存与独立链接").isDisabled(), true);
    assert.ok(!(await firstAnswer.inputValue()).includes("https://"));
    await button("预览问答").click();
    await page
      .getByRole("dialog")
      .getByText(/介绍确认后再准备独立链接/)
      .waitFor();
    assert.equal(
      await page
        .getByRole("dialog")
        .locator(".publishing-preview-share")
        .count(),
      0,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await page.getByRole("button", { name: /2\. 预算整理练习/ }).click();
    const budgetInitial = find(await read(), "预算整理练习");
    await button("下移第1条问答").click();
    await button("移除第1条问答").click();
    await button("撤销移除").waitFor();
    await button("撤销移除").click();
    await button("移除第1条问答").click();
    await firstQuestion.fill("题".repeat(50));
    assert.equal(await button("确认并保存本份问答").isDisabled(), true);
    const title = "预算整理材料的百度网盘地址在哪？";
    await firstQuestion.fill(title);
    await page.screenshot({ path: `${out}/03-content-review.png` });
    await checkpoint();
    await page.reload();
    await firstQuestion.waitFor();
    assert.equal(await firstQuestion.inputValue(), title);
    assert.equal(
      (await read()).calls.filter(
        (call) => call.method === "zhidao.workflow.generateMany",
      ).length,
      2,
      "刷新不得自动付费",
    );
    await confirm();
    await page.waitForFunction(() =>
      Object.values(
        JSON.parse(sessionStorage.getItem("zhidao-publishing-qa")).records,
      )
        .find((r) => r.resource.title === "预算整理练习")
        .rows.every((r) => r.reviewed),
    );
    assert.equal(find(await read(), "预算整理练习").rows.length, 19);
    assert.equal(
      await button("撤销移除").count(),
      0,
      "确认保存后不能撤销已提交的删行",
    );
    assert.equal(
      find(await read(), "预算整理练习").rows[0].id,
      budgetInitial.rows[0].id,
    );
    await page.getByRole("button", { name: /1\. 办公表格练习/ }).click();
    await confirm();
    await next("转存与独立链接").waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector(".publishing-workflow-footer button:last-child")
          .disabled,
    );
    await next("转存与独立链接").click();
    assert.equal(await page.getByRole("checkbox").count(), 0, "不增加二次确认");
    await page
      .getByRole("combobox", { name: "库外资源转存到", exact: true })
      .click();
    await page
      .getByRole("option", { name: "百度资料账号", exact: true })
      .click();
    const office = page
      .locator(".publishing-preparation-row")
      .filter({ hasText: "办公表格练习" });
    const budget = page
      .locator(".publishing-preparation-row")
      .filter({ hasText: "预算整理练习" });
    await page.evaluate(() => {
      window.__publishingHoldShares = true;
    });
    await button("准备所有待处理资源").click();
    await page.getByText("正在创建第2条分享", { exact: true }).waitFor();
    await button("停止准备").click();
    await page.getByText("已暂停，已完成的分享保留", { exact: true }).waitFor();
    const paused = find(await read(), "办公表格练习");
    assert.equal(paused.links.length, 1);
    await button("准备所有待处理资源").click();
    await office
      .getByRole("button", { name: "分享已准备", exact: true })
      .waitFor();
    await budget
      .getByRole("button", { name: "转存进行中", exact: true })
      .waitFor();
    assert.equal(await next("预览与下载").isDisabled(), true);
    await page.evaluate(() => {
      window.__publishingTransferComplete = true;
    });
    await budget
      .getByRole("button", { name: "分享已准备", exact: true })
      .waitFor();
    const ready = await read(),
      officeReady = find(ready, "办公表格练习"),
      budgetReady = find(ready, "预算整理练习");
    assert.equal(officeReady.links.length, 2);
    assert.equal(budgetReady.links.length, 19);
    assert.deepEqual(officeReady.links[0], paused.links[0]);
    assert.equal(
      new Set(
        [...officeReady.links, ...budgetReady.links].map((link) => link.url),
      ).size,
      21,
    );
    assert.equal(
      ready.calls.filter((call) => call.method === "zhidao.workflow.prepare")
        .length,
      3,
    );
    await page.screenshot({ path: `${out}/04-independent-links.png` });
    // Edits and reordering retain the fixed question identity -> URL relationship.
    await button("上一步").click();
    await button("下移第1条问答").click();
    await confirm();
    await page.waitForFunction(
      () =>
        !document.querySelector(".publishing-workflow-footer button:last-child")
          .disabled,
    );
    const edited = find(await read(), "办公表格练习");
    assert.deepEqual(edited.rowShares, officeReady.rowShares);
    assert.deepEqual(
      edited.rows.map((row) => row.id),
      officeReady.rows.map((row) => row.id).reverse(),
    );
    await next("转存与独立链接").click();
    assert.equal(await button("准备所有待处理资源").isDisabled(), true);
    await next("预览与下载").click();
    await button("预览完整问答").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/每条问答一个独立链接/).waitFor();
    assert.ok((await dialog.locator(".publishing-preview-share").count()) > 0);
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await button("下载已审核表格").click();
    await page
      .getByText("表格已保存：/tmp/百度知道问答.xlsx", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: `${out}/05-download-1366.png` });
    const rect = await button("下载已审核表格").boundingBox();
    assert.ok(rect.x + rect.width <= 1366);
    const calls = (await read()).calls.length;
    await page.reload();
    await button("下载已审核表格").waitFor();
    assert.equal((await read()).calls.length, calls, "恢复不重建链接或重跑AI");
    assert.deepEqual(errors, []);
    return {
      out,
      checks: [
        "五步内容优先",
        "最多20条",
        "检查与刷新恢复",
        "删减撤销排序",
        "未确认禁止建链",
        "按实际N条建链",
        "暂停恢复不重复",
        "固定ID防串链",
        "完整预览与下载",
        "1440与1366桌面视觉",
      ],
    };
  } catch (error) {
    await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
    console.error(JSON.stringify({ out, errors }));
    throw error;
  }
}
