import { z } from "zod";
import { AppError } from "../errors";
import { zhidaoAnswerIssue } from "../../shared/zhidao-content";

export const materialVariantsSchema = z.object({
  materials: z
    .array(z.string().min(20).max(2000))
    .min(1)
    .max(10)
    .describe(
      "资料文案正文字符串数组，每项是一篇完整文案，不要返回标题/正文对象；篇数按输入count生成。",
    ),
});

/** Normalize known text shapes locally; never invent missing articles or retry a paid call. */
export function normalizeMaterialVariants(data: unknown, warnings: string[]) {
  const object =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const values = Array.isArray(data)
    ? data
    : (object?.materials ?? object?.articles);
  if (!Array.isArray(values))
    throw new AppError(
      "INVALID_MATERIALS",
      "模型未返回可识别的资料文案列表，本次费用已记录；原有文案已保留。",
    );
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const fields =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const body =
      typeof value === "string"
        ? value
        : [fields?.content, fields?.body, fields?.text, fields?.answer].find(
            (entry): entry is string =>
              typeof entry === "string" && !!entry.trim(),
          );
    const text = body?.trim() || "";
    const issue = !text
      ? "没有可识别的正文"
      : text.length < 20
        ? "正文少于20字"
        : text.length > 2000
          ? "正文超过2000字"
          : zhidaoAnswerIssue(text);
    if (issue) {
      warnings.push(`第${index + 1}篇${issue}，已排除。`);
      continue;
    }
    const key = text.normalize("NFKC").replace(/\s+/g, "");
    if (seen.has(key)) {
      warnings.push(`第${index + 1}篇与其他文案重复，已合并。`);
      continue;
    }
    seen.add(key);
    entries.push(text);
    if (!/[。！？.!?][”’」』）)\]】]*$/.test(text))
      warnings.push(
        `第${index + 1}篇末尾缺少句末标点，可能尚未写完，请检查并编辑后使用。`,
      );
  }
  if (!entries.length)
    throw new AppError(
      "INVALID_MATERIALS",
      `模型没有返回可用资料文案：${warnings.slice(0, 3).join("；") || "文案列表为空"} 本次费用已记录；原有文案已保留。`,
    );
  if (entries.length > 10) {
    warnings.push("模型返回超过10篇，已保留前10篇可用文案。");
    entries.length = 10;
  }
  return { materials: entries };
}
