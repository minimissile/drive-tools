// Browser plugin not available. Reuse the running source Vite service, a disposable
// database and mocked official browser pages; never publish to a real account.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { fixture } from "../tests/helpers.ts";
import { zhihuFixture } from "../tests/zhihu-fixture.ts";
import { zhihuBrowserFixture } from "../tests/zhihu-browser-fixture.ts";
import { zhihuBrowser, verifyZhihu } from "../core/zhihu/browser.ts";
import { createZhihuHandlers } from "../core/ipc/zhihu.ts";
const url = "http://127.0.0.1:8070";
assert.equal(
  (await fetch(`${url}/__panxu_dev`).then((r) => r.json())).root,
  process.cwd(),
);
const evidence = await mkdtemp(join(tmpdir(), "panxu-zhihu-e2e-"));
const f = await fixture(),
  x = await zhihuFixture({ db: f.app.db, dir: f.dir });
let browser,
  page,
  context,
  failRead = false,
  mode = "article",
  wirePosts = 0,
  checkpoints = 0;
let blockSave = false,
  releaseSave,
  enteredSave;
const checks = [],
  errors = [];
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
try {
  const a = await x.addAccount("知乎 · 生活记录"),
    b = await x.addAccount("知乎 · 知识分享");
  const handlers = createZhihuHandlers({ zhihu: x.service });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PANXU_QA_BROWSER ||
      join(
        process.env.HOME,
        "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
  });
  context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/v4/me")
      return route.fulfill({ json: { id: a.uid, name: "模拟知乎身份" } });
    if (u.hostname === "pic1.zhimg.com")
      return route.fulfill({ body: image, contentType: "image/png" });
    if (u.pathname === "/creator")
      return route.fulfill({
        body: "<html><body>创作等级 Lv.2</body></html>",
        contentType: "text/html; charset=utf-8",
      });
    if (route.request().method() === "POST") {
      wirePosts++;
      return route.fulfill({
        status: mode === "reject" ? 429 : 200,
        json:
          mode === "reject"
            ? { error: { message: "发布限制" } }
            : {
                id: 54321,
                author: {
                  id: mode === "wrong-author" ? "another-person" : a.uid,
                },
              },
      });
    }
    if (["www.zhihu.com", "zhuanlan.zhihu.com"].includes(u.hostname))
      return route.fulfill({
        body:
          u.pathname === "/"
            ? "<html><body>知乎首页</body></html>"
            : zhihuBrowserFixture(
                u.pathname.startsWith("/question/") ? "answer" : "article",
                mode !== "no-ai",
                mode === "dialog",
              ),
        contentType: "text/html",
      });
    throw Error(
      `Blocked unexpected external request: ${u.origin}${u.pathname}`,
    );
  });
  const adapter = zhihuBrowser((_a, action) => action(context));
  assert.equal((await verifyZhihu(context)).uid, a.uid);
  assert.equal((await adapter.progress(a)).level, 2);
  const payload = (kind = "article", ai = false) => {
    const c = x.content({
      kind,
      aiAssisted: ai,
      questionUrl:
        kind === "answer" ? "https://www.zhihu.com/question/123" : "",
    });
    return {
      task: {
        id: "fixture-task",
        uid: a.uid,
        questionId: kind === "answer" ? "123" : null,
      },
      content: c,
      images: [],
    };
  };
  assert.equal(
    (
      await adapter.publish(a, payload(), async () => {
        checkpoints++;
      })
    ).url,
    "https://zhuanlan.zhihu.com/p/54321",
  );
  const answer = payload("answer", true);
  const imagePath = join(evidence, "image.png");
  await writeFile(imagePath, image);
  answer.images = [{ path: imagePath, sha256: "fixture" }];
  assert.equal(
    (
      await adapter.publish(a, answer, async () => {
        checkpoints++;
      })
    ).url,
    "https://www.zhihu.com/question/123/answer/54321",
  );
  assert.equal(checkpoints, 2);
  mode = "dialog";
  assert.equal(
    (await adapter.publish(a, payload(), async () => {})).url,
    "https://zhuanlan.zhihu.com/p/54321",
  );
  checks.push("模拟官方身份、创作者等级、文章、回答、图片与 AI 声明发布回执");
  mode = "no-ai";
  const postsBefore = wirePosts;
  await assert.rejects(
    adapter.publish(a, payload("article", true), async () => {}),
    /AI/,
  );
  assert.equal(wirePosts, postsBefore);
  mode = "wrong-author";
  await assert.rejects(
    adapter.publish(a, payload(), async () => {}),
    /作者/,
  );
  mode = "reject";
  await assert.rejects(
    adapter.publish(a, payload(), async () => {}),
    /拒绝/,
  );
  checks.push("AI 标识缺失、作者不符、平台限流均阻止记为成功");
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === url
      ? route.continue()
      : route.abort(),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.exposeFunction("invokeQa", async (method, args) => {
    if (method === "updater.state")
      return { phase: "idle", channel: "stable", autoCheck: false };
    if (method === "zhihu.snapshot" && failRead)
      throw Error("模拟知乎读取失败");
    if (method === "zhihu.content.save" && blockSave)
      await new Promise((resolve) => {
        releaseSave = resolve;
        enteredSave?.();
      });
    if (handlers[method]) return handlers[method](args);
    if (method === "websiteAccounts.check") return x.accounts.verify(args.id);
    if (method === "websiteAccounts.login") return true;
    return f.app.invoke(method, args);
  });
  await page.addInitScript(() => {
    window.panxu = {
      invoke: (method, args) => window.invokeQa(method, args),
      onChanged: () => () => {},
      onUpdateChanged: () => () => {},
    };
    localStorage.setItem(
      "panxu-ui-v1",
      JSON.stringify({ page: "zhihu-operations" }),
    );
  });
  await page.goto(url);
  await page
    .getByRole("heading", { name: "知乎多号运营", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "启用养号计划", exact: true }).click();
  await page.getByText("养号已启用", { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "accounts-1440.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: /素材池/ }).click();
  await page
    .getByRole("textbox", { name: "标题 / 任务名称" })
    .fill("春日随笔：把普通生活记录成自己的内容");
  await page
    .getByRole("textbox", { name: /^正文/ })
    .fill(
      "这是一份本人独立创作的生活随笔，记录真实观察和感受。每天保持清晰表达，让内容自然积累。",
    );
  await page.locator(".zhihu-content-choice").first().click();
  await page.getByRole("button", { name: "新建素材", exact: true }).click();
  assert.match(
    await page.getByRole("textbox", { name: /^正文/ }).inputValue(),
    /本人独立创作/,
  );
  blockSave = true;
  const saveEntered = new Promise((resolve) => {
    enteredSave = resolve;
  });
  await page.getByRole("button", { name: "保存素材", exact: true }).click();
  await saveEntered;
  assert.equal(
    await page
      .getByRole("button", { name: "新建素材", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("textbox", { name: /^正文/ }).isDisabled(),
    true,
  );
  assert.equal(
    await page.locator(".zhihu-content-choice").first().isDisabled(),
    true,
  );
  blockSave = false;
  releaseSave();
  await page.getByRole("button", { name: "审核此版本", exact: true }).click();
  await page
    .getByRole("button", { name: "加入发布队列", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(evidence, "contents-1440.png"),
    fullPage: true,
  });
  // Unsaved text restores after a source page refresh and never restores review consent.
  await page
    .getByRole("textbox", { name: /^正文/ })
    .fill("这是一段尚未保存的长表单内容，用来核对刷新恢复行为。");
  await page.reload();
  await page.getByRole("tab", { name: /素材池/ }).click();
  assert.match(
    await page.getByRole("textbox", { name: /^正文/ }).inputValue(),
    /尚未保存/,
  );
  checks.push("源码界面：养号启用、素材保存审核、长表单刷新恢复");
  checks.push("素材切换保留新建草稿；等待保存时锁定切换与编辑，防止异步覆盖");
  const c = x.content({ title: "已审核的独立内容 · 发布流程验收" });
  const task = x.service.enqueue(b.id, c.id, new Date(x.time).toISOString());
  x.service.scheduler(true);
  await x.service.tick();
  x.service.scheduler(false);
  await page.getByRole("tab", { name: /发布队列/ }).click();
  await page
    .getByText("已收到知乎官方发布回执", { exact: true })
    .first()
    .waitFor();
  assert.equal(x.service.store.get("zhihu_tasks", task.id).status, "published");
  await page.screenshot({
    path: join(evidence, "tasks-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("tab", { name: "账号与养号" }).click();
  await page.screenshot({
    path: join(evidence, "accounts-1366.png"),
    fullPage: true,
  });
  assert.equal(
    await page
      .locator("body")
      .evaluate((e) => e.scrollWidth > window.innerWidth),
    false,
  );
  failRead = true;
  await page.getByText("模拟知乎读取失败", { exact: false }).waitFor();
  failRead = false;
  await page.getByRole("button", { name: /重试/ }).click();
  await page
    .getByText("模拟知乎读取失败", { exact: false })
    .waitFor({ state: "hidden" });
  checks.push(
    "源码界面：队列发布回执、读取失败重试、1366/1440 桌面与无横向溢出",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify({ checks, wirePosts, errors }, null, 2),
  );
  console.log(JSON.stringify({ evidence, checks, wirePosts, errors }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({
      path: join(evidence, "failure.png"),
      fullPage: true,
    });
    console.error((await page.locator("body").innerText()).slice(-3500));
  }
  console.error({ evidence, errors });
  throw error;
} finally {
  await browser?.close();
  await x.close();
  await f.cleanup();
}
