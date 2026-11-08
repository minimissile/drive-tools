import type {
  BrowserContext,
  ElementHandle,
  Locator,
  Page,
  Response,
} from "playwright-core";
import type { WebsiteAccount } from "../../shared/website-accounts";
import {
  zhihuInteractionRequestSchema,
  zhihuInteractionReceiptSchema,
  type ZhihuInteractionBrowserPort,
  type ZhihuInteractionRequest,
  type ZhihuInteractionReceipt,
} from "../../shared/zhihu-interaction";
import {
  canonicalZhihuParticipationUrl,
  zhihuParticipationUrlKind,
} from "../../shared/zhihu-participation";
import { AppError } from "../errors";
import {
  assertZhihuParticipationAccount,
  assertZhihuParticipationSnapshot,
  loadZhihuParticipationPage,
  normalizeZhihuVisibleUrl,
  parseZhihuDocumentSnapshot,
  zhihuParticipationDomSnapshot,
  type ZhihuParticipationPageSnapshot,
} from "./browser";

const fail = (message: string): never => {
  throw new AppError("ZHIHU_INTERACTION_BROWSER", message);
};
const plain = (text: string) => text.replace(/\r\n?/g, "\n").trim();
const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,150}$/.test(value)
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : null;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
type Target = {
  url: string;
  kind: "answer" | "article" | "author";
  id: string;
};
type CommentProof = { id: string; uid: string; text: string };

function targetFor(request: ZhihuInteractionRequest): Target {
  const url = canonicalZhihuParticipationUrl(request.url),
    kind = url && zhihuParticipationUrlKind(url);
  if (!url || !kind || kind === "question")
    return fail("互动目标只能是规范的回答、文章或作者页面。");
  if ((request.kind === "follow") !== (kind === "author"))
    fail("关注只能针对作者，赞同或评论只能针对具体回答、文章。");
  if (request.kind === "comment" ? !plain(request.text) : !!request.text)
    fail("评论需要准确正文，赞同或关注不接受附加评论文本。");
  if (!request.excludedUids.includes(request.actorUid))
    fail("互动排除名单必须包括执行账号本人。");
  return { url, kind, id: new URL(url).pathname.split("/").at(-1)! };
}

/** Explicit public state labels only. An unreadable state is never an inactive state. */
export function parseZhihuInteractionButtonState(
  kind: "like" | "follow",
  value: { label: string; className: string; pressed: string | null },
): boolean | null {
  const label = value.label.replace(/[\s\u200b-\u200d\ufeff,+＋]/g, ""),
    activeClass = /(?:^|\s)(?:is-active|is-following)(?:\s|$)/.test(
      value.className,
    );
  const activeLabel =
    kind === "like"
      ? /^(?:已赞同|取消赞同)(?:\d+(?:\.\d+)?[万亿kK]?)?$/.test(label)
      : /^(?:已关注|互相关注|已互相关注|取消关注)$/.test(label);
  const inactiveLabel =
    kind === "like"
      ? /^赞同(?:\d+(?:\.\d+)?[万亿kK]?)?$/.test(label)
      : /^(?:关注|关注他|关注她|关注TA|关注作者)$/.test(label);
  if (!activeLabel && !inactiveLabel) return null;
  if (value.pressed !== null && !["true", "false"].includes(value.pressed))
    return null;
  if (value.pressed === "false" && (activeClass || activeLabel)) return null;
  if (value.pressed === "true" || activeClass || activeLabel) return true;
  return inactiveLabel ? false : null;
}

async function targetRoot(page: Page, target: Target): Promise<Locator> {
  if (target.kind === "author") {
    const root = page.locator(".ProfileHeader:visible");
    if ((await root.count()) !== 1)
      fail("作者头部不是唯一可识别区域，未进行关注。");
    return root;
  }
  if (target.kind === "article") {
    for (const selector of [
      ".Post:visible",
      "article:has(.Post-RichTextContainer):visible",
      ".Post-Main:visible",
    ]) {
      const root = page.locator(selector);
      if ((await root.count()) === 1) return root;
      if ((await root.count()) > 1) fail("文章正文区域不唯一，未进行互动。");
    }
    return fail("没有识别到此篇文章的唯一正文区域。");
  }
  const roots = page.locator(".AnswerItem:visible"),
    count = await roots.count(),
    matches: number[] = [];
  if (count > 30) fail("回答卡片过多，无法唯一核实目标回答。");
  for (let index = 0; index < count; index++) {
    const root = roots.nth(index);
    let match =
      (await root.getAttribute("data-answerid")) === target.id ||
      (await root.getAttribute("data-aid")) === target.id;
    try {
      match ||=
        String(
          JSON.parse((await root.getAttribute("data-zop")) ?? "{}").itemId ??
            "",
        ) === target.id;
    } catch {
      /* Not identity evidence. */
    }
    const links = root.locator(
      ".ContentItem-time a[href],a.ContentItem-more[href]",
    );
    for (
      let link = 0, n = Math.min(await links.count(), 10);
      !match && link < n;
      link++
    )
      match =
        normalizeZhihuVisibleUrl(
          (await links.nth(link).getAttribute("href")) ?? "",
          target.url,
        ) === target.url;
    if (match) matches.push(index);
  }
  if (matches.length !== 1) fail("没有找到与目标answerId唯一匹配的回答卡片。");
  return roots.nth(matches[0]);
}

