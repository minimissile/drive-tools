import type { BrowserContext, Page } from "playwright-core";
import type { WebsiteAccount } from "../../shared/website-accounts";
import {
  canonicalZhihuParticipationUrl,
  zhihuParticipationUrlKind,
  zhihuResearchHitSchema,
  zhihuResearchDocumentSchema,
  type ZhihuParticipationBrowserPort,
  type ZhihuResearchHit,
  type ZhihuResearchDocument,
} from "../../shared/zhihu-participation";
import { AppError } from "../errors";
import { officialBrowserPage } from "../browser-pages";
import { verifyZhihu } from "../zhihu/browser";
import { readFeaturedQuestions } from "./recommended";

const fail = (message: string): never => {
  throw new AppError("ZHIHU_PARTICIPATION_BROWSER", message);
};
const clean = (value: string) =>
  value
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const officialHosts = ["www.zhihu.com", "zhihu.com", "zhuanlan.zhihu.com"];
export interface ZhihuVisibleCard {
  href: string;
  title: string;
  excerpt: string;
  author?: string;
}
export interface ZhihuParticipationPageSnapshot {
  url: string;
  challenge: boolean;
  login: boolean;
  gateText: string;
  shell: boolean;
  empty: boolean;
  cards: ZhihuVisibleCard[];
  heading: string;
  body: string;
  collapsed: boolean;
  related: ZhihuVisibleCard[];
}

/** Tracking is discarded only after validating a direct official content link. */
export function normalizeZhihuVisibleUrl(
  raw: string,
  base = "https://www.zhihu.com/",
) {
  try {
    const url = new URL(raw, base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !officialHosts.includes(url.hostname)
    )
      return null;
    url.search = "";
    url.hash = "";
    return canonicalZhihuParticipationUrl(url.href);
  } catch {
    return null;
  }
}

export function normalizeZhihuVisibleHits(
  cards: ZhihuVisibleCard[],
  kind?: "question" | "author",
  limit = 10,
): ZhihuResearchHit[] {
  const cap = Number.isInteger(limit) ? Math.min(10, Math.max(1, limit)) : 10;
  const result: ZhihuResearchHit[] = [],
    seen = new Set<string>();
  for (const card of cards.slice(0, 30)) {
    let url = normalizeZhihuVisibleUrl(card.href),
      sourceKind = url && zhihuParticipationUrlKind(url);
    if (!url || !sourceKind) continue;
    if (kind === "author" && sourceKind !== "author") continue;
    if (kind === "question" && !["question", "answer"].includes(sourceKind))
      continue;
    const answerExcerpt = kind === "question" && sourceKind === "answer";
    if (answerExcerpt) url = url.replace(/\/answer\/\d+$/, "");
    if (seen.has(url)) continue;
    const parsed = zhihuResearchHitSchema.safeParse({
      kind: answerExcerpt ? "question" : sourceKind,
      url,
      title: clean(card.title).slice(0, 300),
      excerpt:
        `${answerExcerpt ? "[搜索命中回答摘录] " : ""}${clean(card.excerpt)}`.slice(
          0,
          2000,
        ),
      ...(!answerExcerpt && card.author
        ? { author: clean(card.author).slice(0, 300) }
        : {}),
    });
    if (!parsed.success) continue;
    seen.add(url);
    result.push(parsed.data);
    if (result.length >= cap) break;
  }
  return result;
}

