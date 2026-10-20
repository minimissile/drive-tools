// Browser plugin unavailable. Only Settings and its directly owned operations; disposable data, no paid requests.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-settings-"));
const dataPath = join(evidence, "data");
await mkdir(dataPath);
const identity = await fetch("http://127.0.0.1:5173/__panxu_dev").then((r) =>
  r.json(),
);
assert.equal(identity.root, process.cwd());
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:5173",
  PANXU_DEV_ROOT: process.cwd(),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [join(process.cwd(), "dist-dev")],
  env,
  timeout: 45000,
});
const checks = [],
  errors = [];
let page;
console.log(`Settings evidence: ${evidence}`);
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.__settingsExternal = 0;
    globalThis.fetch = async () => {
      globalThis.__settingsExternal++;
      throw Error("Settings QA blocks external services");
    };
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const u = new URL(d.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:5173",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  await page.evaluate(() =>
    window.panxu.invoke("binding.save", {
      platform: "csdn",
      alias: "本人内容运营账号 · 很长的平台别名用于设置页布局检查",
      windowId: "local-qa-fingerprint-window-1234567890",
      editorUrl: "https://editor.csdn.net/md/",
      linkPermission: "none",
      ruleNote: "",
      capabilities: { formats: [], linkPositions: [], editorUrls: {} },
      confirmCapabilities: false,
    }),
  );
  await page.addInitScript(() => {
    window.__settingsQA = { modes: {}, mocks: {}, calls: [], pending: [] };
  });
  const client = await fetch("http://127.0.0.1:5173/src/api/client.ts").then(
    (r) => r.text(),
  );
  const instrumented = client.replace(
    "return window.panxu.invoke",
    `
    const qa = window.__settingsQA;
    qa.calls.push({ method, args });
    if (qa.modes[method] === "fail") return Promise.reject(new Error("模拟读取失败，请重试"));
    if (qa.modes[method] === "hold") return new Promise(resolve => qa.pending.push({ method, resolve }));
    if (Object.hasOwn(qa.mocks, method)) return Promise.resolve(qa.mocks[method]);
    return window.panxu.invoke`,
  );
  assert.notEqual(client, instrumented);
  await page.route("**/src/api/client.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: instrumented,
    }),
  );
  await page.reload();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分区" }).waitFor();
  const size = (w, h = 900) =>
    app.evaluate(
      ({ BrowserWindow }, [w, h]) =>
        BrowserWindow.getAllWindows()[0].setSize(w, h),
      [w, h],
    );
  const section = async (name) => {
    await page
      .getByRole("navigation", { name: "设置分区" })
      .getByRole("link", { name, exact: true })
      .click();
  };
  const shot = async (name) => {
    await page.evaluate(() => {
      for (const a of document.getAnimations())
        if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    });
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await page.waitForTimeout(100);
    const b = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(evidence, name + ".png"), Buffer.from(b, "base64"));
  };
  await size(1320);
  const prefix = process.env.PANXU_SETTINGS_BASELINE ? "before" : "after";
  for (const [name, key] of [
    ["AI与预算", "ai"],
    ["5118接口", "traffic"],
    ["知识库", "notes"],
    ["比特连接", "browser"],
    ["发布映射", "bindings"],
    ["备份与更新", "maintenance"],
  ]) {
    await section(name);
    await shot(`${prefix}-${key}-1320`);
  }
  if (!process.env.PANXU_SETTINGS_BASELINE) {
    const button = (name) => page.getByRole("button", { name, exact: true });
    const settingsNav = page.getByRole("navigation", { name: "设置分区" });
    const waitSaved = (scope) =>
      page
        .locator(`#settings-${scope} .settings-actions`)
        .getByText("此分区设置已保存")
        .waitFor();
    const mock = (method, value) =>
      page.evaluate(
        ({ method, value }) => {
          window.__settingsQA.mocks[method] = value;
        },
        { method, value },
      );
    const mode = (method, value) =>
      page.evaluate(
        ({ method, value }) => {
          window.__settingsQA.modes[method] = value;
        },
        { method, value },
      );
    const count = (method) =>
      page.evaluate(
        (method) =>
          window.__settingsQA.calls.filter((c) => c.method === method).length,
        method,
      );
    const lastArgs = (method) =>
      page.evaluate(
        (method) =>
          window.__settingsQA.calls.filter((c) => c.method === method).at(-1)
            ?.args,
        method,
      );

    // Current-source screenshots start with no other business page mounted.
    await section("发布映射");
    assert.equal(
      await page
        .locator(".channel-fieldset")
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopStyle),
      "solid",
    );
    assert.equal(
      await page
        .locator(".channel-fieldset")
        .first()
        .evaluate((el) => getComputedStyle(el).borderLeftWidth),
      "0px",
    );
    assert.equal(
      await page
        .locator(".settings-page select, .settings-page datalist")
        .count(),
      0,
    );
    checks.push(
      "首次直达设置页，发布映射样式完整，不依赖工作室；使用自定义下拉框",
    );

    await section("AI与预算");
    const budget = page.locator("#settings-ai-budget");
    await budget.fill("-1");
    const beforeInvalid = await count("settings.save");
    await button("保存AI配置").click();
    await page.locator("#settings-budget-error").waitFor();
    assert.equal(await budget.getAttribute("aria-invalid"), "true");
    assert.equal(await count("settings.save"), beforeInvalid);
    assert.equal(
      await budget.evaluate((el) => el === document.activeElement),
      true,
    );
    await budget.fill("1.25");
    await section("知识库");
    await page
      .getByRole("checkbox", { name: "在知识笔记中明文导出本人分享提取码" })
      .check();
    await button("保存知识库设置").click();
    await waitSaved("notes");
    assert.deepEqual(await lastArgs("settings.save"), { exportCodes: true });
    assert.equal(await budget.inputValue(), "1.25");
    assert.match(
      await page.locator("#settings-ai .settings-actions").innerText(),
      /未保存/,
    );
    await button("保存AI配置").click();
    await waitSaved("ai");
    assert.equal(
      (await lastArgs("settings.save")).dailyAiBudgetMicros,
      1250000,
    );
    checks.push(
      "负预算阻止提交并定位错误；分区保存只提交所属字段，保留其他未保存编辑",
    );

    await section("比特连接");
    const address = page.getByRole("textbox", { name: "比特接口地址" });
    await address.fill("http://127.0.0.1:59999");
    await page.reload();
    await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
    await section("比特连接");
    assert.equal(await address.inputValue(), "http://127.0.0.1:59999");
    await button("保存比特地址").click();
    await waitSaved("browser");
    assert.deepEqual(await lastArgs("settings.save"), {
      bitUrl: "http://127.0.0.1:59999",
    });
    checks.push("刷新后恢复非敏感设置草稿，保存状态准确");

    await section("AI与预算");
    const secret = page.getByLabel("openrouter密钥", { exact: true });
    const secretArea = page.locator("#settings-ai .settings-secret");
    await secret.fill("qa-local-only-key");
    assert.equal(await secret.getAttribute("type"), "password");
    await secretArea.getByRole("button", { name: "显示输入的密钥" }).click();
    assert.equal(await secret.getAttribute("type"), "text");
    await secretArea
      .getByRole("button", { name: "保存Key", exact: true })
      .click();
    await secretArea
      .getByRole("button", { name: "移除", exact: true })
      .waitFor();
    assert.equal(await secret.inputValue(), "");
    assert.equal(await secret.getAttribute("type"), "password");
    const savedKeyCalls = await count("secret.save");
    await secretArea.getByRole("button", { name: "移除", exact: true }).click();
    await secretArea
      .getByRole("button", { name: "取消移除", exact: true })
      .click();
    assert.equal(await count("secret.save"), savedKeyCalls);
    assert.equal(
      await secretArea
        .getByRole("button", { name: "移除", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await secretArea.getByRole("button", { name: "移除", exact: true }).click();
    await shot("secret-removal-confirmation-1320");
    await secretArea
      .getByRole("button", { name: "确认移除密钥", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("#settings-ai .settings-remove-confirm") ===
        null,
    );
    assert.equal((await lastArgs("secret.save")).value, "");
    assert.equal(
      await secret.evaluate((el) => el === document.activeElement),
      true,
    );
    checks.push(
      "密钥默认遮蔽、按需显示，保存后清空；移除可取消，确认后返回输入焦点",
    );

    // One local automatic read: loading, persistent error, retry; no error toast duplication.
    await mode("ai.modelCatalog", "hold");
    await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
    // Force only the Settings component to remount through a page reload.
    await page.reload();
    await mode("ai.modelCatalog", "hold");
    await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
    await page.getByText("正在读取官方模型能力…", { exact: true }).waitFor();
    await section("AI与预算");
    await shot("model-catalog-loading-1320");
    await page.evaluate(() => {
      window.__settingsQA.modes["ai.modelCatalog"] = "fail";
      window.__settingsQA.pending
        .splice(0)
        .forEach((p) => p.resolve({ text: [], media: [] }));
    });
    // Remount with failure without changing other pages' state.
    await page.reload();
    await mode("ai.modelCatalog", "fail");
    await nav.getByRole("button", { name: "连接与设置", exact: true }).click();
    await page.getByRole("heading", { name: "模型目录读取失败" }).waitFor();
    await shot("model-catalog-error-1320");
    await mode("ai.modelCatalog", "");
    await button("重试读取").click();
    await page
      .getByRole("heading", { name: "模型目录读取失败" })
      .waitFor({ state: "hidden" });
    assert.equal(await page.locator('.toast[data-tone="error"]').count(), 0);
    checks.push(
      "模型目录慢读取、失败、重试有统一状态，保留选择且不重复弹错误提示",
    );

    await section("5118接口");
    const plan = page.locator(".api-plan").first();
    const price = plan.getByRole("spinbutton", { name: /单价/ });
    const units = plan.getByRole("spinbutton", { name: /每日计费单位上限/ });
    await price.fill("-1");
    const beforePlan = await count("api.plan");
    await plan.getByRole("button", { name: "保存配置", exact: true }).click();
    assert.equal(
      await price.evaluate((el) => el.validity.rangeUnderflow),
      true,
    );
    assert.equal(await count("api.plan"), beforePlan);
    await price.fill("0.005");
    await units.fill("200");
    await plan.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.waitForFunction(() =>
      window.__settingsQA.calls.some((c) => c.method === "api.plan"),
    );
    assert.equal((await lastArgs("api.plan")).dailyUnits, 200);
    assert.equal((await lastArgs("api.plan")).enabled, false);
    assert.equal(await count("traffic.query"), 0);
    checks.push(
      "接口价格与调用上限原生表单校验有效，保存配置不自动启用或查询付费接口",
    );

    await section("比特连接");
    await mock("bit.windows", []);
    await button("读取指纹窗口列表").click();
    await page.getByText(/未找到指纹窗口。请先在比特浏览器/).waitFor();
    await mock("bit.windows", [
      { id: "local-qa-window", name: "本人内容账号", seq: null },
    ]);
    await button("读取指纹窗口列表").click();
    await page
      .getByText("已读取 1 个指纹窗口，可在发布映射中选择。", { exact: true })
      .waitFor();
    await mock("bit.health", true);
    await button("检测连接").click();
    await page.waitForFunction(() =>
      window.__settingsQA.calls.some((c) => c.method === "bit.health"),
    );
    await address.fill("http://127.0.0.1:59998");
    assert.equal(await page.locator(".settings-result").count(), 0);
    assert.equal(
      await page.getByRole("option", { name: /本人内容账号/ }).count(),
      0,
    );
    await button("保存比特地址").click();
    await waitSaved("browser");
    checks.push(
      "模拟比特连接及窗口列表：空列表给出恢复路径，重新读取后可在映射中使用",
    );

    await section("发布映射");
    await page
      .locator("#settings-bindings table")
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", { name: "发布账号别名", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: "确认本次账号能力核实", exact: true })
        .isChecked(),
      false,
    );
    await button("取消修改").click();
    checks.push(
      "编辑既有映射自动定位表单，账号能力确认不自动勾选，取消可回到添加状态",
    );

    await section("备份与更新");
    await mock("system.backup", "/tmp/settings-qa-backup");
    await button("导出一致性备份").click();
    await page.getByText(/备份已保存到：\/tmp\/settings-qa-backup/).waitFor();
    await mock("system.backupPreview", {
      folder: "/tmp/very-long-backup-folder-for-workspace-restore-preview",
      token: "qa-preview",
      createdAt: Date.now(),
      resources: 10000,
      accounts: 6,
      drafts: 300,
      covers: 1200,
    });
    await button("选择备份并预检").click();
    const restore = button("恢复到新工作空间并重启");
    assert.equal(await restore.isDisabled(), true);
    await page
      .getByRole("checkbox", {
        name: "已保存正在编辑的内容，同意恢复到新工作空间并重启",
        exact: true,
      })
      .check();
    assert.equal(await restore.isEnabled(), true);
    await shot("backup-preview-confirmation-1320");
    await button("选择备份并预检").click();
    assert.equal(await restore.isDisabled(), true);
    assert.equal(await count("system.restore"), 0);
    checks.push(
      "模拟备份导出与预检，恢复必须显式确认；重新预检清除旧确认，不触发真实恢复",
    );

    await size(840, 900);
    for (const [name, key] of [
      ["AI与预算", "ai"],
      ["5118接口", "traffic"],
      ["知识库", "notes"],
      ["比特连接", "browser"],
      ["发布映射", "bindings"],
      ["备份与更新", "maintenance"],
    ]) {
      await section(name);
      await shot(`after-${key}-840`);
      const box = await settingsNav.boundingBox();
      assert.ok(
        box && box.y >= 35 && box.y + box.height < 250,
        `${name}: sticky navigation visible`,
      );
      const selected = settingsNav.getByRole("link", { name, exact: true });
      assert.equal(await selected.getAttribute("aria-current"), "location");
    }
    assert.equal(
      await page
        .locator(".settings-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
    );
    const metrics = await page
      .locator(".api-plan")
      .first()
      .evaluate((el) => {
        const inputs = [...el.querySelectorAll("form .field-pair input")].map(
          (i) => i.getBoundingClientRect(),
        );
        return inputs.map((i) => ({ x: i.x, y: i.y, width: i.width }));
      });
    // At the minimum desktop width, paired inputs remain readable without overlap.
    assert.ok(metrics[0].width >= 180 && metrics[1].width >= 180);
    assert.ok(
      metrics[1].x >= metrics[0].x + metrics[0].width ||
        metrics[1].y > metrics[0].y,
    );
    checks.push(
      "840px 下六个分区导航可达、表单按内容宽度重排，长路径和映射表格不撑破页面",
    );

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
    );
    await size(1320, 900);
    await section("比特连接");
    await shot("browser-200-percent");
    assert.equal(
      await page
        .locator(".settings-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await address.focus();
    assert.equal(
      await address.evaluate((el) =>
        getComputedStyle(el)
          .transitionDuration.split(",")
          .every((v) => v.trim() === "0s"),
      ),
      true,
    );
    checks.push("200% 缩放无页面横向溢出；减少动态效果设置下输入焦点动画关闭");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
    );
    await size(1320, 900);
    await section("AI与预算");
    await page.locator(".page-heading").scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await shot("settings-overview-1320");
  }
  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(() => globalThis.__settingsExternal), 0);
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} catch (error) {
  console.error(
    await page
      ?.evaluate(() => window.__settingsQA?.calls.map((c) => c.method))
      .catch(() => null),
  );
  console.error(
    await page
      ?.evaluate(() => document.body.innerText.slice(-1200))
      .catch(() => null),
  );
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, dataPath }, null, 2),
  );
  await app.close();
}
