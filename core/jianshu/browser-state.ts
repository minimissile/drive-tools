import type { WebsiteSessionState } from "../../shared/website-accounts";
import type { JianshuPayload, JianshuReceipt } from "../../shared/jianshu";

export const jianshuEditorUrl = "https://www.jianshu.com/writer#/";
export const jianshuHosts = ["www.jianshu.com", "jianshu.com"];

export function jianshuArticleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !jianshuHosts.includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/p\/[a-f0-9]{12}\/?$/.test(url.pathname)
    )
      return null;
    return `https://www.jianshu.com${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** Only accepts a payload from the official signed-in viewer endpoint. */
export function jianshuCurrentUser(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const user = value as Record<string, unknown>;
  if (user.is_signed_in === false || user.is_login === false) return null;
  const slug =
    typeof user.slug === "string" && /^[a-f0-9]{12}$/.test(user.slug)
      ? user.slug
      : "";
  const id =
    (typeof user.id === "string" ||
      (typeof user.id === "number" && Number.isSafeInteger(user.id))) &&
    /^[1-9]\d{0,19}$/.test(String(user.id))
      ? String(user.id)
      : "";
  const nickname = user.nickname ?? user.name;
  if ((!slug && !id) || typeof nickname !== "string" || !nickname.trim())
    return null;
  // A slug is stable and also occurs in the author's public profile. A numeric-only
  // viewer remains numeric; receipt checks never invent a mapping between the two.
  return { uid: slug || id, nickname: nickname.trim().slice(0, 100) };
}

/** An unrecognized identity response is not proof of logout; preserve the account. */
export function jianshuSessionObservation(
  state: WebsiteSessionState,
): WebsiteSessionState {
  if (state.expired)
    return { ...state, hasSession: false, uid: null, unverified: false };
  if (state.hasSession && state.uid) return state;
  if (state.expired) return state;
  if (state.checkedAt && !state.unverified) return { ...state, expired: true };
  return {
    ...state,
    hasSession: false,
    uid: null,
    unverified: true,
    expired: false,
  };
}

export function jianshuIdentityScript() {
  return `(async () => {
    if (!['https://www.jianshu.com', 'https://jianshu.com'].includes(location.origin) || !['/', '/writer', '/writer/', '/sign_in'].includes(location.pathname))
      throw Error('简书身份页面已变化，请在官方窗口完成登录后重新检查');
    const read = ${jianshuCurrentUser.toString()};
    const endpoint = new URL('/author/current_user', location.origin).href;
    let response;
    try {
      response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch {
      const signInForm = location.pathname === '/sign_in' && !!document.querySelector('form input[type="password"], form[action*="sign_in"]');
      if (signInForm) return null;
      throw Error('简书当前身份读取未完成，请检查网络或在官网完成登录验证');
    }
    if (response.status === 401) return null;
    if (!response.ok || response.url !== endpoint || !/application\\/(?:[a-z0-9.+-]*\\+)?json\\b/i.test(response.headers.get('content-type') ?? ''))
      throw Error('简书当前身份响应未核实，请在官网完成登录或验证后重试');
    const text = await response.text();
    if (text.length > 512000) throw Error('简书当前身份响应异常，请稍后重新检查');
    let user;
    try { user = JSON.parse(text); } catch { throw Error('简书当前身份响应无法读取，请重新检查'); }
    const identity = read(user);
    if (identity) return identity;
    if (user === null || (user && !Array.isArray(user) && (user.is_signed_in === false || user.is_login === false))) return null;
    throw Error('未能确认简书当前登录身份；请在官方窗口完成登录或验证后重试');
  })()`;
}

export interface JianshuArticleObservation {
  url: string;
  title: string;
  text: string;
  authorIds: string[];
  links: string[];
  linkedTexts: { text: string; url: string }[];
  imageCount: number;
  published: boolean;
}

/** Runs in a disposable article reader. It never reads current-viewer metadata as author. */
export function readJianshuArticle(): JianshuArticleObservation | null {
  if (
    !/^https:\/\/(?:www\.)?jianshu\.com\/p\/[a-f0-9]{12}\/?$/.test(
      location.href,
    )
  )
    return null;
  const slug = location.pathname.split("/")[2];
  const object = (v: unknown): Record<string, any> | null =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, any>)
      : null;
  let page: Record<string, any> | null = null;
  for (const selector of [
    "script#__NEXT_DATA__",
    'script[data-name="page-data"]',
  ]) {
    const text = document.querySelector(selector)?.textContent;
    if (!text || text.length > 2_000_000) continue;
    try {
      page = object(JSON.parse(text));
      if (page) break;
    } catch {}
  }
  const initial =
    page?.props?.initialState ?? page?.props?.pageProps?.initialState ?? page;
  const candidate = initial?.note?.data ?? initial?.note;
  const note = candidate?.slug === slug ? object(candidate) : null;
  const authorIds: string[] = [];
  const author = object(note?.user ?? note?.author);
  if (author) {
    if (typeof author.slug === "string" && /^[a-f0-9]{12}$/.test(author.slug))
      authorIds.push(author.slug);
    if (
      (typeof author.id === "string" ||
        (typeof author.id === "number" && Number.isSafeInteger(author.id))) &&
      /^[1-9]\d{0,19}$/.test(String(author.id))
    )
      authorIds.push(String(author.id));
  }
  let datedArticle = false;
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    if (!script.textContent || script.textContent.length > 512000) continue;
    try {
      const value = JSON.parse(script.textContent);
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (!["Article", "BlogPosting"].includes(entry?.["@type"])) continue;
        const rawUrl =
          typeof entry.url === "string"
            ? entry.url
            : entry.mainEntityOfPage?.["@id"];
        if (
          !rawUrl ||
          new URL(rawUrl).pathname.replace(/\/$/, "") !==
            location.pathname.replace(/\/$/, "") ||
          new URL(rawUrl).hostname.replace(/^www\./, "") !== "jianshu.com"
        )
          continue;
        const writers = Array.isArray(entry.author)
          ? entry.author
          : [entry.author];
        if (writers.length !== 1) continue;
        const writer = writers[0];
        const profile =
          typeof writer?.url === "string" ? writer.url : writer?.["@id"];
        if (typeof profile !== "string") continue;
        const url = new URL(profile, location.origin);
        if (
          url.protocol !== "https:" ||
          !["jianshu.com", "www.jianshu.com"].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.port
        )
          continue;
        const matched = /^\/u\/([a-f0-9]{12})\/?$/.exec(url.pathname);
        if (matched && (!authorIds.length || authorIds.includes(matched[1]))) {
          authorIds.push(matched[1]);
          datedArticle =
            typeof entry.datePublished === "string" &&
            Number.isFinite(Date.parse(entry.datePublished));
        }
      }
    } catch {}
  }
  // Never fall back to the whole page, recommendations, comments or a header profile.
  const body = document.querySelector(
    ".show-content, ._2rhmJa, [data-article-content]",
  );
  const title = document.querySelector("h1")?.textContent?.trim() ?? "";
  if (!body || !title || !authorIds.length) return null;
  const text = (body as HTMLElement).innerText;
  if (!text || text.length > 200000) return null;
  const explicitPrivate =
    note?.public === false ||
    note?.is_private === true ||
    !!document.querySelector(
      '[data-article-state="draft"], [data-article-state="private"]',
    );
  const datedNote =
    typeof note?.published_at === "string" &&
    Number.isFinite(Date.parse(note.published_at));
  const anchors = Array.from(body.querySelectorAll("a[href]"));
  return {
    url: location.href,
    title,
    text,
    authorIds: [...new Set(authorIds)],
    links: anchors.map((a) => (a as HTMLAnchorElement).href),
    linkedTexts: anchors.map((a) => ({
      text: a.textContent ?? "",
      url: (a as HTMLAnchorElement).href,
    })),
    imageCount: body.querySelectorAll("img").length,
    published:
      !explicitPrivate && (note?.public === true || datedNote || datedArticle),
  };
}

export function unwrapJianshuLink(value: string): string | null {
  try {
    let url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
    if (url.hostname === "links.jianshu.com" && url.pathname === "/go") {
      const to = url.searchParams.get("to");
      if (!to) return null;
      url = new URL(to);
    }
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function checkJianshuArticle(
  observation: JianshuArticleObservation | null,
  expectedUid: string,
  url: string,
  payload: JianshuPayload,
): JianshuReceipt {
  const canonical = jianshuArticleUrl(url);
  const failed = (reason: string): JianshuReceipt => ({
    verified: false,
    url: canonical ?? url,
    reason,
  });
  if (!canonical) return failed("请填写简书公开文章的完整 HTTPS 地址。");
  if (!observation || jianshuArticleUrl(observation.url) !== canonical)
    return failed("尚未读到该简书文章的完整内容与作者，保留待核对状态。");
  if (!observation.published)
    return failed("尚未确认文章公开发布，请在简书核对可见范围和审核结果。");
  if (!expectedUid || !observation.authorIds.includes(expectedUid))
    return failed("文章作者与所选简书账号不一致，未登记为发布成功。");
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  if (normalize(observation.title) !== normalize(payload.title))
    return failed("简书文章标题与当前稿件不一致，请确认文章链接和稿件版本。");
  if (
    !normalize(payload.text) ||
    normalize(observation.text) !== normalize(payload.text)
  )
    return failed("简书正文与当前交付内容不一致或尚未完整加载，请核对原文。");
  const targets = new Set(
    observation.links.map(unwrapJianshuLink).filter(Boolean),
  );
  const expectedTargets = [
    ...payload.sourceUrls,
    ...(payload.resourceUrl ? [payload.resourceUrl] : []),
  ]
    .map(unwrapJianshuLink)
    .filter(Boolean);
  for (const linked of observation.linkedTexts) {
    const displayed = unwrapJianshuLink(linked.text.trim());
    if (
      displayed &&
      expectedTargets.includes(displayed) &&
      unwrapJianshuLink(linked.url) !== displayed
    )
      return failed("文章链接文字与实际跳转地址不一致，请修正资源或来源入口。");
  }
  const plainUrls = observation.text.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const value of plainUrls) {
    // A URL-looking anchor label is not a second, plain-text resource entry.
    if (observation.linkedTexts.some((link) => link.text.includes(value)))
      continue;
    const target = unwrapJianshuLink(value.replace(/[，。；、）】》]+$/, ""));
    if (target) targets.add(target);
  }
  for (const expected of [
    ...payload.sourceUrls,
    ...(payload.resourceUrl ? [payload.resourceUrl] : []),
  ]) {
    const target = unwrapJianshuLink(expected);
    if (!target || !targets.has(target))
      return failed("文章中缺少当前稿件的准确来源或资源入口，请修正后再核对。");
  }
  // This proves the article text/author/entry only. Re-encoded remote images still need
  // a human review, regardless of whether their count happens to match local images.
  const imageReviewRequired =
    payload.images.length > 0 || observation.imageCount > 0;
  return {
    verified: true,
    url: canonical,
    imageReviewRequired,
    reason: imageReviewRequired
      ? "文章已核实，配图待人工核对。"
      : "已核对公开文章、作者、标题、正文与准确入口。",
  };
}
