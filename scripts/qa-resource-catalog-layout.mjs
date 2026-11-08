import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Use with test:session. All real-data operations are read-only; mutations below
// run only inside a source fixture iframe without Electron preload or live IPC.
export async function run({ page, checkpoint, windowId }) {
  console.log(JSON.stringify({ windowId }));
  const evidence = resolve("test-results/resource-catalog-layout");
  await mkdir(evidence, { recursive: true });
  const screenshot = async (name) =>
    page.screenshot({ path: resolve(evidence, `${name}.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".catalog-preview").waitFor();
  const geometry = async (root) =>
    root.locator(".catalog-page").evaluate((el) => {
      const doc = el.ownerDocument;
      const rect = (selector) =>
        doc.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        index: rect(".catalog-index"),
        header: rect(".catalog-detail-header"),
        toolbar: rect(".catalog-preview-toolbar"),
        table: rect(".catalog-resource-table"),
        mainScroll: doc.querySelector("main").scrollTop,
        pageOverflow:
          doc.querySelector("main").scrollHeight -
          doc.querySelector("main").clientHeight,
        horizontalOverflow: el.scrollWidth - el.clientWidth,
      };
    });
  const verifyScroll = async (root) => {
    const before = await geometry(root);
    assert.ok(
      before.pageOverflow <= 1,
      `outer page overflow: ${before.pageOverflow}`,
    );
    assert.ok(before.horizontalOverflow <= 1);
    assert.ok(
      before.toolbar.top - before.index.top < 105,
      "content header uses too much height",
    );
    const moved = await root
      .locator(".catalog-preview-scroll")
      .evaluate((el) => {
        el.scrollTop = 500;
        return el.scrollTop;
      });
    assert.ok(moved > 200, "resource list must scroll");
    const after = await geometry(root);
    assert.equal(after.mainScroll, before.mainScroll);
    assert.equal(after.index.top, before.index.top);
    assert.equal(after.header.top, before.header.top);
    assert.equal(after.toolbar.top, before.toolbar.top);
    const sticky = await root
      .locator(".catalog-resource-table th")
      .first()
      .boundingBox();
    assert.ok(sticky.y >= before.toolbar.bottom - 1);
    await root
      .locator(".catalog-preview-scroll")
      .evaluate((el) => (el.scrollTop = 0));
    return before;
  };
  const verifyBorders = async (root) => {
    const missing = await root
      .locator(".catalog-page button")
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => button.getClientRects().length)
          .filter((button) => {
            const s = getComputedStyle(button);
            return (
              parseFloat(s.borderTopWidth) < 1 ||
              s.borderTopStyle === "none" ||
              s.borderTopColor === "rgba(0, 0, 0, 0)"
            );
          })
          .map(
            (button) => button.textContent || button.getAttribute("aria-label"),
          ),
      );
    assert.deepEqual(missing, []);
  };
  const actual = await verifyScroll(page);
  await verifyBorders(page);
  await screenshot("actual-1440");
  const origin = new URL(page.url()).origin;
  // An iframe has no Electron preload. This isolates the existing in-memory
  // fixture while the enclosing test window retains its exact managed ID.
  const fixture = async (scenario = "normal") => {
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style><iframe title="资源清单隔离界面" src="${origin}/__qa-resource-catalog.html?controls=0&scenario=${scenario}"></iframe>`,
    );
    const root = page.frameLocator("iframe");
    await root.locator(".catalog-page").waitFor();
    return root;
  };
  let root = await fixture();
  await root.locator(".catalog-preview").waitFor();
  await verifyScroll(root);
  await verifyBorders(root);
  const search = root.getByRole("searchbox", {
    name: "搜索清单资源",
    exact: true,
  });
  await search.fill("听力");
  assert.equal(
    await root.locator(".catalog-resource-table tbody tr").count(),
    3,
  );
  assert.ok(
    (await root.locator(".catalog-preview-toolbar").innerText()).includes(
      "3 / 26",
    ),
  );
  await search.focus();
  const focus = await root
    .locator(".catalog-preview-actions .input-frame")
    .evaluate((el) => ({
      outline: getComputedStyle(el).outlineColor,
      color: getComputedStyle(el.querySelector("input")).outlineStyle,
    }));
  assert.notEqual(focus.outline, "rgba(0, 0, 0, 0)");
  assert.equal(focus.color, "none", "only compound outer frame draws focus");
  await root
    .locator(".catalog-preview-actions")
    .getByRole("button", { name: "清空搜索" })
    .click();
  assert.equal(await search.inputValue(), "");
  assert.equal(
    await root.locator(".catalog-resource-table tbody tr").count(),
    20,
  );
  await root
    .getByRole("checkbox", { name: "选择本页资源", exact: true })
    .check();
  await root
    .locator(".catalog-preview-scroll")
    .evaluate((el) => (el.scrollTop = 500));
  await root.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(
    await root
      .locator(".catalog-preview-scroll")
      .evaluate((el) => el.scrollTop),
    0,
  );
  assert.equal(
    await root.locator(".catalog-resource-table tbody tr").count(),
    6,
  );
  await root
    .getByRole("checkbox", { name: "选择本页资源", exact: true })
    .check();
  await root
    .getByRole("button", { name: "删除所选（26）", exact: true })
    .click();
  await root
    .getByRole("heading", { name: "清单暂无可发布资源", exact: true })
    .waitFor();
  await root.getByRole("button", { name: "撤销删除", exact: true }).click();
  await root.locator(".catalog-resource-table").waitFor();
  await root.getByRole("button", { name: "上一页", exact: true }).click();
  await screenshot("fixture-1440");
  await page.setViewportSize({ width: 1366, height: 768 });
  await verifyScroll(root);
  await verifyBorders(root);
  await screenshot("fixture-1366");
  await root.getByRole("tab", { name: "落地页站点", exact: true }).click();
  await root
    .getByRole("heading", { name: "落地页站点", exact: true })
    .waitFor();
  await verifyBorders(root);
  await root
    .getByRole("tab", { name: "文档平台 · 待更新", exact: true })
    .click();
  await root.getByRole("heading", { name: "发布交接", exact: true }).waitFor();
  await verifyBorders(root);
  const tabs = await root
    .locator(".catalog-workspace-tabs")
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  assert.ok(tabs <= 1, "publishing tabs must scroll inside the content pane");
  // Long left indexes scroll internally without moving their search or title.
  root = await fixture("many-catalogs");
  await root.locator(".catalog-preview").waitFor();
  const left = await root
    .getByRole("searchbox", { name: "搜索清单", exact: true })
    .boundingBox();
  const moved = await root.locator(".catalog-index-list").evaluate((el) => {
    el.scrollTop = 600;
    return el.scrollTop;
  });
  assert.ok(moved > 200);
  assert.equal(
    (
      await root
        .getByRole("searchbox", { name: "搜索清单", exact: true })
        .boundingBox()
    ).y,
    left.y,
  );
  await root
    .getByRole("searchbox", { name: "搜索清单", exact: true })
    .fill("不存在的清单");
  await root
    .getByRole("heading", { name: "没有匹配的清单", exact: true })
    .waitFor();
  await verifyBorders(root);
  await checkpoint();
  return {
    windowId,
    actual,
    evidence,
    checks: [
      "independent scroll",
      "sticky index and toolbar",
      "bordered buttons",
      "search and focus",
      "pagination and selection",
      "fixture delete and undo",
      "empty state",
      "long index",
      "1440×900 and 1366×768",
    ],
    realData: "read-only",
  };
}
