import type { Page, Request } from "playwright-core";
import { tiebaCurrentUser } from "./identity";
import type { TiebaAutocarePageSnapshot } from "./autocare-page";

const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
const number = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const flag = (v: unknown) =>
  v === 1 || v === true ? true : v === 0 || v === false ? false : null;
export function tiebaModernViewer(value: unknown) {
  const data = object(value),
    user = object(data.user);
  const viewer = tiebaCurrentUser({ ...user, open_uid: undefined });
  return data.error_code === 0 && [1, true, "1"].includes(user.is_login)
    ? viewer
    : null;
}
/** Only the current viewer and forum from the page's own successful response. Never retain tokens/posts. */
export function tiebaModernForum(value: unknown) {
  const data = object(value),
    forum = object(data.forum);
  const viewer = tiebaModernViewer(data);
  const fid = number(forum.id),
    sign = object(object(forum.sign_in_info).user_info);
  if (
    data.error_code !== 0 ||
    !viewer ||
    !fid ||
    typeof forum.name !== "string" ||
    !forum.name.trim() ||
    forum.name.length > 100
  )
    return null;
  if (sign.user_id != null && String(sign.user_id) !== viewer.uid) return null;
  return {
    viewer,
    forum: { id: String(fid), name: forum.name },
    signed: flag(sign.is_sign_in),
    followed: flag(forum.is_like),
    level: number(forum.user_level ?? forum.level_id),
    experience: number(forum.cur_score),
    memberCount: number(forum.member_num),
    postCount: number(forum.post_num),
    threadCount: number(forum.thread_num),
  };
}
type ModernForum = NonNullable<ReturnType<typeof tiebaModernForum>>;
const captures = new WeakMap<
  Page,
  {
    read(): ModernForum | null;
    viewer(): ReturnType<typeof tiebaModernViewer>;
    wait(): Promise<ModernForum | null>;
  }
>();
export function captureTiebaModernPage(page: Page) {
  let epoch = 0,
    current: ModernForum | null = null;
  let viewer: ReturnType<typeof tiebaModernViewer> = null;
  const requests = new WeakMap<Request, number>();
  let resolve: ((v: ModernForum | null) => void) | undefined;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      epoch++;
      current = null;
      viewer = null;
      resolve?.(null);
      resolve = undefined;
    }
    requests.set(request, epoch);
  });
  page.on("response", async (response) => {
    const url = new URL(response.url()),
      generation = requests.get(response.request());
    if (
      url.origin !== "https://tieba.baidu.com" ||
      url.pathname !== "/c/f/frs/page_pc" ||
      !response.ok()
    )
      return;
    try {
      const data = await response.json();
      const identity = tiebaModernViewer(data);
      const parsed = tiebaModernForum(data);
      if (generation !== epoch || !identity) return;
      viewer = identity;
      current = parsed;
      resolve?.(parsed);
      resolve = undefined;
    } catch {
      /* Unrecognized responses remain unknown. */
    }
  });
  const capture = {
    read: () => current,
    viewer: () => viewer,
    wait: async () =>
      current || viewer
        ? current
        : await new Promise<ModernForum | null>((done) => {
            const timer = setTimeout(() => {
              if (resolve === receive) resolve = undefined;
              done(null);
            }, 10000);
            const receive = (value: ModernForum | null) => {
              clearTimeout(timer);
              done(value);
            };
            resolve = receive;
          }),
  };
  captures.set(page, capture);
  return capture;
}
export async function modernTiebaSnapshot(
  page: Page,
  legacy: TiebaAutocarePageSnapshot,
): Promise<TiebaAutocarePageSnapshot> {
  const capture = captures.get(page);
  const modern =
    capture?.read() ??
    (!legacy.forum && new URL(legacy.url).pathname === "/f"
      ? await capture?.wait()
      : null);
  if (!modern) return legacy;
  const location = new URL(legacy.url);
  if (
    location.origin !== "https://tieba.baidu.com" ||
    !/^\/f\/?$/.test(location.pathname) ||
    location.searchParams.get("kw")?.toLowerCase() !==
      modern.forum.name.toLowerCase()
  )
    return legacy;
  const controls = await page.evaluate<{
    signCount: number;
    signText: string;
    signDisabled: boolean;
    followCount: number;
    followText: string;
    followClasses: string;
  }>(String.raw`(() => {
    const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const sign = [...document.querySelectorAll('.operate-btn.follow-sign')].filter(visible);
    const follow = [...document.querySelectorAll('.bar-info .follow-btn')].filter(visible);
    const text = e => e?.textContent?.trim() ?? '';
    return {signCount:sign.length,signText:text(sign[0]),signDisabled:!!sign[0]?.matches('[aria-disabled="true"], [disabled], .button-wrapper--disabled'),followCount:follow.length,followText:text(follow[0]),followClasses:follow[0]?.getAttribute('class') ?? ''};
  })()`);
  const signed = modern.signed === true || controls.signText === "已签到";
  return {
    ...legacy,
    modern: true,
    viewer: {
      id: modern.viewer.uid,
      is_login: 1,
      name_show: modern.viewer.nickname,
    },
    forum: modern.forum,
    heading: modern.forum.name,
    levelText: modern.level === null ? "" : `Lv.${modern.level}`,
    experienceText: modern.experience === null ? "" : String(modern.experience),
    memberText: modern.memberCount === null ? "" : String(modern.memberCount),
    postText: modern.postCount === null ? "" : String(modern.postCount),
    footerText:
      modern.threadCount === null ? "" : `主题数${modern.threadCount}`,
    signed,
    signButtons:
      !signed && controls.signText === "签到" ? controls.signCount : 0,
    signButtonText: controls.signText,
    signButtonTitle: controls.signText,
    signButtonHref: null,
    signDisabled: controls.signDisabled,
    followButtonCount:
      controls.followText === "关注" ? controls.followCount : 0,
    followButtonText: controls.followText,
    followButtonHref: null,
    followButtonClasses: controls.followClasses,
  };
}
