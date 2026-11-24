import { z } from "zod";
import {
  initialIntakeKeywords,
  intakeKeywordDraftSchema,
} from "../resources/IntakeKeywords";
import {
  publishingQuestionSchema,
  publishingResourceLimit,
  publishingResourceSchema,
} from "../../shared/zhidao-workflow";
import { parseResourceKeywordText } from "../../shared/resource-keywords";
export const publishingDraftRow = z.object({
  key: z.string().uuid(),
  resourceId: z.string(),
  copyId: z.string(),
  title: z.string().max(200),
  link: z.string().max(2000),
  category: z.string().max(60),
  summary: z.string().max(5000),
  image: z.string().max(2000).default(""),
  keywords: intakeKeywordDraftSchema,
  checked: z.boolean(),
  prepared: z.boolean(),
});
export type PublishingDraftRow = z.infer<typeof publishingDraftRow>;
export const publishingDraftSchema = z
  .object({
    flowVersion: z.literal(2).optional(),
    step: z.number().int().min(0).max(4),
    accountId: z.string(),
    rows: z.array(publishingDraftRow).max(publishingResourceLimit),
    activeKey: z.string(),
    pendingReviews: z
      .array(z.string())
      .max(publishingResourceLimit)
      .default([]),
    reviewVersions: z
      .record(
        z.string(),
        z.object({
          generationId: z.string().optional(),
          legacyUpgraded: z.literal(true).optional(),
        }),
      )
      .default({}),
    keywordBatchId: z.string().default(""),
    keywordBatchApplied: z
      .array(z.string())
      .max(publishingResourceLimit)
      .default([]),
  })
  .transform((draft) => ({
    ...draft,
    flowVersion: 2 as const,
    step:
      draft.flowVersion === 2 ? draft.step : draft.step >= 2 ? 2 : draft.step,
  }));
export type PublishingDraft = z.infer<typeof publishingDraftSchema>;
export const publishingReviewDraftSchema = z.object({
  rows: z.array(publishingQuestionSchema).max(100),
});
export function publishingReviewDraftKey(
  dataPath: string,
  recordId: string,
  legacyUpgraded?: true,
  generationId?: string,
) {
  return `panxu-publishing-review:${dataPath}:${recordId}${legacyUpgraded ? ":upgraded" : ""}${generationId ? `:ai:${generationId}` : ""}`;
}

export function newPublishingResource(): PublishingDraftRow {
  return {
    key: crypto.randomUUID(),
    resourceId: "",
    copyId: "",
    title: "",
    link: "",
    category: "",
    summary: "",
    image: "",
    keywords: initialIntakeKeywords(),
    checked: false,
    prepared: false,
  };
}
export function publishingInput(row: PublishingDraftRow) {
  return publishingResourceSchema.parse({
    ...row,
    keywords: parseResourceKeywordText(row.keywords.text),
  });
}
export function resourceEntryIssue(rows: PublishingDraftRow[]) {
  if (!rows.length) return "请至少录入一份资源。";
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const result = publishingResourceSchema
      .omit({ keywords: true })
      .safeParse(row);
    if (!result.success)
      return `第${index + 1}行：${result.error.issues[0].message}`;
    const link = new URL(row.link).pathname.replace(/\/$/, "");
    if (seen.has(link))
      return `第${index + 1}行与已有资源链接重复，请保留一份。`;
    seen.add(link);
  }
  return "";
}
