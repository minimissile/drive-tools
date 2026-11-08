import { errors, type Page } from "playwright-core";
import type {
  TiebaThreadCandidate,
  TiebaThreadContext,
  TiebaReplyReceipt,
} from "../../shared/tieba-participation";
import { AppError } from "../errors";
import {
  assertTiebaAccount,
  assertTiebaViewer,
  withTiebaBusinessPage,
} from "./browser-runtime";
import { tiebaForumUrl } from "./autocare-page";
import type { TiebaBrowserProfile } from "./types";
import type { TiebaParticipationBrowser } from "./participation-types";
import {
  ensureTiebaAiContentDeclaration,
  assertTiebaAiContentDeclaration,
} from "./content-declaration";
import {
  assertTiebaParticipationPage,
  assertTiebaThreadIdentity,
  canReplyToTiebaPage,
  findTiebaReplyReceipt,
  normalizedTiebaReply,
  parseTiebaPosts,
  parseTiebaThreadContext,
  parseTiebaThreadList,
  tiebaParticipationPageScript,
  tiebaReplyButtonSelector,
  tiebaReplyEditorSelector,
  tiebaSafeThreadPage,
  tiebaThreadUrl,
  type TiebaParticipationPageSnapshot,
} from "./participation-page";

type Go = (url: string) => Promise<void>;
const snapshot = (page: Page) =>
  page.evaluate<TiebaParticipationPageSnapshot>(tiebaParticipationPageScript);
function unknownReceipt(threadId: string, message: string): TiebaReplyReceipt {
  return {
    status: "uncertain",
    threadId,
    postId: null,
    url: null,
    authorUid: null,
    body: null,
    checkedAt: new Date().toISOString(),
    message,
  };
}