/** A live nth() locator may move after hydration; bind the actual nodes before any irreversible click. */
async function assertRootBinding(
  page: Page,
  target: Target,
  selected: Locator,
) {
  const expected = await (await targetRoot(page, target)).elementHandle(),
    actual = await selected.elementHandle();
  try {
    if (
      !expected ||
      !actual ||
      !(await expected.evaluate(
        (element, selectedRoot) =>
          element === selectedRoot && element.isConnected,
        actual,
      ))
    )
      fail("目标卡片发生替换或重排，原控件不再唯一属于准确目标，未点击。");
  } finally {
    await expected?.dispose();
    await actual?.dispose();
  }
}

async function boundControl(
  page: Page,
  target: Target,
  selectedRoot: Locator,
  control: Locator,
): Promise<ElementHandle<HTMLElement | SVGElement>> {
  const expected = await (await targetRoot(page, target)).elementHandle(),
    actual = await selectedRoot.elementHandle(),
    handle = await control.elementHandle();
  let accepted = false;
  try {
    if (
      !expected ||
      !actual ||
      !handle ||
      !(await expected.evaluate(
        (element, value) =>
          element === value.root &&
          element.isConnected &&
          value.control.isConnected &&
          element.contains(value.control),
        { root: actual, control: handle },
      ))
    )
      fail("最终控件与准确目标正文不是同一DOM区域，未点击。");
    accepted = true;
    return handle;
  } finally {
    await expected?.dispose();
    await actual?.dispose();
    if (!accepted) await handle?.dispose();
  }
}

const commentEditorSelector =
  ".CommentEditor textarea:visible,.CommentEditor [contenteditable='true']:visible,.CommentEditorV2 textarea:visible,.CommentEditorV2 [contenteditable='true']:visible";
const replyEditorAncestors =
  ".CommentItem,.CommentItemV2,[data-comment-id],[data-root-comment-id],.ReplyEditor,.CommentReplyEditor,.CommentEditor-reply,.CommentItemV2-reply,.CommentItem-reply,[data-reply-to],[data-reply-to-comment-id]";

async function isTopLevelEditor(
  editor: Locator,
  control?: ElementHandle<HTMLElement | SVGElement>,
) {
  return editor.evaluate(
    (element, { submit, excluded }) => {
      const container = element.closest(".CommentEditor,.CommentEditorV2");
      if (
        !container ||
        !element.isConnected ||
        (submit && (!submit.isConnected || !container.contains(submit)))
      )
        return false;
      if (element.closest(excluded)) return false;
      return !/回复/.test(
        `${element.getAttribute("placeholder") ?? ""} ${element.getAttribute("aria-label") ?? ""}`,
      );
    },
    { submit: control ?? null, excluded: replyEditorAncestors },
  );
}

async function assertTopLevelEditor(
  editor: Locator,
  control?: ElementHandle<HTMLElement | SVGElement>,
) {
  if (!(await isTopLevelEditor(editor, control)))
    fail("编辑器不是本条内容唯一的顶层评论输入框，未提交回复或其他讨论。");
}

/** Only known editor structures inside this exact content root are eligible.
 * A global/portalled editor is deliberately not inferred from its visibility. */
async function topLevelCommentEditor(root: Locator) {
  const editors = root.locator(commentEditorSelector),
    count = await editors.count(),
    matches: number[] = [];
  if (count > 20) fail("本条内容的评论输入框过多，无法唯一核实顶层编辑器。");
  for (let index = 0; index < count; index++)
    if (await isTopLevelEditor(editors.nth(index))) matches.push(index);
  if (matches.length > 1)
    fail("本条内容存在多个顶层评论输入框，未选择任何一个提交。");
  return matches.length === 1 ? editors.nth(matches[0]) : null;
}

const replyKeys =
  /^(?:reply[_-]?to(?:[_-]?(?:comment|author))?(?:[_-]?id)?|parent[_-]?id|root[_-]?comment[_-]?id)$/i;
