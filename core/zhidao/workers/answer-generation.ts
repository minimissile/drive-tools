import { AppError, ServiceHttpError } from "../../errors";
import type { OperationRun } from "../../../shared/zhidao";
import { wait, type WorkerContext } from "./context";

/** Only a known 429 rejection can be retried automatically; no uncertain paid calls. */
export async function generateAutoAnswer(
  ctx: WorkerContext,
  run: OperationRun,
  question: string,
  style: string,
  evidence: unknown,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const nextAt = Number(ctx.store.run(run.id).config.nextGenerationAt ?? 0);
    let remaining = nextAt - Date.now();
    while (remaining > 0) {
      ctx.progress(
        run,
        `模型服务暂时限流，等待${Math.ceil(remaining / 1000)}秒后重试生成 · 已提交进度已保留，可停止任务`,
      );
      await wait(Math.min(remaining, 30_000), signal);
      remaining = nextAt - Date.now();
    }
    signal.throwIfAborted();
    try {
      const result = await ctx.generateAnswer(question, style, evidence);
      if (!ctx.closed)
        ctx.store.config(run.id, {
          ...ctx.store.run(run.id).config,
          nextGenerationAt: 0,
        });
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (ctx.closed) throw error;
      if (error instanceof ServiceHttpError && error.status === 429) {
        const delay = Math.max(
          1000,
          error.retryAfterMs ?? 30_000 * 2 ** attempt,
        );
        ctx.store.config(run.id, {
          ...ctx.store.run(run.id).config,
          nextGenerationAt: Date.now() + delay,
        });
        if (attempt >= 2 || delay > 120_000)
          throw new AppError(
            "AI_RATE_LIMITED",
            `模型服务持续限流（HTTP 429），任务已暂停并保留进度。请至少等待${Math.ceil(delay / 1000)}秒后继续，或在 AI 设置中更换文案模型。`,
          );
        continue;
      }
      if (
        error instanceof Error &&
        (error.message === "fetch failed" ||
          ["TimeoutError", "AbortError"].includes(error.name))
      )
        throw new AppError(
          "AI_GENERATION_UNCERTAIN",
          "模型请求连接中断或超时，本次生成结果及费用待核实。任务已暂停，已提交回答保留；核对后可手动继续，不会自动重试此次生成。",
        );
      throw error;
    }
  }
}
