import type { Page, Response } from "playwright-core";
import { AppError } from "../errors";
import {
  jianshuCreatedDraftUrl,
  jianshuEditorScript,
  prepareJianshuDraftCreation,
} from "./editor";

const createEndpoint = "https://www.jianshu.com/author/notes";

/** The identity of a new note comes from this page's POST response, never its route. */
export async function createBitJianshuDraft(page: Page): Promise<string> {
  const snapshot = await prepareJianshuDraftCreation({
    url: () => page.url(),
    evaluate: (script) => page.evaluate(script),
  });
  const matches = (response: Response) => {
    try {
      const request = response.request();
      if (
        response.url() !== createEndpoint ||
        request.url() !== createEndpoint ||
        request.method() !== "POST" ||
        request.frame() !== page.mainFrame()
      )
        return false;
      const body = request.postDataJSON();
      return (
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        String(body.notebook_id) === snapshot.notebookId
      );
    } catch {
      return false;
    }
  };
  // Attach a rejection handler immediately: a failed click must not leave an
  // unhandled waiter. The Playwright waiter removes its page listeners on timeout.
  const observed = page.waitForResponse(matches, { timeout: 30000 }).then(
    (response) => ({ response, error: null }),
    (error: unknown) => ({ response: null, error }),
  );
  try {
    await page.evaluate(
      jianshuEditorScript({
        action: "create",
        expectedEditorUrl: snapshot.editorUrl,
        expectedNotebookId: snapshot.notebookId,
      }),
    );
    const { response, error } = await observed;
    if (error || !response || !response.ok())
      throw new Error("未取得有效的新建回执");
    if (
      !/application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(
        response.headers()["content-type"] ?? "",
      )
    )
      throw new Error("新建回执不是JSON");
    const text = await response.text();
    if (text.length > 512000) throw new Error("新建回执过大");
    const editorUrl = jianshuCreatedDraftUrl(
      JSON.parse(text),
      snapshot.notebookId,
    );
    if (!editorUrl) throw new Error("新建回执未能确认准确文章");
    return editorUrl;
  } catch {
    throw new AppError(
      "JIANSHU_CREATE_UNCERTAIN",
      "简书新建文章的回执尚未确认，已停止填写；请先检查官网草稿，避免重复创建。",
      true,
    );
  }
}