function hasReplyTarget(value: unknown, request: boolean, depth = 0): boolean {
  if (depth > 4) return request;
  if (Array.isArray(value))
    return (
      value.length > 100 ||
      value.some((item) => hasReplyTarget(item, request, depth + 1))
    );
  const record = object(value);
  if (!record) return false;
  const entries = Object.entries(record);
  if (entries.length > 100) return true;
  return entries.some(([key, item]) => {
    const reply =
      replyKeys.test(key) &&
      (request || !/^root[_-]?comment[_-]?id$/i.test(key));
    if (
      reply &&
      item !== undefined &&
      item !== null &&
      item !== "" &&
      item !== 0 &&
      item !== "0" &&
      item !== false
    )
      return true;
    return request && item && typeof item === "object"
      ? hasReplyTarget(item, request, depth + 1)
      : false;
  });
}

function assertCommentRequest(response: Response, text: string) {
  const request = response.request(),
    body = request.postData();
  if (request.method() !== "POST" || !body || body.length > 50000)
    return fail("未取得本次评论创建请求的准确正文，保留待核对。");
  let payload: RecordValue | null = null;
  try {
    payload = object(JSON.parse(body));
  } catch {
    if (
      /application\/x-www-form-urlencoded/i.test(
        request.headers()["content-type"] ?? "",
      )
    )
      payload = Object.fromEntries(new URLSearchParams(body));
  }
  if (!payload || hasReplyTarget(payload, true))
    return fail("评论请求含回复对象或结构无法确认，不登记为顶层评论成功。");
  const content =
    typeof payload.content === "string"
      ? payload.content
      : typeof payload.text === "string"
        ? payload.text
        : null;
  if (content === null || plain(content) !== plain(text))
    fail("官方评论请求正文与本次准确文本不一致，保留待核对。");
}

function officialResponse(response: Response) {
  try {
    const url = new URL(response.url());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["www.zhihu.com", "zhuanlan.zhihu.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
function exactEntityPath(path: string, target: Target) {
  return target.kind === "author"
    ? new RegExp(`^/api/v4/members/${target.id}/?$`).test(path)
    : new RegExp(
        `^/api/(?:v4/)?${target.kind === "answer" ? "answers" : "articles"}/${target.id}/?$`,
      ).test(path);
}
function commentPath(path: string, target: Target) {
  if (target.kind === "author") return false;
  const plural = target.kind === "answer" ? "answers" : "articles";
  return (
    new RegExp(
      `^/api/v4/${plural}/${target.id}/(?:root_comments|comments)/?$`,
    ).test(path) ||
    new RegExp(
      `^/api/v4/comment_v5/${plural}/${target.id}/(?:root_comment|root_comments|comment|comments)/?$`,
    ).test(path)
  );
}
function mutationPath(
  path: string,
  target: Target,
  kind: ZhihuInteractionRequest["kind"],
  authorUid: string,
) {
  if (kind === "comment") return commentPath(path, target);
  if (kind === "follow")
    return [target.id, authorUid].some((id) =>
      new RegExp(`^/api/v4/members/${id}/followers/?$`).test(path),
    );
  return new RegExp(
    `^/api/(?:v4/)?${target.kind === "answer" ? "answers" : "articles"}/${target.id}/(?:voters|likers|like|vote)/?$`,
  ).test(path);
}
function authorOf(record: RecordValue) {
  const author = object(record.author),
    member = object(author?.member);
  return identifier(member?.id) ?? identifier(author?.id);
}

async function responseText(response: Response, limit: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                "ZHIHU_INTERACTION_BROWSER",
                "官方回执读取超时，未将未知响应登记为成功。",
              ),
            ),
          10000,
        );
      }),
    ]);
    if (text.length > limit)
      fail("官方回执超过读取上限，未将未知响应登记为成功。");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Observe responses caused by this page's normal UI; never issue private content or mutation requests. */
