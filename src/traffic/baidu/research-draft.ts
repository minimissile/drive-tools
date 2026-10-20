import { z } from "zod";
export const formSchema = z.object({
  words: z.string().default(""),
  negative: z.string().default(""),
  regions: z.array(z.number()).default([]),
  removeDuplicate: z.boolean().default(false),
  regionExtend: z.boolean().default(false),
  device: z.number().default(0),
  price: z.string().default(""),
  match: z.string().default("auto"),
  businessId: z.string().default(""),
  rankTab: z.string().default("search"),
  dimensions: z
    .array(
      z.object({
        type: z.number(),
        dimensionName: z.string(),
        roots: z.string(),
      }),
    )
    .max(7)
    .default([
      { type: 1, dimensionName: "地域", roots: "" },
      { type: 2, dimensionName: "业务", roots: "" },
      { type: 3, dimensionName: "词性", roots: "" },
    ]),
  outputUngroupedWords: z.boolean().default(true),
  templateName: z.string().default(""),
  trade: z.string().default(""),
  category: z.string().default("trade"),
  industryDevice: z.string().default("all"),
  startDate: z.string().default(""),
  endDate: z.string().default(""),
  wordType: z.string().default("hotWord"),
  industryView: z.string().default("words"),
  geoGran: z.string().default("country"),
  geoTarget: z.string().default(""),
});
export const defaultForm = formSchema.parse({});

export type ResearchDraftValue = z.infer<typeof formSchema>;
export type ResearchDraft = {
  value: ResearchDraftValue;
  update(patch: Partial<ResearchDraftValue>): void;
};
