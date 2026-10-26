import { z } from "zod";
import { answerStyle } from "./answer-styles";

export const generationTracks = {
  general: {
    label: "通用资料",
    prefixes: "如何使用\n怎么上手",
    guidance: "先核对目录、版本与适用条件，再按自己的实际需求选择内容。",
  },
  study: {
    label: "学习与考试",
    prefixes: "从哪里开始学习\n如何系统学习",
    guidance:
      "我会先看目录明确范围，再按基础、练习、复盘的顺序使用；考试资料还需核对年份与考试要求。",
  },
  office: {
    label: "办公与效率",
    prefixes: "如何使用\n怎么上手",
    guidance:
      "建议先复制一份备份，用少量示例数据试用，再核对公式、格式与使用软件是否兼容。",
  },
  design: {
    label: "设计与创作",
    prefixes: "如何学习\n怎么练习",
    guidance:
      "建议先确认素材格式、使用工具和授权范围，再从一个小练习开始，保留自己的修改版本。",
  },
  software: {
    label: "软件与教程",
    prefixes: "如何上手\n怎么使用",
    guidance:
      "先核对软件版本、系统要求和安装来源，按说明操作；重要文件先备份，遇到错误记录完整提示。",
  },
} as const;
export const generationRuleValues = z.object({
  track: z
    .enum(["general", "study", "office", "design", "software"])
    .default("general"),
  mode: z.enum(["template", "ai"]).default("template"),
  style: answerStyle.default("清晰实用"),
  prefixes: z.string().max(2000).default("如何使用\n怎么上手"),
  suffixes: z.string().max(2000).default("？"),
  introTemplate: z.string().max(2000).default("{资源简介}\n\n{使用建议}"),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  preferSummary: z.boolean().default(true),
  maxChars: z.number().int().min(100).max(2000).default(400),
  linkPosition: z.enum(["last", "first"]).default("last"),
  includeImage: z.boolean().default(false),
});
export const generationRules = generationRuleValues
  .refine((v) => !!v.introTemplate.trim(), "请填写简介模板")
  .refine(
    (v) =>
      ![...v.introTemplate.matchAll(/\{([^{}]+)\}/g)].some(
        (m) =>
          !["资源名称", "资源简介", "SEO关键词", "使用建议"].includes(m[1]),
      ),
    "模板仅支持资源名称、资源简介、SEO关键词、使用建议四个变量",
  );
export type GenerationRules = z.infer<typeof generationRules>;
export const defaultGenerationRules = generationRules.parse({});
export function templateUsesAi(config: { rules?: unknown }) {
  const rules = config.rules;
  return !(
    rules &&
    typeof rules === "object" &&
    "mode" in rules &&
    rules.mode === "template"
  );
}

