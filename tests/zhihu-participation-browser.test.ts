import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeZhihuVisibleUrl,
  normalizeZhihuVisibleHits,
  parseZhihuSearchSnapshot,
  parseZhihuDocumentSnapshot,
  zhihuParticipationSearchReady,
  isZhihuBodyExpandLabel,
  isZhihuBodyExpandHref,
  type ZhihuParticipationPageSnapshot,
} from "../core/zhihu-participation/browser";

const question = "https://www.zhihu.com/question/123";
const snapshot = (
  patch: Partial<ZhihuParticipationPageSnapshot> = {},
): ZhihuParticipationPageSnapshot => ({
  url: "https://www.zhihu.com/search?type=content&q=PPT",
  challenge: false,
  login: false,
  gateText: "",
  shell: true,
  empty: false,
  cards: [],
  heading: "",
  body: "",
  collapsed: false,
  related: [],
  ...patch,
});
const search = { query: "PPT", kind: "question" as const, limit: 10 };

test("body expansion accepts only plain read-more controls staying on the same document", () => {
  for (const label of ["显示全部", "展开", "展开全文", "阅读全文\u200b"])
    assert.equal(isZhihuBodyExpandLabel(label), true);
  for (const label of [
    "赞同",
    "评论",
    "关注",
    "登录后阅读全文",
    "购买全文",
    "开通会员",
    "阅读全文并关注",
  ])
    assert.equal(isZhihuBodyExpandLabel(label), false);
  for (const href of [null, "", "#", "javascript:void(0);", question])
    assert.equal(isZhihuBodyExpandHref(href, question), true);
  for (const href of [
    "/signin",
    "https://www.zhihu.com/checkout",
    "https://example.invalid/",
    "https://www.zhihu.com/question/999",
    "javascript:publish()",
  ])
    assert.equal(isZhihuBodyExpandHref(href, question), false);
});

test("visible links discard official tracking without accepting redirects, credentials or external locations", () => {
  assert.equal(
    normalizeZhihuVisibleUrl(
      "/question/123/answer/456?utm_source=search#comment",
    ),
    `${question}/answer/456`,
  );
  assert.equal(
    normalizeZhihuVisibleUrl("https://zhihu.com/question/123/"),
    question,
  );
  for (const url of [
    "https://link.zhihu.com/?target=https://www.zhihu.com/question/123",
    "https://www.zhihu.com.evil.invalid/question/123",
    "https://secret@www.zhihu.com/question/123",
    "http://www.zhihu.com/question/123",
    "https://www.zhihu.com:8443/question/123",
    "https://www.zhihu.com/settings",
    "javascript:alert(1)",
  ])
    assert.equal(normalizeZhihuVisibleUrl(url), null);
});

test("question discovery deduplicates answering cards by their actual parent question and labels answer excerpts", () => {
  const cards = [
    {
      href: `${question}/answer/456?utm=search`,
      title: "PPT如何整理？",
      excerpt: "回答中的整理方法",
      author: "回答者",
    },
    {
      href: `${question}/answer/789`,
      title: "PPT如何整理？",
      excerpt: "另一个回答",
    },
    {
      href: "https://zhuanlan.zhihu.com/p/999",
      title: "一篇文章",
      excerpt: "文章正文摘要",
    },
    {
      href: "https://www.zhihu.com/question/222",
      title: "如何准备提纲？",
      excerpt: "问题描述",
    },
  ];
  const hits = parseZhihuSearchSnapshot(snapshot({ cards }), search);
  assert.deepEqual(
    hits.map((hit) => hit.url),
    [question, "https://www.zhihu.com/question/222"],
  );
  assert.equal(hits[0].kind, "question");
  assert.match(hits[0].excerpt, /回答摘录/);
  assert.equal(
    hits[0].author,
    undefined,
    "an answer's author is not the question's author",
  );
  assert.equal(normalizeZhihuVisibleHits(cards, "question", 1).length, 1);
  const many = Array.from({ length: 20 }, (_, index) => ({
    href: `https://www.zhihu.com/question/${index + 1000}`,
    title: "问题",
    excerpt: "",
  }));
  assert.equal(normalizeZhihuVisibleHits(many, "question", 99).length, 10);
  assert.equal(
    normalizeZhihuVisibleHits(many, "question", Number.NaN).length,
    10,
  );
});

test("a recognized empty search differs from loading, unrecognized markup, login, rate limits and redirects", () => {
  assert.deepEqual(
    parseZhihuSearchSnapshot(snapshot({ empty: true }), search),
    [],
  );
  for (const page of [
    snapshot(),
    snapshot({ shell: false, empty: true }),
    snapshot({ challenge: true, empty: true }),
    snapshot({ login: true, empty: true }),
    snapshot({ gateText: "当前请求存在异常，暂时无法访问", empty: true }),
    snapshot({
      cards: [
        {
          href: "https://www.zhihu.com/people/alice",
          title: "误抓作者元信息",
          excerpt: "",
        },
      ],
    }),
    snapshot({
      url: "https://www.zhihu.com/search?type=content&q=other",
      empty: true,
    }),
    snapshot({
      cards: [
        {
          href: "https://example.invalid/question/123",
          title: "外站",
          excerpt: "",
        },
      ],
    }),
  ])
    assert.throws(() => parseZhihuSearchSnapshot(page, search), {
      code: "ZHIHU_PARTICIPATION_BROWSER",
    });
});

