import { AppError } from "../../errors";
import { answerInput } from "../../../shared/zhidao";
import { wait } from "./context";
import type { OperationRun } from "../../../shared/zhidao";
import type { WorkerContext } from "./context";

export async function runAnswers(
  ctx: WorkerContext,
  run: OperationRun,
  signal: AbortSignal,
) {
  const input = answerInput.parse(run.config);
  if (input.mode === "manual") {
    if (ctx.store.items(run.id).some((i) => i.status === "ready")) return;
    const result = await ctx.generateAnswer(input.question, input.style);
    signal.throwIfAborted();
    ctx.store.put(run.id, "manual", {
      name: input.question.slice(0, 100),
      question: input.question,
      answer: result.answer,
      status: "ready",
    });
    return;
  }
  const identity = await ctx.identity(input.accountId);
  signal.throwIfAborted();
  const answered = new Set(
    ctx.repo.db
      .all<{ qid: string }>(
        "SELECT json_extract(i.data,'$.questionId') qid FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE json_extract(r.config,'$.accountId')=? AND i.status IN ('submitted','uncertain','submitting')",
        input.accountId,
      )
      .map((r) => r.qid),
  );
  let success = ctx.store
    .items(run.id)
    .filter((i) => i.status === "submitted").length;
  let failures = 0;
  for (const category of ["emotion", "general", "education"]) {
    let base = 0;
    let empty = 0;
    for (let page = 0; page < 50 && success < input.count; page++) {
      signal.throwIfAborted();
      ctx.progress(
        run,
        `正在读取${category === "emotion" ? "情感" : category === "general" ? "综合" : "教育"}题库 · 已提交${success}/${input.count}`,
        success,
      );
      const result = await ctx.client.questions(
        input.accountId,
        category,
        base,
      );
      signal.throwIfAborted();
      if (!result.items.length) {
        if (++empty >= 3) break;
      }
      for (const q of result.items) {
        signal.throwIfAborted();
        if (success >= input.count) break;
        const qid = String(q.qid ?? "");
        if (
          !/^[\w-]{1,100}$/.test(qid) ||
          !q.question ||
          q.answered ||
          answered.has(qid)
        )
          continue;
        let item = ctx.store.items(run.id).find((i) => i.key === qid);
        const storedStatus = item
          ? ctx.repo.db.get<{ status: string }>(
              "SELECT status FROM operation_items WHERE id=?",
              item.id,
            )?.status
          : undefined;
        if (
          storedStatus &&
          ["submitted", "uncertain", "submitting"].includes(storedStatus)
        ) {
          answered.add(qid);
          continue;
        }
        if (!item?.answer) {
          const generated = await ctx.generateAnswer(q.question, input.style);
          signal.throwIfAborted();
          item = ctx.store.put(run.id, qid, {
            name: q.question.slice(0, 100),
            question: q.question,
            questionId: qid,
            answer: generated.answer,
            status: "ready",
          });
        }
        signal.throwIfAborted();
        ctx.store.submitting(item);
        try {
          const response = await ctx.client.answer(
            input.accountId,
            qid,
            item.answer,
            identity.stoken,
          );
          if (ctx.closed) return;
          const aid = response.data?.aid;
          if (Number(response.errno) === 0 && aid) {
            ctx.store.put(run.id, qid, {
              ...item,
              status: "submitted",
              answerId: String(aid),
              message: "平台已返回回答ID；审核结果以平台为准",
            });
            success++;
            failures = 0;
            answered.add(qid);
          } else {
            const pending = Number(response.errno) === 36;
            if (pending) answered.add(qid);
            ctx.store.put(run.id, qid, {
              ...item,
              status: pending ? "uncertain" : "failed",
              message: pending
                ? "平台返回等待审核，请核对后处理"
                : `回答未确认成功（${String(response.errno ?? "未知错误码")}）`,
            });
            if (
              [4, 15, 27, 268, 3002, 3006, 3008, 18007].includes(
                Number(response.errno),
              )
            )
              throw new AppError(
                "ANSWER_STOPPED",
                `平台限制或登录异常（${response.errno}），已停止提交。`,
              );
            if (++failures >= 3)
              throw new AppError(
                "ANSWER_FAILURES",
                "连续三次提交失败，已停止任务。",
              );
          }
        } catch (error) {
          if (ctx.closed) return;
          if (
            ctx.repo.db.get<{ status: string }>(
              "SELECT status FROM operation_items WHERE id=?",
              item.id,
            )?.status === "submitting"
          )
            ctx.store.put(run.id, qid, {
              ...item,
              status: "uncertain",
              message: "提交结果未知，请在平台核对；不会自动重复提交",
            });
          throw error;
        }
        ctx.progress(run, `已提交${success}/${input.count}`, success);
        if (success < input.count)
          await wait(
            success && success % 15 === 0 ? 60000 : Math.max(ctx.pace, 18000),
            signal,
          );
      }
      if (!result.hasMore || result.nextBase === base) break;
      base = result.nextBase;
    }
  }
}
