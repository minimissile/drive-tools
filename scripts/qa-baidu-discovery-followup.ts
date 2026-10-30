import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import type { DiscoveryRun, DiscoverySummary } from "../shared/baidu-discovery";

// Continue only the task created by qa-baidu-discovery, using this run's own workbench window.
export async function run({ page, checkpoint }: any) {
  const evidence = "/tmp/panxu-baidu-discovery-qa";
  const original: DiscoveryRun = JSON.parse(
    await readFile(`${evidence}/live-result.json`, "utf8"),
  );
  await page.addInitScript("window.__name=fn=>fn");
  await page.evaluate("window.__name=fn=>fn");
  await page.setViewportSize({ width: 1366, height: 768 });
  const invoke = (method: string, args?: unknown) =>
    page.evaluate(
      ({ method, args }: any) => window.panxu!.invoke(method, args),
      { method, args },
    );
  const settle = async (id: string) => {
    let latest: DiscoveryRun = await invoke("baiduDiscovery.get", { id });
    const deadline = Date.now() + 100000;
    while (latest.status === "running" && Date.now() < deadline) {
      await checkpoint();
      await new Promise((resolve) => setTimeout(resolve, 600));
      latest = await invoke("baiduDiscovery.get", { id });
    }
    if (latest.status === "running")
      latest = await invoke("baiduDiscovery.pause", { id });
    return latest;
  };
  await page
    .getByRole("heading", { name: "百度批量扩词", exact: true })
    .waitFor();
  await page.getByLabel("选择采词任务").waitFor();
  if (
    (await page.getByLabel("选择采词任务").getAttribute("data-value")) !==
    original.id
  ) {
    await page.getByLabel("选择采词任务").click();
    await page.locator(`[role=option][data-value="${original.id}"]`).click();
  }
  const word = original.words.find(
    (word) => !original.queries.some((query) => query.word === word.word),
  )!;
  await page.getByLabel("筛选采集关键词", { exact: true }).fill(word.word);
  await page.getByLabel(`选择关键词 ${word.word}`, { exact: true }).check();
  await page
    .getByRole("button", { name: "所选词继续扩词", exact: true })
    .click();
  let expanded = await settle(original.id);
  assert.equal(expanded.status, "completed", expanded.message);
  assert.equal(expanded.queries.length, original.queries.length + 1);
  assert.ok(expanded.words.length >= original.words.length);
  assert.ok(
    expanded.words.some((word) =>
      word.origins.some((origin) => origin.depth === 2),
    ),
  );
  await page.getByLabel("筛选采集关键词", { exact: true }).fill("");
  await page.getByText(`已处理 3 / 3 个查询词`, { exact: false }).waitFor();
  await page
    .getByRole("heading", { name: "去重关键词", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/results-1366.png` });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 2 /", { exact: false }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("heading", { name: "去重关键词", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/results-1440.png` });
  await invoke("baiduDiscovery.closeBrowser");
  // A bounded automatic expansion makes exactly two keyword requests, using suggestions only.
  const before: DiscoverySummary[] = await invoke("baiduDiscovery.list");
  await page.getByLabel("初始关键词", { exact: true }).fill("画竹子教程");
  await page.getByLabel("相关搜索词", { exact: true }).uncheck();
  await page.getByLabel("自动继续扩词", { exact: true }).check();
  await page.getByLabel("查询词上限", { exact: true }).fill("2");
  await page.getByRole("button", { name: "开始采集", exact: true }).click();
  let autoId = "";
  while (!autoId) {
    await checkpoint();
    const list: DiscoverySummary[] = await invoke("baiduDiscovery.list");
    autoId =
      list.find((item) => !before.some((old) => old.id === item.id))?.id || "";
    if (!autoId) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const automatic = await settle(autoId);
  assert.equal(automatic.status, "completed", automatic.message);
  assert.equal(automatic.queries.length, 2);
  assert.equal(automatic.limited, true);
  assert.ok(
    automatic.words.some((word) =>
      word.origins.some((origin) => origin.depth === 2),
    ),
  );
  await writeFile(
    `${evidence}/followup.json`,
    JSON.stringify({ expanded, automatic }, null, 2),
  );
  await invoke("baiduDiscovery.closeBrowser");
  // Leave the richer task selected for native save-dialog verification and user review.
  await page.getByLabel("选择采词任务").click();
  await page.locator(`[role=option][data-value="${original.id}"]`).click();
  await page
    .getByRole("heading", { name: "去重关键词", exact: true })
    .scrollIntoViewIfNeeded();
  return {
    manual: { queries: expanded.queries.length, words: expanded.words.length },
    automatic: {
      queries: automatic.queries.length,
      words: automatic.words.length,
      limited: automatic.limited,
    },
    evidence,
  };
}