class Evidence {
  readonly authors = new Set<string>();
  readonly comments = new Map<string, CommentProof>();
  private readonly pending = new Set<Promise<void>>();
  private reads = 0;
  constructor(
    private page: Page,
    private target: Target,
  ) {
    page.on("response", this.listen);
  }
  private listen = (response: Response) => {
    if (
      this.reads >= 40 ||
      response.request().method() !== "GET" ||
      !response.ok() ||
      !officialResponse(response)
    )
      return;
    const path = new URL(response.url()).pathname,
      entity = exactEntityPath(path, this.target),
      comments = commentPath(path, this.target);
    if (!entity && !comments) return;
    this.reads++;
    const job = this.read(response, entity)
      .catch(() => {})
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  };
  private async read(response: Response, entity: boolean) {
    const text = await responseText(response, 2_000_000);
    const raw = JSON.parse(text),
      record = object(raw),
      data = object(record?.data),
      value = data ?? record;
    if (entity && value) {
      if (this.target.kind === "author") {
        if (
          (value.url_token === this.target.id ||
            identifier(value.id) === this.target.id) &&
          identifier(value.id)
        )
          this.authors.add(identifier(value.id)!);
      } else if (identifier(value.id) === this.target.id && authorOf(value))
        this.authors.add(authorOf(value)!);
    }
    if (!entity) {
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(record?.data)
          ? record.data
          : [];
      for (const row of rows.slice(0, 100)) {
        const comment = object(row),
          id = identifier(comment?.id),
          uid = comment && authorOf(comment),
          content = comment?.content;
        if (comment && hasReplyTarget(comment, false)) continue;
        if (
          !id ||
          !uid ||
          typeof content !== "string" ||
          content.length > 12000
        )
          continue;
        this.comments.set(id, {
          id,
          uid,
          text: await responsePlainText(this.page, content),
        });
      }
    }
  }
  async settle() {
    await Promise.allSettled([...this.pending]);
  }
  close() {
    this.page.off("response", this.listen);
  }
}

async function responsePlainText(page: Page, content: string) {
  return page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(
      html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div)>/gi, "\n"),
      "text/html",
    );
    return (doc.body.textContent ?? "").replace(/\r\n?/g, "\n").trim();
  }, content);
}

async function pageIdentity(
  page: Page,
  root: Locator,
  target: Target,
  evidence: Evidence,
) {
  const uids = await root.evaluate((element) => {
    const values: string[] = [];
    for (const name of [
      "data-author-id",
      "data-author-uid",
      "data-member-id",
      "data-member-hash-id",
    ]) {
      const value = element.getAttribute(name);
      if (value) values.push(value);
    }
    try {
      const data = JSON.parse(element.getAttribute("data-zop") ?? "{}");
      for (const key of ["authorId", "author_id", "authorMemberHashId"])
        if (typeof data[key] === "string") values.push(data[key]);
    } catch {
      /* Display name and profile slug are not UID evidence. */
    }
    return values;
  });
  // Only the exact public SSR entity is read; never return the surrounding state or session fields.
  const embedded = await page.evaluate(({ kind, id }) => {
    const node = document.querySelector("script#js-initialData");
    if (!node?.textContent || node.textContent.length > 2_000_000) return null;
    try {
      const value = JSON.parse(node.textContent),
        entities = value.initialState?.entities;
      if (!entities) return null;
      if (kind === "author") {
        const rows = Object.values(entities.users ?? {}) as Record<
          string,
          unknown
        >[];
        const match = rows.filter(
          (user) =>
            user.urlToken === id || user.url_token === id || user.id === id,
        );
        return match.length === 1 && typeof match[0].id === "string"
          ? match[0].id
          : null;
      }
      const record = entities[kind === "answer" ? "answers" : "articles"]?.[id];
      if (!record || String(record.id) !== id) return null;
      if (typeof record.author === "string") {
        const user = entities.users?.[record.author];
        return typeof user?.id === "string" ? user.id : null;
      }
      return typeof record.author?.id === "string" ? record.author.id : null;
    } catch {
      return null;
    }
  }, target);
  await evidence.settle();
  const all = new Set(
    [...evidence.authors, ...uids, ...(embedded ? [embedded] : [])].filter(
      (uid) => identifier(uid) !== null,
    ),
  );
  if (all.size !== 1)
    fail(
      "无法从此目标的官方记录唯一核实作者UID，未操作；昵称或people链接不作为UID。",
    );
  return [...all][0];
}

