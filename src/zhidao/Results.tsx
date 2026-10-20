import { useState } from "react";
import { Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { z } from "zod";
import type { OperationItem } from "../../shared/zhidao";
import { useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Status } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { updateSelection } from "../lib/selection";
import { useOperationAction } from "./hooks";
export function ResultTable({
  items,
  selected = [],
  onSelect,
  editable = false,
  running = false,
  onChanged,
}: {
  items: OperationItem[];
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  editable?: boolean;
  running?: boolean;
  onChanged(): void;
}) {
  const action = useOperationAction();
  const [editing, setEditing] = useState<OperationItem | null>(null),
    [resolving, setResolving] = useState<OperationItem | null>(null),
    [deleting, setDeleting] = useState<OperationItem | null>(null),
    [remoteId, setRemoteId] = useState("");
  const pageIds = items.map((i) => i.id);
  return (
    <>
      <div className="operations-table-scroll">
        <table className="operations-table">
          <thead>
            <tr>
              {onSelect ? (
                <th className="operations-check">
                  <SelectionCheckbox
                    aria-label="选择本页结果"
                    total={items.length}
                    selected={
                      items.filter((i) => selected.includes(i.id)).length
                    }
                    onChange={(e) =>
                      onSelect(
                        updateSelection(
                          selected,
                          pageIds,
                          e.target.checked,
                          100,
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
            {items.map((item) => (
              <tr key={item.id}>
                {onSelect ? (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.name}`}
                      checked={selected.includes(item.id)}
                      onChange={(e) =>
                        onSelect(
                          updateSelection(
                            selected,
                            [item.id],
                            e.target.checked,
                            100,
                          ),
                        )
                      }
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
                  {item.question ? <small>{item.name}</small> : null}
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
                  {editable ? (
                    <small>{item.reviewed ? "已审核" : "待审核"}</small>
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
                        onClick={() =>
                          void action.run("zhidao.open", {
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
                          running ||
                          ["submitted", "uncertain"].includes(item.status)
                        }
                        onClick={() => setEditing(item)}
                        aria-label={`编辑 ${item.name}`}
                      >
                        <Pencil size={14} />
                      </Button>
                    ) : null}
                    {item.status === "uncertain" ? (
                      <Button
                        quiet
                        size="compact"
                        disabled={running}
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
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting ? (
        <Dialog
          title="移除本地结果"
          onClose={() => setDeleting(null)}
          busy={!!action.pending}
        >
          <p>
            将从此任务的结果列表移除「{deleting.name}
            」。网盘文件和已归档资源不受影响。
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button
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
              确认移除
            </Button>
          </div>
        </Dialog>
      ) : null}
      {editing ? (
        <ItemEditor
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
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
        >
          <Notice warning>
            此请求的远端结果未知。请先打开平台核对，再登记结果；确认未提交后继续任务才会重试。
          </Notice>
          <Button
            onClick={() =>
              void action.run("zhidao.open", {
                url: "https://zhidao.baidu.com/b/batch/batch-upload",
              })
            }
          >
            打开百度知道
          </Button>
          <Field label="平台回答ID或上传任务ID">
            <input
              value={remoteId}
              onChange={(e) => setRemoteId(e.target.value)}
              maxLength={100}
            />
          </Field>
          <div className="dialog-actions">
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
                    remoteId,
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
              登记已提交
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
function ItemEditor({
  item,
  onClose,
  onSaved,
}: {
  item: OperationItem;
  onClose(): void;
  onSaved(): void;
}) {
  const { data } = useAppData();
  const action = useOperationAction();
  const parse = z.object({
    name: z.string(),
    question: z.string(),
    answer: z.string(),
  });
  const draft = useLocalDraft(
    `panxu-operation-edit:${data!.dataPath}:${item.id}`,
    { name: item.name, question: item.question, answer: item.answer },
    (v) => parse.parse(v),
  );
  const [reviewed, setReviewed] = useState(false);
  const changed =
    draft.value.question !== item.question ||
    draft.value.answer !== item.answer;
  return (
    <Dialog
      title="编辑问答"
      onClose={onClose}
      busy={!!action.pending}
      className="operation-edit-dialog"
    >
      <Field label="资源名称">
        <input
          value={draft.value.name}
          maxLength={200}
          onChange={(e) => draft.update({ name: e.target.value })}
        />
      </Field>
      <Field label="问题标题" hint="批量上传标题需不超过49字">
        <textarea
          rows={2}
          value={draft.value.question}
          maxLength={5000}
          onChange={(e) => {
            draft.update({ question: e.target.value });
            setReviewed(false);
          }}
        />
      </Field>
      <Field label="回答内容">
        <textarea
          rows={12}
          value={draft.value.answer}
          maxLength={25000}
          onChange={(e) => {
            draft.update({ answer: e.target.value });
            setReviewed(false);
          }}
        />
      </Field>
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      <label className="check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={changed}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        {changed
          ? "保存修改后，可再次打开并确认审核"
          : "我已核对事实、链接与发布内容"}
      </label>
      <div className="dialog-actions">
        <Button onClick={onClose}>取消</Button>
        <Button
          primary
          disabled={!!action.pending || !draft.value.name.trim()}
          onClick={() =>
            void action.run(
              "zhidao.item.save",
              { id: item.id, ...draft.value, reviewed },
              () => {
                draft.clear();
                onSaved();
              },
              changed ? "修改已保存，请再次审核" : "审核状态已保存",
            )
          }
        >
          保存{changed ? "修改" : reviewed ? "并确认审核" : ""}
        </Button>
      </div>
    </Dialog>
  );
}
