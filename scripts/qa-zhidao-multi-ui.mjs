import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function run({ page, checkpoint, windowId }) {
  const out = "/tmp/panxu-zhidao-multi-ui";
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-zhidao-multi.html";
  url.search = `?run=${windowId}`;
  await page.goto(url.href);
  const frame = page.frameLocator('iframe[title="多账号答题模拟页面"]');
  const picker = frame.getByRole("combobox", { name: /回答账号/ });
  const click = async (locator) => {
    await locator.evaluate((node) => {
      node.focus();
      node.click();
    });
  };
  try {
    await picker.waitFor();
  } catch (error) {
    throw new Error(
      `${error.message}\nPage errors: ${errors.join("; ")}\n${await page.locator("body").innerText()}`,
    );
  }
  assert.match(await picker.textContent(), /西桥/);
  await click(picker);
  try {
    const option = frame.getByRole("option", { name: /南山/ });
    await option.waitFor({ timeout: 5000 });
    await click(option);
  } catch (error) {
    await page.screenshot({ path: `${out}/picker-failure.png` });
    throw new Error(
      `${error.message}\nPage errors: ${errors.join("; ")}\nTrigger: ${await picker.evaluate((node) => node.outerHTML)}\nParent text: ${await page.locator("body").innerText()}\n${await frame.locator("body").innerText()}`,
    );
  }
  await picker.press("Escape");
  assert.match(await picker.textContent(), /西桥.*南山/);
  await frame.getByLabel("每个账号回答数", { exact: true }).fill("5");
  const consent = frame.getByRole("checkbox", { name: /授权本次/ });
  assert.equal(await consent.isChecked(), false);
  const start = frame.getByRole("button", {
    name: "开始自动回答",
    exact: true,
  });
  assert.equal(await start.isDisabled(), true);
  await click(consent);
  await click(start);
  const sessions = frame.getByRole("region", { name: "各账号回答进度" });
  await frame
    .getByText("各账号独立执行，点击账号查看详细进度与日志。")
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("iframe")?.contentWindow.__qaState().runs
        .length === 2,
  );
  const values = await page.evaluate(
    () => document.querySelector("iframe").contentWindow.__qaState().calls,
  );
  assert.equal(values.length, 1);
  assert.deepEqual(values[0].accountIds, ["zd_one", "zd_two"]);
  assert.equal(values[0].count, 5);
  await click(frame.getByRole("button", { name: /南山.*回答中.*2 \/ 5/ }));
  await frame.getByText("南山正在读取题目", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/multi-1440.png` });
  const stop = frame.getByRole("button", { name: "停止此账号", exact: true });
  assert.equal(await stop.count(), 2);
  await click(stop.first());
  await page.waitForFunction(
    () =>
      document.querySelector("iframe")?.contentWindow.__qaState().runs[0]
        .status === "paused",
  );
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("iframe").contentWindow.__qaState().runs[1]
          .status,
    ),
    "running",
  );
  // Reload the child only: UI drafts persist, submission consent does not.
  const childUrl = await frame.locator("body").evaluate(() => location.href);
  await page.locator("iframe").evaluate((node, src) => {
    node.src = src;
  }, childUrl);
  await picker.waitFor();
  assert.match(await picker.textContent(), /西桥.*南山/);
  assert.equal(await consent.isChecked(), false);
  await page.setViewportSize({ width: 1366, height: 768 });
  await click(picker);
  await frame.getByRole("option", { name: /长昵称用于核对/ }).waitFor();
  await page.screenshot({ path: `${out}/picker-1366.png` });
  await picker.press("Escape");
  await checkpoint();
  assert.deepEqual(errors, []);
  return {
    windowId,
    evidence: out,
    checks: [
      "昵称展示与旧草稿迁移",
      "多选与每号目标数",
      "独立进度与日志切换",
      "只停止一个账号",
      "刷新保留选择不保留授权",
    ],
  };
}
