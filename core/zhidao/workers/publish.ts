import { AppError } from "../../errors";
import { id } from "../../database";
import { xlsx } from "../../export-formats";
import { publishInput } from "../../../shared/zhidao";
import { wait } from "./context";
import type { OperationRun } from "../../../shared/zhidao";
import type { WorkerContext } from "./context";

export async function runPublish(
  ctx: WorkerContext,
  run: OperationRun,
  signal: AbortSignal,
) {
  const input = publishInput.parse(run.config);
  await ctx.identity(input.accountId);
  signal.throwIfAborted();
  if (!(await ctx.client.permission(input.accountId)))
    throw new AppError(
      "NO_BULK_PERMISSION",
      "此账号暂无百度知道快捷答题资格，可先导出模板。",
    );
  signal.throwIfAborted();
  ctx.validatePublication(input.itemIds);
  ctx.assertNoDuplicatePublication(input.itemIds, input.accountId, run.id);
  for (let index = 0; index < input.itemIds.length; index++) {
    signal.throwIfAborted();
    const source = ctx.store.item(input.itemIds[index]);
    const existing = ctx.store.items(run.id).find((i) => i.key === source.id);
    if (existing && ["submitted", "uncertain"].includes(existing.status))
      continue;
    if (source.copyId) await ctx.verifyCopy?.(source.copyId);
    signal.throwIfAborted();
    ctx.validatePublication([source.id]);
    const item = ctx.store.put(run.id, source.id, {
      ...source,
      id: existing?.id ?? id("item"),
      runId: run.id,
      key: source.id,
      status: "pending",
      taskId: "",
      message: "",
    });
    ctx.progress(run, `正在上传${index + 1}/${input.itemIds.length}`, index);
    ctx.store.submitting(item);
    try {
      const response = await ctx.client.upload(
        input.accountId,
        `${input.taskName}-${index + 1}`,
        xlsx(
          [
            ["qid", "问题标题", "回答内容"],
            ["", source.question, source.answer],
          ],
          "问答结果",
        ),
      );
      if (ctx.closed) return;
      const taskId = response.data?.taskId;
      if (response.code === 200 && taskId)
        ctx.store.put(run.id, item.key, {
          ...item,
          status: "submitted",
          taskId: String(taskId),
          message: "上传任务已创建；平台审核结果尚未确认",
        });
      else {
        ctx.store.put(run.id, item.key, {
          ...item,
          status: "failed",
          message: `上传未成功（${String(response.code ?? "未知错误码")}）`,
        });
        throw new AppError(
          "UPLOAD_REJECTED",
          `百度知道未接受第${index + 1}条模板，请检查账号资格或内容。`,
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
        ctx.store.put(run.id, item.key, {
          ...item,
          status: "uncertain",
          message: "上传结果未知，请在平台核对后处理，避免重复上传",
        });
      throw error;
    }
    await wait(ctx.pace, signal);
  }
}
