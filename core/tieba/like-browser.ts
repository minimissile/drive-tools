import type { Page } from "playwright-core";
import type { TiebaLikeReading } from "../../shared/tieba-actions";
import type { TiebaAutocareBrowser, TiebaBrowserProfile } from "./types";
import { AppError } from "../errors";
import { tiebaModernViewer } from "./modern-page";
import {
  assertTiebaAccount,
  assertTiebaViewer,
  withTiebaBusinessPage,
  clickTiebaControl,
} from "./browser-runtime";
import { tiebaForumUrl } from "./autocare-page";
const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {};
const numericId = (value: unknown) =>
  typeof value === "number" && !Number.isSafeInteger(value)
    ? ""
    : /^[1-9]\d{0,19}$/.test(String(value))
      ? String(value)
      : "";
export function parseTiebaLike(
  value: unknown,
  uid: string,
  forumId: string,
  threadId: string,
): TiebaLikeReading {
  const data = object(value),
    thread = object(data.thread),
    forum = object(data.forum),
    agree = object(thread.agree);
  const viewer = tiebaModernViewer(data),
    authorUid = numericId(object(thread.author).id);
  if (!viewer || viewer.uid !== uid)
    throw new AppError(
      "TIEBA_IDENTITY_MISMATCH",
      "点赞页面的当前账号不一致，已停止操作。",
    );
  if (
    numericId(thread.id) !== threadId ||
    numericId(forum.id) !== forumId ||
    !authorUid ||
    ![0, 1, false, true].includes(agree.has_agree)
  )
    throw new AppError(
      "TIEBA_LIKE_UNRECOGNIZED",
      "未能核实原帖子、作者或已赞状态，未进行新的点赞。",
    );
  return {
    uid,
    forumId,
    threadId,
    authorUid,
    title:
      typeof thread.title === "string"
        ? thread.title.slice(0, 200)
        : `帖子 ${threadId}`,
    url: `https://tieba.baidu.com/p/${threadId}`,
    liked: agree.has_agree === 1 || agree.has_agree === true,
    checkedAt: new Date().toISOString(),
  };
}
const likeButton =
  'svg:has(use[href="#agree_pb"], use[xlink\\:href="#agree_pb"])';
async function readPost(
  page: Page,
  go: (url: string) => Promise<void>,
  uid: string,
  forumId: string,
  threadId: string,
) {
  const response = page.waitForResponse(
    (r) => {
      const u = new URL(r.url());
      return (
        u.origin === "https://tieba.baidu.com" &&
        u.pathname === "/c/f/pb/page_pc" &&
        r.ok()
      );
    },
    { timeout: 20000 },
  );
  // Observe only this navigation's official response, never a separate authenticated API call.
  const result = response.then((r) => r.json());
  result.catch(() => {});
  await go(`https://tieba.baidu.com/p/${threadId}`);
  return parseTiebaLike(await result, uid, forumId, threadId);
}
export function tiebaLikeBrowser(
  profile: TiebaBrowserProfile,
): Pick<TiebaAutocareBrowser, "likePost" | "readLike"> {
  return {
    readLike: (account, uid, forum, threadId) => {
      assertTiebaAccount(account, uid);
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        return withTiebaBusinessPage(context, (page, go) =>
          readPost(page, go, uid, forum.forumId, threadId),
        );
      });
    },
    likePost: (
      account,
      uid,
      forum,
      excludedUids,
      excludedThreads,
      checkpoint,
    ) => {
      assertTiebaAccount(account, uid);
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        return withTiebaBusinessPage(context, async (page, go) => {
          await go(tiebaForumUrl(forum.name));
          await page
            .locator('a[href*="/p/"]')
            .first()
            .waitFor({ timeout: 10000 });
          const ids = await page.evaluate<string[]>(
            String.raw`(() => {const ids=[];for(const a of document.querySelectorAll('a[href]')){try{const u=new URL(a.href);const m=u.pathname.match(/^\/p\/([1-9]\d{0,19})$/);if(u.origin==='https://tieba.baidu.com'&&!u.username&&!u.password&&m&&!ids.includes(m[1]))ids.push(m[1]);}catch{}}return ids.slice(0,8);})()`,
          );
          for (const id of ids) {
            if (excludedThreads.includes(id)) continue;
            const current = await readPost(page, go, uid, forum.forumId, id);
            if (
              excludedUids.includes(current.authorUid) ||
              current.authorUid === uid ||
              current.liked
            )
              continue;
            await assertTiebaViewer(context, uid);
            const fresh = await readPost(page, go, uid, forum.forumId, id);
            if (
              fresh.liked ||
              fresh.authorUid !== current.authorUid ||
              excludedUids.includes(fresh.authorUid)
            )
              continue;
            const button = page
              .locator(likeButton)
              .filter({ visible: true })
              .locator("..");
            if ((await button.count()) !== 1)
              throw new AppError(
                "TIEBA_LIKE_CONTROL",
                "官网普通点赞控件不唯一或不可用，未进行点赞。",
              );
            const text = (await button.innerText()).trim();
            if (!/^(?:点赞|赞|[\d,]+)$/.test(text))
              throw new AppError(
                "TIEBA_LIKE_CONTROL",
                "无法确认普通点赞按钮，未执行操作。",
              );
            await checkpoint(fresh);
            const response = page
              .waitForResponse(
                (r) => {
                  const u = new URL(r.url());
                  return (
                    u.origin === "https://tieba.baidu.com" &&
                    r.request().method() === "POST" &&
                    /agree/i.test(u.pathname)
                  );
                },
                { timeout: 8000 },
              )
              .catch(() => null);
            await clickTiebaControl(button);
            await response;
            return readPost(page, go, uid, forum.forumId, id);
          }
          return null;
        });
      });
    },
  };
}
