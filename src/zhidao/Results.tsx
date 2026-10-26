import { useState } from "react";
import { Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import type { OperationItem } from "../../shared/zhidao";
import { Button, Field, Notice, Status } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import "./operation-dialogs.css";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { updateSelection } from "../lib/selection";
import { useOperationAction } from "./hooks";
import { ItemEditor } from "./ItemEditor";
import {
  zhidaoContentIssue,
  zhidaoPublishLimit,
} from "../../shared/zhidao-publishing";
export function ResultTable({
  items,
  selected = [],
  onSelect,
  editable = false,
  running = false,
  selectable = () => true,
  publication = false,
  reviewSelection = false,
  onChanged,
}: {
  items: OperationItem[];
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  editable?: boolean;
  running?: boolean;
  selectable?: (item: OperationItem) => boolean;
  publication?: boolean;
  reviewSelection?: boolean;
  onChanged(): void;
}) {
  const action = useOperationAction();
  const [editing, setEditing] = useState<OperationItem | null>(null),
    [selectOnReview, setSelectOnReview] = useState(false),
    [resolving, setResolving] = useState<OperationItem | null>(null),
    [deleting, setDeleting] = useState<OperationItem | null>(null),
    [remoteId, setRemoteId] = useState("");
  const pageIds = items.filter(selectable).map((i) => i.id);
  return (
    <>
      <div className="operations-table-scroll">
        <table
          className={`operations-table${reviewSelection ? " publish-review-table" : ""}`}
        >
          <thead>
            <tr>
              {onSelect ? (
                <th className="operations-check">
                  <SelectionCheckbox
                    aria-label="选择本页结果"
                    title={
                      reviewSelection
                        ? "选择本页已审核的问答；待审核问答请逐条核对"
                        : undefined
                    }
                    total={pageIds.length}
                    disabled={running || !pageIds.length}
                    selected={
                      items.filter(
                        (i) => selectable(i) && selected.includes(i.id),
                      ).length
                    }
                    onChange={(e) =>
                      onSelect(
                        updateSelection(
                          selected,
                          pageIds,
                          e.target.checked,
                          zhidaoPublishLimit,
                        ),
                      )
                    }
                  />
                </th>
              ) : null}
              <th>名称 / 问题</th>
              <th>结果与来源</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const needsReview = reviewSelection && !selectable(item);
              const selectionFull =
                !selected.includes(item.id) &&
                selected.length >= zhidaoPublishLimit;
              const canReview =
                needsReview &&
                editable &&
                !!onSelect &&
                ["ready", "failed"].includes(item.status);
              const openEditor = (select: boolean) => {
                setSelectOnReview(select);
                setEditing(item);
              };
              return (
                <tr key={item.id}>
                  {onSelect ? (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.name}`}
                        checked={selected.includes(item.id)}
                        disabled={
                          running ||
                          !!action.pending ||
                          selectionFull ||
                          (!selectable(item) &&
                            !canReview &&
                            !selected.includes(item.id))
                        }
                        title={
                          selectionFull
                            ? `最多选择${zhidaoPublishLimit}条，请先取消其他选择`
                            : canReview
                              ? "打开问答，审核后自动选中"
                              : undefined
                        }
                        onChange={(e) => {
                          if (e.target.checked && canReview) {
                            openEditor(true);
                            return;
                          }
                          onSelect(
                            updateSelection(
                              selected,
                              [item.id],
                              e.target.checked,
                              zhidaoPublishLimit,
                            ),
                          );
                        }}
                      />
                    </td>
                  ) : null}
                  <td>
                    <strong
                      className="operation-result-title"
                      title={item.question || item.name}
                    >
                      {item.question || item.name}
                    </strong>
                    {item.question &&
                    item.name &&
                    !item.question.startsWith(item.name) ? (
                      <small>{item.name}</small>
                    ) : null}
                  </td>
                  <td>
                    <p className="operation-result-preview">
                      {item.answer
                        ? item.answer.replace(/<[^>]*>/g, " ")
                        : item.link || item.evidence || "等待结果"}
                    </p>
                    {item.sourceName ? <small>{item.sourceName}</small> : null}
                    {item.code ? <small>提取码：{item.code}</small> : null}
                    {item.taskId || item.answerId ? (
                      <small>
                        {item.taskId
                          ? `上传任务ID：${item.taskId}`
                          : `回答ID：${item.answerId}`}
                      </small>
                    ) : null}
                    {item.message ? <small>{item.message}</small> : null}
                  </td>
                  <td>
                    <Status
                      kind={
                        item.status === "ready" || item.status === "submitted"
                          ? "good"
                          : item.status === "pending"
                            ? "normal"
                            : "warning"
                      }
                    >
                      {
                        {
                          pending: "待处理",
                          ready: "已生成",
                          failed: "失败",
                          submitted: "已提交",
                          uncertain: "待核对",
                          skipped: "已跳过",
                        }[item.status]
                      }
                    </Status>
                    {editable && ["ready", "failed"].includes(item.status) ? (
                      <small>
                        {needsReview
                          ? zhidaoContentIssue(item) || "待审核"
                          : item.reviewed
                            ? "已审核"
                            : "待审核"}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    <div className="operation-row-actions">
                      <Button
                        quiet
                        size="compact"
                        disabled={!!action.pending}
                        onClick={() =>
                          void action.run(
                            "system.copyText",
                            { text: item.answer || item.link || item.name },
                            undefined,
                            "已复制",
                          )
                        }
                        aria-label={`复制 ${item.name}`}
                      >
                        <Copy size={14} />
                      </Button>
                      {item.sourceUrl || item.link ? (
                        <Button
                          quiet
                          size="compact"
                          aria-label={`打开 ${item.name}`}
                          title="打开问题或来源"
                          disabled={
                            !!action.pending || (running && !!item.questionId)
                          }
                          onClick={() =>
                            item.questionId
                              ? void action.run("zhidao.answer.open", {
                                  id: item.id,
                                })
                              : void action.run("zhidao.open", {
                                  url: item.sourceUrl || item.link,
                                })
                          }
                        >
                          <ExternalLink size={14} />
                        </Button>
                      ) : null}
                      {editable ? (
                        <Button
                          quiet
                          size="compact"
                          disabled={
                            !!action.pending ||
                            running ||
                            (canReview && selectionFull) ||
                            ["submitted", "uncertain"].includes(item.status)
                          }
                          onClick={() => openEditor(canReview)}
                          aria-label={`${canReview ? "审核并选择" : "编辑"} ${item.name}`}
                          title={
                            canReview && selectionFull
                              ? `最多选择${zhidaoPublishLimit}条，请先取消其他选择`
                              : undefined
                          }
                        >
                          {canReview ? "审核并选择" : <Pencil size={14} />}
                        </Button>
                      ) : null}
                      {item.status === "uncertain" ? (
                        <Button
                          quiet
                          size="compact"
                          disabled={!!action.pending || running}
                          onClick={() => {
                            setRemoteId("");
                            setResolving(item);
                          }}
                        >
                          核对结果
                        </Button>
                      ) : null}
                      {!running &&
                      !["submitted", "uncertain"].includes(item.status) ? (
                        <Button
                          quiet
                          size="compact"
                          aria-label={`移除 ${item.name}`}
                          disabled={!!action.pending}
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {deleting ? (
        <Dialog
          title="移除本地结果"
          onClose={() => setDeleting(null)}
          busy={!!action.pending}
          footer={
            <>
              <Button
                disabled={!!action.pending}
                onClick={() => setDeleting(null)}
              >
                取消
              </Button>
              <Button
                primary
                disabled={!!action.pending}
                onClick={() =>
                  void action.run(
                    "zhidao.item.remove",
                    { ids: [deleting.id] },
                    () => {
                      onSelect?.(selected.filter((id) => id !== deleting.id));
                      setDeleting(null);
                      onChanged();
                    },
                    "本地结果已移除",
                  )
                }
              >
                {action.pending ? "正在移除…" : "确认移除"}
              </Button>
            </>
          }
        >
          <p className="operation-dialog-description">{`将从此任务的结果列表移除「${deleting.name}」。`}</p>
          <p className="operation-dialog-caption">
            网盘文件和已归档资源不受影响。已提交和待核对的结果不能移除。
          </p>
        </Dialog>
      ) : null}
      {editing ? (
        <ItemEditor
          item={editing}
          reviewAndSelect={selectOnReview}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            if (selectOnReview)
              onSelect?.(
                updateSelection(selected, [saved.id], true, zhidaoPublishLimit),
              );
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
      {resolving ? (
        <Dialog
          title="核对平台提交结果"
          onClose={() => setResolving(null)}
          busy={!!action.pending}
          footer={
            <>
              <Button
                disabled={!!action.pending}
                onClick={() => setResolving(null)}
              >
                取消
              </Button>
              <Button
                disabled={!!action.pending}
                onClick={() =>
                  void action.run(
                    "zhidao.resolve",
                    { id: resolving.id, outcome: "retry", confirmed: true },
                    () => {
                      setResolving(null);
                      onChanged();
                    },
                    "已记录未提交，可继续任务",
                  )
                }
              >
                已核对，确认未提交
              </Button>
              <Button
                primary
                disabled={!remoteId.trim() || !!action.pending}
                onClick={() =>
                  void action.run(
                    "zhidao.resolve",
                    {
                      id: resolving.id,
                      outcome: "submitted",
                      remoteId: remoteId.trim(),
                      confirmed: true,
                    },
                    () => {
                      setResolving(null);
                      onChanged();
                    },
                    "已登记平台结果",
                  )
                }
              >
                {action.pending === "zhidao.resolve"
                  ? "正在登记…"
                  : "登记已提交"}
              </Button>
            </>
          }
        >
          <p className="operation-dialog-description">
            {resolving.question || resolving.name}
          </p>
          <Notice warning>
            此请求的远端结果未知。请先打开平台核对，再登记结果；确认未提交后继续任务才会重试。
            {(resolving.uploadBatchSize ?? 0) > 1
              ? ` 本批共${resolving.uploadBatchSize}条问答，核对结果会同时应用于整批。`
              : ""}
          </Notice>
          <div>
            <Button
              disabled={!!action.pending}
              onClick={() =>
                publication
                  ? void action.run("zhidao.publish.open", {
                      id: resolving.runId,
                    })
                  : resolving.questionId
                    ? void action.run("zhidao.answer.open", {
                        id: resolving.id,
                      })
                    : void action.run("zhidao.open", {
                        url: "https://zhidao.baidu.com/b/batch/batch-upload",
                      })
              }
            >
              {action.pending === "zhidao.answer.open" ||
              action.pending === "zhidao.publish.open" ||
              action.pending === "zhidao.open"
                ? "正在打开…"
                : "打开百度知道"}
            </Button>
          </div>
          <Field
            label={resolving.questionId ? "平台回答ID" : "上传任务ID"}
            hint="确认平台已提交后，填写实际返回的ID。"
          >
            <input
              aria-label={
                resolving.questionId && !publication
                  ? "平台回答ID"
                  : "上传任务ID"
              }
              value={remoteId}
              onChange={(e) => setRemoteId(e.target.value)}
              maxLength={100}
              disabled={!!action.pending}
              placeholder="填写已核对的ID"
            />
          </Field>
        </Dialog>
      ) : null}
    </>
  );
}
