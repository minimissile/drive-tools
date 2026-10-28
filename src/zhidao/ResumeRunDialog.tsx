import { useState } from "react";
import type { OperationRun } from "../../shared/zhidao";
import { operationLabels } from "../../shared/zhidao";
import { templateUsesAi } from "../../shared/zhidao-generation";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import { Button, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { useOperationAction } from "./hooks";
import "./operation-dialogs.css";

export function ResumeRunDialog({
  run,
  onClose,
  onResumed,
}: {
  run: OperationRun;
  onClose(): void;
  onResumed(): void;
}) {
  const action = useOperationAction();
  const [consent, setConsent] = useState(false);
  const { data } = useAppData();
  const { openSettings, navigate } = useAppNavigation();
  const accountId =
    typeof run.config.accountId === "string" ? run.config.accountId : "";
  const accounts = useIpcQuery("zhidao.accounts", undefined, {
    enabled: !!accountId,
  });
  const account = accounts.data?.find((entry) => entry.id === accountId);
  const missingAccount = !!accountId && !!accounts.data && !account;
  const aiIssue =
    run.kind !== "answer" &&
    !(run.kind === "template" && templateUsesAi(run.config))
      ? ""
      : !data!.settings.openrouterConfigured
        ? "请先保存 OpenRouter API Key，再继续任务。"
        : !data!.settings.aiModels.copy
          ? "请先选择文案创作模型并保存设置，再继续任务。"
          : "";
  const automatic = run.kind === "answer" && run.config.mode === "auto";
  const webCollection =
    run.kind === "collect" &&
    (run.config.haisou === true || run.config.pansoo === true);
  return (
    <Dialog
      title={
        run.kind === "answer"
          ? "继续答题任务"
          : run.kind === "publish"
            ? "继续发布任务"
            : `继续${operationLabels[run.kind]}任务`
      }
      onClose={onClose}
      busy={!!action.pending}
      footer={
        <>
          <Button disabled={!!action.pending} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={
              !consent ||
              !!action.pending ||
              !!aiIssue ||
              missingAccount ||
              (!!accountId && (!accounts.data || !!accounts.error))
            }
            onClick={() =>
              void action.run(
                "zhidao.resume",
                {
                  id: run.id,
                  authorized: true,
                },
                () => {
                  onClose();
                  onResumed();
                },
                "任务已继续",
              )
            }
          >
            {action.pending ? "正在继续…" : "确认继续"}
          </Button>
        </>
      }
    >
      <dl className="operation-resume-summary">
        <div className="operation-summary-title">
          <dt>任务</dt>
          <dd>{run.title}</dd>
        </div>
        {accountId ? (
          <div>
            <dt>账号</dt>
            <dd>
              {account?.alias ??
                (missingAccount
                  ? "原账号已移除"
                  : accounts.error
                    ? "账号暂未读取"
                    : "正在读取账号…")}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{automatic ? "已提交" : "已完成"}</dt>
          <dd>
            {run.done} / {run.total}
          </dd>
        </div>
        {automatic && typeof run.config.style === "string" ? (
          <div>
            <dt>回答风格</dt>
            <dd>{run.config.style}</dd>
          </div>
        ) : null}
      </dl>
      <QueryError
        error={accounts.error}
        loading={accounts.loading}
        onRetry={accounts.reload}
      />
      {missingAccount ? (
        <Notice warning>
          请先在账号管理中恢复任务绑定的账号，再继续此任务。
          <Button
            quiet
            onClick={() => {
              onClose();
              navigate("zhidao-accounts");
            }}
          >
            管理知道账号
          </Button>
        </Notice>
      ) : null}
      {aiIssue ? (
        <Notice warning>
          {aiIssue}
          <Button
            quiet
            onClick={() => {
              onClose();
              openSettings("ai");
            }}
          >
            配置 AI 连接与模型
          </Button>
        </Notice>
      ) : null}
      <Notice>
        {webCollection
          ? "将从保存的网页采集进度继续，复用已读取的搜索页。原站要求登录、安全验证或提示请求频繁时，请先在原站处理或稍后继续。"
          : run.kind === "publish"
            ? "将从已保存进度继续上传到绑定账号。已提交批次不会重传；结果未知的批次需先核对，本操作不会调用 AI 生成内容。"
            : automatic
              ? "将从已保存进度继续，可能产生新的 AI 费用并向绑定账号提交内容。已提交记录会保留，结果未知的条目需先人工核对。"
              : run.kind === "template" && !templateUsesAi(run.config)
                ? "将跳过已生成的问答，仅整理未完成的资料。不调用AI，也不会自动上传。"
                : run.kind === "answer" || run.kind === "template"
                  ? "将从已保存进度继续生成，可能产生新的 AI 费用。已生成的结果会保留。"
                  : "将从已保存进度继续。已有结果会保留，已授权的 AI 操作可能产生新的费用。"}
      </Notice>
      <CheckboxField
        checked={consent}
        onChange={(event) => setConsent(event.target.checked)}
        disabled={!!action.pending}
        label={
          webCollection
            ? "我已核对任务和网页采集来源"
            : "我已核对账号、任务内容和已提交结果"
        }
        hint="仅授权继续上方这一个任务，本次勾选不会保存。"
      />
    </Dialog>
  );
}