function isShare(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["pan.baidu.com", "yun.baidu.com"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/s\/[\w-]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
export const generationResource = z.object({
  title: z.string().trim().min(1, "请填写资源名称").max(200, "名称不超过200字"),
  link: z
    .string()
    .trim()
    .max(2000)
    .refine(isShare, "需为有效的百度网盘分享链接"),
  code: z
    .string()
    .trim()
    .max(20)
    .default("")
    .refine((v) => !v || /^[a-z\d]{4}$/i.test(v), "提取码应为4位字母或数字"),
  summary: z.string().trim().max(5000, "简介不超过5000字").default(""),
  image: z
    .string()
    .trim()
    .max(2000)
    .default("")
    .refine((value) => {
      if (!value) return true;
      try {
        const u = new URL(value);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    }, "图片需为HTTPS链接"),
});
export type GenerationResource = z.infer<typeof generationResource>;
export function generationResourceKey(resource: GenerationResource) {
  let link = resource.link;
  try {
    link = new URL(link).pathname.replace(/\/$/, "");
  } catch {
    /* Validation reports malformed links separately. */
  }
  return `${resource.title.normalize("NFKC").replace(/\s+/g, "").toLowerCase()}|${link}`;
}
export const generationColumns = [
  "title",
  "link",
  "code",
  "summary",
  "image",
] as const;
export type GenerationMapping = Record<
  (typeof generationColumns)[number],
  number
>;
export const generationColumnLabels = {
  title: "资源名称",
  link: "网盘链接",
  code: "提取码",
  summary: "资源简介",
  image: "图片链接",
};
export function guessGenerationMapping(headers: string[]): GenerationMapping {
  const aliases = {
    title: /^(资源名称|资源标题|名称|标题|name|title)$/i,
    link: /^(网盘链接|分享链接|链接|url|link)$/i,
    code: /^(提取码|密码|code|pwd)$/i,
    summary: /^(资源简介|简介|描述|说明|summary|description)$/i,
    image: /^(图片链接|图片|封面|image|cover)$/i,
  };
  return Object.fromEntries(
    generationColumns.map((key) => [
      key,
      headers.findIndex((h) => aliases[key].test(h.trim())),
    ]),
  ) as GenerationMapping;
}
export function mapGenerationRows(
  rows: string[][],
  mapping: GenerationMapping,
  header: boolean,
) {
  const resources: GenerationResource[] = [],
    issues: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  rows.slice(header ? 1 : 0).forEach((row, index) => {
    if (row.every((cell) => !cell.trim())) return;
    const value = Object.fromEntries(
      generationColumns.map((key) => [key, row[mapping[key]]?.trim() ?? ""]),
    );
    const rawLink = value.link;
    value.link =
      rawLink.match(
        /https?:\/\/(?:pan|yun)\.baidu\.com\/s\/[\w-]+(?:\?[^\s，。]*)?/i,
      )?.[0] ?? rawLink;
    if (!value.code) {
      try {
        value.code = new URL(value.link).searchParams.get("pwd") ?? "";
      } catch {
        /* reported below */
      }
      value.code ||=
        rawLink.match(/提取码\s*[:：]?\s*([a-z\d]{4})/i)?.[1] ?? "";
    }
    const parsed = generationResource.safeParse(value);
    let message = parsed.success
      ? ""
      : parsed.error.issues
          .map(
            (issue) =>
              `${generationColumnLabels[issue.path[0] as keyof typeof generationColumnLabels] ?? "资料"}：${issue.message}`,
          )
          .join("；");
    const fingerprint = parsed.success
      ? generationResourceKey(parsed.data)
      : "";
    if (parsed.success && seen.has(fingerprint))
      message = "同名同链接重复，请保留一行";
    if (parsed.success && resources.length >= 100)
      message = "单次最多100份资料，请拆分表格";
    if (message) issues.push({ row: index + (header ? 2 : 1), message });
    else if (parsed.success) {
      seen.add(fingerprint);
      resources.push(parsed.data);
    }
  });
  return { resources, issues };
}
function hash(text: string) {
  let n = 0;
  for (const c of text) n = (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0;
  return n;
}
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
export function generationQuestion(
  resource: GenerationResource,
  rules: GenerationRules,
) {
  const prefixes = lines(rules.prefixes),
    suffixes = lines(rules.suffixes);
  const seed = hash(resource.title + resource.link);
  let prefix = prefixes[seed % prefixes.length] ?? "",
    suffix = suffixes[(seed >>> 5) % suffixes.length] ?? "";
  if (!/[？?]$/.test(suffix)) suffix += "？";
  suffix = suffix.slice(-20);
  prefix = prefix.slice(0, 20);
  const name = resource.title.replace(
    /\.(?:zip|rar|7z|pdf|docx?|xlsx?|pptx?)$/i,
    "",
  );
  return `${prefix}${name.slice(0, Math.max(1, 49 - prefix.length - suffix.length))}${suffix}`;
}
export function generationBody(
  resource: GenerationResource,
  rules: GenerationRules,
) {
  const summary =
    resource.summary ||
    `这份资料名为「${resource.title}」。目前未提供具体目录与版本，使用前请先核对是否符合自己的需求。`;
  const values: Record<string, string> = {
    资源名称: resource.title,
    资源简介: summary,
    SEO关键词: rules.keywords
      .filter((word) => resource.title.includes(word) || summary.includes(word))
      .slice(0, 3)
      .join("、"),
    使用建议: generationTracks[rules.track].guidance,
  };
  const template =
    rules.preferSummary && resource.summary
      ? "{资源简介}\n\n{使用建议}"
      : rules.introTemplate;
  const text = template.replace(
    /\{([^{}]+)\}/g,
    (_, key: string) => values[key] ?? "",
  );
  return limitGenerationText(text, rules.maxChars);
}
export function limitGenerationText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const end = text.slice(0, maxChars - 1);
  const boundary = Math.max(
    end.lastIndexOf("。"),
    end.lastIndexOf("！"),
    end.lastIndexOf("？"),
  );
  return boundary >= maxChars / 2 ? end.slice(0, boundary + 1) : `${end}…`;
}
export function generationHtml(
  resource: GenerationResource,
  rules: GenerationRules,
  body = generationBody(resource, rules),
) {
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  const paragraphs = body
    .split(/\n+/)
    .filter(Boolean)
    .map((p) => `<p>${escape(p)}</p>`)
    .join("");
  const link = `<p>相关资料：${escape(resource.link)}${resource.code ? ` 提取码：${escape(resource.code)}` : ""}</p>`;
  return (
    (rules.linkPosition === "first" ? link + paragraphs : paragraphs + link) +
    (rules.includeImage && resource.image
      ? `<p><img src="${escape(resource.image)}" alt="${escape(resource.title)}" /></p>`
      : "")
  );
}
