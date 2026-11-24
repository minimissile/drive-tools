import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { AppError } from "../core/errors";
import { zhihuBrowser } from "../core/zhihu/browser";
import { ZhihuOperations } from "../core/zhihu/service";
import { zhihuTaskNeedsReconciliation } from "../shared/zhihu";
import { zhihuBrowserFixture } from "./zhihu-browser-fixture";
import { zhihuFixture } from "./zhihu-fixture";

const questionUrl = "https://www.zhihu.com/question/123";
const declarationError = "ZHIHU_AI_DECLARATION_UNAVAILABLE";
const legacyMessage =
  "请在官方编辑器确认 AI 辅助声明，当前页面无法自动核实。任务已暂停。";

test("知乎：仅已知未提交的旧回答声明失败解除账号级阻断", async () => {
  const f = await zhihuFixture();
  let restarted: ZhihuOperations | undefined;
  try {
    const account = await f.addAccount();
    const content = f.content({
      kind: "answer",
      questionUrl,
      aiAssisted: true,
    });
    const task = f.service.enqueue(
      account.id,
      content.id,
      new Date(f.time).toISOString(),
    );
    const legacy = {
      ...task,
      status: "attention" as const,
      attemptedAt: task.scheduledAt,
      message: legacyMessage,
    };
    f.service.store.save("zhihu_tasks", task.id, legacy);
    for (const variant of [
      { id: "zhtask_submitted", submittedAt: task.scheduledAt },
      { id: "zhtask_unproven", message: "提交结果未知" },
      { id: "zhtask_article", kind: "article" as const },
    ])
      f.service.store.save("zhihu_tasks", variant.id, {
        ...legacy,
        ...variant,
      });

    f.service.close();
    restarted = new ZhihuOperations({
      db: f.db,
      accounts: f.accounts,
      environments: f.environments,
      queue: f.queue,
      ports: f.ports,
      dataPath: f.dir,
      changed: () => {},
    });
    const migrated = restarted.store.get("zhihu_tasks", task.id);
    assert.equal(zhihuTaskNeedsReconciliation(migrated), false);
    assert.deepEqual(migrated, {
      ...legacy,
      failure: {
        phase: "before_submit",
        code: declarationError,
        at: task.scheduledAt,
      },
    });
    for (const id of ["zhtask_submitted", "zhtask_unproven", "zhtask_article"])
      assert.equal(
        zhihuTaskNeedsReconciliation(restarted.store.get("zhihu_tasks", id)),
        true,
      );
    assert.equal(f.submissions, 0);
  } finally {
    restarted?.close();
    await f.close();
  }
});

test("知乎：新声明失败保留原任务但不进入提交核对", async () => {
  const f = await zhihuFixture();
  try {
    const account = await f.addAccount();
    const content = f.content({
      kind: "answer",
      questionUrl,
      aiAssisted: true,
    });
    const task = f.service.enqueue(
      account.id,
      content.id,
      new Date(f.time).toISOString(),
    );
    f.before(async () => {
      throw new AppError(declarationError, "模拟声明无法确认");
    });
    f.service.scheduler(true);
    await f.service.tick();
    const failed = f.service.store.get("zhihu_tasks", task.id);
    assert.equal(failed.status, "attention");
    assert.equal(failed.submittedAt, undefined);
    assert.equal(failed.failure?.phase, "before_submit");
    assert.equal(failed.failure?.code, declarationError);
    assert.equal(zhihuTaskNeedsReconciliation(failed), false);
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

const modernSettings = `
  <button id="settings">发布设置</button>
  <div id="panel"></div>
  <script>
    document.getElementById('settings').onclick = () => setTimeout(() => {
      const panel = document.getElementById('panel');
      panel.innerHTML = '<button role="combobox" aria-expanded="false">无声明</button>';
      const control = panel.querySelector('button');
      control.onclick = () => {
        control.setAttribute('aria-expanded', 'true');
        const list = document.createElement('div');
        list.setAttribute('role', 'listbox');
        list.innerHTML = '<button role="option">包含 AI 辅助创作</button>';
        list.firstChild.onclick = () => {
          control.textContent = '包含 AI 辅助创作';
          control.setAttribute('aria-expanded', 'false');
          list.remove();
        };
        panel.append(list);
      };
    }, 50);
  </script>`;

const browserPath = process.env.PANXU_QA_BROWSER ?? chromium.executablePath();

test(
  "知乎：回答新版和旧版声明均须确认，缺失声明阻止提交",
  {
    skip: !existsSync(browserPath) && "需要本地 Chromium",
  },
  async (t) => {
    const f = await zhihuFixture();
    try {
      const account = await f.addAccount();
      const content = f.content({
        kind: "answer",
        questionUrl,
        aiAssisted: true,
      });
      const task = f.service.enqueue(
        account.id,
        content.id,
        new Date(f.time).toISOString(),
      );
      const browser = await chromium.launch({
        headless: true,
        executablePath: browserPath,
      });
      try {
        for (const mode of [
          "modern",
          "legacy",
          "missing",
          "ambiguous",
        ] as const)
          await t.test(mode, async () => {
            // This standalone context uses only fixture responses. No real cookies
            // or requests belong to it, including requests opened by the adapter.
            const context = await browser.newContext({
              serviceWorkers: "block",
            });
            try {
              let checkpoints = 0;
              let posts = 0;
              const fixture = zhihuBrowserFixture("answer", mode === "legacy");
              const markup =
                mode === "modern"
                  ? modernSettings
                  : mode === "ambiguous"
                    ? "<button>发布设置</button><button>发布设置</button>"
                    : "";
              await context.route("**/*", (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== "https://www.zhihu.com")
                  return route.abort();
                if (url.pathname === "/api/v4/me")
                  return route.fulfill({
                    json: { id: account.uid, name: "模拟账号" },
                  });
                if (
                  url.pathname === "/api/v4/questions/123/answers" &&
                  route.request().method() === "POST"
                ) {
                  posts++;
                  return route.fulfill({
                    json: { id: 789, author: { id: account.uid } },
                  });
                }
                if (url.pathname === "/question/123")
                  return route.fulfill({
                    body: fixture.replace(
                      '<button id="publish">',
                      `${markup}<button id="publish">`,
                    ),
                    contentType: "text/html; charset=utf-8",
                  });
                if (url.pathname === "/")
                  return route.fulfill({
                    body: "<body>模拟首页</body>",
                    contentType: "text/html; charset=utf-8",
                  });
                return route.abort();
              });
              const adapter = zhihuBrowser((_account, action) =>
                action(context),
              );
              const publish = adapter.publish(
                account,
                { task, content, images: [] },
                async () => {
                  checkpoints++;
                  const pages = context
                    .pages()
                    .filter((page) => page.url() === questionUrl);
                  assert.equal(pages.length, 1);
                  const page = pages[0];
                  if (mode === "modern")
                    assert.match(
                      await page.getByRole("combobox").innerText(),
                      /包含 AI 辅助创作/,
                    );
                  else
                    assert.equal(
                      await page
                        .getByRole("checkbox", { name: "包含AI辅助创作" })
                        .isChecked(),
                      true,
                    );
                },
              );
              if (mode === "missing" || mode === "ambiguous") {
                await assert.rejects(publish, { code: declarationError });
                assert.equal(checkpoints, 0);
                assert.equal(posts, 0);
              } else {
                assert.equal((await publish).url, `${questionUrl}/answer/789`);
                assert.equal(checkpoints, 1);
                assert.equal(posts, 1);
              }
            } finally {
              await context.close();
            }
          });
      } finally {
        await browser.close();
      }
    } finally {
      await f.close();
    }
  },
);
