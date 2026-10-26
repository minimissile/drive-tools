import type { BrowserContext, Page, Request } from "playwright-core";
import { BitBrowser, assertEditorPage } from "../bitbrowser";
import { AppError } from "../errors";
import { bindingEditorUrl } from "../../shared/channels";
import type { BrowserBinding } from "../../shared/types";
import type {
  CsdnEditorPayload,
  CsdnSubmitReceipt,
} from "../../shared/csdn-workflow";
import type { CsdnEditor } from "./workflow";

const modalSelector = ".modal__publish-article";
const normalizeBody = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();
const normalizeTag = (value: string) =>
  value.trim().replace(/^#/, "").toLowerCase();
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Selectors and receipt shape checked against CSDN's public Markdown editor, 2026-10-21.
 * Uses the official UI; never signs, replays or invents a publishing API request.
 */
export class CsdnBrowserEditor implements CsdnEditor {
  constructor(private bit: Pick<BitBrowser, "withContext">) {}
  private async identity(context: BrowserContext, payload: CsdnEditorPayload) {
    const cookie = (await context.cookies("https://editor.csdn.net/")).find(
      (c) => c.name === "UserName",
    );
    let username = "";
    try {
      username = decodeURIComponent(cookie?.value ?? "");
    } catch {
      /* Invalid cookie is not an identity. */
    }
    if (!username)
      throw new AppError(
        "CSDN_LOGIN_REQUIRED",
        "请在指定比特窗口登录 CSDN，然后重试自动填写。",
      );
    if (username.toLowerCase() !== payload.author.toLowerCase())
      throw new AppError(
        "CSDN_ACCOUNT_MISMATCH",
        "比特窗口当前登录的 CSDN 用户名与任务配置不一致，请核对账号。",
      );
  }
  private async taskPage(
    context: BrowserContext,
    payload: Pick<CsdnEditorPayload, "pageKey">,
  ) {
    for (const page of context.pages()) {
      if (!/^https:\/\/(editor|mp)\.csdn\.net\//.test(page.url())) continue;
      if (
        (await page.evaluate(() => window.name).catch(() => "")) ===
        payload.pageKey
      )
        return page;
    }
    return null;
  }
  private assertPage(page: Page, binding: BrowserBinding) {
    assertEditorPage(bindingEditorUrl(binding, "article"), page.url());
  }
  async inspect(binding: BrowserBinding, pageKey: string) {
    await this.bit.withContext(binding, async (context) => {
      const existing = await this.taskPage(context, { pageKey });
      const page = existing ?? (await context.newPage());
      if (!existing)
        await page.goto("https://mp.csdn.net/mp_blog/manage/article", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      await page.bringToFront();
    });
  }
  private async readBody(page: Page) {
    // Read the editor's own text model to preserve fenced code and trailing newlines.
    return page.evaluate(() => {
      const root = document.querySelector("#app") as HTMLElement & {
        __vue__?: { $store?: { getters: Record<string, { text?: string }> } };
      };
      return (
        root?.__vue__?.$store?.getters["content/current"]?.text ??
        document.querySelector<HTMLElement>(".editor__inner")?.innerText ??
        ""
      );
    });
  }
  private async assertContent(page: Page, payload: CsdnEditorPayload) {
    const title = await page.locator("input.article-bar__title").inputValue();
    const body = await this.readBody(page);
    if (
      title !== payload.title ||
      normalizeBody(body) !== normalizeBody(payload.body)
    )
      throw new AppError(
        "CSDN_EDITOR_CHANGED",
        "CSDN 编辑器内容与已审阅稿件不一致，请保留现场并重新核对，未提交。",
      );
    const modal = page.locator(modalSelector);
    const tags = (await modal.locator(".tag__name").allTextContents())
      .map((tag) => tag.trim())
      .filter(Boolean);
    const sorted = (tags: string[]) =>
      JSON.stringify([...new Set(tags.map(normalizeTag))].sort());
    if (sorted(tags) !== sorted(payload.tags))
      throw new AppError(
        "CSDN_TAGS_CHANGED",
        "平台标签与当前稿件不一致，请核对站内已有标签并重新填写。",
      );
    const description = modal.locator(".form-entry").filter({
      has: page.locator("label.form-entry__label", { hasText: "文章摘要" }),
    });
    if (
      (await description.locator("textarea").inputValue()).trim() !==
      payload.summary
    )
      throw new AppError(
        "CSDN_SUMMARY_CHANGED",
        "平台摘要与任务设置不一致，请重新填写。",
      );
    if (
      !(await modal.locator("input#public").isChecked()) ||
      !(await modal.locator("input#original").isChecked())
    )
      throw new AppError(
        "CSDN_VISIBILITY_CHANGED",
        "请使用原创、全部可见的教程发布设置。",
      );
    const declaration = await modal
      .locator(".creation-statement-select input")
      .inputValue();
    if (
      declaration !== (payload.aiAssisted ? "部分内容由AI辅助生成" : "无声明")
    )
      throw new AppError(
        "CSDN_AI_LABEL_CHANGED",
        "CSDN 创作声明与稿件生成方式不一致，请重新填写。",
      );
    const backup = modal.locator('.gitcode-box input[type="checkbox"]');
    if ((await backup.count()) && (await backup.isChecked()))
      throw new AppError(
        "CSDN_BACKUP_SELECTED",
        "请取消额外的 GitCode 备份后再提交本次 CSDN 文章。",
      );
  }
  async prepare(binding: BrowserBinding, payload: CsdnEditorPayload) {
    await this.bit.withContext(binding, async (context) => {
      await this.identity(context, payload);
      let page = await this.taskPage(context, payload);
      if (!page) {
        page = await context.newPage();
        const response = await page.goto(bindingEditorUrl(binding, "article"), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        assertEditorPage(
          bindingEditorUrl(binding, "article"),
          page.url(),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
          response?.status(),
        );
        await page.evaluate((name) => {
          window.name = name;
        }, payload.pageKey);
      }
      this.assertPage(page, binding);
      await page.bringToFront();
      page.setDefaultTimeout(10_000);
      if (!(await page.locator(modalSelector).isVisible())) {
        const display = page.locator(".article-bar__title-display");
        if (await display.isVisible()) await display.click();
        const title = page.locator("input.article-bar__title");
        await title.waitFor({ state: "visible" });
        const previousTitle = await title.inputValue(),
          previousBody = await this.readBody(page);
        if (
          (previousTitle && previousTitle !== payload.title) ||
          (previousBody.trim() &&
            normalizeBody(previousBody) !== normalizeBody(payload.body))
        )
          throw new AppError(
            "CSDN_EXISTING_CONTENT",
            "任务窗口已有不同内容，为保留现场已暂停；请在窗口核对后恢复本任务稿件。",
          );
        await title.fill(payload.title);
        await title.press("Enter");
        await page
          .locator('.editor__inner[contenteditable="true"]')
          .fill(payload.body);
        await page.waitForFunction(
          (expected) => {
            const root = document.querySelector("#app") as HTMLElement & {
              __vue__?: {
                $store?: { getters: Record<string, { text?: string }> };
              };
            };
            const text =
              root?.__vue__?.$store?.getters["content/current"]?.text ??
              document.querySelector<HTMLElement>(".editor__inner")
                ?.innerText ??
              "";
            return (
              text.replace(/\r\n/g, "\n").trimEnd() ===
              expected.replace(/\r\n/g, "\n").trimEnd()
            );
          },
          payload.body,
          { timeout: 5000 },
        );
        await page.locator(".btn-publish").click();
      }
      const modal = page.locator(modalSelector);
      await modal.waitFor({ state: "visible" });
      // Only this task's own editor is changed; no existing user editor is reused.
      const tagRow = modal.locator(".form-entry").filter({
        has: page.locator("label.form-entry__label", { hasText: "文章标签" }),
      });
      const deletes = tagRow.locator(".tag__btn-tag-delete");
      while (await deletes.count()) await deletes.first().click();
      for (const tag of payload.tags) {
        const add = tagRow.getByRole("button", { name: /添加文章标签/ });
        if (await add.isVisible()) await add.click();
        const searchTag = tag.trim().replace(/^#/, "");
        await tagRow.locator(".mark_selection_box input").fill(searchTag);
        const suggestion = page
          .locator(".el-autocomplete-suggestion li")
          .filter({
            hasText: new RegExp(`^\\s*${escapeRegExp(searchTag)}\\s*$`, "i"),
          })
          .first();
        try {
          await suggestion.waitFor({ state: "visible", timeout: 5000 });
        } catch {
          throw new AppError(
            "CSDN_TAG_REQUIRES_REVIEW",
            `未找到站内已有标签“${tag}”，请在 CSDN 窗口核对标签，并在盘序修改、审阅后重新填写。`,
          );
        }
        await suggestion.click();
      }
      const description = modal.locator(".form-entry").filter({
        has: page.locator("label.form-entry__label", { hasText: "文章摘要" }),
      });
      await description.locator("textarea").fill(payload.summary);
      if (!(await modal.locator("input#original").isChecked()))
        await modal.locator('label[for="original"]').click();
      if (!(await modal.locator("input#public").isChecked()))
        await modal.locator('label[for="public"]').click();
      await modal.locator(".creation-statement-select").click();
      await page
        .locator(".el-select-dropdown:visible .el-select-dropdown__item")
        .filter({
          hasText: new RegExp(
            `^\\s*${payload.aiAssisted ? "部分内容由AI辅助生成" : "无声明"}\\s*$`,
          ),
        })
        .click();
      const backup = modal.locator('.gitcode-box input[type="checkbox"]');
      if ((await backup.count()) && (await backup.isChecked()))
        await backup.locator("..").click();
      await this.identity(context, payload);
      await this.assertContent(page, payload);
    });
  }
  async submit(
    binding: BrowserBinding,
    payload: CsdnEditorPayload,
    beforeSubmit: () => Promise<void>,
  ): Promise<CsdnSubmitReceipt> {
    return this.bit.withContext(binding, async (context) => {
      await this.identity(context, payload);
      const page = await this.taskPage(context, payload);
      if (!page)
        throw new AppError(
          "CSDN_EDITOR_MISSING",
          "任务编辑窗口已关闭，请重新自动填写。",
        );
      this.assertPage(page, binding);
      await page.bringToFront();
      await this.assertContent(page, payload);
      const button = page
        .locator(modalSelector)
        .getByRole("button", { name: "发布文章", exact: true });
      if (!(await button.isEnabled()))
        throw new AppError(
          "CSDN_SUBMIT_DISABLED",
          "CSDN 发布按钮不可用，请在窗口检查必填项或账号验证。",
        );
      // Watch only an actual publish request from this official page, excluding autosaved drafts.
      const responsePromise = page
        .waitForResponse(
          (response) => isCsdnPublishRequest(response.request()),
          { timeout: 30_000 },
        )
        .catch(() => null);
      await beforeSubmit();
      await this.identity(context, payload);
      await this.assertContent(page, payload);
      await button.click({ timeout: 10_000 });
      const response = await responsePromise;
      if (!response)
        throw new AppError(
          "CSDN_RECEIPT_UNKNOWN",
          "未取得明确提交回执，可能正在等待扫码或平台响应。",
        );
      const data = await response.json().catch(() => null);
      if (!data || response.status() >= 500)
        throw new AppError("CSDN_RECEIPT_UNKNOWN", "平台提交响应不完整。");
      if (data.code !== 200)
        return {
          status: "rejected",
          message: `CSDN 未接受本次提交：${String(data.message ?? data.msg ?? data.code).slice(0, 180)}`,
        };
      const articleId = String(data.data?.id ?? "");
      if (!/^\d+$/.test(articleId))
        throw new AppError(
          "CSDN_RECEIPT_UNKNOWN",
          "平台返回成功但缺少文章 ID。",
        );
      const url =
        data.data?.url ||
        `https://blog.csdn.net/${payload.author}/article/details/${articleId}`;
      return { status: "submitted", url };
    });
  }
}

export function isCsdnPublishRequest(
  request: Pick<Request, "url" | "method" | "postDataJSON">,
): boolean {
  const url = new URL(request.url());
  if (
    url.origin !== "https://bizapi.csdn.net" ||
    url.pathname !== "/blog-console-api/v3/mdeditor/saveArticle" ||
    request.method() !== "POST"
  )
    return false;
  try {
    return request.postDataJSON()?.pubStatus === "publish";
  } catch {
    return false;
  }
}
