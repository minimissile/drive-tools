import type { BrowserContext, Page, Response } from "playwright-core";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../../shared/website-accounts";
import type { ZhihuBrowserPort, ZhihuPayload } from "../../shared/zhihu";
import { zhihuReceiptUrl } from "../../shared/zhihu";
import { AppError } from "../errors";
import { officialBrowserPage, findEnvironmentPage } from "../browser-pages";
import { parseZhihuCreatorScore } from "./creator-score";

const blocked = (message: string): never => {
  throw new AppError("ZHIHU_BROWSER_BLOCKED", message);
};
const official = (page: Page) =>
  officialBrowserPage(page, ["www.zhihu.com", "zhuanlan.zhihu.com"]);
const creatorLevelLink =
  'a[href="/creator/account/rights"], a[href="https://www.zhihu.com/creator/account/rights"]';

export function parseZhihuCreatorLevel(levelLinks: string[], text: string) {
  if (levelLinks.length) {
    const levels = levelLinks.map((label) => {
      const match = label
        .replace(/[\u200b-\u200d\uFEFF]/g, "")
        .trim()
        .match(/^Lv\.?\s*(\d{1,2})$/i);
      return match ? Number(match[1]) : null;
    });
    const level = levels[0] ?? null;
    return level !== null &&
      level >= 0 &&
      level <= 10 &&
      levels.every((value) => value === level)
      ? level
      : null;
  }
  const match = text.match(
    /创作(?:者)?等级\s*[:：]?\s*(?:Lv\.?\s*)?(\d{1,2})|(?:Lv\.?\s*(\d{1,2}))\s*创作者/i,
  );
  const level = match ? Number(match[1] ?? match[2]) : null;
  return level !== null && level <= 10 ? level : null;
}

