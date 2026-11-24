import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function run({ page, windowId }) {
  const out = "/tmp/panxu-zhidao-answer-language";
  await mkdir(out, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-zhidao-multi.html";
  url.search = `?run=${windowId}`;
  await page.goto(url.href);
  const frame = page.frameLocator('iframe[title="多账号答题模拟页面"]');
  const language = frame.getByRole("combobox", {
    name: "回答语言",
    exact: true,
  });
  const click = (locator) =>
    locator.evaluate((node) => {
      node.focus();
      node.click();
    });
  const choose = async (label) => {
    await click(language);
    await click(frame.getByRole("option", { name: label, exact: true }));
  };
  try {
    await language.waitFor();
    assert.match(await language.textContent(), /普通话/);
    const boxes = await frame
      .locator(".answer-expression-options .select-control")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
    assert.equal(boxes.length, 2);
    assert.ok(Math.abs(boxes[0].y - boxes[1].y) <= 1);
    assert.ok(boxes[1].x > boxes[0].x + boxes[0].width);
    assert.ok(Math.abs(boxes[0].height - boxes[1].height) <= 1);
    await choose("粤语");
    await frame.getByText(/粤语语气示例/).waitFor();
    assert.match(
      await frame.locator(".answer-style-preview blockquote").textContent(),
      /嘅|唔/,
    );
    await click(frame.getByRole("tab", { name: "手动回答", exact: true }));
    assert.match(await language.textContent(), /粤语/);
    await frame
      .getByLabel("你的问题", { exact: true })
      .fill("如何沟通自己的感受？");
    await click(frame.getByRole("button", { name: "生成回答", exact: true }));
    await frame
      .getByRole("region", { name: "生成的回答" })
      .getByText(/自己嘅感受/)
      .waitFor();
    const manual = await page.evaluate(
      () => document.querySelector("iframe").contentWindow.__qaState().calls[0],
    );
    assert.equal(manual.input.language, "cantonese");
    await click(frame.getByRole("tab", { name: "自动回答", exact: true }));
    const consent = frame.getByRole("checkbox", { name: /授权本次/ });
    assert.equal(await consent.count(), 0);
    await choose("普通话");
    assert.equal(await consent.count(), 0);
    await choose("粤语");
    await click(
      frame.getByRole("button", { name: "开始自动回答", exact: true }),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("iframe").contentWindow.__qaState().calls
          .length === 2,
    );
    const automatic = await page.evaluate(
      () => document.querySelector("iframe").contentWindow.__qaState().calls[1],
    );
    assert.equal(automatic.language, "cantonese");
    const childUrl = await frame.locator("body").evaluate(() => location.href);
    await page.locator("iframe").evaluate((node, src) => {
      node.src = src;
    }, childUrl);
    await language.waitFor();
    assert.match(await language.textContent(), /粤语/);
    assert.equal(await consent.count(), 0);
    await click(frame.getByRole("button", { name: "停止回答", exact: true }));
    await frame
      .getByRole("button", { name: "继续回答", exact: true })
      .waitFor();
    await click(frame.getByRole("button", { name: "继续回答", exact: true }));
    const dialog = frame.getByRole("dialog", { name: "继续答题任务" });
    await dialog.waitFor();
    assert.equal(
      await dialog.locator("dt", { hasText: "回答语言" }).count(),
      1,
    );
    await dialog.getByText("粤语", { exact: true }).waitFor();
    await click(dialog.getByRole("button", { name: "取消", exact: true }));
    let expectedCalls = 2;
    for (const [value, label, words] of [
      ["sichuanese", "川渝话", /莫着急|咋个/],
      ["northeastern", "东北话", /咱|咋办/],
    ]) {
      await choose(label);
      await frame
        .getByText(`${label}语气示例 · 实际回答会结合每道题生成`, {
          exact: true,
        })
        .waitFor();
      assert.match(
        await frame.locator(".answer-style-preview blockquote").textContent(),
        words,
      );
      await click(frame.getByRole("tab", { name: "手动回答", exact: true }));
      await frame
        .getByLabel("你的问题", { exact: true })
        .fill("如何沟通自己的感受？");
      await click(frame.getByRole("button", { name: "生成回答", exact: true }));
      expectedCalls++;
      await page.waitForFunction(
        (n) =>
          document.querySelector("iframe").contentWindow.__qaState().calls
            .length === n,
        expectedCalls,
      );
      const manualCall = await page.evaluate(() =>
        document.querySelector("iframe").contentWindow.__qaState().calls.at(-1),
      );
      assert.equal(manualCall.input.language, value);
      await frame
        .getByRole("region", { name: "生成的回答" })
        .getByText(words)
        .waitFor();
      await click(frame.getByRole("tab", { name: "自动回答", exact: true }));
      assert.match(await language.textContent(), new RegExp(label));
      await choose("普通话");
      assert.equal(await consent.count(), 0);
      await choose(label);
      await click(
        frame.getByRole("button", { name: "开始自动回答", exact: true }),
      );
      expectedCalls++;
      await page.waitForFunction(
        (n) =>
          document.querySelector("iframe").contentWindow.__qaState().calls
            .length === n,
        expectedCalls,
      );
      const autoCall = await page.evaluate(() =>
        document.querySelector("iframe").contentWindow.__qaState().calls.at(-1),
      );
      assert.equal(autoCall.language, value);
      await page.locator("iframe").evaluate((node, src) => {
        node.src = src;
      }, childUrl);
      await language.waitFor();
      assert.match(await language.textContent(), new RegExp(label));
      assert.equal(await consent.count(), 0);
      await click(frame.getByRole("button", { name: "停止回答", exact: true }));
      await frame
        .getByRole("button", { name: "继续回答", exact: true })
        .waitFor();
      await click(frame.getByRole("button", { name: "继续回答", exact: true }));
      await dialog.waitFor();
      await dialog.getByText(label, { exact: true }).waitFor();
      await click(dialog.getByRole("button", { name: "取消", exact: true }));
      await language.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/${value}-1440.png` });
    }
    await click(language);
    for (const label of ["普通话", "粤语", "川渝话", "东北话"])
      await frame.getByRole("option", { name: label, exact: true }).waitFor();
    await page.screenshot({ path: `${out}/language-options-1440.png` });
    await language.press("Escape");
    await language.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/language-1440.png` });
    assert.deepEqual(errors, []);
    return {
      windowId,
      screenshot: `${out}/language-1440.png`,
      checks: [
        "语言与风格同排",
        "旧草稿默认普通话",
        "粤语示例同步",
        "川渝话与东北话示例及生成参数",
        "手动及自动参数传递",
        "刷新恢复语言",
        "无二次勾选且修改语言不自动启动",
        "继续任务显示保存语言",
      ],
    };
  } catch (error) {
    await page.screenshot({ path: `${out}/failure.png` });
    throw error;
  }
}
