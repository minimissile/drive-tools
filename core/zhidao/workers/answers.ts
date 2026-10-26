import { AppError } from "../../errors";
import { answerInput } from "../../../shared/zhidao";
import { wait } from "./context";
import type { OperationRun } from "../../../shared/zhidao";
import type { WorkerContext } from "./context";
import { sampledQuestions, shuffled } from "./answer-questions";
import { zhidaoQuestionPageSize } from "../client";
import { answerHistory } from "../answer-history";
import { generateAutoAnswer } from "./answer-generation";

const isAnswered = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "true";

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
  if (ctx.store.items(run.id).some((i) => i.status === "uncertain"))
    throw new AppError(
      "ANSWER_RESULT_UNCERTAIN",
      "存在待核对回答，请先登记平台结果或确认未提交，再继续任务。",
    );
  await ctx.identity(input.accountId);
  signal.throwIfAborted();
  const answered = answerHistory(ctx.repo.db);
  let success = ctx.store
    .items(run.id)
    .filter((i) => i.status === "submitted").length;
  let failures = 0;
  async function* candidates() {
    // Resume saved answers first: random page selection must not lose paid work.
    for (const item of shuffled(
      ctx.store
        .items(run.id)
        .filter(
          (i) =>
            ["ready", "failed"].includes(i.status) && i.answer && i.questionId,
        ),
    )) {
      yield {
        qid: item.questionId,
        question: item.question,
        category: item.questionCategory ?? input.categories[0],
        sourceBase: item.questionBase,
        answered: false,
      };
    }
    for (const category of shuffled([...new Set(input.categories)])) {
      let reads = 0;
      for await (const q of sampledQuestions(async (base) => {
        signal.throwIfAborted();
        if (reads++ && ctx.pace > 0) await wait(ctx.pace, signal);
        ctx.progress(
          run,
          `正在随机翻页 · ${category === "emotion" ? "情感" : category === "general" ? "综合" : "教育"}第${Math.floor(base / zhidaoQuestionPageSize) + 1}页 · 已提交${success}/${input.count}`,
          success,
        );
        const result = await ctx.client.questions(
          input.accountId,
          category,
          base,
        );
        signal.throwIfAborted();
        return {
          ...result,
          items: result.items.map((q) => ({ ...q, sourceBase: base })),
        };
      }))
        yield { ...q, category };
    }
  }
  if (success >= input.count) return;
  for await (const q of candidates()) {
    const category = q.category;
    signal.throwIfAborted();
    if (success >= input.count) break;
    const qid = String(q.qid ?? "");
    if (!/^[\w-]{1,100}$/.test(qid) || !q.question) continue;
    if (isAnswered(q.answered)) {
      answered.add(qid, q.question);
      continue;
    }
    if (answered.has(qid, q.question)) continue;
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
      answered.add(qid, q.question);
      continue;
    }
    if (!item?.answer) {
      ctx.progress(
        run,
        `正在生成回答 · 已提交${success}/${input.count} · ${q.question.slice(0, 50)}`,
        success,
      );
      const generated = await generateAutoAnswer(
        ctx,
        run,
        q.question,
        input.style,
        {
          category,
          requirements: input.instructions,
        },
        signal,
      );
      if (ctx.closed) return;
      item = ctx.store.put(run.id, qid, {
        name: q.question.slice(0, 100),
        question: q.question,
        questionId: qid,
        questionBase: q.sourceBase,
        questionCategory: category,
        sourceUrl: `https://zhidao.baidu.com/question/hx/${qid}?activity=21th&qpi=21th_activity`,
        sourceName: `${category === "emotion" ? "情感" : category === "general" ? "综合" : "教育"}题库`,
        answer: generated.answer,
        status: "ready",
      });
      signal.throwIfAborted();
    }
    const nextAt = Number(ctx.store.run(run.id).config.nextAnswerAt ?? 0);
    const delay = nextAt - Date.now();
    if (delay > 0) {
      ctx.progress(
        run,
        `等待提交间隔 · 已提交${success}/${input.count} · 可停止并保留当前回答`,
        success,
      );
      await wait(delay, signal);
    }
    signal.throwIfAborted();
    const identity = await ctx.identity(input.accountId);
    signal.throwIfAborted();
    // A saved candidate may have been answered in another run or browser while waiting.
    const currentPage = await ctx.client.questions(
      input.accountId,
      category,
      q.sourceBase ?? item.questionBase ?? 0,
    );
    signal.throwIfAborted();
    const current = currentPage.items.find(
      (entry) => String(entry.qid) === qid,
    );
    const historical = answerHistory(ctx.repo.db).has(qid, q.question);
    if (!current || isAnswered(current.answered) || historical) {
      if (current || historical) answered.add(qid, q.question);
      ctx.store.put(run.id, qid, {
        ...item,
        status: "skipped",
        message:
          !current && !historical
            ? "候选页已变化，保留已生成回答，本次不提交"
            : "此问题已有历史回答或平台已答标记，已跳过提交",
      });
      continue;
    }
    // Persist the cooldown before sending; stop/resume cannot erase the interval.
    ctx.store.config(run.id, {
      ...ctx.store.run(run.id).config,
      nextAnswerAt:
        Date.now() +
        Math.max(
          ctx.pace,
          (success + 1) % 15 === 0
            ? Math.max(60, input.intervalSeconds) * 1000
            : input.intervalSeconds * 1000,
        ),
    });
    ctx.progress(
      run,
      `正在提交回答 · 已提交${success}/${input.count}`,
      success,
    );
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
      const hasErrno =
        response.errno !== undefined &&
        response.errno !== null &&
        response.errno !== "";
      if (hasErrno && Number(response.errno) === 0 && aid) {
        ctx.store.put(run.id, qid, {
          ...item,
          status: "submitted",
          answerId: String(aid),
          message: "平台已返回回答ID；审核结果以平台为准",
        });
        success++;
        failures = 0;
        answered.add(qid, q.question);
      } else {
        const pending = !hasErrno || [0, 36].includes(Number(response.errno));
        if (pending) answered.add(qid, q.question);
        ctx.store.put(run.id, qid, {
          ...item,
          status: pending ? "uncertain" : "failed",
          message: pending
            ? Number(response.errno) === 36
              ? "平台返回等待审核，请核对后处理"
              : "平台未返回可确认的回答ID，请先核对；不会自动重复提交"
            : `回答未确认成功（${String(response.errno ?? "未知错误码")}）`,
        });
        if (pending)
          throw new AppError(
            "ANSWER_RESULT_UNCERTAIN",
            "此回答的提交结果待核对，任务已暂停；请核对平台记录后继续。",
          );
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
      ) {
        ctx.store.put(run.id, qid, {
          ...item,
          status: "uncertain",
          message: "提交结果未知，请在平台核对；不会自动重复提交",
        });
        throw new AppError(
          "ANSWER_RESULT_UNCERTAIN",
          "提交结果未知，任务已暂停；请先在平台核对此回答。",
        );
      }
      throw error;
    }
    ctx.progress(run, `已提交${success}/${input.count}`, success);
    if (success >= input.count) break;
  }
}
