import { useEffect, useState } from "react";
import { Download, Eye, Send } from "lucide-react";
import { z } from "zod";
import { zhidaoAccountLabel, type OperationRun } from "../../shared/zhidao";
import {
  zhidaoPublishLimit,
  zhidaoTaskNameLimit,
} from "../../shared/zhidao-publishing";
import {
  publishingSelectionRevision,
  publishingTaskName,
  publishingLinkTypeSchema,
  type PublishingLinkType,
  type PublishingDestination,
  type PublishingRecord,
} from "../../shared/zhidao-workflow";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData, useAppNavigation } from "../state";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { useOperationAction } from "./hooks";
import { PublishAudit } from "./PublishAudit";

export function PublishingSubmit({
  records,
  ready,
  onPreview,
  onChanged,
  onShowRun,
}: {
  records: PublishingRecord[];
  ready: boolean;
  onPreview(destination?: PublishingDestination): void;
  onChanged(): void;
  onShowRun(run: OperationRun): void;
}) {
  const { data } = useAppData(),
    { navigate } = useAppNavigation();
  const action = useOperationAction();
  const [error, setError] = useState(""),
    [download, setDownload] = useState(""),
    [submitted, setSubmitted] = useState("");
  const ids = records.map((record) => record.id),
    total = records.reduce((n, record) => n + record.rows.length, 0);
  const signature = ids.join(",");
  const defaultTaskName = publishingTaskName(
    records.map((record) => record.resource.title),
  );
  const draft = useLocalDraft(
    `panxu-workflow-publish:${data!.dataPath}`,
    {
      accountId: "",
      taskName: defaultTaskName,
      taskNameEdited: false,
      batchKey: signature,
      linkType: "drive" as PublishingLinkType,
    },
    (raw) => {
      const parsed = z
        .object({
          accountId: z.string(),
          taskName: z.string().max(15),
          taskNameEdited: z.boolean().optional(),
          batchKey: z.string().default(""),
          linkType: publishingLinkTypeSchema.default("drive"),
        })
        .parse(raw);
      return {
        ...parsed,
        taskNameEdited: parsed.taskNameEdited ?? parsed.taskName !== "问答发布",
      };
    },
  );
  const accounts = useIpcQuery("zhidao.accounts", undefined, {
    keepPrevious: true,
  });
  const runId =
    records.find((record) => record.publicationRunId)?.publicationRunId ||
    submitted;
  const mixedRuns =
    records.some((record) => record.publicationRunId) &&
    (records.some((record) => !record.publicationRunId) ||
      new Set(records.map((record) => record.publicationRunId)).size > 1);
  const run = useIpcQuery(
    "zhidao.run",
    { id: runId, page: 1 },
    { enabled: !!runId, refreshInterval: 2500, keepPrevious: true },
  );
  const currentRun = run.data?.run.id === runId ? run.data.run : undefined;
  const linkOptions = useIpcQuery(
    "zhidao.workflow.linkOptions",
    { ids },
    { enabled: total === 1 && !runId },
  );
  const linkType: PublishingLinkType =
    total === 1
      ? ((currentRun?.config.workflowLinkType as
          PublishingLinkType | undefined) ?? draft.value.linkType)
      : "drive";
  const publicUrl =
    linkType === "landing"
      ? linkOptions.data?.landingUrl
      : linkOptions.data?.redirectUrl;
  const destination: PublishingDestination | undefined =
    linkType === "drive"
      ? undefined
      : {
          type: linkType,
          url:
            (currentRun?.config.workflowLinkUrl as string | undefined) ??
            publicUrl ??
            "",
          revision:
            (currentRun?.config.workflowLinkRevision as string | undefined) ??
            linkOptions.data?.revision ??
            "",
        };
  const linkIssue =
    linkType === "drive" || !!runId
      ? ""
      : linkOptions.error
        ? "无法读取资源入口，请重试。"
        : !linkOptions.data
          ? "正在读取资源入口…"
          : (linkType === "landing"
              ? linkOptions.data.landingIssue
              : linkOptions.data.redirectIssue) ||
            (!publicUrl ? "资源入口尚未就绪，请在资源库维护。" : "");
  const account = accounts.data?.find(
      (account) => account.id === draft.value.accountId,
    ),
    rights = account?.publishingRights;
  const busy = !!action.pending || currentRun?.status === "running";
  useEffect(() => {
    setSubmitted("");
    setDownload("");
    setError("");
  }, [signature]);
  useEffect(() => {
    if (draft.value.batchKey !== signature) {
      draft.update(
        !draft.value.batchKey && draft.value.taskNameEdited
          ? { batchKey: signature }
          : {
              batchKey: signature,
              taskName: defaultTaskName,
              taskNameEdited: false,
              linkType: "drive",
            },
      );
    } else if (
      !draft.value.taskNameEdited &&
      draft.value.taskName !== defaultTaskName
    )
      draft.update({ taskName: defaultTaskName });
  }, [
    signature,
    defaultTaskName,
    draft.value.batchKey,
    draft.value.taskNameEdited,
    draft.value.taskName,
    draft.update,
  ]);
  useEffect(() => {
    if (!draft.value.accountId && accounts.data?.length === 1)
      draft.update({ accountId: accounts.data[0].id });
  }, [accounts.data, draft.value.accountId, draft.update]);
  const issue =
    linkIssue ||
    (!ready
      ? "请先确认全部问答并准备独立链接。"
      : total > zhidaoPublishLimit
        ? `单批最多上传${zhidaoPublishLimit}条问答，请减少本批资源后上传。`
        : !account
          ? "请选择百度知道发布账号。"
          : account.status !== "connected" || account.bulkPermission !== true
            ? "请刷新账号资格，确认登录和批量上传权限。"
            : rights?.isBanned
              ? "此账号的批量上传权益受限，请核对账号。"
              : rights?.remainingQuota != null && rights.remainingQuota < total
                ? `剩余额度${rights.remainingQuota}条，不足以上传${total}条问答。`
                : "");
  const nameInvalid =
    !draft.value.taskName.trim() ||
    draft.value.taskName.trim().length > zhidaoTaskNameLimit;
  return (
    <Panel title="上传问答表格">
      <p className="publishing-help">
        {records.length}份资源 · {total}条已确认问答 ·
        每条一个独立链接。上传后仍需等待百度审核。
      </p>
      <QueryError
        error={accounts.error}
        loading={accounts.loading}
        onRetry={accounts.reload}
        title="无法读取发布账号"
      />
      {!runId ? (
        <>
          <div className="operations-form-grid">
            <Field label="百度知道发布账号">
              <Select
                value={draft.value.accountId}
                disabled={busy || !accounts.data}
                onValueChange={(accountId) => {
                  draft.update({ accountId });
                  setError("");
                }}
                items={[
                  { value: "", label: "选择百度知道账号" },
                  ...(draft.value.accountId && !account
                    ? [
                        {
                          value: draft.value.accountId,
                          label: "原账号不可用，请重新选择",
                          disabled: true,
                        },
                      ]
                    : []),
                  ...(accounts.data ?? []).map((account) => ({
                    value: account.id,
                    label: zhidaoAccountLabel(account),
                  })),
                ]}
              />
            </Field>
            <Field
              label="任务名称"
              hint={`${draft.value.taskName.length} / 15字`}
            >
              <input
                aria-label="任务名称"
                value={draft.value.taskName}
                maxLength={15}
                disabled={busy}
                onChange={(e) =>
                  draft.update({
                    taskName: e.target.value,
                    taskNameEdited: true,
                  })
                }
              />
            </Field>
          </div>
          {total === 1 ? (
            <div className="publishing-link-type">
              <Field label="回答中的链接">
                <Select
                  value={linkType}
                  disabled={busy}
                  onValueChange={(value) => {
                    draft.update({ linkType: value as PublishingLinkType });
                    setError("");
                    setDownload("");
                  }}
                  items={[
                    { value: "drive", label: "网盘直链" },
                    { value: "landing", label: "资源落地页" },
                    { value: "redirect", label: "直达链接" },
                  ]}
                />
              </Field>
              <div className="publishing-help">
                {linkType === "drive"
                  ? "使用已准备的百度网盘分享链接。"
                  : destination?.url ||
                    (linkType === "landing"
                      ? "使用资源库中已发布的资源落地页。"
                      : "使用资源库中已同步的固定直达链接。")}
                {linkType !== "drive" ? (
                  <span>
                    预览、下载与上传均使用此入口；不会新建或发布落地页。
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="publishing-help">
              多条问答使用网盘独立链接；仅单个问答可选择落地页或直达链接。
            </p>
          )}
          {linkType !== "drive" ? (
            <QueryError
              error={linkOptions.error}
              loading={linkOptions.loading}
              onRetry={linkOptions.reload}
              title="无法读取资源入口"
            />
          ) : null}
          <div className="publish-account-status">
            <div>
              <strong>
                {account?.bulkPermission ? "可批量上传" : "资格待确认"}
              </strong>
              <span>
                剩余额度{" "}
                {rights?.remainingQuota == null
                  ? "待查询"
                  : `${rights.remainingQuota.toLocaleString()}条`}
              </span>
              <small>上传前会再次核对身份和额度</small>
            </div>
            <Button
              size="compact"
              disabled={busy || !account}
              onClick={() => {
                setError("");
                void action.run(
                  "zhidao.account.check",
                  { id: account!.id },
                  accounts.reload,
                  undefined,
                  (error) => setError(error.message),
                );
              }}
            >
              刷新资格与额度
            </Button>
          </div>
          {!accounts.error &&
          !(linkType !== "drive" && linkOptions.error) &&
          (error || issue || nameInvalid) ? (
            <Notice warning>
              {error || issue || "任务名称需填写1–15字。"}
              {linkType !== "drive" &&
              linkIssue &&
              !linkOptions.error &&
              linkOptions.data ? (
                <Button
                  quiet
                  size="compact"
                  onClick={() => navigate("library")}
                >
                  去资源库维护入口
                </Button>
              ) : null}
            </Notice>
          ) : null}
          <div className="publishing-review-actions">
            <Button
              primary
              disabled={
                busy ||
                !!issue ||
                nameInvalid ||
                !!accounts.error ||
                !accounts.data
              }
              onClick={() => {
                setError("");
                void action.run(
                  "zhidao.workflow.publish",
                  {
                    ids,
                    accountId: draft.value.accountId,
                    taskName: draft.value.taskName.trim(),
                    selectionRevision: publishingSelectionRevision(records),
                    linkType,
                    linkRevision: destination?.revision,
                    authorized: true,
                  },
                  (run) => {
                    setSubmitted(run.id);
                    onChanged();
                  },
                  undefined,
                  (error) => setError(error.message),
                );
              }}
            >
              <Send size={15} />
              {action.pending === "zhidao.workflow.publish"
                ? "正在创建上传任务…"
                : `上传${total}条问答`}
            </Button>
            <Button
              disabled={busy || !ready || !!linkIssue}
              onClick={() => onPreview(destination)}
            >
              <Eye size={15} />
              预览完整问答
            </Button>
            <Button
              quiet
              disabled={busy || !ready || !!linkIssue}
              onClick={() =>
                void action.run(
                  "zhidao.workflow.export",
                  { ids, linkType, linkRevision: destination?.revision },
                  (path) => {
                    if (path) setDownload(path);
                  },
                )
              }
            >
              <Download size={15} />
              下载已审核表格
            </Button>
          </div>
          <p className="publishing-help">
            点击上传即使用
            {account ? `「${zhidaoAccountLabel(account)}」` : "所选账号"}
            真实提交本批问答，自动生成Excel，无需下载后重新选择文件。
          </p>
        </>
      ) : (
        <>
          {mixedRuns ? (
            <Notice warning>
              本批包含已有发布任务的资源。请先查看原发布记录，再返回录入步骤移除已上传资源，单独提交其余资源。
            </Notice>
          ) : null}
          <QueryError
            error={run.error}
            loading={run.loading}
            onRetry={run.reload}
            title="无法读取上传任务，原任务仍保留"
          />
          {currentRun ? (
            <>
              <div className="publish-account-status">
                <div>
                  <Status
                    kind={
                      currentRun.status === "completed"
                        ? "good"
                        : currentRun.status === "running"
                          ? "normal"
                          : "warning"
                    }
                  >
                    {currentRun.status === "completed"
                      ? "上传已完成"
                      : currentRun.status === "running"
                        ? "正在上传"
                        : "上传任务待处理"}
                  </Status>
                  <strong>{currentRun.title}</strong>
                  <span>
                    {currentRun.done} / {currentRun.total}条已提交
                  </span>
                  <span>
                    {zhidaoAccountLabel(
                      accounts.data?.find(
                        (a) => a.id === currentRun.config.accountId,
                      ) ?? { alias: "原发布账号", nickname: "" },
                    )}
                  </span>
                </div>
              </div>
              <p className="publishing-help" role="status">
                {currentRun.message}
              </p>
              <PublishAudit run={currentRun} onChanged={run.reload} />
              <div className="publishing-review-actions">
                <Button onClick={() => onShowRun(currentRun)}>
                  查看发布记录与处理异常
                </Button>
                <Button quiet onClick={() => onPreview(destination)}>
                  预览完整问答
                </Button>
              </div>
            </>
          ) : !run.error ? (
            <p className="publishing-help" role="status">
              正在读取已保存的上传任务，不会重复提交…
            </p>
          ) : null}
        </>
      )}
      {download ? <Notice>表格已保存：{download}</Notice> : null}
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
    </Panel>
  );
}
