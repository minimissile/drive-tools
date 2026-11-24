import { createTemporaryPage, releaseTemporaryPage } from "../browser-page-lifecycle";
import type { BrowserContext, Page } from "playwright-core";
import type { JianshuPort } from "../../shared/jianshu";
import { jianshuDraftUrl } from "../../shared/jianshu";
import type { ContentImage } from "../../shared/content-sources";
import { fillJianshuEditor } from "./editor";
import { createBitJianshuDraft } from "./browser-create";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../../shared/website-accounts";
import { findEnvironmentPage, officialBrowserPage } from "../browser-pages";
import { AppError } from "../errors";
import {
  checkJianshuArticle,
  jianshuArticleUrl,
  jianshuEditorUrl,
  jianshuHosts,
  jianshuIdentityScript,
  readJianshuArticle,
  type JianshuArticleObservation,
} from "./browser-state";

/** Scope navigation guards to the disposable reader, never to the shared session. */
async function guardReader(page: Page, allowed: (url: string) => boolean) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      !allowed(request.url())
    )
      await route.abort();
    else await route.fallback();
  });
}

export async function verifyBitJianshu(
  context: BrowserContext,
): Promise<WebsiteSessionState> {
  const page = await createTemporaryPage(context, jianshuEditorUrl);
  try {
    await guardReader(page, (value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          jianshuHosts.includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.port &&
          ["/writer", "/writer/", "/sign_in"].includes(url.pathname) &&
          !url.search
        );
      } catch {
        return false;
      }
    });
    const response = await page.goto(jianshuEditorUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!response?.ok() || !officialBrowserPage(page, jianshuHosts))
      throw new AppError(
        "JIANSHU_IDENTITY_HTTP",
        "简书身份页面未能读取，请在此账号的官方窗口完成登录或验证。",
      );
    const identity = (await page.evaluate(jianshuIdentityScript())) as {
      uid: string;
      nickname: string;
    } | null;
    return {
      hasSession: !!identity,
      uid: identity?.uid ?? null,
      nickname: identity?.nickname ?? null,
      checkedAt: new Date().toISOString(),
      windowOpen: false,
      expired: !identity,
      error: identity ? null : "简书尚未登录，请在官方窗口完成登录后检查。",
    };
  } catch {
    return {
      hasSession: false,
      uid: null,
      unverified: true,
      windowOpen: false,
      error: "未能核实简书当前身份，请检查关联环境网络并完成官方验证后重试。",
    };
  } finally {
    await releaseTemporaryPage(page);
  }
}

/** Each local article owns one unpublished official note. */
export function jianshuBrowser(
  withContext: <T>(
    account: WebsiteAccount,
    action: (context: BrowserContext) => Promise<T>,
    visible?: boolean,
  ) => Promise<T>,
  readImage?: (image: ContentImage) => Promise<Buffer>,
): JianshuPort {
  return {
    async openEditor(account, rawUrl) {
      const url = jianshuDraftUrl(rawUrl);
      if (account.provider !== "jianshu" || !account.uid || !url)
        throw new AppError(
          "JIANSHU_EDITOR_INPUT",
          "请选择已核实的简书账号和准确的官网草稿地址。",
        );
      return withContext(
        account,
        async (context) => {
          // Reuse an already-open exact note, including a user-edited draft. Do not
          // navigate it, reset selection, or send any editor/fill commands.
          const existing = context
            .pages()
            .find(
              (page) => !page.isClosed() && jianshuDraftUrl(page.url()) === url,
            );
          const page =
            existing ??
            (await findEnvironmentPage(
              context,
              `panxu:jianshu:note:${account.id}:${url}`,
              url,
              (candidate) => jianshuDraftUrl(candidate.url()) === url,
            ));
          if (
            !officialBrowserPage(page, jianshuHosts) ||
            jianshuDraftUrl(page.url()) !== url
          )
            throw new AppError(
              "JIANSHU_EDITOR_ORIGIN",
              "简书原稿尚未打开，请检查官网登录状态后重试。",
            );
          await page.bringToFront();
          return { opened: true, editorUrl: url };
        },
        true,
      );
    },
    prepare: (account, payload, onCheckpoint) =>
      withContext(
        account,
        async (context) => {
          if (account.provider !== "jianshu" || !account.uid)
            throw new AppError(
              "JIANSHU_ACCOUNT",
              "请先选择已核实身份的简书账号。",
            );
          const savedUrl = jianshuDraftUrl(
            payload.editorUrl ?? payload.fillCheckpoint?.editorUrl,
          );
          const page = await findEnvironmentPage(
            context,
            `panxu:jianshu:editor:${account.id}:${payload.id}`,
            savedUrl ?? jianshuEditorUrl,
            (candidate) =>
              !savedUrl || jianshuDraftUrl(candidate.url()) === savedUrl,
          );
          if (!officialBrowserPage(page, jianshuHosts))
            throw new AppError(
              "JIANSHU_EDITOR_ORIGIN",
              "简书编辑窗口已离开官方页面，请重新检查。",
            );
          await page.bringToFront();
          if (savedUrl && jianshuDraftUrl(page.url()) !== savedUrl)
            throw new AppError(
              "JIANSHU_EDITOR_CHANGED",
              "简书编辑窗口已切换文章，请先保留官网修改，再重新打开原草稿。",
              true,
            );
          return fillJianshuEditor(
            {
              url: () => page.url(),
              evaluate: (script) => page.evaluate(script),
              createDraft: () => createBitJianshuDraft(page),
            },
            payload,
            onCheckpoint,
            readImage,
          );
        },
        true,
      ),
    checkResult: (account, rawUrl, payload) =>
      withContext(account, async (context) => {
        const url = jianshuArticleUrl(rawUrl);
        if (!url || account.provider !== "jianshu" || !account.uid)
          throw new AppError(
            "JIANSHU_RECEIPT_INPUT",
            "请选择已核实的简书账号，并填写本人公开文章链接。",
          );
        const page = await createTemporaryPage(context, url);
        try {
          await guardReader(page, (value) => jianshuArticleUrl(value) === url);
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          if (!response?.ok() || !officialBrowserPage(page, jianshuHosts))
            return checkJianshuArticle(null, account.uid, url, payload);
          const observation = (await page.evaluate(
            `(() => { const __name = fn => fn; return (${readJianshuArticle.toString()})(); })()`,
          )) as JianshuArticleObservation | null;
          return checkJianshuArticle(observation, account.uid, url, payload);
        } catch {
          return {
            verified: false,
            url,
            reason:
              "简书文章读取未完成，请检查官网页面后重试；未认定为发布失败，也不会自动重发。",
          };
        } finally {
          await releaseTemporaryPage(page);
        }
      }),
  };
}
