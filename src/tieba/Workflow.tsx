import { useRef, useState } from "react";
import { z } from "zod";
import {
  tiebaAutocareConfigSchema,
  type TiebaAutocareSnapshot,
} from "../../shared/tieba-autocare";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import {
  Button,
  Header,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Switch } from "../ui/Switch";
import { TiebaTargets } from "./Targets";
import { TiebaTasks } from "./Tasks";
import { TiebaLogs } from "./Logs";
import { TiebaParticipation } from "./Participation";
import { TiebaAutomation } from "./Automation";
import { TiebaTopicComposer } from "./TopicComposer";
import { TiebaInsights } from "./Insights";
import {
  sameTiebaTargets,
  tiebaSelectionView,
  tiebaTime,
  tiebaAccountNeedsVerification,
} from "./view-model";
import type { FeedbackMessage } from "../lib/feedback";
import { tiebaBackendError } from "./useTiebaAction";
import { tiebaTargetRefreshFeedback } from "./console-view";
import "./tieba.css";
import "./console.css";

const draftSchema = z.object({
  config: tiebaAutocareConfigSchema,
  revision: z.number().int().positive(),
  baseTargetIds: z.array(z.string()).max(300),
});

export default function TiebaWorkflow() {
  const { navigate } = useAppNavigation();
  const query = useIpcQuery("tieba.autocare.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 3000,
  });
  const { data } = useAppData();
  const backendPending = /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(
    query.error,
  );
  return (
    <div className="tieba-autocare" data-testid="tieba-autocare">
      <Header
        title="贴吧自动养号"
        description="管理签到、回帖批次与主题创作，分别核对官网进度和发布可见性。"
        action={
          <Button quiet onClick={() => navigate("tieba-publishing")}>
            资源发帖与统计
          </Button>
        }
      />
      <QueryError
        error={
          backendPending
            ? "当前后台尚未加载贴吧自动养号，请点击顶部“应用更新并重启”，完成后重试读取。"
            : query.error
        }
        title={backendPending ? "贴吧功能等待应用更新" : undefined}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && !query.error ? (
        <LoadingState label="正在读取贴吧账号与签到计划…" />
      ) : null}
      {query.data ? (
        <TiebaControl
          key={data!.dataPath}
          snapshot={query.data}
          workspace={data!.dataPath}
          receive={query.setData}
          reload={query.reload}
          unavailable={!!query.error}
        />
      ) : null}
    </div>
  );
}