export function tiebaParticipationBrowser(
  profile: TiebaBrowserProfile,
  options: { pageTimeoutMs?: number; resultTimeoutMs?: number } = {},
): TiebaParticipationBrowser {
  const settled = async (page: Page, kind: "forum" | "thread") => {
    const ready =
      kind === "forum"
        ? "value.forum && value.listRecognized && (value.rows.length || value.listEmpty)"
        : "value.forum && value.thread && value.posts.length && (value.locked || (value.editorCount > 0 && value.submitCount > 0))";
    try {
      await page.waitForFunction(
        `(() => { const value = ${tiebaParticipationPageScript}; return value.challenge || value.login || /操作(?:太|过于|过)?频繁|请求(?:太|过于|过)?频繁/.test(value.statusText) || (${ready}); })()`,
        undefined,
        { timeout: options.pageTimeoutMs ?? 6000 },
      );
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    return snapshot(page);
  };
  const withAccount: TiebaBrowserProfile = (account, action) =>
    profile(account, async (context) => {
      if (!account.uid)
        throw new AppError(
          "TIEBA_IDENTITY_REQUIRED",
          "请先核实原贴吧账号身份。",
        );
      await assertTiebaViewer(context, account.uid);
      return action(context);
    });
  const read = async (
    page: Page,
    go: Go,
    uid: string,
    candidate: TiebaThreadCandidate,
  ) => {
    await go(tiebaThreadUrl(candidate.threadId));
    return parseTiebaThreadContext(
      await settled(page, "thread"),
      uid,
      candidate,
    );
  };
  // Search only official current/first and last pages. Failure to observe a reply
  // is unknown; it is never a license to submit the body again.
  const reconcile = async (
    page: Page,
    go: Go,
    uid: string,
    thread: TiebaThreadContext,
    body: string,
    initial?: TiebaParticipationPageSnapshot,
    rejectOtherOwnReplies = false,
  ) => {
    const first = initial ?? (await settled(page, "thread"));
    assertTiebaThreadIdentity(first, uid, thread);
    let receipt = findTiebaReplyReceipt(first, uid, thread, body);
    if (receipt) return receipt;
    if (
      rejectOtherOwnReplies &&
      parseTiebaPosts(first).some(
        (post) => post.floor > 1 && post.authorUid === uid,
      )
    )
      throw new AppError(
        "TIEBA_ALREADY_PARTICIPATED",
        "官网已存在本人对该帖的回复，本次不新增回复。",
      );
    const last = first.lastHref
      ? tiebaSafeThreadPage(first.lastHref, thread.threadId)
      : null;
    if (last && last !== page.url()) {
      await go(last);
      const final = await settled(page, "thread");
      receipt = findTiebaReplyReceipt(final, uid, thread, body);
      if (receipt) return receipt;
      if (
        rejectOtherOwnReplies &&
        parseTiebaPosts(final).some(
          (post) => post.floor > 1 && post.authorUid === uid,
        )
      )
        throw new AppError(
          "TIEBA_ALREADY_PARTICIPATED",
          "官网尾页已存在本人对该帖的回复，本次不新增回复。",
        );
    }
    return unknownReceipt(
      thread.threadId,
      "官网尚未找到可核实的本人回复楼层，保留原提交结果，不会再次提交。",
    );
  };
  const validate = (
    account: Parameters<TiebaParticipationBrowser["listThreads"]>[0],
    uid: string,
  ) => assertTiebaAccount(account, uid);
  return {
    listThreads(account, uid, forum) {
      validate(account, uid);
      return withAccount(account, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          await go(tiebaForumUrl(forum.name));
          const result = parseTiebaThreadList(
            await settled(page, "forum"),
            uid,
            forum,
          );
          await assertTiebaViewer(context, uid);
          return result;
        }),
      );
    },
    readThread(account, uid, candidate) {
      validate(account, uid);
      return withAccount(account, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          const result = await read(page, go, uid, candidate);
          await assertTiebaViewer(context, uid);
          return result;
        }),
      );
    },
    reply(account, uid, thread, body, beforeSubmit, replyOptions) {
      validate(account, uid);
      if (body.trim().length < 20 || body.length > 800)
        throw new AppError("TIEBA_REPLY_INVALID", "回复正文须为20至800字。");
      if (
        thread.truncated ||
        !thread.body.trim() ||
        thread.canReply !== true ||
        thread.closed === true
      )
        throw new AppError(
          "TIEBA_CONTEXT_INCOMPLETE",
          "原帖上下文或回复能力不完整，请重新读取后再准备回复。",
        );
      return withAccount(account, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          const fresh = await read(page, go, uid, {
            ...thread,
            replyCount: null,
            lastActiveAt: null,
            discoveredAt: thread.checkedAt,
          });
          if (
            fresh.truncated ||
            fresh.body !== thread.body ||
            fresh.title !== thread.title ||
            fresh.authorUid !== thread.authorUid
          )
            throw new AppError(
              "TIEBA_CONTEXT_CHANGED",
              "原帖正文或作者已变化，请重新读取并审阅回复。",
            );
          let current = await snapshot(page);
          const existing = await reconcile(
            page,
            go,
            uid,
            thread,
            body,
            current,
            true,
          );
          if (existing.status === "verified")
            return {
              ...existing,
              message: "官网已有相同本人回复，未重复提交。",
            };
          // The preflight receipt search may have visited the official last page.
          // Return to the original post before touching its ordinary reply editor.
          if (page.url() !== tiebaThreadUrl(thread.threadId)) {
            await read(page, go, uid, {
              ...thread,
              replyCount: null,
              lastActiveAt: null,
              discoveredAt: thread.checkedAt,
            });
            current = await snapshot(page);
          }
          if (fresh.closed === true || !canReplyToTiebaPage(current))
            throw new AppError(
              "TIEBA_REPLY_UNAVAILABLE",
              "官网未显示唯一可用的普通回复编辑器与发表按钮，请在官方页面检查。",
            );
          if (current.editorText.trim())
            throw new AppError(
              "TIEBA_REPLY_EDITOR_OCCUPIED",
              "官网编辑器已有未提交文字，已保留原内容，请先在官网处理。",
            );
          const editor = page
            .locator(tiebaReplyEditorSelector)
            .filter({ visible: true });
          const button = page
            .locator(tiebaReplyButtonSelector)
            .filter({ visible: true });
          if ((await editor.count()) !== 1 || (await button.count()) !== 1)
            throw new AppError(
              "TIEBA_REPLY_UNAVAILABLE",
              "官网回复控件不唯一，本次未提交。",
            );
          await editor.fill(body);
          const declaration = await ensureTiebaAiContentDeclaration(
            page,
            replyOptions?.aiGenerated === true,
          );
          await assertTiebaViewer(context, uid);
          current = await snapshot(page);
          assertTiebaThreadIdentity(current, uid, thread);
          if (
            parseTiebaPosts(current).some(
              (post) => post.floor > 1 && post.authorUid === uid,
            )
          )
            throw new AppError(
              "TIEBA_ALREADY_PARTICIPATED",
              "编辑期间官网出现本人回复，本次未新增提交。",
            );
          if (
            !canReplyToTiebaPage(current) ||
            normalizedTiebaReply(current.editorText) !==
              normalizedTiebaReply(body)
          )
            throw new AppError(
              "TIEBA_REPLY_EDITOR_CHANGED",
              "回复编辑器内容或发表能力已变化，本次未提交。",
            );
          const before = parseTiebaThreadContext(current, uid, {
            ...thread,
            replyCount: null,
            lastActiveAt: null,
            discoveredAt: thread.checkedAt,
          });
          if (
            before.truncated ||
            before.body !== thread.body ||
            before.authorUid !== thread.authorUid ||
            before.title !== thread.title
          )
            throw new AppError(
              "TIEBA_CONTEXT_CHANGED",
              "原帖在提交前发生变化，请重新准备回复。",
            );
          await beforeSubmit();
          try {
            await assertTiebaAiContentDeclaration(
              page,
              replyOptions?.aiGenerated === true,
              declaration,
            );
            await assertTiebaViewer(context, uid);
            current = await snapshot(page);
            assertTiebaThreadIdentity(current, uid, thread);
            if (
              parseTiebaPosts(current).some(
                (post) => post.floor > 1 && post.authorUid === uid,
              )
            )
              throw new AppError(
                "TIEBA_REPLY_UNCERTAIN",
                "提交检查点后官网出现本人回复，保留原任务供只读核对。",
                true,
              );
            const finalContext = parseTiebaThreadContext(current, uid, {
              ...thread,
              replyCount: null,
              lastActiveAt: null,
              discoveredAt: thread.checkedAt,
            });
            if (
              !canReplyToTiebaPage(current) ||
              finalContext.truncated ||
              finalContext.body !== thread.body ||
              finalContext.authorUid !== thread.authorUid ||
              finalContext.title !== thread.title ||
              normalizedTiebaReply(current.editorText) !==
                normalizedTiebaReply(body)
            )
              throw new AppError(
                "TIEBA_REPLY_UNCERTAIN",
                "提交检查点之后官网状态发生变化，保留原任务以便核对。",
                true,
              );
            await button.click({ timeout: 10000 });
            try {
              await page.waitForFunction(
                `(() => { const value = ${tiebaParticipationPageScript}; return value.challenge || value.login || value.posts.some(p => { const a = p.data?.author; return String(a?.user_id ?? a?.id ?? '') === ${JSON.stringify(uid)} && p.text.normalize('NFKC').replace(/\s+/gu, ' ').trim() === ${JSON.stringify(normalizedTiebaReply(body))}; }); })()`,
                undefined,
                { timeout: options.resultTimeoutMs ?? 12000 },
              );
            } catch (error) {
              if (!(error instanceof errors.TimeoutError)) throw error;
            }
            await assertTiebaViewer(context, uid);
            return await reconcile(
              page,
              go,
              uid,
              thread,
              body,
              await snapshot(page),
            );
          } catch (error) {
            if (error instanceof AppError) {
              error.uncertain = true;
              throw error;
            }
            throw new AppError(
              "TIEBA_REPLY_UNCERTAIN",
              "回复提交后未取得确定回执，保留原任务，只读核对，不会重复提交。",
              true,
            );
          }
        }),
      );
    },
    reconcileReply(account, uid, thread, body, submittedAt) {
      validate(account, uid);
      if (!Number.isFinite(Date.parse(submittedAt)))
        throw new AppError(
          "TIEBA_REPLY_TIME_INVALID",
          "原提交时间无效，未进行结果核对。",
        );
      return withAccount(account, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          await go(tiebaThreadUrl(thread.threadId));
          const result = await reconcile(page, go, uid, thread, body);
          await assertTiebaViewer(context, uid);
          return result;
        }),
      );
    },
  };
}
