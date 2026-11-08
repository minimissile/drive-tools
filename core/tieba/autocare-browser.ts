import { errors, type BrowserContext, type Page } from "playwright-core";
import type { WebsiteAccount } from "../../shared/website-accounts";
import type { TiebaForumReading } from "../../shared/tieba-autocare";
import { normalizeTiebaForumName } from "../../shared/tieba-forums";
import { AppError } from "../errors";
import { tiebaCurrentUser } from "./identity";
import {
  assertTiebaViewer,
  assertTiebaAccount,
  withTiebaBusinessPage,
} from "./browser-runtime";
import type { TiebaAutocareBrowser, TiebaBrowserProfile } from "./types";
import { tiebaForumDiscoveryBrowser } from "./forum-discovery";
import {
  assertTiebaPage,
  parseTiebaFollowedPage,
  parseTiebaFollowedStats,
  parseTiebaForum,
  tiebaAutocarePageScript,
  tiebaForumUrl,
  tiebaSignSelector,
  tiebaFollowSelector,
  tiebaInertControlHref,
  type TiebaAutocarePageSnapshot,
} from "./autocare-page";

const snapshot = (page: Page) =>
  page.evaluate<TiebaAutocarePageSnapshot>(tiebaAutocarePageScript);
const forumKey = (name: string) =>
  normalizeTiebaForumName(name).replace(/[A-Z]/gu, (c) => c.toLowerCase());
type FollowedState = {
  names: string[];
  stats: Map<string, { level: number | null; experience: number | null }>;
};

