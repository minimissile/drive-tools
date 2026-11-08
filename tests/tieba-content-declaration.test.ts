import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import {
  ensureTiebaAiContentDeclaration,
  assertTiebaAiContentDeclaration,
} from "../core/tieba/content-declaration";
import {
  contentDeclarationFixture,
  type DeclarationFixtureMode,
} from "./tieba-content-declaration-fixture";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
});
async function fixture(
  mode: DeclarationFixtureMode = "selectable",
  suffix = "",
) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("https://tieba.baidu.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><meta charset="utf-8">${contentDeclarationFixture(mode)}${suffix}`,
    }),
  );
  const page = await context.newPage();
  await page.goto("https://tieba.baidu.com/f?kw=test");
  return {
    context,
    page,
    clicks: () =>
      page.evaluate(
        () =>
          (window as unknown as { __declarationClicks?: string[] })
            .__declarationClicks ?? [],
      ),
  };
}
test("AI声明：人工稿不碰入口，官网没有入口时沿用普通流程", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await ensureTiebaAiContentDeclaration(f.page, false),
      "not_required",
    );
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
  const g = await fixture("absent");
  try {
    assert.equal(await ensureTiebaAiContentDeclaration(g.page, true), "absent");
    assert.equal(
      await assertTiebaAiContentDeclaration(g.page, true, "absent"),
      "absent",
    );
  } finally {
    await g.context.close();
  }
});
test("AI声明：仅选准确AI项，确认后只读复验，不点击原创声明", async () => {
  const f = await fixture();
  try {
    const selected = await ensureTiebaAiContentDeclaration(f.page, true);
    assert.equal(selected, "selected");
    assert.deepEqual(await f.clicks(), ["入口", "贴子含AI内容"]);
    assert.equal(
      await assertTiebaAiContentDeclaration(f.page, true, selected),
      "selected",
    );
    await ensureTiebaAiContentDeclaration(f.page, true);
    assert.deepEqual(await f.clicks(), ["入口", "贴子含AI内容"]);
    await f.page.locator(".ai-entrance").evaluate((el) => el.remove());
    await assert.rejects(
      assertTiebaAiContentDeclaration(f.page, true, selected),
      { code: "TIEBA_AI_DECLARATION_UNCONFIRMED" },
    );
  } finally {
    await f.context.close();
  }
});
test("AI声明：多入口、多义AI项、仅原创和禁用选项均不盲点", async () => {
  for (const [mode, suffix] of [
    ["selectable", '<div class="ai-entrance">内容声明</div>'],
    ["ambiguous", ""],
    ["original-only", ""],
    ["disabled", ""],
  ] as const) {
    const f = await fixture(mode, suffix);
    try {
      await assert.rejects(ensureTiebaAiContentDeclaration(f.page, true));
      assert.ok((await f.clicks()).every((value) => value === "入口"));
    } finally {
      await f.context.close();
    }
  }
});
test("AI声明：点击后状态不可确认时停止，不把一次点击当成功", async () => {
  const f = await fixture("unconfirmed");
  try {
    await assert.rejects(ensureTiebaAiContentDeclaration(f.page, true), {
      code: "TIEBA_AI_DECLARATION_UNCONFIRMED",
    });
    assert.deepEqual(await f.clicks(), ["入口", "贴子含AI内容"]);
  } finally {
    await f.context.close();
  }
});
test("AI声明：支持明确aria选中证据，矛盾状态和非官网均拒绝", async () => {
  const f = await fixture();
  try {
    await f.page
      .locator("#ai-entrance-select-box")
      .evaluate((el) => ((el as HTMLElement).style.display = "block"));
    await f.page
      .locator(".select-box-item")
      .filter({ hasText: "贴子含AI内容" })
      .evaluate((el) => el.setAttribute("aria-selected", "true"));
    assert.equal(
      await assertTiebaAiContentDeclaration(f.page, true),
      "selected",
    );
    assert.deepEqual(await f.clicks(), []);
    await f.page
      .locator(".select-box-item")
      .filter({ hasText: "贴子原创声明" })
      .evaluate((el) => el.setAttribute("aria-selected", "true"));
    await assert.rejects(assertTiebaAiContentDeclaration(f.page, true), {
      code: "TIEBA_AI_DECLARATION_UNCONFIRMED",
    });
    await f.page.goto("about:blank");
    await assert.rejects(ensureTiebaAiContentDeclaration(f.page, true), {
      code: "TIEBA_AI_DECLARATION_ORIGIN",
    });
  } finally {
    await f.context.close();
  }
});
