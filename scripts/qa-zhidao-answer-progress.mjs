import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function run({ page, windowId }) {
  const out = "/tmp/panxu-zhidao-answer-progress";
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-zhidao-multi.html";
  url.search = `?run=${windowId}&progress=1`;
  await page.goto(url.href);
  const frame = page.frameLocator('iframe[title="多账号答题模拟页面"]');
  const click = (locator) =>
    locator.evaluate((node) => {
      node.focus();
      node.click();
    });
  const picker = frame.getByRole("combobox", {
    name: "查看今日回答记录",
    exact: true,
  });
  await picker.waitFor();
  assert.match(await picker.textContent(), /今日回答/);
  await click(picker);
  await frame.getByRole("option", { name: /今日回答/ }).waitFor();
  assert.equal(
    await frame.getByRole("option", { name: /昨日回答/ }).count(),
    0,
  );
  await picker.press("Escape");
  assert.equal(
    await frame
      .getByText("昨日生成的回答不应重新显示在今日进度中。", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await frame.getByRole("checkbox", { name: /授权本次/ }).count(),
    0,
  );
  const start = frame.getByRole("button", {
    name: "开始自动回答",
    exact: true,
  });
  await start.waitFor();
  assert.equal(await start.isDisabled(), false);
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("iframe").contentWindow.__qaState().calls.length,
    ),
    0,
  );
  await frame.getByLabel("每个账号回答数", { exact: true }).fill("4");
  await click(start);
  await page.waitForFunction(
    () =>
      document.querySelector("iframe").contentWindow.__qaState().calls
        .length === 1,
  );
  const call = await page.evaluate(
    () => document.querySelector("iframe").contentWindow.__qaState().calls[0],
  );
  assert.equal(call.count, 4);
  assert.equal(call.authorized, true);
  await page.screenshot({ path: `${out}/today-direct-start-1440.png` });
  // Make all fixture records historical to model a day with no retained progress.
  await page.evaluate(() => {
    const child = document.querySelector("iframe").contentWindow;
    const runs = child
      .__qaState()
      .runs.map((run) => ({
        ...run,
        status: "completed",
        createdAt: "2000-01-01T00:00:00.000Z",
      }));
    child.__qaSetRuns(runs);
  });
  await frame.getByText("今天尚未开始回答", { exact: true }).waitFor();
  assert.equal(await picker.count(), 0);
  await frame.getByText("等待开始回答", { exact: true }).waitFor();
  const childUrl = await frame.locator("body").evaluate(() => location.href);
  await page.locator("iframe").evaluate((node, src) => {
    node.src = src;
  }, childUrl);
  await start.waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("iframe").contentWindow.__qaState().calls.length,
    ),
    1,
  );
  assert.equal(
    await frame.getByRole("checkbox", { name: /授权本次/ }).count(),
    0,
  );
  await frame.getByText("今天尚未开始回答", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/today-empty-1440.png` });
  assert.deepEqual(errors, []);
  return {
    windowId,
    evidence: out,
    checks: [
      "旧焦点自动切换今日记录",
      "下拉仅含当日记录",
      "无二次勾选直接开始",
      "空的当天不恢复旧进度或日志",
      "刷新不自动开始",
    ],
  };
}
