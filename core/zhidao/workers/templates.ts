import { AppError, safeMessage } from "../../errors";
import { templateInput } from "../../../shared/zhidao";
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
  let index = 0;
  for (const copyId of input.copyIds) {
    signal.throwIfAborted();
    const existing = ctx.store.items(run.id).find((i) => i.key === copyId);
    if (existing?.status === "ready") {
      index++;
      continue;
    }
    await ctx.verifyCopy?.(copyId);
    signal.throwIfAborted();
    const { copy, resource } = ctx.ownTarget(copyId);
    ctx.progress(
      run,
      `正在生成「${resource.title}」 · ${index + 1}/${input.copyIds.length}`,
      index,
    );
    let evidence: unknown = {
      summary: resource.summary,
      filenames: copy.files.slice(0, 50).map((f) => f.name),
    };
    if (input.verifyFacts) {
      const web = await publicEvidence(
        resource.title + " 简介",
        ctx.fetcher,
        signal,
      );
      signal.throwIfAborted();
      evidence = { ...(evidence as object), web };
    }
    try {
      const result = await ctx.generateAnswer(
        `介绍「${resource.title}」的内容、适用人群和使用方法`,
        "清晰实用",
        evidence,
      );
      signal.throwIfAborted();
      const code = (await ctx.secrets.get(`share:${copy.id}`)) ?? "";
      signal.throwIfAborted();
      const current = ctx.ownTarget(copyId).copy;
      if (
        current.shareVersion !== copy.shareVersion ||
        current.shareUrl !== copy.shareUrl
      )
        throw new AppError(
          "STALE_SHARE",
          "生成期间分享已变化，请重新生成模板。",
        );
      ctx.store.put(run.id, copyId, {
        name: resource.title,
        question: questionTitle(resource.title, index),
        answer: safeHtmlAnswer(result.answer, copy.shareUrl!, code),
        link: copy.shareUrl!,
        code,
        copyId,
        shareVersion: copy.shareVersion,
        status: "ready",
        reviewed: false,
        evidence: JSON.stringify(evidence),
      });
    } catch (error) {
      signal.throwIfAborted();
      ctx.store.put(run.id, copyId, {
        name: resource.title,
        copyId,
        status: "failed",
        message: safeMessage(error),
      });
      throw error;
    }
    index++;
    ctx.progress(run, `已生成${index}/${input.copyIds.length}`, index);
  }
}
