import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { devSessionRequest } from "./dev-session-client.mjs";

export async function run({ page, windowId }) {
  const out = `/tmp/panxu-link-types/${windowId}`;
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
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
  const original = await page.evaluate(async () => {
    const snapshot = await window.panxu.invoke("snapshot"),
      path = snapshot.dataPath + "/publishing-qa",
      id = crypto.randomUUID(),
      rowId = crypto.randomUUID();
    const resource = {
      key: id,
      resourceId: "qa-office",
      copyId: "qa-copy",
      title: "办公表格练习",
      link: "https://pan.baidu.com/s/office",
      category: "效率办公",
      summary: "包含表格整理和月报核对练习，适用于掌握基础公式的读者。",
      keywords: ["办公表格练习"],
    };
    const share = { url: "https://pan.baidu.com/s/qa-drive", code: "abcd" };
    const record = {
      id,
      resource,
      copyId: "qa-copy",
      libraryResourceId: "qa-office",
      accountId: "qa-drive",
      stage: "ready",
      contentFirst: true,
      linkedAnswerFormat: true,
      operations: [],
      links: [share],
      rowShares: { [rowId]: share },
      generation: {
        id: crypto.randomUUID(),
        status: "completed",
        targets: [],
        drafts: [],
      },
      rows: [
        {
          id: rowId,
          keyword: "办公表格练习",
          relatedKeywords: [],
          question: "办公表格练习的百度网盘链接在哪？",
          answer:
            "<p>这些办公练习包含表格整理和月报核对，适合已经掌握基础公式的读者。</p>",
          reviewed: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(
      "zhidao-publishing-qa",
      JSON.stringify({ records: { [id]: record }, calls: [] }),
    );
    const draft = {
      flowVersion: 2,
      step: 4,
      accountId: "",
      activeKey: id,
      rows: [
        {
          ...resource,
          keywords: { seeds: "办公表格练习", text: "办公表格练习" },
          image: "",
          checked: true,
          prepared: true,
        },
      ],
      pendingReviews: [],
      reviewVersions: {},
      keywordBatchId: "",
      keywordBatchApplied: [],
    };
    localStorage.setItem(
      `panxu-window:${encodeURIComponent(window.panxu.windowId)}:panxu-zhidao-publishing-workflow:${path}`,
      JSON.stringify(draft),
    );
    return record;
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const choose = async (label) => {
    await devSessionRequest("dev.session.focus", { id: windowId });
    await page
      .getByRole("combobox", { name: "回答中的链接", exact: true })
      .click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  const preview = async (url) => {
    await button("预览完整问答").click();
    const dialog = page.getByRole("dialog");
    assert.equal(
      (await dialog.locator(".publishing-preview-share").textContent()).trim(),
      url,
    );
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  };
  const read = () =>
    page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("zhidao-publishing-qa")),
    );
  try {
    await page.reload();
    await page
      .getByRole("combobox", { name: "回答中的链接", exact: true })
      .waitFor();
    assert.equal(
      await button("管理知道账号").count(),
      1,
      "发布页仅保留页头的账号管理入口",
    );
    await choose("资源落地页");
    await preview("https://panxu.site/r/qa-office");
    await button("下载已审核表格").click();
    assert.equal(
      (await read()).calls
        .filter((c) => c.method === "zhidao.workflow.export")
        .at(-1).args.linkType,
      "landing",
    );
    await page.reload();
    await page
      .getByRole("combobox", { name: "回答中的链接", exact: true })
      .waitFor();
    assert.match(
      await page
        .getByRole("combobox", { name: "回答中的链接", exact: true })
        .textContent(),
      /资源落地页/,
    );
    await choose("直达链接");
    await preview("https://panxu.site/go/qa-office");
    await page.evaluate(() => {
      const state = JSON.parse(sessionStorage.getItem("zhidao-publishing-qa"));
      state.publicUnavailable = true;
      sessionStorage.setItem("zhidao-publishing-qa", JSON.stringify(state));
    });
    await page.reload();
    await button("去资源库维护入口").waitFor();
    assert.equal(await button("上传1条问答").isDisabled(), true);
    assert.equal(await button("下载已审核表格").isDisabled(), true);
    await page.screenshot({ path: `${out}/unavailable.png` });
    await page.evaluate(() => {
      const state = JSON.parse(sessionStorage.getItem("zhidao-publishing-qa"));
      state.publicUnavailable = false;
      const record = Object.values(state.records)[0],
        id = crypto.randomUUID(),
        share = { url: "https://pan.baidu.com/s/qa-second", code: "efgh" };
      record.rows.push({
        ...record.rows[0],
        id,
        question: "月报练习的百度网盘链接在哪？",
      });
      record.links.push(share);
      record.rowShares[id] = share;
      sessionStorage.setItem("zhidao-publishing-qa", JSON.stringify(state));
    });
    await page.reload();
    await button("上传2条问答").waitFor();
    assert.equal(
      await page
        .getByRole("combobox", { name: "回答中的链接", exact: true })
        .count(),
      0,
    );
    await button("下载已审核表格").click();
    assert.equal(
      (await read()).calls
        .filter((c) => c.method === "zhidao.workflow.export")
        .at(-1).args.linkType,
      "drive",
    );
    await page.evaluate((record) => {
      const state = JSON.parse(sessionStorage.getItem("zhidao-publishing-qa"));
      state.records[record.id] = record;
      sessionStorage.setItem("zhidao-publishing-qa", JSON.stringify(state));
    }, original);
    await page.reload();
    await page
      .getByRole("combobox", { name: "回答中的链接", exact: true })
      .waitFor();
    await page
      .getByRole("combobox", { name: "百度知道发布账号", exact: true })
      .click();
    await page
      .getByRole("option", { name: "资料答主 · 主账号", exact: true })
      .click();
    await page.screenshot({ path: `${out}/single-redirect.png` });
    await button("上传1条问答").click();
    await page.getByText("上传已完成", { exact: true }).waitFor();
    assert.equal(
      (await read()).calls
        .filter((c) => c.method === "zhidao.workflow.publish")
        .at(-1).args.linkType,
      "redirect",
    );
    await preview("https://panxu.site/go/qa-office");
    await page.reload();
    await page.getByText("上传已完成", { exact: true }).waitFor();
    assert.equal(
      (await read()).calls.filter((c) => c.method === "zhidao.workflow.publish")
        .length,
      1,
    );
    assert.deepEqual(errors, []);
    return {
      out,
      checks: [
        "单条三种链接",
        "预览与下载一致",
        "刷新保留类型",
        "入口不可用阻止提交",
        "多条隐藏选择并使用网盘",
        "上传与已提交预览一致",
        "刷新不重发",
      ],
    };
  } catch (error) {
    await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
    console.error(JSON.stringify({ out, errors }));
    throw error;
  }
}
