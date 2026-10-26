import { useState } from "react";
import { z } from "zod";
import type { OperationItem } from "../../shared/zhidao";
import {
  zhidaoQuestionTitleLimit,
  zhidaoContentIssue,
} from "../../shared/zhidao-publishing";
import { useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import { useOperationAction } from "./hooks";
import "./operation-dialogs.css";
export function ItemEditor({
  item,
  onClose,
  onSaved,
  reviewAndSelect = false,
}: {
  item: OperationItem;
  onClose(): void;
  onSaved(item: OperationItem): void;
  reviewAndSelect?: boolean;
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
  const contentIssue = zhidaoContentIssue(draft.value);
  const save = () => {
    const complete = (saved: OperationItem) => {
      draft.clear();
      onSaved(saved);
    };
    if (reviewAndSelect)
      void action.run(
        "zhidao.item.review",
        { id: item.id, ...draft.value, confirmed: true },
        complete,
        "已审核并选中",
      );
    else
      void action.run(
        "zhidao.item.save",
        { id: item.id, ...draft.value, reviewed },
        complete,
        changed ? "修改已保存，请再次审核" : "审核状态已保存",
      );
  };
  return (
    <Dialog
      title={reviewAndSelect ? "审核并选择问答" : "编辑问答"}
      onClose={onClose}
      busy={!!action.pending}
      className="operation-edit-dialog"
      footer={
        <>
          <Button disabled={!!action.pending} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={
              !!action.pending ||
              !draft.value.name.trim() ||
              (reviewAndSelect && (!reviewed || !!contentIssue))
            }
            onClick={save}
          >
            {action.pending
              ? "正在保存…"
              : reviewAndSelect
                ? "审核并选中"
                : `保存${changed ? "修改" : reviewed ? "并确认审核" : ""}`}
          </Button>
        </>
      }
    >
      <Field label="结果名称">
        <input
          aria-label="结果名称"
          value={draft.value.name}
          disabled={!!action.pending}
          maxLength={200}
          onChange={(e) => draft.update({ name: e.target.value })}
        />
      </Field>
      <Field
        label="问题标题"
        hint={`当前${draft.value.question.trim().length}字；批量上传标题需不超过${zhidaoQuestionTitleLimit}字`}
      >
        <textarea
          aria-label="问题标题"
          rows={2}
          value={draft.value.question}
          disabled={!!action.pending}
          maxLength={5000}
          onChange={(e) => {
            draft.update({ question: e.target.value });
            setReviewed(false);
          }}
        />
      </Field>
      <Field label="回答内容" hint={`${draft.value.answer.length} / 25000字`}>
        <textarea
          aria-label="回答内容"
          rows={8}
          value={draft.value.answer}
          disabled={!!action.pending}
          maxLength={25000}
          onChange={(e) => {
            draft.update({ answer: e.target.value });
            setReviewed(false);
          }}
        />
      </Field>
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      <CheckboxField
        checked={reviewed}
        disabled={
          (!reviewAndSelect && changed) || !!contentIssue || !!action.pending
        }
        onChange={(e) => setReviewed(e.target.checked)}
        label="我已核对事实、链接与发布内容"
        hint={
          contentIssue
            ? `${contentIssue}，再确认审核。`
            : changed && !reviewAndSelect
              ? "保存修改后，可再次打开并确认审核。"
              : reviewAndSelect
                ? "确认后保存当前内容并选中此条问答；修改内容后需重新确认。"
                : "修改问题或回答后，需要重新确认审核。"
        }
      />
    </Dialog>
  );
}