const snapshot = async (page: Page, target: Target) => {
  const value = await page.evaluate<ZhihuParticipationPageSnapshot>(
    `(() => { const __name = (fn) => fn; return (${zhihuParticipationDomSnapshot.toString()})(${JSON.stringify({ mode: "document", kind: target.kind, url: target.url })}); })()`,
  );
  assertZhihuParticipationSnapshot(value);
  if (
    /实名认证|身份认证|绑定手机|阅读并同意|接受.{0,8}(?:协议|条款)|账号异常|禁止评论|已被禁言|今日.{0,12}上限|(?:评论|赞同|关注|互动).{0,10}(?:受限|限制|频繁)/.test(
      value.gateText,
    )
  )
    fail("知乎显示身份、协议或互动限制，需要本人处理；不继续点击。");
  if (
    canonicalZhihuParticipationUrl(page.url()) !== target.url ||
    canonicalZhihuParticipationUrl(value.url) !== target.url
  )
    fail("互动页面已离开准确目标，操作已停止。");
  return value;
};
async function assertContext(
  page: Page,
  target: Target,
  request: ZhihuInteractionRequest,
) {
  const document = parseZhihuDocumentSnapshot(
    await snapshot(page, target),
    target.url,
  );
  if (document.truncated || plain(document.text) !== plain(request.contextText))
    fail("目标正文已变化、折叠或不完整，请重新阅读后作出决定，未提交互动。");
}
async function interactionButtonState(
  control: Locator | ElementHandle<HTMLElement | SVGElement>,
  kind: "like" | "follow",
) {
  const className = (await control.getAttribute("class")) ?? "",
    pressed = await control.getAttribute("aria-pressed"),
    states: boolean[] = [];
  // Icon buttons can expose their action only through title. Conflicting
  // explicit labels remain unknown; a class alone never proves an inactive vote.
  for (const attribute of ["aria-label", "title"]) {
    const label = (await control.getAttribute(attribute))?.trim();
    if (!label) continue;
    const state = parseZhihuInteractionButtonState(kind, {
      label,
      className,
      pressed,
    });
    if (state === null) return null;
    states.push(state);
  }
  const textState = parseZhihuInteractionButtonState(kind, {
    label: await control.innerText(),
    className,
    pressed,
  });
  if (textState !== null) states.push(textState);
  return states.length && states.every((state) => state === states[0])
    ? states[0]
    : null;
}

async function assertActionButtonScope(
  root: Locator,
  control: ElementHandle<HTMLElement | SVGElement>,
) {
  const owned = await root.evaluate((element, selected) => {
    if (!element.contains(selected) || !selected.isConnected) return false;
    for (
      let parent = selected.parentElement;
      parent && parent !== element;
      parent = parent.parentElement
    )
      if (
        parent.matches(
          ".AnswerItem,.CommentItem,.CommentItemV2,[data-comment-id],.Comments-container,.CommentsV2,.Comments",
        )
      )
        return false;
    return true;
  }, control);
  if (!owned) fail("赞同或关注按钮位于其他回答或评论区域，未点击。");
}

async function button(root: Locator, kind: "like" | "follow") {
  const control =
    kind === "like"
      ? root
          .getByRole("button", {
            name: /^(?:赞同|已赞同|取消赞同)(?:[\s,+＋]*\d[\d,.]*\s*[万亿kK]?)?$/,
          })
          .or(
            root.locator(
              'button.VoteButton--up,button[title="赞同"],button[title="已赞同"],button[title="取消赞同"],[role="button"][title="赞同"],[role="button"][title="已赞同"],[role="button"][title="取消赞同"]',
            ),
          )
          .filter({ visible: true })
      : root.locator("button.FollowButton:visible");
  if ((await control.count()) === 0)
    await control.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  if ((await control.count()) !== 1 || !(await control.isEnabled()))
    fail(
      `准确目标内没有唯一可用的${kind === "like" ? "赞同" : "关注"}按钮（可见候选${await control.count()}）；未选择其他回答或全页控件。`,
    );
  const handle = await control.elementHandle();
  if (!handle) return fail("目标按钮已被替换，未点击。");
  try {
    await assertActionButtonScope(root, handle);
  } finally {
    await handle.dispose();
  }
  const state = await interactionButtonState(control, kind);
  if (state === null) fail("赞同或关注状态不明确，未将未知状态当作未操作。");
  return { control, state };
}

