import type { BrowserContext, Page, Response } from "playwright-core";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../../shared/website-accounts";
import type { ZhihuBrowserPort, ZhihuPayload } from "../../shared/zhihu";
import { zhihuReceiptUrl } from "../../shared/zhihu";
import { AppError } from "../errors";
import { officialBrowserPage, findEnvironmentPage } from "../browser-pages";

const blocked = (message: string): never => {
  throw new AppError("ZHIHU_BROWSER_BLOCKED", message);
};
const official = (page: Page) =>
  officialBrowserPage(page, ["www.zhihu.com", "zhuanlan.zhihu.com"]);
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
      const r = await fetch("/api/v4/me", { credentials: "include" });
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
          const text = await page.locator("body").innerText();
          const match = text.match(
            /创作(?:者)?等级\s*[:：]?\s*(?:Lv\.?\s*)?(\d{1,2})|(?:Lv\.?\s*(\d{1,2}))\s*创作者/i,
          );
          const level = match ? Number(match[1] ?? match[2]) : null;
          return {
            creator:
              level !== null
                ? true
                : /申请入驻|立即入驻|开通创作者/.test(text)
                  ? false
                  : null,
            level: level !== null && level <= 10 ? level : null,
            source: "official",
            checkedAt: new Date().toISOString(),
            note:
              level !== null
                ? "从官方创作者页面识别"
                : "页面未提供可可靠识别的等级，请查看官方页面后手动记录",
          };
        } finally {
          /* Keep the creator page available for the user's inspection. */
        }
      }),
    publish: (account, payload, beforeSubmit) =>
      withContext(account, async (context) => {
        await assertIdentity(context, account);
        const { content, task } = payload;
        // Never reuse a human's editor or a previous ambiguous submission.
        const page = await context.newPage();
        await page.goto(
          content.kind === "article"
            ? "https://zhuanlan.zhihu.com/write"
            : `https://www.zhihu.com/question/${task.questionId}`,
          { waitUntil: "domcontentloaded", timeout: 30000 },
        );
        await page.bringToFront();
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
          if ((await title.count()) !== 1)
            blocked("未找到知乎文章标题输入框，请人工检查。");
          if ((await title.inputValue()).trim())
            blocked("知乎恢复了已有草稿，请保留原内容并人工处理。");
          await title.fill(content.title);
        }
        const editor = page.locator(
          '.DraftEditor-root [contenteditable="true"], .ProseMirror[contenteditable="true"], .public-DraftEditor-content[contenteditable="true"]',
        );
        if ((await editor.count()) !== 1)
          blocked("未找到唯一的知乎正文编辑器，页面可能已变化。");
        if (
          (await editor.innerText()).trim() ||
          (await editor.locator("img").count())
        )
          blocked("编辑器已有内容，未覆盖，请人工检查草稿。");
        await editor.fill(content.body);
        if (payload.images.length) {
          const fileInput = page.locator('input[type="file"][accept*="image"]');
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
        if (content.aiAssisted) {
          const ai = page.getByRole("checkbox", {
            name: /AI\s*辅助|人工智能辅助/i,
          });
          if ((await ai.count()) !== 1)
            blocked(
              "请在官方编辑器确认 AI 辅助声明，当前页面无法自动核实。任务已暂停。",
            );
          await ai.check();
          if (!(await ai.isChecked())) blocked("AI 辅助声明未确认，停止提交。");
        }
        const assertContent = async () => {
          await assertPage(page);
          if (
            (await editor.innerText()).replace(/\s+/g, " ").trim() !==
            content.body.replace(/\s+/g, " ").trim()
          )
            blocked("编辑器正文与已审核素材不一致，停止提交。");
          if ((await editor.locator("img").count()) !== payload.images.length)
            blocked("编辑器配图数量与审核素材不一致，停止提交。");
          if (
            content.aiAssisted &&
            !(await page
              .getByRole("checkbox", { name: /AI\s*辅助|人工智能辅助/i })
              .isChecked())
          )
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
        await beforeSubmit();
        let observed: Response | undefined;
        const receipt = page.waitForResponse(
          (response) => {
            const u = new URL(response.url()),
              request = response.request();
            const path =
              content.kind === "article"
                ? /^\/api\/articles\/\d+\/publish$/
                : new RegExp(`^/api/v4/questions/${task.questionId}/answers$`);
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
        const result = parseZhihuReceipt(await response.json(), payload);
        await page.close().catch(() => {});
        return result;
      }),
  };
}
