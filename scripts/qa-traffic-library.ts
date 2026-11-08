import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Run with test:session against the existing dev backend. All business reads are
// local; this check never submits queries, creates pools, or exports user data.
export async function run({ page, windowId }: any) {
  const output = "/tmp/panxu-traffic-library-qa";
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await page.getByRole("heading", { name: "流量词库", exact: true }).waitFor();
  assert.equal(
    await nav.getByRole("button", { name: "流量发现", exact: true }).count(),
    0,
  );
  const tabs = page.getByRole("tablist", { name: "流量词库功能", exact: true });
  assert.deepEqual(await tabs.getByRole("tab").allTextContents(), [
    "关键词库",
    "我的词池",
    "5118找词",
    "百度营销",
    "找热点",
  ]);
  await tabs.getByRole("tab", { name: "关键词库", selected: true }).waitFor();
  await page.screenshot({ path: join(output, "traffic-1440.png") });

  await tabs.getByRole("tab", { name: "百度营销", exact: true }).click();
  await page
    .getByText("单次最多返回3000词 · 月搜索量至少10自动入库", { exact: true })
    .waitFor();
  await tabs.getByRole("tab", { name: "关键词库", exact: true }).click();
  await page.getByRole("heading", { name: "关键词库", exact: true }).waitFor();
  await page.getByLabel("词库来源", { exact: true }).click();
  await page
    .getByRole("option", { name: "百度批量扩词", exact: true })
    .waitFor();
  // Only inspect the source option: the running backend may still predate the
  // staged storage migration and precise per-entry history contract.
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(output, "knowledge-1440.png") });

  await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
  const settingsNav = page.getByRole("navigation", {
    name: "设置分区",
    exact: true,
  });
  await settingsNav
    .getByRole("link", { name: "调用与费用", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "settings-costs",
  );
  const costs = page.getByRole("region", { name: "调用与费用", exact: true });
  await costs.getByText("5118累计外部请求", { exact: false }).waitFor();
  await costs.getByText("AI累计生成请求", { exact: false }).waitFor();
  await costs
    .getByRole("heading", { name: "最近500笔调用记录", exact: true })
    .waitFor();
  await costs
    .getByRole("button", { name: "导出全部CSV", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: join(output, "costs-1440.png") });
  await costs
    .getByRole("button", { name: "接口与套餐设置", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "settings-traffic",
  );
  await settingsNav
    .getByRole("link", { name: "调用与费用", exact: true })
    .click();

  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "百度批量扩词", exact: true }).click();
  await page
    .getByRole("heading", { name: "百度批量扩词", exact: true })
    .waitFor();
  await page
    .getByText(/采集词按默认月搜索量10收录到流量词库，非实测值/)
    .waitFor();
  await page.screenshot({ path: join(output, "discovery-1440.png") });

  const history = await page.evaluate(async () => {
    const tasks = await window.panxu.invoke("baiduDiscovery.list");
    if (!Array.isArray(tasks)) throw new Error("扩词历史未返回任务列表");
    return {
      taskCount: tasks.length,
      wordsAcrossTasks: tasks.reduce((sum, task) => sum + task.wordCount, 0),
    };
  });
  assert.deepEqual(errors, []);
  return {
    windowId,
    checks: [
      "模块名称、五个功能页签与默认关键词库",
      "百度营销含10入库文案",
      "词库扩词来源入口",
      "设置费用统计与导出入口",
      "接口套餐定位与桌面无横向溢出",
      "百度扩词默认值说明",
    ],
    history,
    screenshots: [
      "traffic-1440.png",
      "knowledge-1440.png",
      "costs-1440.png",
      "discovery-1440.png",
    ].map((file) => join(output, file)),
    backendScope:
      "只读界面烟雾检查；未验证尚未应用的新数据结构、迁移与词条历史接口。",
  };
}
