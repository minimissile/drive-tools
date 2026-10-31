import { useState } from "react";
import type { OperationItem } from "../../shared/zhidao";
import { Button, Field, Notice } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { useOperationAction } from "./hooks";
import "./operation-dialogs.css";

export function ResolveItemDialog({
  item,
  publication = false,
  onClose,
  onChanged,
}: {
  item: OperationItem;
  publication?: boolean;
  onClose(): void;
  onChanged(): void;
}) {
  const action = useOperationAction();
  const [remoteId, setRemoteId] = useState("");
  return (
    <Dialog
      title="核对平台提交结果"
      onClose={() => onClose()}
      busy={!!action.pending}
      footer={
        <>
          <Button disabled={!!action.pending} onClick={() => onClose()}>
            取消
          </Button>
          <Button
            disabled={!!action.pending}
            onClick={() =>
              void action.run(
                "zhidao.resolve",
                { id: item.id, outcome: "retry", confirmed: true },
                () => {
                  onClose();
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
                  id: item.id,
                  outcome: "submitted",
                  remoteId: remoteId.trim(),
                  confirmed: true,
                },
                () => {
                  onClose();
                  onChanged();
                },
                "已登记平台结果",
              )
            }
          >
            {action.pending === "zhidao.resolve" ? "正在登记…" : "登记已提交"}
          </Button>
        </>
      }
    >
      <p className="operation-dialog-description">
        {item.question || item.name}
      </p>
      <Notice warning>
        此请求的远端结果未知。请先打开平台核对，再登记结果；确认未提交后继续任务才会重试。
        {(item.uploadBatchSize ?? 0) > 1
          ? ` 本批共${item.uploadBatchSize}条问答，核对结果会同时应用于整批。`
          : ""}
      </Notice>
      <div>
        <Button
          disabled={!!action.pending}
          onClick={() =>
            publication
              ? void action.run("zhidao.publish.open", {
                  id: item.runId,
                })
              : item.questionId
                ? void action.run("zhidao.answer.open", {
                    id: item.id,
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
        label={item.questionId ? "平台回答ID" : "上传任务ID"}
        hint="确认平台已提交后，填写实际返回的ID。"
      >
        <input
          aria-label={
            item.questionId && !publication ? "平台回答ID" : "上传任务ID"
          }
          value={remoteId}
          onChange={(e) => setRemoteId(e.target.value)}
          maxLength={100}
          disabled={!!action.pending}
          placeholder="填写已核对的ID"
        />
      </Field>
    </Dialog>
  );
}