export function assertZhihuParticipationSnapshot(
  snapshot: ZhihuParticipationPageSnapshot,
) {
  let url: URL;
  try {
    url = new URL(snapshot.url);
  } catch {
    return fail("知乎页面地址无法识别，未读取上下文。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !officialHosts.includes(url.hostname)
  )
    fail("页面已离开知乎官方来源，读取已停止。");
  if (snapshot.challenge)
    fail("知乎显示验证码或安全验证，请本人在官方窗口处理后重新读取。");
  if (snapshot.login)
    fail("知乎要求登录，当前上下文未读取，请先核实账号身份。");
  if (
    /请求.{0,8}频繁|操作.{0,8}频繁|访问.{0,8}频繁|访问受限|访问异常|请求存在异常|请求次数过多|系统检测到.{0,20}异常/.test(
      snapshot.gateText,
    )
  )
    fail("知乎显示访问限制或请求频繁，读取已停止，不自动重试。");
  if (
    /没有知识存在的荒原|该(?:内容|问题|回答|文章).{0,8}(?:删除|不存在)|页面不存在|内容暂时无法访问|内容已下线/.test(
      snapshot.gateText,
    )
  )
    fail("此知乎内容已删除或暂不可访问，不能作为空结果保存。");
  return url;
}

export function parseZhihuSearchSnapshot(
  snapshot: ZhihuParticipationPageSnapshot,
  input: { query: string; kind: "question" | "author"; limit: number },
) {
  const url = assertZhihuParticipationSnapshot(snapshot);
  if (
    url.origin !== "https://www.zhihu.com" ||
    url.pathname.replace(/\/$/, "") !== "/search" ||
    url.searchParams.get("q") !== input.query ||
    url.searchParams.get("type") !==
      (input.kind === "author" ? "people" : "content")
  )
    fail("知乎搜索发生跳转或关键词变化，未保存结果。");
  if (!snapshot.shell)
    fail("未识别到知乎官方搜索结果区域，请核对页面结构后重试。");
  if (snapshot.empty && snapshot.cards.length === 0) return [];
  const known = normalizeZhihuVisibleHits(snapshot.cards);
  if (!known.length)
    fail("搜索结果尚未加载或卡片结构无法识别，不能当作没有命中。");
  const hits = normalizeZhihuVisibleHits(
    snapshot.cards,
    input.kind,
    input.limit,
  );
  if (input.kind === "author" && !hits.length)
    fail("作者搜索未识别到作者卡片，不能将其他内容区域当作无命中。");
  if (
    input.kind === "question" &&
    !hits.length &&
    known.every((hit) => hit.kind === "author")
  )
    fail(
      "内容搜索只识别到作者元信息，结果卡片结构需要核对，不能当作问题无命中。",
    );
  return hits;
}

/** Search shells mount before their titles and URLs hydrate; a .List-item alone is not data. */
export function zhihuParticipationSearchReady(
  snapshot: ZhihuParticipationPageSnapshot,
): boolean {
  assertZhihuParticipationSnapshot(snapshot);
  return (
    snapshot.shell &&
    ((snapshot.empty && snapshot.cards.length === 0) ||
      normalizeZhihuVisibleHits(snapshot.cards).length > 0)
  );
}

export function isZhihuBodyExpandLabel(label: string): boolean {
  return /^(?:显示全部|展开|展开全文|展开全部|阅读全文)$/.test(
    clean(label).replace(/\s/g, ""),
  );
}

export function isZhihuBodyExpandHref(
  raw: string | null,
  expectedUrl: string,
): boolean {
  if (
    !raw?.trim() ||
    raw.trim().startsWith("#") ||
    /^javascript:(?:void\(0\);?|;?)$/i.test(raw.trim())
  )
    return true;
  try {
    return (
      canonicalZhihuParticipationUrl(new URL(raw, expectedUrl).href) ===
      expectedUrl
    );
  } catch {
    return false;
  }
}

export function parseZhihuDocumentSnapshot(
  snapshot: ZhihuParticipationPageSnapshot,
  expectedUrl: string,
  at = new Date().toISOString(),
): ZhihuResearchDocument {
  assertZhihuParticipationSnapshot(snapshot);
  const canonical = canonicalZhihuParticipationUrl(expectedUrl),
    kind = canonical && zhihuParticipationUrlKind(canonical);
  if (
    !canonical ||
    !kind ||
    canonicalZhihuParticipationUrl(snapshot.url) !== canonical
  )
    fail("知乎内容页与所选官方链接不一致，未保存上下文。");
  const title = clean(snapshot.heading).slice(0, 300);
  if (!snapshot.shell || !title)
    fail("未识别到此条知乎内容的唯一标题或正文区域，请核对页面后重试。");
  if (snapshot.collapsed && kind !== "author")
    fail(
      "此条正文仍被折叠，不能确认完整上下文；请本人在官方窗口核对后重新读取。",
    );
  const body = clean(snapshot.body);
  if ((kind === "answer" || kind === "article") && !body)
    fail("未读取到此条内容的真实正文，不能使用其他推荐卡片代替。");
  const raw = [title, body].filter(Boolean).join("\n\n"),
    suffix = "\n\n[正文较长，仅保存页面正文前段，最多16000字符]";
  const related = normalizeZhihuVisibleHits(snapshot.related)
    .filter(
      (hit) =>
        hit.url !== canonical &&
        (kind !== "author" || hit.kind === "article") &&
        (kind !== "question" ||
          (hit.kind === "answer" &&
            hit.url.startsWith(`${canonical}/answer/`))),
    )
    .slice(0, 5)
    .map((hit) => ({ ...hit, excerpt: hit.excerpt.slice(0, 700) }));
  return zhihuResearchDocumentSchema.parse({
    kind,
    url: canonical,
    title,
    truncated: raw.length > 16000,
    text:
      raw.length > 16000 ? raw.slice(0, 16000 - suffix.length) + suffix : raw,
    observedAt: at,
    related,
  });
}

/** Self-contained DOM reader. Never clicks, scrolls, calls content APIs or reads app state. */
export function zhihuParticipationDomSnapshot(input: {
  mode: "search" | "document";
  kind: string;
  url: string;
}): ZhihuParticipationPageSnapshot {
  const visible = (element: Element | null): element is HTMLElement =>
    !!element &&
    element instanceof HTMLElement &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden" &&
    getComputedStyle(element).display !== "none";
  const first = (root: ParentNode, selector: string) =>
    [...root.querySelectorAll(selector)].find(visible) as
      HTMLElement | undefined;
  const text = (root: Element | undefined | null, max = 16500) =>
    visible(root ?? null)
      ? (root as HTMLElement).innerText.trim().slice(0, max)
      : "";
  const card = (root: HTMLElement): ZhihuVisibleCard | null => {
    const heading = first(
      root,
      "h2,h3,.ContentItem-title,.UserItem-title,.ProfileHeader-name",
    );
    const anchor =
      (heading?.matches("a[href]")
        ? heading
        : heading?.querySelector("a[href]")) ??
      first(
        root,
        input.mode === "search" && input.kind === "author"
          ? ".UserItem-title a[href],a.UserLink-link[href],a[href*='/people/']"
          : ".ContentItem-title a[href],a.ContentItem-title[href],a[href*='/question/'],a[href*='zhuanlan.zhihu.com/p/']",
      );
    if (!(anchor instanceof HTMLAnchorElement)) return null;
    const title = text(heading, 300) || text(anchor, 300);
    if (!title) return null;
    const excerpt = first(
      root,
      ".RichContent-inner,.RichText,.ContentItem-excerpt,.UserItem-content,.UserItem-headline,.ztext",
    );
    return {
      href: anchor.href,
      title,
      excerpt: text(excerpt, 2000),
      author:
        text(first(root, ".AuthorInfo-name,.UserLink-link"), 300) || undefined,
    };
  };
  const bodyText = document.body?.innerText ?? "";
  const dialogs = [
    ...document.querySelectorAll(
      "[role='dialog'],[role='alert'],.SignFlow,.SignContainer-content,.Captcha,.Unhuman,.ErrorPage,.ErrorMessage",
    ),
  ].filter(visible);
  const dialogText = dialogs.map((root) => text(root, 2000)).join("\n");
  const challenge =
    !!first(
      document,
      "iframe[src*='captcha'],iframe[src*='Captcha'],[class*='Captcha'],[id*='captcha'],.Unhuman",
    ) || /安全验证|请完成验证|输入验证码|验证后继续/.test(dialogText);
  const login =
    !!first(
      document,
      ".SignFlow,.SignContainer-content,form[action*='sign_in']",
    ) || /(?:登录|注册)知乎|登录后(?:查看|继续)|请先登录/.test(dialogText);
  let shell = false,
    empty = false,
    cards: ZhihuVisibleCard[] = [],
    heading = "",
    body = "",
    collapsed = false,
    related: ZhihuVisibleCard[] = [];
  if (input.mode === "search") {
    const search = first(
      document,
      ".SearchMain,.Search-container,.SearchResult-Card,[data-za-module='SearchResultList']",
    );
    shell = !!search;
    if (search) {
      let roots = [...search.querySelectorAll(".List-item,.SearchItem")].filter(
        visible,
      );
      if (!roots.length)
        roots = [...search.querySelectorAll(".UserItem,.ContentItem")].filter(
          visible,
        );
      roots = roots.filter(
        (root, _i, all) =>
          !all.some((other) => other !== root && other.contains(root)),
      );
      cards = roots
        .slice(0, 10)
        .map(card)
        .filter((value): value is ZhihuVisibleCard => !!value);
      const blank = first(
        search,
        ".EmptyState,.SearchEmpty,.Search-empty,.List-empty,[role='status']",
      );
      empty =
        !!blank &&
        /没有找到|未找到|没有搜索到|暂无搜索|没有相关|搜索结果为空/.test(
          text(blank, 500),
        );
    }
  } else if (input.kind === "author") {
    const header = first(document, ".ProfileHeader");
    heading = text(first(document, ".ProfileHeader-name"), 300);
    shell = !!header && !!heading;
    if (header) {
      const fields = [
        ".ProfileHeader-headline",
        ".ProfileHeader-info",
        ".ProfileHeader-detail",
      ]
        .map((selector) => text(first(header, selector), 6000))
        .filter(Boolean);
      body = fields.length
        ? ["[作者公开简介]", ...fields].join("\n")
        : "[页面未展示公开简介]";
    }
    const main = first(document, ".Profile-mainColumn,.Profile-main");
    if (main)
      related = [...main.querySelectorAll(".List-item,.ContentItem")]
        .filter(visible)
        .slice(0, 10)
        .map(card)
        .filter((value): value is ZhihuVisibleCard => !!value);
  } else if (input.kind === "article") {
    heading = text(first(document, "h1.Post-Title,.Post-Title"), 300);
    const content = first(
      document,
      ".Post-RichTextContainer .RichText,.Post-RichTextContainer,.Post-RichText,.Post-content .RichText",
    );
    shell = !!content && !!heading;
    body = text(content);
    collapsed =
      !!content?.closest(".is-collapsed") ||
      !!first(document, ".Post-RichTextContainer .ContentItem-expandButton");
  } else {
    heading = text(first(document, ".QuestionHeader-title"), 300);
    const question = first(document, ".QuestionHeader");
    if (input.kind === "question") {
      shell = !!question && !!heading;
      body = text(
        question &&
          first(
            question,
            ".QuestionRichText .RichText,.QuestionRichText,.QuestionHeader-detail",
          ),
      );
      collapsed =
        !!question &&
        /显示全部|展开|阅读全文/.test(
          text(first(question, ".QuestionRichText-more"), 100),
        );
      related = [
        ...document.querySelectorAll(
          ".Question-main .AnswerItem,.Question-mainColumn .AnswerItem",
        ),
      ]
        .filter(visible)
        .slice(0, 5)
        .map<ZhihuVisibleCard | null>((root) => {
          const permalink = first(
            root,
            ".ContentItem-time a[href*='/answer/'],a.ContentItem-more[href*='/answer/']",
          );
          if (!(permalink instanceof HTMLAnchorElement)) return null;
          return {
            href: permalink.href,
            title: heading || "当前问题下的回答",
            excerpt: text(first(root, ".RichContent-inner,.RichText"), 700),
            author: text(first(root, ".AuthorInfo-name"), 300) || undefined,
          };
        })
        .filter((value): value is ZhihuVisibleCard => !!value);
    } else {
      const answerId = new URL(input.url).pathname.match(
        /\/answer\/(\d+)$/,
      )?.[1];
      const answers = [...document.querySelectorAll(".AnswerItem")].filter(
        visible,
      );
      const answer = answers.find((root) => {
        if (
          root.getAttribute("data-answerid") === answerId ||
          root.getAttribute("data-aid") === answerId
        )
          return true;
        try {
          if (
            String(
              JSON.parse(root.getAttribute("data-zop") ?? "{}").itemId ?? "",
            ) === answerId
          )
            return true;
        } catch {
          /* DOM metadata is untrusted. */
        }
        return [
          ...root.querySelectorAll(
            ".ContentItem-time a[href],a.ContentItem-more[href]",
          ),
        ].some((link) => {
          try {
            return (
              new URL((link as HTMLAnchorElement).href).pathname ===
              new URL(input.url).pathname
            );
          } catch {
            return false;
          }
        });
      });
      shell = !!answer && !!heading;
      if (answer) {
        body = text(
          first(
            answer,
            ".RichContent-inner .RichText,.RichContent-inner,.RichText",
          ),
        );
        collapsed =
          !!first(answer, ".RichContent.is-collapsed") ||
          /^(?:显示全部|展开|展开全文|展开全部|阅读全文)$/.test(
            text(first(answer, ".ContentItem-expandButton"), 100).replace(
              /[\s\u200b-\u200d\ufeff]/g,
              "",
            ),
          );
      }
    }
  }
  if (input.mode === "document" && input.kind !== "author") {
    const selector =
      input.kind === "article"
        ? ".Post-Author .AuthorInfo a[href*='/people/'],.Post-Header .AuthorInfo a[href*='/people/']"
        : ".Question-main .AnswerItem .AuthorInfo a[href*='/people/'],.Question-mainColumn .AnswerItem .AuthorInfo a[href*='/people/']";
    const authors = [...document.querySelectorAll(selector)]
      .filter(visible)
      .filter(
        (anchor): anchor is HTMLAnchorElement =>
          anchor instanceof HTMLAnchorElement && !!text(anchor, 300),
      )
      .filter(
        (anchor, index, all) =>
          all.findIndex((a) => a.href === anchor.href) === index,
      )
      .slice(0, 5)
      .map((anchor) => ({
        href: anchor.href,
        title: text(anchor, 300),
        excerpt: "当前内容中公开列出的作者，尚未读取作者资料",
        author: text(anchor, 300),
      }));
    related = [...related, ...authors].slice(0, 10);
  }
  const hasContent = shell && (cards.length > 0 || !!heading);
  return {
    url: location.href,
    challenge:
      challenge ||
      (!hasContent &&
        /安全验证|请完成验证|输入验证码|验证后继续访问/.test(
          bodyText.slice(0, 2000),
        )),
    login:
      login ||
      (!hasContent &&
        /登录知乎|登录后(?:查看|继续)|请先登录/.test(bodyText.slice(0, 2000))),
    gateText:
      `${document.title}\n${dialogText}\n${hasContent ? "" : bodyText.slice(0, 2000)}`.slice(
        0,
        6000,
      ),
    shell,
    empty,
    cards,
    heading,
    body,
    collapsed,
    related,
  };
}

const snapshotScript = (input: {
  mode: "search" | "document";
  kind: string;
  url: string;
}) =>
  `(() => { const __name = (fn) => fn; return (${zhihuParticipationDomSnapshot.toString()})(${JSON.stringify(input)}); })()`;

/** Reveal this exact document only; this is neither an interaction task nor a read receipt. */
export async function expandZhihuParticipationBody(
  page: Page,
  expectedUrl: string,
  snapshot: ZhihuParticipationPageSnapshot,
): Promise<ZhihuParticipationPageSnapshot> {
  const validate = (value: ZhihuParticipationPageSnapshot) => {
    assertZhihuParticipationSnapshot(value);
    if (
      canonicalZhihuParticipationUrl(value.url) !== expectedUrl ||
      canonicalZhihuParticipationUrl(page.url()) !== expectedUrl
    )
      fail("展开前后知乎目标链接发生变化，已停止读取。");
  };
  validate(snapshot);
  if (!snapshot.collapsed) return snapshot;
  const kind = zhihuParticipationUrlKind(expectedUrl);
  if (kind !== "question" && kind !== "answer") return snapshot;
  let root = page.locator(".QuestionHeader:visible");
  if (kind === "answer") {
    const answerId = new URL(expectedUrl).pathname.match(
      /\/answer\/(\d+)$/,
    )![1];
    const roots = page.locator(".AnswerItem:visible"),
      count = await roots.count(),
      matches: number[] = [];
    if (count > 30) fail("回答区域过多，无法唯一核对目标正文，未点击展开。");
    for (let index = 0; index < count; index++) {
      const candidate = roots.nth(index);
      let matched =
        (await candidate.getAttribute("data-answerid")) === answerId ||
        (await candidate.getAttribute("data-aid")) === answerId;
      try {
        matched ||=
          String(
            JSON.parse((await candidate.getAttribute("data-zop")) ?? "{}")
              .itemId ?? "",
          ) === answerId;
      } catch {
        /* Malformed public DOM metadata is not identity evidence. */
      }
      if (!matched) {
        const links = candidate.locator(
          ".ContentItem-time a[href],a.ContentItem-more[href]",
        );
        for (
          let link = 0, n = Math.min(await links.count(), 10);
          link < n;
          link++
        )
          if (
            normalizeZhihuVisibleUrl(
              (await links.nth(link).getAttribute("href")) ?? "",
              expectedUrl,
            ) === expectedUrl
          ) {
            matched = true;
            break;
          }
      }
      if (matched) matches.push(index);
    }
    if (matches.length !== 1)
      fail("未找到唯一匹配此answerId的回答正文，未点击其他卡片。");
    root = roots.nth(matches[0]);
  } else if ((await root.count()) !== 1)
    fail("当前问题头部不唯一，未点击展开。");
  const controls = root.locator(
    kind === "question"
      ? ".QuestionRichText-more:visible"
      : ".ContentItem-expandButton:visible",
  );
  if ((await controls.count()) !== 1)
    fail("当前正文没有唯一可识别的展开入口，未点击其他区域。");
  const label = await controls.innerText();
  if (!isZhihuBodyExpandLabel(label))
    fail("正文入口并非单纯显示全部/阅读全文，未点击登录、付费或其他操作。");
  const rootText = await root.innerText();
  if (
    /开通.{0,8}会员|购买后|购买(?:阅读|全文)|付费阅读|会员专享|试读结束|解锁(?:正文|全文)/.test(
      rootText,
    )
  )
    fail("当前正文存在付费阅读提示，未点击展开或购买。");
  if (!isZhihuBodyExpandHref(await controls.getAttribute("href"), expectedUrl))
    fail("展开控件指向其他链接，未点击。");
  const nestedLinks = controls.locator("a[href]");
  for (let index = 0, count = await nestedLinks.count(); index < count; index++)
    if (
      !isZhihuBodyExpandHref(
        await nestedLinks.nth(index).getAttribute("href"),
        expectedUrl,
      )
    )
      fail("展开控件包含登录或其他跳转，未点击。");
  // Recheck the full official snapshot immediately before this one read-only expansion.
  const beforeClick = await page.evaluate<ZhihuParticipationPageSnapshot>(
    snapshotScript({ mode: "document", kind, url: expectedUrl }),
  );
  validate(beforeClick);
  if (!beforeClick.collapsed) return beforeClick;
  if (
    (await controls.count()) !== 1 ||
    !isZhihuBodyExpandLabel(await controls.innerText())
  )
    fail("正文展开控件状态已变化，未点击其他操作。");
  await controls.click({ timeout: 5000 });
  const deadline = Date.now() + 5000;
  for (;;) {
    const current = await page.evaluate<ZhihuParticipationPageSnapshot>(
      snapshotScript({ mode: "document", kind, url: expectedUrl }),
    );
    validate(current);
    if (!current.collapsed) return current;
    if (Date.now() >= deadline)
      fail("正文展开后仍被折叠，无法确认完整上下文，读取已停止。");
    await page.waitForTimeout(250);
  }
}
export async function assertZhihuParticipationAccount(
  context: BrowserContext,
  account: WebsiteAccount,
) {
  if (
    account.provider !== "zhihu" ||
    !account.uid ||
    account.status !== "connected"
  )
    fail("请先核实此知乎账号的登录身份。");
  const identity = await verifyZhihu(context);
  if (!identity.hasSession || identity.uid !== account.uid)
    fail("浏览器当前知乎身份与所选账号不一致，读取已停止。");
}
export async function loadZhihuParticipationPage(
  page: Page,
  url: string,
  kind: string,
  mode: "search" | "document",
) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  if (!officialBrowserPage(page, officialHosts))
    fail("知乎页面已跳转至非官方来源，读取已停止。");
  if (!response || !response.ok())
    fail(
      `知乎页面加载失败${response ? `（HTTP ${response.status()}）` : ""}，未将读取失败当作空结果；请核对登录、验证或访问限制。`,
    );
  if (mode === "search") {
    const deadline = Date.now() + 10000;
    for (;;) {
      const snapshot = await page.evaluate<ZhihuParticipationPageSnapshot>(
        snapshotScript({ mode, kind, url }),
      );
      if (zhihuParticipationSearchReady(snapshot) || Date.now() >= deadline)
        return snapshot;
      // Wait for real DOM hydration only. No scrolling, repeated navigation or simulated dwell.
      await page.waitForTimeout(250);
    }
  }
  await page
    .waitForFunction(
      () =>
        !!document.querySelector(
          ".SearchMain .List-item,.SearchMain .EmptyState,.SearchMain .UserItem,.QuestionHeader-title,.Post-Title,.ProfileHeader-name,.SignFlow,[class*='Captcha'],.Unhuman",
        ),
      undefined,
      { timeout: 10000 },
    )
    .catch(() => {});
  const snapshot = await page.evaluate<ZhihuParticipationPageSnapshot>(
    snapshotScript({ mode, kind, url }),
  );
  return expandZhihuParticipationBody(page, url, snapshot);
}

