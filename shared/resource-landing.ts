import { z } from "zod";
import type { LandingTraffic } from "./landing-traffic";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const references = z.array(text(1, 80)).max(12);
export const landingDescriptionLimit = 120;
export const landingSearchPolicyVersion = "panxu-search-2026-11-04";
export const landingDescriptionSchema = text(25, landingDescriptionLimit).regex(
  /[。！？.!?][”’"']?$/,
  "搜索摘要须以完整句子结束，不能截断。",
);
export const landingDraftSchema = z.object({
  title: text(8, 90),
  description: landingDescriptionSchema,
  summary: text(30, 600),
  highlights: z.array(text(4, 160)).max(6),
  sections: z
    .array(
      z.object({
        heading: text(4, 70),
        kind: z.enum(["facts", "guide"]),
        body: text(30, 4000),
        evidenceIds: references,
      }),
    )
    .min(1)
    .max(7),
  faq: z
    .array(
      z.object({
        question: text(5, 100),
        answer: text(15, 900),
        kind: z.enum(["facts", "guide"]),
        evidenceIds: references,
      }),
    )
    .max(6),
});
export type LandingDraft = z.infer<typeof landingDraftSchema>;
/** Incomplete edits can be restored and repaired; publication remains strict. */
const editableText = z.string().max(12000);
export const landingEditableDraftSchema = z.object({
  title: editableText,
  description: editableText,
  summary: editableText,
  highlights: z.array(editableText).max(6),
  sections: z
    .array(
      z.object({
        heading: editableText,
        kind: z.enum(["facts", "guide"]),
        body: editableText,
        evidenceIds: references,
      }),
    )
    .max(7),
  faq: z
    .array(
      z.object({
        question: editableText,
        answer: editableText,
        kind: z.enum(["facts", "guide"]),
        evidenceIds: references,
      }),
    )
    .max(6),
});
/** Accept short model candidates for one repair pass; publication stays strict. */
export const landingCandidateSchema = landingDraftSchema.extend({
  title: text(1, 90),
  description: text(1, landingDescriptionLimit),
  summary: text(1, 600),
  highlights: z.array(text(1, 160)).max(6),
  sections: z
    .array(
      landingDraftSchema.shape.sections.element.extend({ body: text(1, 4000) }),
    )
    .min(1)
    .max(7),
  faq: z
    .array(
      landingDraftSchema.shape.faq.element.extend({ answer: text(1, 900) }),
    )
    .max(6),
});
export const landingRubric = [
  { key: "evidence", label: "正文依据与准确性", max: 25 },
  { key: "intent", label: "帮助读者判断和使用", max: 25 },
  { key: "specificity", label: "资源特有信息与增值", max: 20 },
  { key: "readability", label: "自然表达与信息密度", max: 15 },
  { key: "trust", label: "来源、范围与可信度", max: 15 },
] as const;
export const landingDimensionsSchema = z.object({
  evidence: z.number().int().min(0).max(25),
  intent: z.number().int().min(0).max(25),
  specificity: z.number().int().min(0).max(20),
  readability: z.number().int().min(0).max(15),
  trust: z.number().int().min(0).max(15),
});
export const landingReviewSchema = z.object({
  policyVersion: text(1, 80).optional(),
  score: z.number().int().min(0).max(100),
  dimensions: landingDimensionsSchema.optional(),
  verdict: z.enum(["pass", "revise"]),
  reasons: z.array(text(1, 500)).max(12),
  unsupportedClaims: z.array(text(1, 500)).max(12),
});
export type LandingReview = z.infer<typeof landingReviewSchema>;
export const landingSourceSchema = z.object({
  resourceTitle: text(1, 200),
  category: text(1, 80),
  tags: z.array(text(1, 60)).max(20),
  facts: z
    .array(
      z.object({
        id: text(1, 80),
        label: text(1, 100),
        text: text(1, 8000),
      }),
    )
    .min(1)
    .max(136),
  files: z
    .array(
      z.object({
        evidenceId: text(1, 80),
        name: text(1, 300),
        size: z.number().int().nonnegative().nullable(),
        directory: z.boolean(),
      }),
    )
    .max(80),
  documents: z
    .array(
      z.object({
        fileEvidenceId: text(1, 80),
        name: text(1, 300),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        pageCount: z.number().int().min(1).max(5000),
        pages: z.array(z.number().int().min(1)).max(48),
        sampled: z.boolean(),
        readAt: z.string().datetime(),
      }),
    )
    .max(3)
    .optional(),
  manifestTruncated: z.boolean(),
  shareCheckedAt: z.string().datetime().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LandingSource = z.infer<typeof landingSourceSchema>;
export interface LandingQuality {
  eligible: boolean;
  score: number;
  issues: string[];
  dimensions: { label: string; score: number; max: number }[];
  checks: { label: string; ok: boolean }[];
}
export function landingText(draft: LandingDraft): string {
  return [
    draft.title,
    draft.description,
    draft.summary,
    ...draft.highlights,
    ...draft.sections.flatMap((s) => [s.heading, s.body]),
    ...draft.faq.flatMap((f) => [f.question, f.answer]),
  ].join("\n");
}
/** No URLs, credentials, raw HTML or sales claims enter an indexable article. */
export function landingQuality(
  draft: LandingDraft,
  source: LandingSource,
  review?: LandingReview | null,
): LandingQuality {
  const ids = new Set(source.facts.map((f) => f.id));
  const blocks = [...draft.sections, ...draft.faq];
  const body = landingText(draft);
  const claims = body
    .replace(
      /(?:不能|不会|无法|不|未)(?:保证|承诺|声称|宣称)(?:永久有效|收录|排名|通过|录用|涨薪|亲测有效|亲测可用|全网最全|全网首发|保过|包过)/g,
      "",
    )
    .replace(
      /(?:并非|不是|不代表|并不意味着)(?:永久有效|亲测有效|亲测可用|全网最全|全网首发|保过|包过)/g,
      "",
    );
  const dimensions = landingRubric.map((r) => ({
    label: r.label,
    max: r.max,
    score: review?.dimensions?.[r.key] ?? 0,
  }));
  const score = dimensions.reduce((sum, d) => sum + d.score, 0);
  const documentIds = new Set(
    (source.documents ?? []).flatMap((d, i) =>
      d.pages
        .filter((p) => p <= d.pageCount)
        .map((p) => `doc-${i + 1}-p${p}`)
        .filter((id) => ids.has(id)),
    ),
  );
  const checks = [
    {
      label: "标题、摘要与各段内容完整",
      ok: landingDraftSchema.safeParse(draft).success,
    },
    {
      label: "搜索摘要是完整句子，没有超长或截断",
      ok: landingDescriptionSchema.safeParse(draft.description).success,
    },
    { label: "有可核对的文件信息", ok: source.files.length > 0 },
    {
      label: "已读取实际正文，具有可追溯的内容依据",
      ok:
        !!source.documents?.length &&
        documentIds.size > 0 &&
        source.documents.every((d) => d.pages.length > 0),
    },
    {
      label: "介绍以资源内容为主，避免通用建议凑篇幅",
      ok:
        draft.sections.some(
          (s) =>
            s.kind === "facts" &&
            s.evidenceIds.some((id) => documentIds.has(id)),
        ) &&
        draft.sections
          .filter((s) => s.kind === "facts")
          .reduce((n, s) => n + s.body.length, 0) >=
          draft.sections
            .filter((s) => s.kind === "guide")
            .reduce((n, s) => n + s.body.length, 0),
    },
    {
      label: "事实引用可追溯",
      ok: blocks.every(
        (b) =>
          b.evidenceIds.every((id) => ids.has(id)) &&
          (b.kind !== "facts" || b.evidenceIds.length > 0),
      ),
    },
    {
      label: "没有模板空话与机械扩写",
      ok: !/在当今|本文将|值得一提|综上所述|赋能|开启.{0,8}之旅/.test(body),
    },
    {
      label: "无链接、联系方式及 HTML 混入正文",
      ok: !/https?:\/\/|www\.|<\/?[a-z!][^>]*>|\bsk-(?:or-)?[\w-]{12,}|\bBearer\s+\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:微信|QQ|电话|手机号|提取码|访问码)\s*[:：=]\s*\S+/i.test(
        body,
      ),
    },
    {
      label: "无虚构体验或效果承诺",
      ok: !/亲测有效|亲测可用|保证(?:收录|排名|通过|录用|涨薪)|百分之百|100%|永久有效|全网最全|全网首发|保过|包过|已阅读全部|我们实测|本站实测/.test(
        claims,
      ),
    },
    {
      label: "不由文件元数据推断出版性质或内容",
      ok: !/非学术出版物|非正式出版物|并非出版社|不属于出版社|不是出版社|(?:文件大小|\d\s*MB)[^。\n]{0,60}(?:内容量.{0,8}丰富|页数.{0,8}(?:较多|丰富))/.test(
        body,
      ),
    },
    {
      label: "内容没有重复段落",
      ok:
        new Set(draft.sections.map((s) => s.body.replace(/\s/g, ""))).size ===
          draft.sections.length &&
        new Set(draft.faq.map((f) => f.question)).size === draft.faq.length,
    },
    {
      label: "独立内容检查通过",
      ok:
        !!review &&
        review.verdict === "pass" &&
        !!review.dimensions &&
        score >= 82 &&
        dimensions.every((d) => d.score >= Math.ceil(d.max * 0.7)) &&
        review.unsupportedClaims.length === 0,
    },
  ];
  const issues = checks.filter((c) => !c.ok).map((c) => c.label);
  const structure = landingDraftSchema.safeParse(draft);
  if (!structure.success)
    issues.push(
      ...structure.error.issues.map(
        (i) =>
          `${i.path.join(".")}：${i.code === "too_small" ? "字数或数量不足，请补充具体有用信息" : "不符合内容长度或结构要求"}`,
      ),
    );
  if (review && review.verdict !== "pass") issues.push(...review.reasons);
  if (review?.unsupportedClaims.length)
    issues.push(...review.unsupportedClaims);
  return {
    eligible: checks.every((c) => c.ok),
    score,
    dimensions,
    checks,
    issues: [...new Set(issues)],
  };
}
/** Compare prose without titles/file metadata; catches near-identical programmatic pages. */
export function landingSimilarity(a: LandingDraft, b: LandingDraft): number {
  const grams = (d: LandingDraft) => {
    const value = [
      ...d.sections.map((s) => s.body),
      ...d.faq.map((f) => f.answer),
    ]
      .join("")
      .replace(/[\s\p{P}\p{S}]/gu, "")
      .toLowerCase();
    return new Set(
      Array.from({ length: Math.max(0, value.length - 2) }, (_, i) =>
        value.slice(i, i + 3),
      ),
    );
  };
  const left = grams(a),
    right = grams(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common++;
  return (2 * common) / (left.size + right.size);
}
export const publishedLandingSchema = z.object({
  schemaVersion: z.literal(1),
  article: landingDraftSchema,
  source: landingSourceSchema,
  review: landingReviewSchema,
  generatedAt: z.string().datetime(),
});
export type PublishedLanding = z.infer<typeof publishedLandingSchema>;
export interface RemoteLanding {
  linkId: string;
  version: number;
  document: PublishedLanding | null;
  lastOperationId: string;
  publishedAt: string | null;
  updatedAt: string;
}
export interface LandingWrite {
  operationId: string;
  expectedVersion: number;
  expectedLinkRevision: number;
  document: PublishedLanding | null;
}
export interface LandingContext {
  resourceId: string;
  source: LandingSource;
  notes: string;
  draft: LandingDraft | null;
  draftVersion: number;
  generatedAt: string | null;
  model: string | null;
  quality: LandingQuality | null;
  stale: boolean;
  published: RemoteLanding | null;
  pageUrl: string | null;
  canPublish: boolean;
  targetIssue: string | null;
  pending: boolean;
  error: string | null;
  generating: boolean;
}
export interface ResourceLandingContract {
  "resourceLanding.traffic": {
    args: { resourceId: string };
    value: LandingTraffic;
  };
  "resourceLanding.readDocument": {
    args: { resourceId: string; fileEvidenceId: string; local?: boolean };
    value: LandingContext;
  };
  "resourceLanding.get": {
    args: { resourceId: string };
    value: LandingContext;
  };
  "resourceLanding.generate": {
    args: { resourceId: string; requestId: string; notes: string };
    value: LandingContext;
  };
  "resourceLanding.optimize": {
    args: {
      resourceId: string;
      requestId: string;
      expectedDraftVersion: number;
      notes: string;
      draft: LandingDraft;
    };
    value: LandingContext;
  };
  "resourceLanding.saveDraft": {
    args: {
      resourceId: string;
      expectedDraftVersion: number;
      draft: LandingDraft;
    };
    value: LandingContext;
  };
  "resourceLanding.publish": {
    args: { resourceId: string; expectedDraftVersion: number };
    value: LandingContext;
  };
  "resourceLanding.unpublish": {
    args: { resourceId: string };
    value: LandingContext;
  };
  "resourceLanding.refresh": {
    args: { resourceId: string };
    value: LandingContext;
  };
  "resourceLanding.retry": {
    args: { resourceId: string };
    value: LandingContext;
  };
}
