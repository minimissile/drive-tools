import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolated child-frame state/layout checks; no real website upload or publishing. */
export async function run({ page, checkpoint, windowId }) {
  const evidence = await mkdtemp(join(tmpdir(), "panxu-bilibili-ui-"));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-bilibili.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href);
  const frame = page.frameLocator('iframe[title="B站稿件内存模拟页面"]'),
    root = frame.locator("main");
  const helper = (method) =>
    root.evaluate((_element, method) => window.__bilibiliQa[method](), method);
  const click = (name) =>
    frame.getByRole("button", { name, exact: true }).dispatchEvent("click");
  const fill = (label, value) =>
    frame.getByLabel(label, { exact: true }).evaluate((element, value) => {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  const choose = async (value, label = "B站稿件形式") => {
    const select = frame.getByLabel(label, { exact: true });
    await select.dispatchEvent("click");
    const option = frame
      .getByRole("option")
      .and(frame.locator(`[data-value="${value}"]`))
      .filter({ visible: true });
    await option.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await option.dispatchEvent("click");
    assert.equal(await select.getAttribute("data-value"), value);
  };
  try {
    await frame.getByLabel("B站稿件标题", { exact: true }).waitFor();
    await choose("article");
    await fill("B站稿件标题", "MBTI与职业兴趣测评资料的阅读顺序");
    const text =
      "先区分性格偏好、职业兴趣和能力表现，再阅读对应资料。测评结果应结合自己的具体经历与实际任务核对，不用一个类型代替完整认识。";
    await fill("B站稿件正文", text);
    await fill("B站稿件标签", "MBTI，职业规划，资料整理");
    assert.equal(
      await frame
        .getByLabel("B站配图来源", { exact: true })
        .getAttribute("data-value"),
      "",
    );
    await choose("video_bili_fixture", "B站配图来源");
    await frame
      .getByRole("img", { name: "B站稿件配图预览", exact: true })
      .waitFor();
    await click("保存草稿");
    await frame.getByText("本地稿件已保存。", { exact: true }).waitFor();
    assert.equal(
      (await helper("latestSaved")).videoJobId,
      "video_bili_fixture",
    );
    await click("预览与检查");
    await frame
      .getByRole("heading", {
        name: "MBTI与职业兴趣测评资料的阅读顺序",
        exact: true,
      })
      .waitFor();
    assert.match(
      await frame
        .getByRole("img", { name: "关联资源的实际封面", exact: true })
        .getAttribute("src"),
      /^data:image\/png;base64,/,
    );
    await choose("dynamic");
    assert.equal(
      await frame
        .getByLabel("B站配图来源", { exact: true })
        .getAttribute("data-value"),
      "video_bili_fixture",
    );
    await click("保存草稿");
    await frame.getByText("本地稿件已保存。", { exact: true }).waitFor();
    const dynamic = await helper("latestSaved");
    assert.equal(dynamic.kind, "dynamic");
    assert.equal(dynamic.videoJobId, "video_bili_fixture");
    await click("预览与检查");
    await frame
      .getByRole("img", { name: "关联资源的实际封面", exact: true })
      .waitFor();
    await choose("article");
    assert.equal(
      await frame
        .getByLabel("B站配图来源", { exact: true })
        .getAttribute("data-value"),
      "video_bili_fixture",
    );
    await click("填写官网投稿");
    await frame
      .getByText("官网已部分填写，请继续核对", { exact: true })
      .waitFor();
    assert.equal(
      (await helper("events")).filter((method) => method === "bilibili.prepare")
        .length,
      1,
    );
    await frame
      .getByText("标题和正文已填入；分类、封面与标签需要在官网核对。", {
        exact: true,
      })
      .waitFor();
    await page.screenshot({
      path: join(evidence, "01-editor-partial.png"),
      fullPage: true,
    });
    await fill("B站官网内容链接", "https://www.bilibili.com/read/cv12345678");
    await click("记录待核实链接");
    await frame.getByText(/已记录：.*待核实，尚未确认发布状态或归属/).waitFor();
    await fill("B站稿件正文", `${text}\n补充：先阅读使用说明，再完成自测。`);
    await helper("remount");
    await frame.getByLabel("B站稿件正文", { exact: true }).waitFor();
    assert.equal(
      await frame.getByLabel("B站稿件正文", { exact: true }).inputValue(),
      `${text}\n补充：先阅读使用说明，再完成自测。`,
    );
    await helper("failSave");
    await click("保存草稿");
    await frame
      .getByText("稿件已在其它窗口更新，当前文字保留。", { exact: true })
      .waitFor();
    assert(
      (
        await frame.getByLabel("B站稿件正文", { exact: true }).inputValue()
      ).includes("补充："),
    );
    await helper("waitPrepare");
    await click("填写官网投稿");
    await frame
      .getByRole("button", { name: "正在填写官网…", exact: true })
      .waitFor();
    await helper("switchAccount");
    await helper("release");
    await frame.getByLabel("B站稿件标题", { exact: true }).waitFor();
    assert.equal(
      await frame
        .getByRole("heading", {
          name: "MBTI与职业兴趣测评资料的阅读顺序",
          exact: true,
        })
        .count(),
      0,
    );
    assert.equal(
      await frame
        .getByText("官网已部分填写，请继续核对", { exact: true })
        .count(),
      0,
    );
    await checkpoint();
    assert.equal(
      await root.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: join(evidence, "02-account-isolated-editor.png"),
      fullPage: true,
    });
    return {
      evidence,
      checks: [
        "三种形式切换及真实控件编辑",
        "图文和文章选择本地视频封面，保存请求保留videoJobId并预览实际图片",
        "保存、预览和partial明确未完成事项",
        "链接记录保持待核实",
        "本窗口暂存恢复及失败保留文字",
        "跨账号晚回包不覆盖新稿件",
        "1440×900无横向溢出",
      ],
      limitation:
        "专用iframe内存IPC，DOM事件验证组件状态与布局；不代表真实账号、上传或发布验收。",
    };
  } finally {
    await helper("cleanup").catch(() => {});
  }
}