export async function verifyZhihu(
  context: BrowserContext,
): Promise<WebsiteSessionState> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.zhihu.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!official(page)) blocked("知乎页面已跳转，请在比特窗口完成登录。");
    const identity = await page.evaluate(async () => {
      const r = await fetch("/api/v4/me", {
        credentials: "include",
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      const v = await r.json();
      return typeof v.id === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(v.id) &&
        typeof v.name === "string"
        ? { uid: v.id, nickname: v.name }
        : null;
    });
    return {
      hasSession: !!identity,
      uid: identity?.uid ?? null,
      nickname: identity?.nickname,
      windowOpen: false,
      error: identity
        ? null
        : "知乎身份未核实，请在比特窗口完成登录 / 安全验证后重新检查。",
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
async function assertIdentity(
  context: BrowserContext,
  account: WebsiteAccount,
) {
  const state = await verifyZhihu(context);
  if (!state.hasSession || state.uid !== account.uid)
    blocked("比特窗口中的知乎身份与任务不一致，请检查登录。");
}
async function assertPage(page: Page) {
  if (!official(page)) blocked("编辑器已离开知乎官方页面，操作暂停。");
  const text = await page.locator("body").innerText();
  if (
    /操作频繁|今日.*上限|本周.*上限|发布.*限制|账号异常|安全验证|请完成验证|验证码/.test(
      text,
    )
  )
    blocked("知乎显示验证或发布限制，请在官方窗口处理后核对任务。");
}

async function declareAi(
  page: Page,
  article: boolean,
): Promise<() => Promise<boolean>> {
  const legacy = page.getByRole("checkbox", {
    name: /AI\s*辅助|人工智能辅助/i,
  });
  if ((await legacy.count()) === 1) {
    await legacy.check();
    return () => legacy.isChecked();
  }
  if (!article)
    return blocked(
      "请在官方编辑器确认 AI 辅助声明，当前页面无法自动核实。任务已暂停。",
    );
  const selected = page
    .locator('button[role="combobox"]')
    .filter({ hasText: /包含\s*AI\s*辅助创作/ });
  if ((await selected.count()) !== 1) {
    let declaration = page
      .locator('button[role="combobox"]')
      .filter({ hasText: /^无声明$/ });
    if (!(await declaration.isVisible().catch(() => false))) {
      const settings = page.getByRole("button", {
        name: "发布设置",
        exact: true,
      });
      if ((await settings.count()) !== 1)
        return blocked("未找到创作声明入口，请核对官方编辑器。");
      await settings.click();
    }
    // The settings panel mounts asynchronously after the click on a fresh editor.
    await declaration.waitFor({ state: "visible", timeout: 10000 });
    if ((await declaration.count()) !== 1)
      return blocked("创作声明状态无法识别，停止提交。");
    const option = page.getByRole("option", { name: /^包含\s*AI\s*辅助创作/ });
    if (!(await option.isVisible().catch(() => false)))
      await declaration.click();
    await option.waitFor({ state: "visible", timeout: 10000 });
    if ((await option.count()) !== 1)
      return blocked("未找到唯一的 AI 辅助创作声明选项。");
    await option.click();
    await selected.waitFor({ state: "visible", timeout: 10000 });
  }
  return async () =>
    (await selected.count()) === 1 && (await selected.isVisible());
}

/** Only a response to this editor's exact mutation may complete a publication. */
export function parseZhihuReceipt(body: unknown, payload: ZhihuPayload) {
  const v = body as {
    id?: string | number;
    author?: { id?: string };
    url?: string;
    error?: unknown;
  };
  if (
    !v ||
    v.error ||
    String(v.author?.id ?? "") !== payload.task.uid ||
    !/^\d+$/.test(String(v.id ?? ""))
  )
    blocked("知乎未返回作者匹配的明确回执，请核对官方页面，避免重复发布。");
  const url =
    payload.content.kind === "article"
      ? `https://zhuanlan.zhihu.com/p/${v.id}`
      : `https://www.zhihu.com/question/${payload.task.questionId}/answer/${v.id}`;
  if (!zhihuReceiptUrl(url, payload.content.kind))
    blocked("知乎发布回执链接无效。");
  return { url };
}
export function matchesPublishedZhihuArticle(
  value: {
    id?: unknown;
    state?: unknown;
    uid?: unknown;
    title?: unknown;
    body?: unknown;
    images?: unknown;
  } | null,
  articleId: string,
  payload: ZhihuPayload,
) {
  return (
    !!value &&
    String(value.id) === articleId &&
    value.state === "published" &&
    value.uid === payload.task.uid &&
    value.title === payload.content.title &&
    typeof value.body === "string" &&
    value.body.replace(/\s/g, "") === payload.content.body.replace(/\s/g, "") &&
    value.images === payload.images.length
  );
}
export function zhihuBrowser(
  withContext: <T>(
    account: WebsiteAccount,
    action: (context: BrowserContext) => Promise<T>,
  ) => Promise<T>,
): ZhihuBrowserPort {
  return {
    progress: (account) =>
      withContext(account, async (context) => {
        await assertIdentity(context, account);
        const page = await findEnvironmentPage(
          context,
          `panxu:zhihu-creator:${account.id}`,
          "https://www.zhihu.com/creator",
        );
        try {
          await page.goto("https://www.zhihu.com/creator", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await page.bringToFront();
          await assertPage(page);
          // The creator shell can arrive before the account's own level link.
          await page
            .waitForFunction(
              (selector) => {
                const text = document.body.innerText;
                return (
                  document.querySelector(selector) ||
                  /创作(?:者)?等级\s*[:：]?\s*(?:Lv\.?\s*)?\d|Lv\.?\s*\d{1,2}\s*创作者/i.test(
                    text,
                  ) ||
                  /申请入驻|立即入驻|开通创作者|安全验证|请完成验证|验证码/.test(
                    text,
                  )
                );
              },
              creatorLevelLink,
              { timeout: 10000 },
            )
            .catch(() => {});
          await assertPage(page);
          // Keep enrollment detection on the landing page. Only enrolled
          // accounts proceed to the score page; missing scores stay unknown.
          const text = await page.locator("body").innerText();
          const level = parseZhihuCreatorLevel(
            await page.locator(creatorLevelLink).allInnerTexts(),
            text,
          );
          let scores = parseZhihuCreatorScore("");
          if (level !== null) {
            await page.goto(
              "https://www.zhihu.com/creator/account/growth-level",
              {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              },
            );
            await assertPage(page);
            await page
              .getByText("当前创作分", { exact: true })
              .waitFor({
                state: "visible",
                timeout: 10000,
              })
              .catch(() => {});
            await assertPage(page);
            const scoreText = await page.locator("body").innerText();
            // The score page also links to rights as “当前已开通权益”.
            const scoreLevel = parseZhihuCreatorLevel(
              await page
                .locator(creatorLevelLink)
                .filter({ hasText: /^\s*Lv\.?\s*\d/i })
                .allInnerTexts(),
              scoreText,
            );
            if (scoreLevel === level)
              scores = parseZhihuCreatorScore(scoreText);
          }
          return {
            creator:
              level !== null
                ? true
                : /申请入驻|立即入驻|开通创作者/.test(text)
                  ? false
                  : null,
            level,
            ...scores,
            source: "official",
            checkedAt: new Date().toISOString(),
            note:
              level !== null
                ? scores.score !== null
                  ? "从官方创作者等级页读取等级与创作分"
                  : "官方等级已识别，创作分暂未读取，可重试"
                : "页面未提供可可靠识别的等级，请查看官方页面后手动记录",
          };
        } finally {
          /* Keep the creator page available for the user's inspection. */
        }
      }),
    publish: (account, payload, beforeSubmit, onEvent) =>
      withContext(account, async (context) => {
        await assertIdentity(context, account);
        const { content, task } = payload;
        // Only an explicitly retried, never-submitted task may reuse its own editor.
        let resumed: Page | undefined;
        if (task.attemptedAt && !task.submittedAt) {
          const owned = [];
          for (const candidate of context.pages())
            if (
              official(candidate) &&
              (await candidate.evaluate(() => window.name).catch(() => "")) ===
                `panxu:zhihu-publish:${task.id}`
            )
              owned.push(candidate);
          if (owned.length > 1)
            return blocked("发现多个原任务编辑器，请核对后继续。");
          resumed = owned[0];
        }
        const page = resumed ?? (await context.newPage());
        let submitted = false;
        let submittedArticleId: string | undefined;
        try {
          if (!resumed)
            await page.goto(
              content.kind === "article"
                ? "https://zhuanlan.zhihu.com/write"
                : `https://www.zhihu.com/question/${task.questionId}`,
              { waitUntil: "domcontentloaded", timeout: 30000 },
            );
          await page.bringToFront();
          await page.evaluate((name) => {
            window.name = name;
          }, `panxu:zhihu-publish:${task.id}`);
          onEvent?.({
            event: "editor.opened",
            message: "已打开本任务的官方编辑器",
            details: { url: page.url() },
          });
          await assertPage(page);
          if (content.kind === "answer") {
            const write = page.getByRole("button", { name: /^写回答$/ });
            if ((await write.count()) !== 1)
              blocked("未找到唯一的写回答入口，可能已回答或页面结构变化。");
            await write.click();
          } else {
            const title = page.locator(
              'textarea[placeholder*="标题"], input[placeholder*="标题"]',
            );
            await title.waitFor({ state: "visible", timeout: 15000 });
            if ((await title.count()) !== 1)
              blocked("未找到知乎文章标题输入框，请人工检查。");
            if (
              (await title.inputValue()).trim() &&
              (!resumed || (await title.inputValue()) !== content.title)
            )
              blocked("知乎恢复了已有草稿，请保留原内容并人工处理。");
            await title.fill(content.title);
          }
          const editor = page.locator(
            '.DraftEditor-root [contenteditable="true"], .ProseMirror[contenteditable="true"], .public-DraftEditor-content[contenteditable="true"]',
          );
          await editor.waitFor({ state: "visible", timeout: 15000 });
          if ((await editor.count()) !== 1)
            blocked("未找到唯一的知乎正文编辑器，页面可能已变化。");
          const previousBody = (await editor.innerText()).trim();
          if (
            (previousBody || (await editor.locator("img").count())) &&
            (!resumed ||
              previousBody.replace(/\s+/g, " ") !==
                content.body.replace(/\s+/g, " ").trim() ||
              (await editor.locator("img").count()) !== payload.images.length)
          )
            blocked("编辑器已有内容，未覆盖，请人工检查草稿。");
          if (!previousBody) await editor.fill(content.body);
          onEvent?.({
            event: "editor.filled",
            message: "标题与正文已填写",
            details: {
              characters: content.body.length,
              images: payload.images.length,
            },
          });
          if (payload.images.length && !resumed) {
            const fileInput = page.locator(
              'input[type="file"][accept*="image"]',
            );
            if ((await fileInput.count()) !== 1)
              blocked("未找到唯一的图片上传入口，请在官方窗口处理。");
            await fileInput.setInputFiles(payload.images.map((i) => i.path));
            await page.waitForFunction(
              (count) =>
                Array.from(
                  document.querySelectorAll(
                    ".DraftEditor-root img, .ProseMirror img",
                  ),
                ).filter(
                  (i) =>
                    /^https:\/\//.test((i as HTMLImageElement).src) &&
                    (i as HTMLImageElement).complete,
                ).length >= count,
              payload.images.length,
              { timeout: 30000 },
            );
          }
          const aiConfirmed = content.aiAssisted
            ? await declareAi(page, content.kind === "article")
            : async () => true;
          if (!(await aiConfirmed())) blocked("AI 辅助声明未确认，停止提交。");
          if (content.aiAssisted)
            onEvent?.({
              event: "editor.ai-declared",
              message: "已核实官方 AI 辅助创作声明",
            });
          const assertContent = async () => {
            await assertPage(page);
            if (
              (await editor.innerText()).replace(/\s+/g, " ").trim() !==
              content.body.replace(/\s+/g, " ").trim()
            )
              blocked("编辑器正文与已审核素材不一致，停止提交。");
            if ((await editor.locator("img").count()) !== payload.images.length)
              blocked("编辑器配图数量与审核素材不一致，停止提交。");
            if (content.aiAssisted && !(await aiConfirmed()))
              blocked("AI 辅助声明已变化，停止提交。");
            if (
              content.kind === "article" &&
              (await page
                .locator(
                  'textarea[placeholder*="标题"], input[placeholder*="标题"]',
                )
                .inputValue()) !== content.title
            )
              blocked("编辑器标题已变化，停止提交。");
          };
          await assertContent();
          const submit = page
            .getByRole("button", {
              name:
                content.kind === "article" ? /^(发布文章|发布)$/ : /^发布回答$/,
            })
            .filter({ visible: true });
          if ((await submit.count()) !== 1 || !(await submit.isEnabled()))
            blocked("未找到可用的发布按钮，请人工检查编辑器。");
          await assertIdentity(context, account);
          await assertContent();
          submittedArticleId =
            content.kind === "article"
              ? new URL(page.url()).pathname.match(/^\/p\/(\d+)\/edit$/)?.[1]
              : undefined;
          await beforeSubmit();
          submitted = true;
          let observed: Response | undefined;
          const receipt = page.waitForResponse(
            (response) => {
              const u = new URL(response.url()),
                request = response.request();
              const path =
                content.kind === "article"
                  ? /^\/api\/articles\/\d+\/publish$/
                  : new RegExp(
                      `^/api/v4/questions/${task.questionId}/answers$`,
                    );
              if (
                u.protocol !== "https:" ||
                u.port ||
                !["www.zhihu.com", "zhuanlan.zhihu.com"].includes(u.hostname) ||
                !path.test(u.pathname) ||
                request.method() !== "POST"
              )
                return false;
              observed = response;
              return true;
            },
            { timeout: 35000 },
          );
          void receipt.catch(() => {});
          await submit.click({ timeout: 10000 });
          if (content.kind === "article") {
            const dialog = page.getByRole("dialog");
            const hasDialog = await dialog
              .waitFor({ state: "visible", timeout: 2000 })
              .then(
                () => true,
                () => false,
              );
            if (hasDialog && !observed) {
              const confirm = dialog.getByRole("button", {
                name: /^(发布文章|确认发布|发布)$/,
              });
              if ((await confirm.count()) !== 1 || !(await confirm.isEnabled()))
                blocked("发布设置未完成，请在知乎窗口核对后处理。");
              await assertIdentity(context, account);
              await assertContent();
              await beforeSubmit();
              await confirm.click({ timeout: 10000 });
            }
          }
          const response = await receipt;
          if (!observed || !response.ok())
            blocked("知乎拒绝提交或触发限制，请核对官方页面。");
          const body = await response.json();
          onEvent?.({
            event: "publish.response",
            message: "收到本任务发布请求的响应",
            details: {
              status: response.status(),
              keys: Object.keys(body),
              id: body.id ?? body.data?.id ?? null,
              url: body.url ?? body.data?.url ?? null,
              authorMatches:
                (body.author?.id ?? body.data?.author?.id) === task.uid,
            },
          });
          const result = parseZhihuReceipt(body, payload);
          await page.close().catch(() => {});
          return result;
        } catch (error) {
          // A newer editor can complete publication through a different mutation.
          // Verify the exact owned draft's published state, author and full content;
          // never infer success from navigation or a toast alone, and never resend.
          if (
            submitted &&
            submittedArticleId &&
            page.url() === `https://zhuanlan.zhihu.com/p/${submittedArticleId}`
          ) {
            const published = await page
              .evaluate(
                async ({ id }) => {
                  const response = await fetch(`/api/articles/${id}`, {
                    credentials: "include",
                    signal: AbortSignal.timeout(15000),
                  });
                  if (!response.ok) return null;
                  const value = await response.json();
                  const document = new DOMParser().parseFromString(
                    String(value.content ?? ""),
                    "text/html",
                  );
                  return {
                    id: value.id,
                    state: value.state,
                    uid: value.author?.id,
                    title: value.title,
                    body: document.body.textContent ?? "",
                    images: document.querySelectorAll("img").length,
                  };
                },
                {
                  id: submittedArticleId,
                },
              )
              .catch(() => null);
            if (
              matchesPublishedZhihuArticle(
                published,
                submittedArticleId,
                payload,
              )
            ) {
              onEvent?.({
                event: "publish.verified",
                message:
                  "已由官方文章状态核实发布成功：作者、标题、正文与原任务一致",
                details: { url: page.url() },
              });
              return { url: page.url() };
            }
          }
          const diagnostic = await page
            .evaluate(() => ({
              url: location.href,
              buttons: Array.from(document.querySelectorAll("button"))
                .filter((e) => e.getBoundingClientRect().width > 0)
                .map((e) => e.innerText || e.getAttribute("aria-label"))
                .slice(0, 60),
              checkboxes: Array.from(
                document.querySelectorAll(
                  'input[type="checkbox"],[role="checkbox"],[role="switch"]',
                ),
              ).map((e) => ({
                label:
                  e.getAttribute("aria-label") ||
                  e.parentElement?.textContent?.slice(0, 100),
                role: e.getAttribute("role"),
                checked: e.getAttribute("aria-checked"),
              })),
              editables: Array.from(
                document.querySelectorAll('[contenteditable="true"]'),
              ).map((e) => ({
                tag: e.tagName,
                classes: e.className,
                length: (e.textContent ?? "").length,
              })),
              notices: Array.from(
                document.querySelectorAll('[role="alert"],[role="dialog"]'),
              )
                .map((e) => e.textContent?.slice(0, 800))
                .slice(0, 5),
            }))
            .catch(() => ({ unavailable: true }));
          onEvent?.({
            event: "editor.diagnostic",
            message: "编辑器未完成，保留本任务页面供核对",
            details: diagnostic,
          });
          if (
            submitted &&
            error instanceof Error &&
            error.message.includes("Timeout")
          )
            blocked(
              "未取得明确发布回执，请核对保留的官方页面；结果未知，不会自动重发。",
            );
          throw error;
        }
      }),
  };
}