export function tiebaAutocareBrowser(
  profile: TiebaBrowserProfile,
  options: { resultTimeoutMs?: number; pageTimeoutMs?: number } = {},
): TiebaAutocareBrowser {
  const settledSnapshot = async (
    page: Page,
    kind: "forum" | "list" | "resolve",
    relation?: { followed: boolean; stats: boolean },
  ) => {
    const ready =
      kind !== "list"
        ? `value.forum && document.readyState === 'complete' && (value.signed || value.signButtons > 0) && (${relation?.followed === false || relation?.stats === true ? "true" : "value.levelText && value.experienceText"})`
        : "value.listRecognized && (value.links.length > 0 || value.listEmpty)";
    try {
      await page.waitForFunction(
        `(() => { const value = ${tiebaAutocarePageScript}; return value.challenge || value.login || /操作(?:太|过于|过)?频繁|请求(?:太|过于|过)?频繁|稍后再试/.test(value.statusText) || (${ready}); })()`,
        undefined,
        { timeout: options.pageTimeoutMs ?? 6000 },
      );
    } catch (error) {
      // A completed but unrecognized widget remains unknown; other page errors
      // must propagate instead of being mistaken for an empty followed list.
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    return snapshot(page);
  };
  const withAccount = <T>(
    account: WebsiteAccount,
    expectedUid: string,
    action: (context: BrowserContext) => Promise<T>,
  ) => {
    assertTiebaAccount(account, expectedUid);
    return profile(account, async (context) => {
      await assertTiebaViewer(context, expectedUid);
      return action(context);
    });
  };
  const read = async (
    page: Page,
    go: (url: string) => Promise<void>,
    expectedUid: string,
    forum: { name: string; forumId?: string; canonicalName?: boolean },
    cached?: FollowedState,
  ) => {
    let state = cached;
    if (!state)
      try {
        state = await followedState(page, go, expectedUid);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== "TIEBA_FOLLOWED_UNRECOGNIZED"
        )
          throw error;
      }
    const key = forumKey(forum.name),
      stats = state?.stats.get(key);
    await go(tiebaForumUrl(forum.name));
    const result = parseTiebaForum(
      await settledSnapshot(
        page,
        forum.canonicalName ? "resolve" : "forum",
        state
          ? {
              followed: state.names.some((n) => forumKey(n) === key),
              stats:
                stats?.level !== null &&
                stats?.level !== undefined &&
                stats?.experience !== null &&
                stats?.experience !== undefined,
            }
          : undefined,
      ),
      expectedUid,
      forum,
    );
    return enrich(result, state);
  };
  const enrich = (
    reading: TiebaForumReading,
    state?: FollowedState,
  ): TiebaForumReading => {
    const key = forumKey(reading.name),
      stats = state?.stats.get(key);
    const followed = state
      ? state.names.some((n) => forumKey(n) === key)
      : null;
    const levelConflict =
      reading.level !== null &&
      stats?.level !== undefined &&
      stats.level !== null &&
      reading.level !== stats.level;
    const experienceConflict =
      reading.experience !== null &&
      stats?.experience !== undefined &&
      stats.experience !== null &&
      reading.experience !== stats.experience;
    const level = levelConflict
        ? null
        : (reading.level ?? stats?.level ?? null),
      experience = experienceConflict
        ? null
        : (reading.experience ?? stats?.experience ?? null);
    const missing = [
      level === null ? "等级" : null,
      experience === null ? "经验" : null,
    ]
      .filter(Boolean)
      .join("、");
    return {
      ...reading,
      followed,
      level,
      experience,
      personalStatsMessage: missing
        ? levelConflict || experienceConflict
          ? "官网当前账号的本吧资料存在不一致，相关数值暂不采用。"
          : followed === false
            ? `尚未关注该吧，官网未提供本账号的本吧${missing}。`
            : `官网暂未提供本账号的本吧${missing}，已保留未知值。`
        : null,
    };
  };
  const followedState = async (
    page: Page,
    go: (url: string) => Promise<void>,
    uid: string,
  ): Promise<FollowedState> => {
    let next: string | null = "https://tieba.baidu.com/i/i/forum?pn=1";
    const visited = new Set<string>(),
      names = new Set<string>(),
      stats = new Map<
        string,
        { level: number | null; experience: number | null }
      >();
    while (next) {
      if (visited.has(next) || visited.size >= 100)
        throw new AppError(
          "TIEBA_FOLLOWED_PAGINATION",
          "关注列表重复翻页或超限，未猜测关注状态。",
        );
      visited.add(next);
      const expectedUrl = new URL(next);
      await go(next);
      const s = await settledSnapshot(page, "list");
      const actualUrl = new URL(s.url);
      if (
        actualUrl.origin !== expectedUrl.origin ||
        actualUrl.pathname !== expectedUrl.pathname ||
        (actualUrl.searchParams.get("pn") ?? "1") !==
          (expectedUrl.searchParams.get("pn") ?? "1")
      )
        throw new AppError(
          "TIEBA_PAGE_REDIRECT",
          "官网关注列表跳转到不同页面，未猜测关系或遗漏分页。",
        );
      const p = parseTiebaFollowedPage(s, uid);
      for (const name of p.names) names.add(name);
      for (const [name, value] of parseTiebaFollowedStats(s, uid)) {
        const key = forumKey(name),
          old = stats.get(key);
        stats.set(
          key,
          old
            ? {
                level: old.level === value.level ? value.level : null,
                experience:
                  old.experience === value.experience ? value.experience : null,
              }
            : value,
        );
      }
      if (names.size > 300)
        throw new AppError(
          "TIEBA_FOLLOWED_LIMIT",
          "关注列表超出300个读取上限，未猜测关注状态。",
        );
      next = p.next;
    }
    return { names: [...names], stats };
  };
  return {
    ...tiebaForumDiscoveryBrowser(profile, options),
    resolveForum: (account, expectedUid, input) => {
      const name = normalizeTiebaForumName(input);
      return withAccount(account, expectedUid, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          const result = await read(page, go, expectedUid, {
            name,
            canonicalName: true,
          });
          await assertTiebaViewer(context, expectedUid);
          return result;
        }),
      );
    },
    listForums: (account, expectedUid) =>
      withAccount(account, expectedUid, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          const state = await followedState(page, go, expectedUid);
          // The list may contain only names. Resolve each real forum ID from its own
          // official page rather than fabricating an ID from a title or list index.
          const result: TiebaForumReading[] = [];
          for (const name of state.names)
            result.push(await read(page, go, expectedUid, { name }, state));
          await assertTiebaViewer(context, expectedUid);
          return result;
        }),
      ),
    readForum: (account, expectedUid, forum) =>
      withAccount(account, expectedUid, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          const result = await read(page, go, expectedUid, forum);
          await assertTiebaViewer(context, expectedUid);
          return result;
        }),
      ),
    followForum: (account, uid, forum, beforeFollow) =>
      withAccount(account, uid, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          let current = await read(page, go, uid, forum);
          const receipt = (
            status: "followed" | "uncertain",
            reading: TiebaForumReading,
            message: string,
          ) => ({
            status,
            uid,
            reading,
            checkedAt: new Date().toISOString(),
            message,
          });
          if (current.followed === true) {
            await assertTiebaViewer(context, uid);
            return receipt(
              "followed",
              current,
              "官网当前账号关注列表已包含该吧，本次未再次关注。",
            );
          }
          if (current.followed !== false)
            throw new AppError(
              "TIEBA_FOLLOW_UNKNOWN",
              "未能完整核实当前账号关注列表，不会猜测并点击关注。",
            );
          await assertTiebaViewer(context, uid);
          const s = await snapshot(page);
          parseTiebaForum(s, uid, forum);
          if (
            tiebaCurrentUser(s.viewer)?.uid !== uid ||
            s.followButtonCount !== 1 ||
            !tiebaInertControlHref(s.followButtonHref ?? null) ||
            s.followButtonClasses
              ?.split(/\s+/u)
              .filter(Boolean)
              .sort()
              .join(" ") !== "focus_btn islike_focus"
          )
            throw new AppError(
              "TIEBA_FOLLOW_UNAVAILABLE",
              "官网未显示唯一、已核实的普通关注入口，本次未关注。",
            );
          const button = page
            .locator(tiebaFollowSelector)
            .filter({ visible: true });
          if ((await button.count()) !== 1)
            throw new AppError(
              "TIEBA_FOLLOW_UNAVAILABLE",
              "官网普通关注入口不唯一。",
            );
          await beforeFollow();
          try {
            await assertTiebaViewer(context, uid);
            const final = await snapshot(page);
            parseTiebaForum(final, uid, forum);
            if (
              tiebaCurrentUser(final.viewer)?.uid !== uid ||
              final.followButtonCount !== 1 ||
              !tiebaInertControlHref(final.followButtonHref ?? null) ||
              final.followButtonClasses
                ?.split(/\s+/u)
                .filter(Boolean)
                .sort()
                .join(" ") !== "focus_btn islike_focus" ||
              !(await button.isEnabled())
            )
              throw new AppError(
                "TIEBA_FOLLOW_UNCERTAIN",
                "关注检查点后官网身份、目标或控件已变化，保留原任务供只读核对。",
                true,
              );
            await button.click({ timeout: 10000 });
            try {
              await page.waitForFunction(
                `(()=>{const value=${tiebaAutocarePageScript};return value.challenge||value.login||value.followButtonCount!==1;})()`,
                undefined,
                { timeout: options.resultTimeoutMs ?? 12000 },
              );
            } catch (error) {
              if (!(error instanceof errors.TimeoutError)) throw error;
            }
            const state = await followedState(page, go, uid);
            current = await read(page, go, uid, forum, state);
            await assertTiebaViewer(context, uid);
            return current.followed === true
              ? receipt(
                  "followed",
                  current,
                  "官网当前账号完整关注列表已确认该吧。",
                )
              : receipt(
                  "uncertain",
                  current,
                  "原关注尝试尚未在官网完整列表确认，只能只读核对，不会重复点击。",
                );
          } catch (error) {
            if (error instanceof AppError) {
              error.uncertain = true;
              throw error;
            }
            throw new AppError(
              "TIEBA_FOLLOW_UNCERTAIN",
              "关注尝试后未取得确定关系回执，只能只读核对。",
              true,
            );
          }
        }),
      ),
    checkIn: (account, expectedUid, forum, beforeSubmit) =>
      withAccount(account, expectedUid, (context) =>
        withTiebaBusinessPage(context, async (page, go) => {
          const current = await read(page, go, expectedUid, forum);
          if (current.signed === true) return current;
          if (current.canSign !== true)
            throw new AppError(
              "TIEBA_SIGN_UNAVAILABLE",
              "官网未显示可执行的普通签到控件，本次未提交，请在官方页面检查。",
            );
          await assertTiebaViewer(context, expectedUid);
          const before = await snapshot(page);
          assertTiebaPage(before, expectedUid);
          const localViewer = tiebaCurrentUser(before.viewer);
          if (!localViewer || localViewer.uid !== expectedUid)
            throw new AppError(
              "TIEBA_IDENTITY_UNAVAILABLE",
              "签到页面未能核实当前用户身份，本次未提交，请重新检查账号。",
            );
          const fresh = parseTiebaForum(before, expectedUid, forum);
          if (fresh.signed === true) return fresh;
          if (fresh.canSign !== true)
            throw new AppError(
              "TIEBA_SIGN_UNAVAILABLE",
              "官网签到状态已变化，本次未提交。",
            );
          const button = page
            .locator(tiebaSignSelector)
            .filter({ visible: true });
          if ((await button.count()) !== 1)
            throw new AppError(
              "TIEBA_SIGN_UNAVAILABLE",
              "官网签到控件不唯一，本次未提交。",
            );
          // This must persist the intent and recheck scope before any site mutation.
          await beforeSubmit();
          try {
            const finalPage = await snapshot(page);
            const finalReading = parseTiebaForum(finalPage, expectedUid, forum);
            if (tiebaCurrentUser(finalPage.viewer)?.uid !== expectedUid)
              throw new AppError(
                "TIEBA_IDENTITY_UNAVAILABLE",
                "签到前当前身份已变化，已停止执行。",
                true,
              );
            if (finalReading.signed === true) return finalReading;
            if (finalReading.canSign !== true)
              throw new AppError(
                "TIEBA_SIGN_UNCERTAIN",
                "签到前官网状态已变化，请只读核对原任务。",
                true,
              );
            await button.click({ timeout: 10000 });
            await page.waitForFunction(
              `(() => { const value = ${tiebaAutocarePageScript}; return value.signed || value.challenge || value.login || /操作(?:太|过于|过)?频繁|请求(?:太|过于|过)?频繁|稍后再试/.test(value.statusText); })()`,
              undefined,
              { timeout: options.resultTimeoutMs ?? 12000 },
            );
            const after = await snapshot(page);
            let result = parseTiebaForum(after, expectedUid, forum);
            if (!tiebaCurrentUser(after.viewer) || result.signed !== true)
              throw new AppError(
                "TIEBA_SIGN_UNCERTAIN",
                "签到已提交，官网结果尚未核实，请只读核对原任务。",
                true,
              );
            if (result.level === null || result.experience === null)
              result = enrich(
                result,
                await followedState(page, go, expectedUid),
              );
            else
              result = {
                ...result,
                followed: current.followed,
                personalStatsMessage: null,
              };
            return result;
          } catch (error) {
            if (error instanceof AppError) {
              error.uncertain = true;
              throw error;
            }
            throw new AppError(
              "TIEBA_SIGN_UNCERTAIN",
              "签到提交后未能读取确定结果，请只读核对原任务，不会自动再次签到。",
              true,
            );
          }
        }),
      ),
  };
}
