import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { DiscoveryRun } from "../shared/baidu-discovery";

export async function run({ page }: any) {
  const run: DiscoveryRun = JSON.parse(
    await readFile("/tmp/panxu-baidu-discovery-qa/live-result.json", "utf8"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("选择采词任务").waitFor();
  if (
    (await page.getByLabel("选择采词任务").getAttribute("data-value")) !==
    run.id
  ) {
    await page.getByLabel("选择采词任务").click();
    await page.locator(`[role=option][data-value="${run.id}"]`).click();
  }
  await page.getByLabel("筛选采集关键词", { exact: true }).fill("画竹子");
  await page.getByLabel("关键词导出格式", { exact: true }).click();
  await page.getByRole("option", { name: "TXT（仅词）", exact: true }).click();
  await page.reload();
  await page.getByLabel("选择采词任务").waitFor();
  assert.equal(
    await page.getByLabel("选择采词任务").getAttribute("data-value"),
    run.id,
  );
  assert.equal(
    await page.getByLabel("筛选采集关键词", { exact: true }).inputValue(),
    "画竹子",
  );
  assert.equal(
    await page
      .getByLabel("关键词导出格式", { exact: true })
      .getAttribute("data-value"),
    "txt",
  );
  await page.getByLabel("筛选采集关键词", { exact: true }).fill("");
  await page
    .getByRole("heading", { name: "去重关键词", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/panxu-baidu-discovery-qa/final-1440.png",
  });
  return {
    checks: [
      "历史任务选择刷新恢复",
      "任务内筛选刷新恢复",
      "结果及导出操作可达",
    ],
    runId: run.id,
  };
}