async function commentsPanel(
  page: Page,
  root: Locator,
  target: Target,
): Promise<Locator> {
  const findPanel = async (): Promise<Locator | null> => {
    let panel = root.locator(
      ".Comments-container:visible,.CommentsV2:visible,.Comments:visible",
    );
    const count = await panel.count();
    if (count > 1) {
      // Some versions nest .CommentsV2 inside .Comments-container; select one outer container.
      panel = root.locator(".Comments-container:visible");
      if ((await panel.count()) !== 1)
        fail("评论区域不唯一，未选择推荐卡片或其他讨论。");
    }
    if ((await panel.count()) === 1) return panel;
    // The outer comments wrapper can change independently from its editor.
    // A unique, known top-level editor is a structural fallback, still entirely
    // inside the exact answer/article root. Keep the root so existing comments
    // can also be checked, rather than narrowing the receipt read to the editor.
    return (await topLevelCommentEditor(root)) ? root : null;
  };
  const ready = await findPanel();
  if (ready) return ready;
  const open = root
    .getByRole("button", { name: /^(?:添加评论|评论|\d[\d,.万亿]*\s*条评论)$/ })
    .filter({ visible: true });
  if ((await open.count()) !== 1 || !(await open.isEnabled()))
    fail("没有找到本条内容唯一的评论区域入口。");
  await assertRootBinding(page, target, root);
  await snapshot(page, target);
  await open.click({ timeout: 5000 }); // Reveal the target thread; this does not submit a comment.
  const deadline = Date.now() + 10000;
  for (;;) {
    await assertRootBinding(page, target, root);
    await snapshot(page, target);
    const panel = await findPanel();
    if (panel) return panel;
    if (Date.now() >= deadline) break;
    // Wait for this one reveal to hydrate. Never close/reopen or click a second
    // comment button when the first reveal does not expose a bound container.
    await page.waitForTimeout(200);
  }
  const diagnostic = await root.evaluate((element, excluded) => {
    const visible = (node: Element) =>
      node instanceof HTMLElement &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden";
    const editors = [
      ...element.querySelectorAll(
        ".CommentEditor textarea,.CommentEditor [contenteditable='true'],.CommentEditorV2 textarea,.CommentEditorV2 [contenteditable='true']",
      ),
    ].filter(visible);
    return {
      containers: [
        ...element.querySelectorAll(
          ".Comments-container,.CommentsV2,.Comments",
        ),
      ].filter(visible).length,
      knownEditors: editors.length,
      excludedReplies: editors.filter(
        (editor) =>
          !!editor.closest(excluded) ||
          /回复/.test(
            `${editor.getAttribute("placeholder") ?? ""} ${editor.getAttribute("aria-label") ?? ""}`,
          ),
      ).length,
    };
  }, replyEditorAncestors);
  return fail(
    `官方评论区域未就绪：目标内可见容器${diagnostic.containers}、已知编辑器${diagnostic.knownEditors}、排除回复${diagnostic.excludedReplies}；不推断目标外区域归属，未填写或提交。`,
  );
}
async function ownComments(
  panel: Locator,
  request: ZhihuInteractionRequest,
  evidence: Evidence,
): Promise<CommentProof[]> {
  await evidence.settle();
  const visible = await panel.evaluate((root) => {
    const results: { id: string; uid: string; text: string }[] = [];
    for (const element of [
      ...root.querySelectorAll(
        "[data-comment-id],[data-id].CommentItemV2,[id^='comment-']",
      ),
    ].slice(0, 100)) {
      if (
        element.parentElement?.closest(
          ".CommentItem,.CommentItemV2,[data-comment-id]",
        )
      )
        continue;
      if (
        ["data-reply-to", "data-reply-to-comment-id"].some((name) => {
          const value = element.getAttribute(name);
          return value !== null && value !== "" && value !== "0";
        })
      )
        continue;
      const id =
          element.getAttribute("data-comment-id") ||
          element.getAttribute("data-id") ||
          element.id.replace(/^comment-/, ""),
        uid =
          element.getAttribute("data-author-id") ||
          element.getAttribute("data-author-uid") ||
          element
            .querySelector("[data-author-id]")
            ?.getAttribute("data-author-id"),
        content = element.querySelector(
          ".CommentItemV2-content,.CommentItem-content,.CommentContent",
        );
      if (id && uid && content instanceof HTMLElement)
        results.push({
          id,
          uid,
          text: content.innerText.replace(/\r\n?/g, "\n").trim(),
        });
    }
    return results;
  });
  const matches = new Map<string, CommentProof>();
  for (const item of [...evidence.comments.values(), ...visible]) {
    if (
      item.uid === request.actorUid &&
      plain(item.text) === plain(request.text) &&
      identifier(item.id)
    )
      matches.set(item.id, item);
  }
  return [...matches.values()];
}

function makeReceipt(
  request: ZhihuInteractionRequest,
  target: Target,
  authorUid: string,
  outcome: "performed" | "already_present",
  commentId: string | null,
): ZhihuInteractionReceipt {
  return zhihuInteractionReceiptSchema.parse({
    evidence: "official_ui",
    kind: request.kind,
    url: target.url,
    actorUid: request.actorUid,
    targetAuthorUid: authorUid,
    targetId: target.kind === "author" ? authorUid : target.id,
    outcome,
    state:
      request.kind === "like"
        ? "liked"
        : request.kind === "follow"
          ? "following"
          : "commented",
    commentId,
    text: request.text,
    observedAt: new Date().toISOString(),
    summary:
      outcome === "already_present"
        ? "官方页面已存在同账号、同目标的准确状态；本次未重复提交。"
        : "已核对本次官方交互响应及同账号、同目标的最终状态。",
  });
}

