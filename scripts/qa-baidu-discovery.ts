import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import type { DiscoveryRun, DiscoverySummary } from "../shared/baidu-discovery";

// Browser plugin not available. Use the project's authorized, window-scoped Electron session.
export async function run({ page, checkpoint }: any) {
  const evidence = "/tmp/panxu-baidu-discovery-qa";
  await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  await page.addInitScript("window.__name = fn => fn;");
  await page.evaluate("window.__name = fn => fn;");
  await page.setViewportSize({ width: 1366, height: 768 });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const invoke = (method: string, args?: unknown) =>
    page.evaluate(
      ({ method, args }: any) => window.panxu!.invoke(method, args),
      { method, args },
    );
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.locator('[data-workbench-entry="baidu-discovery"]').click();
  await page
    .getByRole("heading", { name: "百度批量扩词", exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/initial.png` });
  // Exercise DOM extraction in this test window only. No shared network interception.
  const parser = await page.evaluate(async () => {
    const modulePath = "/core/baidu-discovery-page.ts";
    const module = await import(/* @vite-ignore */ modulePath);
    const inspect = module.inspectBaiduRelated.toString();
    const check = async (html: string) => {
      const frame = document.createElement("iframe");
      frame.srcdoc =
        html +
        `<script>window.__qaRelated = (() => {const __name = fn => fn;return (${inspect})()})();</script>`;
      document.body.append(frame);
      try {
        await new Promise<void>((resolve) => {
          frame.onload = () => resolve();
        });
        return (frame.contentWindow as unknown as { __qaRelated: unknown })
          .__qaRelated;
      } finally {
        frame.remove();
      }
    };
    return {
      legacy: await check(
        '<div><a href="https://www.baidu.com/s?wd=干扰">外部干扰</a></div><div id="rs"><h3>相关搜索</h3><a href="https://www.baidu.com/s?wd=竹子画法">竹子画法</a><a href="https://www.baidu.com/s?wd=竹子画法">竹子画法</a></div>',
      ),
      modern: await check(
        '<section><header><h2>相关搜索</h2></header><div><a href="https://www.baidu.com/s?wd=国画入门">国画入门</a></div></section>',
      ),
      missing: await check(
        '<div><a href="https://www.baidu.com/s?wd=普通结果">普通结果</a></div>',
      ),
      verification: await check(
        "<title>百度安全验证</title><div>请完成验证</div>",
      ),
    };
  });
  assert.deepEqual(parser.legacy.words, ["竹子画法"]);
  assert.deepEqual(parser.modern.words, ["国画入门"]);
  assert.equal(parser.missing.kind, "missing");
  assert.equal(parser.verification.kind, "verification");
  await page
    .getByLabel("初始关键词", { exact: true })
    .fill("画竹子教程\n水墨画入门\n画竹子教程");
  await page.getByLabel("查询词上限", { exact: true }).fill("20");
  await page.getByText("已去重 2 个", { exact: false }).waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "百度批量扩词", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("初始关键词", { exact: true }).inputValue(),
    "画竹子教程\n水墨画入门\n画竹子教程",
  );
  const before: DiscoverySummary[] = await invoke("baiduDiscovery.list");
  assert.ok(
    !before.some((run) => run.status === "running"),
    "有其他采词任务运行时不启动真实采集",
  );
  await page.getByRole("button", { name: "开始采集", exact: true }).click();
  let runId = "";
  for (let i = 0; i < 30 && !runId; i++) {
    await checkpoint();
    const list: DiscoverySummary[] = await invoke("baiduDiscovery.list");
    runId =
      list.find((run) => !before.some((old) => old.id === run.id))?.id || "";
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(runId, "开始采集创建持久任务");
  let run: DiscoveryRun = await invoke("baiduDiscovery.get", { id: runId });
  const deadline = Date.now() + 125000;
  while (run.status === "running" && Date.now() < deadline) {
    await checkpoint();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run = await invoke("baiduDiscovery.get", { id: runId });
  }
  if (run.status === "running") {
    await invoke("baiduDiscovery.pause", { id: runId });
    run = await invoke("baiduDiscovery.get", { id: runId });
  }
  assert.equal(run.status, "completed", run.message);
  await page
    .getByRole("heading", { name: "去重关键词", exact: true })
    .waitFor();
  await page.screenshot({
    path: `${evidence}/live-result.png`,
    fullPage: true,
  });
  await writeFile(`${evidence}/live-result.json`, JSON.stringify(run, null, 2));
  const csv: string | undefined = run.words.length
    ? await page.evaluate(
        async ({ id }: any) => {
          // Export dialog remains native; bytes are separately exercised in unit tests.
          const run = await window.panxu!.invoke<DiscoveryRun>(
            "baiduDiscovery.get",
            { id },
          );
          return run.words.map((word) => word.word).join("\n");
        },
        { id: runId },
      )
    : undefined;
  if (run.words.length) {
    const first = run.words[0];
    await page.getByLabel("筛选采集关键词", { exact: true }).fill(first.word);
    await page
      .getByRole("cell", { name: first.word, exact: true })
      .first()
      .waitFor();
    await page.getByLabel(`选择关键词 ${first.word}`, { exact: true }).check();
    await page
      .getByLabel("筛选采集关键词", { exact: true })
      .fill("不存在的测试筛选词XY123");
    await page
      .getByRole("heading", { name: "没有符合筛选条件的词", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await page.reload();
    await page
      .getByRole("heading", { name: "去重关键词", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByLabel(`选择关键词 ${first.word}`, { exact: true })
        .isChecked(),
      true,
    );
  }
  assert.deepEqual(errors, []);
  await invoke("baiduDiscovery.closeBrowser");
  return {
    checks: [
      "工作台入口",
      "表单刷新恢复",
      "DOM模块识别与验证页识别",
      "真实内置浏览器采集",
      "筛选与跨刷新选择恢复",
    ],
    live: {
      id: runId,
      status: run.status,
      words: run.words.length,
      queries: run.queries.length,
      message: run.message,
      exportable: !!csv,
    },
    evidence,
  };
}
