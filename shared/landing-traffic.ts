import { z } from "zod";

export const landingTrafficChannels = [
  "direct",
  "internal",
  "google",
  "bing",
  "baidu",
  "other_search",
  "chatgpt",
  "perplexity",
  "gemini",
  "copilot",
  "claude",
  "other_ai",
  "other",
] as const;
export const landingTrafficChannelNames: Record<
  (typeof landingTrafficChannels)[number],
  string
> = {
  direct: "直接 / 来源未知",
  internal: "站内导航",
  google: "Google",
  bing: "Bing",
  baidu: "百度",
  other_search: "其他搜索",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  copilot: "Copilot",
  claude: "Claude",
  other_ai: "其他 AI",
  other: "其他来源",
};
export const landingTrafficEventSchema = z
  .object({
    path: z.string().regex(/^\/(?:r\/[A-Za-z0-9_-]{8,32})?$/),
    kind: z.enum(["view", "outbound", "copy"]),
    channel: z.enum(landingTrafficChannels),
  })
  .strict();
export const landingTrafficSchema = z.object({
  from: z.string(),
  to: z.string(),
  trackingSince: z.string(),
  totals: z.object({
    views: z.number().nonnegative(),
    outbound: z.number().nonnegative(),
    copies: z.number().nonnegative(),
  }),
  channels: z.array(
    z.object({
      channel: z.enum(landingTrafficChannels),
      views: z.number().nonnegative(),
      outbound: z.number().nonnegative(),
    }),
  ),
});
export type LandingTraffic = z.infer<typeof landingTrafficSchema>;

/** Only fixed channel categories cross the wire; full URLs and queries stay in the browser. */
export const landingReferrerRules = [
  ["chatgpt", ["chatgpt.com", "chat.openai.com"]],
  ["perplexity", ["perplexity.ai"]],
  ["gemini", ["gemini.google.com"]],
  ["copilot", ["copilot.microsoft.com"]],
  ["claude", ["claude.ai"]],
  [
    "other_ai",
    [
      "kimi.com",
      "kimi.moonshot.cn",
      "doubao.com",
      "chat.deepseek.com",
      "chat.z.ai",
    ],
  ],
  [
    "google",
    [
      "google.com",
      "google.com.hk",
      "google.com.tw",
      "google.co.jp",
      "google.co.uk",
    ],
  ],
  ["bing", ["bing.com"]],
  ["baidu", ["baidu.com"]],
  [
    "other_search",
    ["duckduckgo.com", "sogou.com", "so.com", "yandex.com", "yandex.ru"],
  ],
] as const;
