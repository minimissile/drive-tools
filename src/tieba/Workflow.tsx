import { selectedTiebaActions } from "../../shared/tieba-actions";
import { TiebaCareSetup } from "./CareSetup";
import { Dialog } from "../ui/Dialog";
import { tiebaAccountName } from "./account-label";
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
import { Button, Header, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
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
  tiebaAccountNeedsVerification,
} from "./view-model";
import type { FeedbackMessage } from "../lib/feedback";
import { tiebaBackendError } from "./useTiebaAction";
import { tiebaTargetRefreshFeedback } from "./console-view";
import "./tieba.css";
import "./console.css";

const draftSchema = z.object({
  config: tiebaAutocareConfigSchema.extend({
    actions: z
      .array(z.enum(["checkin", "like"]))
      .max(2)
      .optional(),
  }),
  baseActions: z
    .array(z.enum(["checkin", "like"]))
    .max(2)
    .optional(),
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
        description="选择账号与操作，一键开始；进度和异常统一查看。"
        action={
          <div className="row">
            <Button quiet onClick={() => navigate("tieba-publishing")}>
              资源发帖与统计
            </Button>
            <Button quiet onClick={() => navigate("tieba-analysis")}>
              数据分析
            </Button>
          </div>
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
      baseActions: selectedTiebaActions(s.config),
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
  const targetView = tiebaSelectionView(draft.value, s);
  const ownActions = selectedTiebaActions(draft.value.config);
  const baseActions = draft.value.baseActions ?? ["checkin"];
  const actionsEdited =
    ownActions.length !== baseActions.length ||
    ownActions.some((value) => !baseActions.includes(value));
  const chosenActions = actionsEdited
    ? ownActions
    : selectedTiebaActions(s.config);
  const actionsChanged =
    chosenActions.length !== selectedTiebaActions(s.config).length ||
    chosenActions.some(
      (value) => !selectedTiebaActions(s.config).includes(value),
    );
  const selected = targetView.selected,
    changed = targetView.changed || actionsChanged,
    stale =
      targetView.stale ||
      (actionsChanged && draft.value.revision !== s.revision);
  const [manage, setManage] = useState(false);

  const reset = () => {
    draft.clear();
    draft.update({
      config: s.config,
      revision: s.revision,
      baseTargetIds: s.config.targetIds,
      baseActions: selectedTiebaActions(s.config),
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
            baseActions: selectedTiebaActions(result.config),
          });
      } else {
        draft.clear();
        draft.update({
          config: result.config,
          revision: result.revision,
          baseTargetIds: result.config.targetIds,
          baseActions: selectedTiebaActions(result.config),
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
      config: { targetIds: selected, actions: chosenActions },
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
        : "已停止新操作，已提交的结果继续核对",
      !enabled,
    );
  const names = new Map(
    s.accounts.map((account) => [account.id, tiebaAccountName(account)]),
  );
  const disabled = busy || unavailable;
  return (
    <>
      <TiebaCareSetup
        snapshot={s}
        selected={selected}
        actions={chosenActions}
        busy={disabled}
        stale={stale}
        onSelection={(targetIds) =>
          draft.update({
            config: { targetIds, actions: chosenActions },
            revision: changed ? draft.value.revision : s.revision,
            baseTargetIds: changed
              ? draft.value.baseTargetIds
              : s.config.targetIds,
            baseActions: changed
              ? draft.value.baseActions
              : selectedTiebaActions(s.config),
          })
        }
        onActions={(actions) =>
          draft.update({
            config: { targetIds: selected, actions },
            revision: changed ? draft.value.revision : s.revision,
            baseTargetIds: changed
              ? draft.value.baseTargetIds
              : s.config.targetIds,
            baseActions: changed
              ? draft.value.baseActions
              : selectedTiebaActions(s.config),
          })
        }
        onApply={() =>
          void action(
            () =>
              ipc("tieba.autocare.apply", {
                config: { targetIds: selected, actions: chosenActions },
                revision: s.revision,
                confirmed: true,
              }),
            "所选操作已保存，自动化已开启",
          )
        }
        onStop={() => toggle(false)}
        onManage={() => setManage(true)}
        onAccounts={() => navigate("website-accounts")}
        onSync={() =>
          void action(
            async () => {
              let latest = s;
              for (const account of s.accounts)
                latest = await ipc("tieba.autocare.sync", {
                  accountId: account.id,
                });
              return latest;
            },
            "账号与关注贴吧已同步，请选择参与的账号",
            true,
          )
        }
      />
      {error ? <Notice danger>{error}</Notice> : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {stale ? (
        <Notice warning>
          其他窗口已更新设置，当前选择尚未应用。
          <Button quiet size="compact" onClick={reset}>
            恢复已保存设置
          </Button>
        </Notice>
      ) : null}
      {manage ? (
        <Dialog
          onClose={() => setManage(false)}
          title="管理参与自动化的贴吧"
          className="tieba-manage-dialog"
          footer={
            <Button primary onClick={() => setManage(false)}>
              完成选择
            </Button>
          }
        >
          <TiebaTargets
            selectionOnly
            snapshot={s}
            workspace={workspace}
            selected={selected}
            busy={disabled}
            changed={changed}
            stale={stale}
            onSelection={(targetIds) =>
              draft.update({
                config: { targetIds, actions: chosenActions },
                revision: changed ? draft.value.revision : s.revision,
                baseTargetIds: changed
                  ? draft.value.baseTargetIds
                  : s.config.targetIds,
                baseActions: changed
                  ? draft.value.baseActions
                  : selectedTiebaActions(s.config),
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
        </Dialog>
      ) : null}
      <details className="tieba-care-details">
        <summary>查看任务与历史</summary>
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
      </details>
      <TiebaLogs logs={s.logs} workspace={workspace} names={names} />
      <details className="tieba-care-details">
        <summary>回帖、发帖与数据工具</summary>
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
      </details>
    </>
  );
}
