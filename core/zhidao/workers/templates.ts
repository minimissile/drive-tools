import { AppError, safeMessage } from "../../errors";
import { templateInput } from "../../../shared/zhidao";
import {
  generationBody,
  generationHtml,
  generationQuestion,
  generationTracks,
  limitGenerationText,
  type GenerationResource,
} from "../../../shared/zhidao-generation";
import { safeHtmlAnswer, questionTitle } from "../parsers";
import { publicEvidence } from "../mining";
import type { OperationRun } from "../../../shared/zhidao";
import type { WorkerContext } from "./context";

export async function runTemplates(
  ctx: WorkerContext,
  run: OperationRun,
  signal: AbortSignal,
) {
  const input = templateInput.parse(run.config);
  const sources = input.copyIds.length
    ? input.copyIds.map((copyId) => ({
        key: copyId,
        copyId,
        resource: null as GenerationResource | null,
      }))
    : input.resources.map((resource, index) => ({
        key: `row:${index}`,
        copyId: "",
        resource,
      }));
  let index = 0;
  for (const source of sources) {
    signal.throwIfAborted();
    const copyId = source.copyId;
    const existing = ctx.store.items(run.id).find((i) => i.key === source.key);
    if (existing?.status === "ready") {
      index++;
      continue;
    }
    let resource = source.resource;
    let shareVersion = 0;
    try {
      if (copyId) {
        await ctx.verifyCopy?.(copyId);
        signal.throwIfAborted();
        const target = ctx.ownTarget(copyId);
        shareVersion = target.copy.shareVersion;
        resource = {
          title: target.resource.title,
          link: target.copy.shareUrl!,
          code: (await ctx.secrets.get(`share:${copyId}`)) ?? "",
          summary: target.resource.summary,
          image: "",
        };
      }
      signal.throwIfAborted();
      if (!resource)
        throw new AppError("INVALID_RESOURCE", "资料无法读取，请重新选择。");
      ctx.progress(
        run,
        `正在生成「${resource.title}」 · ${index + 1}/${sources.length}`,
        index,
      );
      const evidence: Record<string, unknown> = {
        summary: resource.summary,
        source: copyId ? "本人已核验分享" : "用户导入，链接有效性未核验",
      };
      if (copyId)
        evidence.filenames = ctx
          .ownTarget(copyId)
          .copy.files.slice(0, 50)
          .map((file) => file.name);
      if (input.verifyFacts) {
        evidence.web = await publicEvidence(
          `${resource.title} 简介`,
          ctx.fetcher,
          signal,
        );
        signal.throwIfAborted();
      }
      const rules = input.rules;
      const question = rules
        ? generationQuestion(resource, rules)
        : questionTitle(resource.title, index);
      let answer: string;
      if (rules?.mode === "template") answer = generationHtml(resource, rules);
      else {
        if (rules)
          evidence.requirements = [
            `这是${generationTracks[rules.track].label}资料问答。先直接回应问题，再说明资料具体内容、适用对象、使用顺序和限制。`,
            `正文不超过${rules.maxChars}字。资料依据：${resource.summary || "只有资源名称，缺少目录和版本，请明确这一限制"}。`,
            `写作结构参考：${generationBody(resource, rules)}。关键词只在内容相关时自然使用：${rules.keywords.join("、")}。`,
            "不编造完整、最新、免费、官方、亲测等属性，不虚构个人经历。不要生成链接、提取码或HTML，系统将追加用户提供的真实资料入口。",
          ].join("\n");
        const result = await ctx.generateAnswer(
          rules
            ? question
            : `介绍「${resource.title}」的内容、适用人群和使用方法`,
          rules?.style ?? "清晰实用",
          evidence,
        );
        signal.throwIfAborted();
        answer = rules
          ? generationHtml(
              resource,
              rules,
              limitGenerationText(result.answer, rules.maxChars),
            )
          : safeHtmlAnswer(result.answer, resource.link, resource.code);
      }
      if (copyId) {
        const current = ctx.ownTarget(copyId).copy;
        if (
          current.shareVersion !== shareVersion ||
          current.shareUrl !== resource.link
        )
          throw new AppError(
            "STALE_SHARE",
            "生成期间分享已变化，请重新生成模板。",
          );
      }
      ctx.store.put(run.id, source.key, {
        name: resource.title,
        question,
        answer,
        link: resource.link,
        code: resource.code,
        copyId,
        shareVersion,
        sourceName: copyId ? "本人已核验分享" : "表格导入 · 链接待核验",
        status: "ready",
        reviewed: false,
        evidence: JSON.stringify(evidence),
        message: "",
      });
    } catch (error) {
      signal.throwIfAborted();
      ctx.store.put(run.id, source.key, {
        name: resource?.title ?? copyId,
        copyId,
        status: "failed",
        message: safeMessage(error),
      });
      throw error;
    }
    index++;
    ctx.progress(run, `已生成${index}/${sources.length}`, index);
  }
}