function TiebaControl({
  snapshot: s,
  workspace,
  receive,
  reload,
  unavailable,
}: {
  snapshot: TiebaAutocareSnapshot;
  workspace: string;
  receive(snapshot: TiebaAutocareSnapshot): void;
  reload(): void;
  unavailable: boolean;
}) {
  const { notify } = useAppActions(),
    { navigate } = useAppNavigation();
  const draft = useLocalDraft(
    `tieba-autocare-config:${workspace}`,
    {
      config: s.config,
      revision: s.revision,
      baseTargetIds: s.config.targetIds,
    },
    (value) => draftSchema.parse(value),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [replyRequest, setReplyRequest] = useState<{
    candidateId: string;
    requestId: string;
  } | null>(null);
  const [accountRefresh, setAccountRefresh] = useState(0);
  const lock = useRef(false);
  const { selected, changed, stale } = tiebaSelectionView(draft.value, s);
  const reset = () => {
    draft.clear();
    draft.update({
      config: s.config,
      revision: s.revision,
      baseTargetIds: s.config.targetIds,
    });
    setError("");
  };
  const action = async (
    work: () => Promise<TiebaAutocareSnapshot>,
    success: string | ((snapshot: TiebaAutocareSnapshot) => FeedbackMessage),
    preserveDraft = false,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await work();
      receive(result);
      if (preserveDraft && changed) {
        if (sameTiebaTargets(s.config.targetIds, result.config.targetIds))
          draft.update({
            revision: result.revision,
            baseTargetIds: result.config.targetIds,
          });
      } else {
        draft.clear();
        draft.update({
          config: result.config,
          revision: result.revision,
          baseTargetIds: result.config.targetIds,
        });
      }
      const feedback =
        typeof success === "string"
          ? { text: success, tone: "success" as const }
          : success(result);
      notify(feedback.text, feedback.tone);
    } catch (cause) {
      setError(
        tiebaBackendError(
          cause instanceof Error
            ? cause.message
            : "操作未完成，请重新读取状态后再试。",
        ),
      );
      reload();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const save = () => {
    if (stale)
      return Promise.reject(
        new Error("其他窗口已更新设置，请先恢复已保存设置，再重新选择目标。"),
      );
    return ipc("tieba.autocare.save", {
      config: draft.value.config,
      revision: s.revision,
    });
  };
  const toggle = (enabled: boolean) =>
    void action(
      async () => {
        let revision = s.revision;
        if (enabled && changed) revision = (await save()).revision;
        return ipc("tieba.autocare.toggle", {
          enabled,
          revision,
          confirmed: true,
        });
      },
      enabled
        ? "已开启自动签到，可在本轮计划查看具体安排"
        : "已停止新签到，已提交的结果继续核对",
      !enabled,
    );
  const names = new Map(
    s.accounts.map((account) => [
      account.id,
      account.alias || account.nickname || "贴吧账号",
    ]),
  );
  const disabled = busy || unavailable;
  return (
    <>
      <Panel className="tieba-master">
        <div className="tieba-master-status">
          <Status kind={s.busy || s.enabled ? "normal" : "warning"}>
            {s.busy
              ? s.enabled
                ? "正在执行"
                : "正在收尾"
              : s.enabled
                ? "已开启"
                : "已关闭"}
          </Status>
          <span>{s.message}</span>
          {s.run ? (
            <small>
              本轮 {tiebaTime(s.run.startedAt)} — {tiebaTime(s.run.deadlineAt)}{" "}
              · 北京时间
            </small>
          ) : (
            <small>开启后在2小时内安排，每个目标吧每日最多签到一次。</small>
          )}
        </div>
        <label className="tieba-power">
          自动签到
          <Switch
            checked={s.enabled}
            disabled={disabled || (!s.enabled && (!selected.length || stale))}
            onCheckedChange={toggle}
            aria-label="开启贴吧自动签到"
            data-testid="tieba-power"
          />
        </label>
      </Panel>
      {error ? <Notice danger>{error}</Notice> : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {stale ? (
        <Notice warning>
          其他窗口已更新设置，当前目标草案尚未应用。请先恢复已保存设置，再重新选择目标。
        </Notice>
      ) : null}
      <TiebaTargets
        snapshot={s}
        workspace={workspace}
        selected={selected}
        busy={disabled}
        changed={changed}
        stale={stale}
        onSelection={(targetIds) =>
          draft.update({
            config: { targetIds },
            revision: changed ? draft.value.revision : s.revision,
            baseTargetIds: changed
              ? draft.value.baseTargetIds
              : s.config.targetIds,
          })
        }
        onSync={(accountId) =>
          void action(
            () => ipc("tieba.autocare.sync", { accountId }),
            "关注吧已同步，新增贴吧默认未选",
            true,
          )
        }
        onPause={(target) =>
          void action(
            () =>
              ipc("tieba.autocare.pause", {
                targetId: target.id,
                paused: !target.paused,
                revision: s.revision,
              }),
            target.paused
              ? "该贴吧已恢复，未来任务按原范围安排"
              : "该贴吧已暂停，其他目标继续运行",
          )
        }
        onSave={() =>
          void action(
            save,
            s.enabled
              ? "目标设置已应用于未来任务"
              : "目标已保存，开启后自动安排签到",
          )
        }
        onReset={reset}
        onAccounts={() => navigate("website-accounts")}
        onObserved={receive}
        onReload={reload}
        onFollow={(target) =>
          void action(
            () =>
              ipc("tieba.autocare.follow", {
                targetId: target.id,
                revision: s.revision,
                confirmed: true,
              }),
            (result) => ({
              text:
                result.followResult?.message ??
                "关注结果尚未完整返回，请核对原目标。",
              tone:
                result.followResult?.status === "followed"
                  ? "success"
                  : result.followResult?.status === "failed"
                    ? "error"
                    : "warning",
            }),
            true,
          )
        }
        onVerifyAccount={(accountId) =>
          void action(
            async () => {
              const account = await ipc("websiteAccounts.check", {
                id: accountId,
              });
              if (tiebaAccountNeedsVerification(account) || !account.uid)
                throw new Error(
                  account.message ||
                    "账号登录尚未核实，请检查现有官网会话后再试。",
                );
              const snapshot = await ipc("tieba.autocare.snapshot");
              setAccountRefresh((value) => value + 1);
              return snapshot;
            },
            "账号身份已核实，可用目标与各面板状态已刷新",
            true,
          )
        }
        onRefreshProfiles={(targetIds) => {
          let feedback: FeedbackMessage = {
            text: "本次官网资料读取结果待核对。",
            tone: "warning",
          };
          void action(
            async () => {
              const result = await ipc("tieba.insights.refresh", {
                targetIds,
                publicationIds: [],
              });
              feedback = tiebaTargetRefreshFeedback(result, s.targets);
              try {
                const snapshot = await ipc("tieba.autocare.snapshot");
                setAccountRefresh((value) => value + 1);
                return snapshot;
              } catch (cause) {
                throw new Error(
                  `官网资料读取已返回，但本地列表刷新失败，请先重试读取状态，无需重复刷新官网。${cause instanceof Error ? cause.message : ""}`,
                );
              }
            },
            () => feedback,
            true,
          );
        }}
      />
      <TiebaTasks
        snapshot={s}
        workspace={workspace}
        busy={disabled}
        onReconcile={(taskId) =>
          void action(
            () => ipc("tieba.autocare.reconcile", { taskId }),
            "已完成原结果查询，请查看任务状态",
            true,
          )
        }
      />
      <TiebaAutomation
        workspace={workspace}
        refreshRevision={accountRefresh}
        openReply={(candidateId) =>
          setReplyRequest({ candidateId, requestId: crypto.randomUUID() })
        }
      />
      <TiebaParticipation
        workspace={workspace}
        autocare={s}
        request={replyRequest}
        onAccounts={() => navigate("website-accounts")}
        refreshRevision={accountRefresh}
      />
      <TiebaTopicComposer
        workspace={workspace}
        onAccounts={() => navigate("website-accounts")}
        refreshRevision={accountRefresh}
      />
      <TiebaInsights workspace={workspace} refreshRevision={accountRefresh} />
      <TiebaLogs logs={s.logs} workspace={workspace} names={names} />
    </>
  );
}
