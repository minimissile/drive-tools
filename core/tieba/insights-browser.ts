import { errors } from "playwright-core";
import type { TiebaBrowserProfile } from "./types";
import type { TiebaInsightsBrowser } from "../tieba-insights/types";
import type {
  TiebaPublicationRef,
  TiebaVisibilityReading,
} from "../../shared/tieba-insights";
import { AppError } from "../errors";
import {
  assertTiebaAccount,
  assertTiebaViewer,
  withTiebaBusinessPage,
} from "./browser-runtime";
import {
  assertTiebaThreadIdentity,
  normalizedTiebaReply,
  parseTiebaPosts,
  tiebaParticipationPageScript,
  tiebaSafeThreadPage,
  tiebaThreadUrl,
  tiebaObjectId,
  type TiebaParticipationPageSnapshot,
} from "./participation-page";

const visibilityPageScript = String.raw`(() => {
  const value=${tiebaParticipationPageScript};
  const nodes=[...new Set(document.querySelectorAll('#j_p_postlist .l_post[data-field], #pb_content .l_post[data-field]'))];
  return {...value,posts:value.posts.map((post,index)=>{
    const node=nodes[index],body=node?.querySelector('.d_post_content');
    return {...post,truncated:!body||!body.getClientRects().length||!!node?.querySelector('.j_content_fold,[data-truncated="true"],.j_content_hide')||!!body.querySelector('video,audio,iframe')};
  })};
})()`;

export function parseTiebaVisibility(
  snapshot: TiebaParticipationPageSnapshot,
  uid: string,
  publication: TiebaPublicationRef,
  at = new Date().toISOString(),
): TiebaVisibilityReading {
  if (!publication.threadId)
    throw new AppError(
      "TIEBA_VISIBILITY_SOURCE",
      "缺少原主题ID，不能定位官网内容。",
    );
  assertTiebaThreadIdentity(snapshot, uid, {
    ...publication,
    threadId: publication.threadId,
  });
  const allPosts = parseTiebaPosts(snapshot);
  const posts = allPosts.filter(
    (post) =>
      !post.truncated &&
      post.authorUid === uid &&
      (publication.kind === "topic" ? post.floor === 1 : post.floor > 1),
  );
  const matches = posts.filter(
    (post) =>
      (!publication.postId || post.postId === publication.postId) &&
      normalizedTiebaReply(post.text) ===
        normalizedTiebaReply(publication.body),
  );
  if (
    matches.length === 1 &&
    (publication.kind !== "topic" || snapshot.title === publication.title)
  )
    return {
      visibility: "visible",
      checkedAt: at,
      message: "官网当前可见原作者与准确正文；原提交状态保持。",
    };
  // Only a website dialog bound to the exact known thread is review evidence.
  // A missing row, 404, verification page or a mention of review in user text is not.
  const thread = snapshot.thread as Record<string, unknown> | null;
  const author =
    thread?.author && typeof thread.author === "object"
      ? (thread.author as Record<string, unknown>)
      : null;
  const authorProof =
    allPosts.some((post) => post.floor === 1 && post.authorUid === uid) ||
    tiebaObjectId(
      thread?.author_id ?? thread?.author_uid ?? author?.user_id,
    ) === uid;
  if (
    publication.kind === "topic" &&
    authorProof &&
    /^(?:发布成功[，,。\s]*)?(?:您发布的|该|此|本)?(?:帖子|贴子|内容)(?:正在|已进入|处于)审核(?:中|流程)[。！!\s]*$/u.test(
      snapshot.statusText.trim(),
    )
  )
    return {
      visibility: "pending_review",
      checkedAt: at,
      message: "准确主题的官网提示内容审核中，尚未确认公开可见。",
    };
  return {
    visibility: "unknown",
    checkedAt: at,
    message:
      "当前页未找到可准确匹配的原内容；不能据此判断删除、限流或提交失败。",
  };
}

export function tiebaInsightsBrowser(
  profile: TiebaBrowserProfile,
  options: { pageTimeoutMs?: number } = {},
): TiebaInsightsBrowser {
  return {
    readVisibility(account, uid, publication) {
      assertTiebaAccount(account, uid);
      if (
        publication.uid !== uid ||
        publication.accountId !== account.id ||
        !publication.body.trim() ||
        !publication.threadId
      )
        throw new AppError(
          "TIEBA_VISIBILITY_SOURCE",
          "原发布身份、主题或正文不完整，未复查其他账号内容。",
        );
      const threadId = publication.threadId;
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        const result = await withTiebaBusinessPage(
          context,
          async (page, go) => {
            const capture = async () => {
              try {
                await page.waitForFunction(
                  `(() => { const s=${visibilityPageScript}; return s.challenge || s.login || (s.thread && s.forum && s.posts.length) || s.statusText; })()`,
                  undefined,
                  { timeout: options.pageTimeoutMs ?? 6000 },
                );
              } catch (error) {
                if (!(error instanceof errors.TimeoutError)) throw error;
              }
              return page.evaluate<TiebaParticipationPageSnapshot>(
                visibilityPageScript,
              );
            };
            try {
              await go(
                tiebaThreadUrl(threadId, publication.postId ?? undefined),
              );
            } catch (error) {
              if (error instanceof AppError && error.code === "TIEBA_PAGE_HTTP")
                return {
                  visibility: "unavailable" as const,
                  checkedAt: new Date().toISOString(),
                  message:
                    "官网页面暂不可访问，未判定删除或限制；原提交状态保持。",
                };
              throw error;
            }
            let snapshot = await capture();
            let reading = parseTiebaVisibility(snapshot, uid, publication);
            if (
              reading.visibility === "unknown" &&
              publication.kind === "reply" &&
              snapshot.lastHref
            ) {
              const last = tiebaSafeThreadPage(snapshot.lastHref, threadId);
              if (last && last !== page.url()) {
                await go(last);
                snapshot = await capture();
                reading = parseTiebaVisibility(snapshot, uid, publication);
              }
            }
            return reading;
          },
        );
        await assertTiebaViewer(context, uid);
        return result;
      });
    },
  };
}
