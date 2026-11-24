import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNewDraftSettings } from "./qa-jianshu-ui.mjs";

/** Login feedback in the real workflow, backed only by the test iframe's IPC. */
export async function run({ page, checkpoint, windowId }) {
  const evidence = await mkdtemp(join(tmpdir(), "panxu-jianshu-login-"));
  console.log(JSON.stringify({ windowId, evidence }));
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-jianshu.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href);
  const frame = page.frameLocator('iframe[title="简书内容内存模拟页面"]');
  const main = frame.locator("main");
  const helper = (method, arg) =>
    main.evaluate(
      (_element, { method, arg }) => window.__jianshuQa[method](arg),
      { method, arg },
    );
  const button = (name) =>
    frame.getByRole("button", { name, exact: true }).filter({ visible: true });
  const click = (name) => button(name).dispatchEvent("click");
  const status = () =>
    frame
      .getByRole("region", { name: "简书账号登录状态", exact: true })
      .filter({ visible: true });
  const choose = async (label, value) => {
    const control = frame.getByLabel(label, { exact: true });
    await control.dispatchEvent("click");
    const option = frame
      .getByRole("option")
      .and(frame.locator(`[data-value="${value}"]`))
      .filter({ visible: true });
    await option.waitFor();
    await option.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await option.dispatchEvent("click");
    assert.equal(await control.getAttribute("data-value"), value);
  };
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
  const events = async (method) =>
    (await helper("events")).filter((event) => event.method === method);
  const first = "web_jianshu_fixture",
    second = "web_jianshu_fixture_2";
  const pending = {
    unverified: true,
    status: "connected",
    message: "已保存登录，请点击检查登录核实当前身份。",
  };
  const checks = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await frame
      .getByRole("heading", { name: "开始一篇文章", exact: true })
      .waitFor();
    await openNewDraftSettings(frame);
    assert.equal(await button("检查登录").count(), 0);
    await helper("accountStates", [pending]);
    await choose("新文章简书账号", first);
    await status().getByText("待核验", { exact: true }).waitFor();
    assert.ok(
      (
        await frame.getByLabel("新文章简书账号", { exact: true }).innerText()
      ).includes("待核验"),
    );
    assert.equal(
      (await events("websiteAccounts.check")).length,
      0,
      "普通读取不自动远端核验",
    );

    await helper("accountCheckMode", "failure");
    await click("检查登录");
    await status()
      .getByText("简书身份核验暂时无法连接，原账号与稿件已保留，请重试。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await frame
        .getByLabel("新文章简书账号", { exact: true })
        .getAttribute("data-value"),
      first,
    );
    assert.equal(await button("检查登录").isEnabled(), true);
    await page.screenshot({
      path: join(evidence, "01-verification-retry-1440.png"),
      fullPage: true,
    });
    checks.push(
      "选中待核验账号后显示原因和检查入口；普通读取不核验，网络失败保留选择并可重试",
    );

    await helper("hold", "websiteAccounts.check");
    const checkBefore = (await events("websiteAccounts.check")).length;
    await click("检查登录");
    await button("正在核验…").waitFor();
    assert.equal(await button("正在核验…").isDisabled(), true);
    await button("正在核验…").dispatchEvent("click");
    assert.equal(
      (await events("websiteAccounts.check")).length,
      checkBefore + 1,
    );
    await helper("release");
    await status().getByText("身份已核实", { exact: true }).waitFor();
    assert.ok(
      !(
        await frame.getByLabel("新文章简书账号", { exact: true }).innerText()
      ).includes("待核验"),
    );
    assert.equal(await button("检查登录").count(), 0);
    checks.push("显式核验防双击，成功立即更新新建区账号和下拉标签");

    await helper("accountStates", [pending, pending]);
    await status().getByText("待核验", { exact: true }).waitFor();
    await helper("hold", "websiteAccounts.check");
    await click("检查登录");
    await button("正在核验…").waitFor();
    await choose("新文章简书账号", second);
    await status().getByText("待核验", { exact: true }).waitFor();
    await helper("release");
    await button("检查登录").waitFor();
    assert.equal(
      await frame
        .getByLabel("新文章简书账号", { exact: true })
        .getAttribute("data-value"),
      second,
    );
    assert.equal(
      await status().getByText("身份已核实", { exact: true }).count(),
      0,
    );
    assert.ok(
      (await helper("accounts")).find((account) => account.id === first)
        .unverified === false,
    );
    checks.push(
      "核验中切换账号，前一个账号迟到成功不会改写当前选择或显示错误的已核实",
    );

    await helper("accountCheckMode", "mismatch");
    await click("检查登录");
    await status()
      .getByText("简书窗口当前登录了其他身份，请重新登录原账号。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await status().getByText("身份已核实", { exact: true }).count(),
      0,
    );
    assert.equal(
      await frame
        .getByLabel("新文章简书账号", { exact: true })
        .getAttribute("data-value"),
      second,
    );
    await helper("accountCheckMode", "unverified");
    await click("检查登录");
    await status()
      .getByText("暂未核实简书当前身份，请稍后重新检查登录。", { exact: true })
      .waitFor();
    assert.equal(
      await status().getByText("身份已核实", { exact: true }).count(),
      0,
    );
    checks.push("核验返回错号或仍未核实时不显示成功，保留明确恢复提示");

    await click("空白文章");
    await frame.getByLabel("简书文章正文", { exact: true }).waitFor();
    const title = "登录核验期间应当保留的标题";
    const body =
      "这段未保存的文章用于核对登录状态变化时，标题和正文不会丢失。无需重新建立草稿，也不应触发任何AI生成、上传、转存或发布。";
    await fill("简书文章标题", title);
    await fill("简书文章正文", body);
    await helper("accountCheckMode", "failure");
    await click("检查登录");
    await status()
      .getByText("简书身份核验暂时无法连接，原账号与稿件已保留，请重试。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await frame.getByLabel("简书文章标题", { exact: true }).inputValue(),
      title,
    );
    assert.equal(
      await frame.getByLabel("简书文章正文", { exact: true }).inputValue(),
      body,
    );
    await click("检查登录");
    await status().getByText("身份已核实", { exact: true }).waitFor();
    assert.equal(
      await frame
        .getByLabel("文章简书账号", { exact: true })
        .getAttribute("data-value"),
      second,
    );
    assert.ok(
      !(
        await frame.getByLabel("文章简书账号", { exact: true }).innerText()
      ).includes("待核验"),
    );
    assert.equal(
      await frame.getByLabel("简书文章标题", { exact: true }).inputValue(),
      title,
    );
    assert.equal(
      await frame.getByLabel("简书文章正文", { exact: true }).inputValue(),
      body,
    );
    await status().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "02-editor-verified-1440.png"),
      fullPage: true,
    });
    checks.push(
      "文章编辑器可就地核验；失败和成功均保留未提交标题、正文及当前账号",
    );

    await helper("accountStates", [pending, pending]);
    await status().getByText("待核验", { exact: true }).waitFor();
    await helper("hold", "websiteAccounts.check");
    await click("检查登录");
    await button("正在核验…").waitFor();
    await helper("leave");
    await frame
      .getByRole("heading", { name: "模拟切换到其他模块", exact: true })
      .waitFor();
    await helper("release");
    await checkpoint();
    await click("返回简书测试工作区");
    await frame.getByLabel("简书文章正文", { exact: true }).waitFor();
    assert.equal(
      await frame.getByLabel("简书文章标题", { exact: true }).inputValue(),
      title,
    );
    assert.equal(
      await frame.getByLabel("简书文章正文", { exact: true }).inputValue(),
      body,
    );
    checks.push("核验中离开页面，迟到结果不切回页面或覆盖输入，返回后仍能继续");

    for (const method of [
      "jianshu.generate",
      "jianshu.prepare",
      "jianshu.checkResult",
      "jianshu.collect",
      "jianshu.save",
    ])
      assert.equal((await events(method)).length, 0, `登录检查不触发${method}`);
    assert.deepEqual(errors, []);
    assert.equal(
      await main.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const result = {
      windowId,
      evidence,
      checks,
      accountChecks: (await events("websiteAccounts.check")).length,
      limitation:
        "实际组件在专属窗口的内存IPC回归，不访问真实账号、不调用模型、不发布；用户账号的真实核验由root单独完成。",
    };
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } catch (error) {
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(evidence, "failure.txt"),
      String(error.stack || error),
    );
    throw error;
  } finally {
    await helper("cleanup").catch(() => {});
  }
}