/** Caller holds WebsiteAccounts.use / the environment lease. No toggles or retries after submission. */
export function zhihuInteractionBrowser(
  withContext: <T>(
    account: WebsiteAccount,
    action: (context: BrowserContext) => Promise<T>,
  ) => Promise<T>,
): ZhihuInteractionBrowserPort {
  const run = async (
    account: WebsiteAccount,
    input: {
      request: ZhihuInteractionRequest;
      guard?: () => void;
      onSubmitting?: () => void | Promise<void>;
    },
    readonly: boolean,
  ): Promise<ZhihuInteractionReceipt | null> => {
    const request = zhihuInteractionRequestSchema.parse(input.request),
      target = targetFor(request);
    if (
      !readonly &&
      (typeof input.guard !== "function" ||
        typeof input.onSubmitting !== "function")
    )
      fail("执行互动必须提供权限门禁和提交意图持久化检查点。");
    if (account.uid !== request.actorUid)
      fail("互动意图与所选知乎账号UID不一致。");
    input.guard?.();
    return withContext(account, async (context) => {
      await assertZhihuParticipationAccount(context, account);
      const page = await context.newPage(),
        evidence = new Evidence(page, target);
      let submitted = false,
        fixedClick: ElementHandle<HTMLElement | SVGElement> | undefined;
      try {
        const initial = await loadZhihuParticipationPage(
          page,
          target.url,
          target.kind,
          "document",
        );
        await snapshot(page, target);
        const document = parseZhihuDocumentSnapshot(initial, target.url);
        if (
          document.truncated ||
          plain(document.text) !== plain(request.contextText)
        )
          fail("官方正文与作出决定时的完整上下文不一致，未操作。");
        const root = await targetRoot(page, target),
          authorUid = await pageIdentity(page, root, target, evidence);
        if (
          request.excludedUids.includes(authorUid) ||
          authorUid === account.uid
        )
          fail("目标是本人或工作台管理的账号，不进行相互互动。");
        const receipt = async (
          outcome: "performed" | "already_present",
          commentId: string | null,
          currentRoot = root,
        ) => {
          await assertRootBinding(page, target, currentRoot);
          await assertZhihuParticipationAccount(context, account);
          await snapshot(page, target);
          return makeReceipt(request, target, authorUid, outcome, commentId);
        };
        let panel: Locator | undefined,
          editor: Locator | undefined,
          control: Locator;
        if (request.kind === "comment") {
          panel = await commentsPanel(page, root, target);
          const existing = await ownComments(panel, request, evidence);
          if (existing.length > 1)
            fail("同账号存在多条相同正文评论，无法唯一核对，未重复评论。");
          if (existing.length === 1)
            return await receipt("already_present", existing[0].id);
          if (readonly) return null;
          editor = (await topLevelCommentEditor(panel)) ?? undefined;
          if (!editor || !(await editor.isEditable()))
            return fail(
              "未识别到此目标唯一的顶层评论编辑器，未选择回复或其他输入框。",
            );
          await assertTopLevelEditor(editor);
          await editor.fill(request.text);
          const actual = await editor.evaluate((element) =>
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLInputElement
              ? element.value
              : (element as HTMLElement).innerText,
          );
          if (plain(actual) !== plain(request.text))
            fail("评论编辑器内容与已决定的准确文本不一致，未提交。");
          // Bind the submit button to the same known editor, even when the
          // outer comments wrapper is absent or contains other reply controls.
          const editorContainer = editor.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' CommentEditor ') or contains(concat(' ', normalize-space(@class), ' '), ' CommentEditorV2 ')][1]",
          );
          control = editorContainer
            .getByRole("button", { name: /^(?:发布|发布评论|发表评论)$/ })
            .filter({ visible: true });
          if ((await control.count()) !== 1 || !(await control.isEnabled()))
            fail("没有找到本评论编辑器唯一可用的发布按钮。");
        } else {
          const current = await button(root, request.kind);
          if (current.state) return await receipt("already_present", null);
          if (readonly) return null;
          control = current.control;
        }
        // Revalidate the account, full context, author and exact control before persisting intent.
        await assertZhihuParticipationAccount(context, account);
        await assertContext(page, target, request);
        if ((await pageIdentity(page, root, target, evidence)) !== authorUid)
          fail("目标作者身份发生变化，未提交。");
        if (
          request.kind !== "comment" &&
          (await button(root, request.kind)).state
        )
          return await receipt("already_present", null);
        if ((await control.count()) !== 1 || !(await control.isEnabled()))
          fail("提交前目标控件已变化，未点击。");
        await assertRootBinding(page, target, root);
        if (editor) await assertTopLevelEditor(editor);
        input.guard?.();
        await input.onSubmitting?.();
        submitted = true;
        // Every error after this persisted checkpoint is uncertain. Never issue a second click.
        await assertContext(page, target, request);
        if (
          request.kind !== "comment" &&
          (await button(root, request.kind)).state
        )
          return await receipt("already_present", null);
        if (editor) {
          const actual = await editor.evaluate((element) =>
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLInputElement
              ? element.value
              : (element as HTMLElement).innerText,
          );
          if (plain(actual) !== plain(request.text))
            fail("提交检查点后评论正文发生变化，未点击发布。");
        }
        if ((await control.count()) !== 1 || !(await control.isEnabled()))
          fail("提交检查点后控件变化，未点击。");
        fixedClick = await boundControl(page, target, root, control);
        if (request.kind !== "comment") {
          await assertActionButtonScope(root, fixedClick);
          const finalState = await interactionButtonState(
            fixedClick,
            request.kind,
          );
          if (finalState === null) fail("最终按钮语义或状态已变化，未点击。");
          if (finalState) return await receipt("already_present", null);
        }
        if (editor) await assertTopLevelEditor(editor, fixedClick);
        const responsePromise = page.waitForResponse(
          (response) => {
            if (
              !officialResponse(response) ||
              !["POST", "PUT", "PATCH"].includes(response.request().method())
            )
              return false;
            return mutationPath(
              new URL(response.url()).pathname,
              target,
              request.kind,
              authorUid,
            );
          },
          { timeout: 15000 },
        );
        void responsePromise.catch(() => {});
        input.guard?.();
        await fixedClick.click({ timeout: 5000 });
        const response = await responsePromise;
        if (!response.ok())
          fail("知乎未返回可确认的成功互动响应，请核对官方状态，不重复操作。");
        await snapshot(page, target);
        if (request.kind === "comment") {
          assertCommentRequest(response, request.text);
          const raw = await responseText(response, 100000);
          const json = object(JSON.parse(raw)),
            data = object(json?.data) ?? json,
            comment = object(data?.comment) ?? data,
            id = identifier(comment?.id),
            uid = comment && authorOf(comment),
            content = comment?.content;
          if (
            !id ||
            uid !== request.actorUid ||
            typeof content !== "string" ||
            plain(await responsePlainText(page, content)) !==
              plain(request.text)
          )
            fail(
              "官方响应无法唯一核实评论ID、本人UID和准确正文；保留待核对，不重发。",
            );
          if (json?.error || json?.success === false || data?.error)
            fail("官方评论响应包含错误，不能登记成功。");
          if (hasReplyTarget(comment, false))
            fail("官方回执含回复对象，不能登记为目标内容顶层评论成功。");
          return await receipt("performed", id);
        }
        // A successful response plus this freshly loaded official page avoids accepting an optimistic toggle as a receipt.
        const refreshed = parseZhihuDocumentSnapshot(
          await loadZhihuParticipationPage(
            page,
            target.url,
            target.kind,
            "document",
          ),
          target.url,
        );
        if (
          refreshed.truncated ||
          plain(refreshed.text) !== plain(request.contextText)
        )
          fail("提交后正文上下文发生变化，保留待核对。");
        const finalRoot = await targetRoot(page, target);
        if (
          (await pageIdentity(page, finalRoot, target, evidence)) !== authorUid
        )
          fail("提交后目标作者无法唯一核实，保留待核对。");
        if (!(await button(finalRoot, request.kind)).state)
          fail(
            "重新读取官方页面后没有确认赞同/关注状态，保留待核对，不重复点击。",
          );
        return await receipt("performed", null, finalRoot);
      } catch (error) {
        if (submitted)
          throw new AppError(
            "ZHIHU_INTERACTION_UNCERTAIN",
            `已保存提交意图，未获得完整官方回执；结果待核对，禁止重复提交。${error instanceof AppError && error.code === "ZHIHU_INTERACTION_BROWSER" ? ` ${error.message}` : ""}`,
            true,
          );
        throw error;
      } finally {
        evidence.close();
        await fixedClick?.dispose().catch(() => {});
        await page.close().catch(() => {});
      }
    });
  };
  return {
    execute: async (account, input) =>
      (await run(account, input, false)) ?? fail("互动未取得可确认回执。"),
    reconcile: (account, input) => {
      if (!Number.isFinite(Date.parse(input.submittedAt)))
        fail("缺少有效提交意图时间，不能核对未知任务。");
      return run(account, { request: input.request }, true);
    },
  };
}