/** Caller holds WebsiteAccounts.use / its environment queue lease. Each read closes only its own page. */
export function zhihuParticipationBrowser(
  withContext: <T>(
    account: WebsiteAccount,
    action: (context: BrowserContext) => Promise<T>,
  ) => Promise<T>,
): ZhihuParticipationBrowserPort {
  return {
    discover: (account, input) => {
      const query = input.query.trim();
      if (
        ((input.source ?? "search") === "search" && !query) ||
        query.length > 200 ||
        !["question", "author"].includes(input.kind) ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > (input.source === "creator_recommend" ? 50 : 10) ||
        (input.source === "creator_recommend" && input.kind !== "question")
      )
        fail("请输入1至200字关键词，每次最多读取10条命中。");
      const url = new URL("https://www.zhihu.com/search");
      url.searchParams.set(
        "type",
        input.kind === "author" ? "people" : "content",
      );
      url.searchParams.set("q", query);
      return withContext(account, async (context) => {
        await assertZhihuParticipationAccount(context, account);
        const page = await context.newPage();
        try {
          if (input.source === "creator_recommend")
            return await readFeaturedQuestions(page, input.limit, async () => {
              assertZhihuParticipationSnapshot(
                await page.evaluate<ZhihuParticipationPageSnapshot>(
                  snapshotScript({
                    mode: "search",
                    kind: "question",
                    url: "https://www.zhihu.com/creator/featured-question/recommend",
                  }),
                ),
              );
            });
          return parseZhihuSearchSnapshot(
            await loadZhihuParticipationPage(
              page,
              url.href,
              input.kind,
              "search",
            ),
            { ...input, query },
          );
        } finally {
          await page.close().catch(() => {});
        }
      });
    },
    inspect: (account, input) => {
      const url =
        canonicalZhihuParticipationUrl(input.url) ??
        fail("仅可读取规范知乎官方内容链接。");
      return withContext(account, async (context) => {
        await assertZhihuParticipationAccount(context, account);
        const page = await context.newPage();
        try {
          return parseZhihuDocumentSnapshot(
            await loadZhihuParticipationPage(
              page,
              url,
              zhihuParticipationUrlKind(url)!,
              "document",
            ),
            url,
          );
        } finally {
          await page.close().catch(() => {});
        }
      });
    },
  };
}

/** Explicit manual handoff: retain this newly-created official page; never click an interaction. */
export async function openZhihuParticipationDocument(
  context: BrowserContext,
  account: WebsiteAccount,
  raw: string,
): Promise<void> {
  const url =
    canonicalZhihuParticipationUrl(raw) ??
    fail("仅可打开规范知乎官方问题、回答、文章或作者链接。");
  await assertZhihuParticipationAccount(context, account);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (
      !officialBrowserPage(page, officialHosts) ||
      canonicalZhihuParticipationUrl(page.url()) !== url
    )
      fail("官方内容页发生跳转，未打开其他内容。");
    await page.bringToFront();
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}