test("search readiness waits for hydrated parseable cards rather than the already mounted empty result shell", () => {
  const shell = snapshot();
  assert.equal(zhihuParticipationSearchReady(shell), false);
  assert.equal(
    zhihuParticipationSearchReady(
      snapshot({ cards: [{ href: "", title: "", excerpt: "" }] }),
    ),
    false,
  );
  const hydrated = snapshot({
    cards: [
      {
        href: "https://www.zhihu.com/question/27878656/answer/2095520773846856617",
        title: "如何系统的整理工作和学习中需要用到的PPT/PDF/打印版的书籍？",
        excerpt: "搜索返回的真实回答摘录",
      },
    ],
  });
  assert.equal(zhihuParticipationSearchReady(hydrated), true);
  assert.equal(
    parseZhihuSearchSnapshot(hydrated, search)[0].url,
    "https://www.zhihu.com/question/27878656",
  );
  assert.equal(zhihuParticipationSearchReady(snapshot({ empty: true })), true);
  assert.throws(
    () => zhihuParticipationSearchReady(snapshot({ challenge: true })),
    { code: "ZHIHU_PARTICIPATION_BROWSER" },
  );
});

test("author search returns public author cards and never treats content cards as a real empty author result", () => {
  const url = "https://www.zhihu.com/search?type=people&q=PPT";
  const page = snapshot({
    url,
    cards: [
      {
        href: "/people/alice?utm=search",
        title: "公开作者",
        excerpt: "公开简介",
      },
    ],
  });
  const hits = parseZhihuSearchSnapshot(page, { ...search, kind: "author" });
  assert.equal(hits[0].kind, "author");
  assert.equal(hits[0].url, "https://www.zhihu.com/people/alice");
  assert.throws(
    () =>
      parseZhihuSearchSnapshot(
        snapshot({
          url,
          cards: [{ href: question, title: "错误区域", excerpt: "" }],
        }),
        { ...search, kind: "author" },
      ),
    { code: "ZHIHU_PARTICIPATION_BROWSER" },
  );
});

test("question context keeps only its own answer links and caps short related excerpts", () => {
  const related = Array.from({ length: 8 }, (_, i) => ({
    href: `${question}/answer/${i + 10}`,
    title: "当前问题回答",
    excerpt: "答".repeat(2000),
    author: "公开作者",
  }));
  related.unshift({
    href: "https://www.zhihu.com/question/999/answer/888",
    title: "其他问题的回答",
    excerpt: "不应混入",
    author: "其他作者",
  });
  const doc = parseZhihuDocumentSnapshot(
    snapshot({
      url: question,
      heading: "真实问题标题",
      body: "问题公开描述",
      related,
    }),
    question,
  );
  assert.equal(doc.related.length, 5);
  assert.ok(
    doc.related.every(
      (hit) =>
        hit.url.startsWith(`${question}/answer/`) && hit.excerpt.length <= 700,
    ),
  );
  assert.equal(doc.text, "真实问题标题\n\n问题公开描述");
});

test("document parsing rejects mismatches, deleted pages, folded or absent body rather than borrowing recommendations", () => {
  const answer = `${question}/answer/456`;
  for (const page of [
    snapshot({
      url: `${question}/answer/999`,
      heading: "标题",
      body: "他人的回答",
    }),
    snapshot({
      url: answer,
      heading: "标题",
      body: "折叠摘要",
      collapsed: true,
    }),
    snapshot({ url: answer, heading: "标题" }),
    snapshot({
      url: answer,
      heading: "标题",
      body: "正文",
      gateText: "该回答已被删除",
    }),
  ])
    assert.throws(() => parseZhihuDocumentSnapshot(page, answer), {
      code: "ZHIHU_PARTICIPATION_BROWSER",
    });
  const article = "https://zhuanlan.zhihu.com/p/321";
  const doc = parseZhihuDocumentSnapshot(
    snapshot({ url: article, heading: "真实文章", body: "文".repeat(20000) }),
    article,
  );
  assert.equal(doc.text.length, 16000);
  assert.equal(doc.truncated, true);
  assert.match(doc.text, /仅保存页面正文前段/);
});

test("author documents include their public header and only article-related links", () => {
  const url = "https://www.zhihu.com/people/alice";
  const doc = parseZhihuDocumentSnapshot(
    snapshot({
      url,
      heading: "公开作者",
      body: "[作者公开简介]\n软件教程作者",
      related: [
        {
          href: "https://zhuanlan.zhihu.com/p/321",
          title: "公开文章",
          excerpt: "公开摘要",
        },
        {
          href: `${question}/answer/456`,
          title: "回答",
          excerpt: "不用于作者文章列表",
        },
      ],
    }),
    url,
  );
  assert.equal(doc.related.length, 1);
  assert.equal(doc.related[0].kind, "article");
  assert.match(doc.text, /公开简介/);
});
