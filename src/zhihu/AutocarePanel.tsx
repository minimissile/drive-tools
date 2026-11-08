import { useRef, useState } from "react";
import { z } from "zod";
import {
  autocareConfigSchema,
  type AutocareConfig,
  type AutocareSnapshot,
} from "../../shared/zhihu-autocare";
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
import { Switch } from "../ui/Switch";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import { ZhihuCreatorProgress } from "./CreatorProgress";
import { AutocareParticipation } from "./AutocareParticipation";
import { AutocareLogs } from "./AutocareLogs";
import { AutocareSettings } from "./AutocareSettings";
import { AutocareAgenda } from "./AutocareAgenda";
import { getAutocareRunView } from "./autocare-agenda";
import type { ZhihuAdvancedTab } from "./Workflow";
import "./autocare.css";
export default function AutocarePanel({
  openAdvanced,
}: {
  openAdvanced(tab?: ZhihuAdvancedTab): void;
}) {
  const q = useIpcQuery("zhihu.autocare.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 3000,
  });
  const { data } = useAppData();
  return (
    <div className="autocare">
      <Header
        title="知乎自动养号"
        description="启动后2小时内自动安排任务，在这里查看截止时间、下一步与运行结果。"
        action={
          <Button size="compact" onClick={() => openAdvanced()}>
            历史与高级功能
          </Button>
        }
      />
      <QueryError error={q.error} loading={q.loading} onRetry={q.reload} />
      {!q.data && !q.error ? (
        <LoadingState label="正在读取养号设置与账号…" />
      ) : null}
      {q.data ? (
        <AutocareControl
          key={q.data.revision}
          snapshot={q.data}
          workspace={data!.dataPath}
          reload={q.reload}
          receiveSnapshot={q.setData}
          openAdvanced={openAdvanced}
        />
      ) : null}
    </div>
  );
}
function AutocareControl({
  snapshot: s,
  workspace,
  reload,
  receiveSnapshot,
  openAdvanced,
}: {
  snapshot: AutocareSnapshot;
  workspace: string;
  reload(): void;
  receiveSnapshot(snapshot: AutocareSnapshot): void;
  openAdvanced(tab?: ZhihuAdvancedTab): void;
}) {
  const { notify } = useAppActions(),
    { navigate, openSettings } = useAppNavigation();
  const draft = useLocalDraft(
    `zhihu-autocare-config:${workspace}`,
    { config: s.config, revision: s.revision },
    (v) =>
      z
        .object({ config: autocareConfigSchema, revision: z.number().int() })
        .parse(v),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const cfg = draft.value.config,
    stale = draft.value.revision !== s.revision;
  const savedConfig = autocareConfigSchema.parse(s.config);
  const run = getAutocareRunView(s);
  const changed = Object.entries(savedConfig).some(
    ([key, value]) =>
      JSON.stringify(cfg[key as keyof AutocareConfig] ?? value) !==
      JSON.stringify(value),
  );
  const requiresBackendUpdate =
    !run.supported ||
    (!s.todayPlan &&
      JSON.stringify(cfg.accountTargets ?? {}) !==
        JSON.stringify(s.config.accountTargets ?? {}));
  const saveConfig = (revision: number) => {
    if (requiresBackendUpdate)
      return Promise.reject(
        new Error(
          "两小时方案尚未加载，请先点击顶部“应用更新并重启”，再保存草案。",
        ),
      );
    return ipc("zhihu.autocare.save", { config: cfg, revision });
  };
  const update = (patch: Partial<AutocareConfig>) =>
    draft.update({ config: { ...cfg, ...patch } });
  const action = async (
    fn: () => Promise<AutocareSnapshot>,
    message: string,
    preserveDraft = false,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      receiveSnapshot(result);
      if (!preserveDraft) draft.clear();
      draft.update({
        config: preserveDraft ? cfg : result.config,
        revision: result.revision,
      });
      notify(message, "success");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成，请重试");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const toggle = (enabled: boolean) =>
    void action(
      async () => {
        if (enabled && !run.supported)
          throw new Error("请先应用后端更新，再开启启动后2小时的养号方案。");
        let revision = s.revision;
        if (enabled && changed) {
          const saved = await saveConfig(revision);
          revision = saved.revision;
        }
        return ipc("zhihu.autocare.toggle", {
          enabled,
          revision,
          confirmed: true,
        });
      },
      enabled
        ? "本轮已启动，任务将在启动后2小时内按排期执行"
        : "已停止新任务；已提交的任务继续核对结果",
      !enabled,
    );
  const blockedAccountIds = new Set(
    s.blockers
      ? s.blockers
          .filter((entry) => entry.blocking)
          .map((entry) => entry.accountId)
      : s.blockedAccountIds,
  );
  const latest = s.jobs.filter(
    (j) =>
      s.config.accountIds.includes(j.accountId) &&
      (j.kind === "answer" ? s.config.answerRecommended : s.config.publish) &&
      ["queued", "ready", "collecting", "generating"].includes(j.status),
  );
  const next =
    s.enabled && run.supported && !run.ended && !!run.startedAt
      ? [
          ...latest
            .filter((j) => j.scheduledAt && !blockedAccountIds.has(j.accountId))
            .map((j) => j.scheduledAt!),
          ...Object.entries(s.cycles)
            .filter(
              ([id]) =>
                s.config.accountIds.includes(id) && !blockedAccountIds.has(id),
            )
            .map(([, c]) => c.at),
        ]
          .filter(
            (at) =>
              !run.deadlineAt || Date.parse(at) < Date.parse(run.deadlineAt),
          )
          .sort()[0]
      : undefined;
  const blockedCount = s.config.accountIds.filter((id) =>
    blockedAccountIds.has(id),
  ).length;
  const needsAttention =
    (!s.blockers && s.needsAttention) ||
    (s.config.accountIds.length > 0 &&
      blockedCount === s.config.accountIds.length);
  const statusMessage = !run.supported
    ? "当前为旧版安排，两小时方案待应用后端更新"
    : run.ended && !s.busy
      ? "本轮已结束，未完成项目不会延长到全天执行"
      : s.busy
        ? s.message
        : !s.enabled
          ? s.message
          : needsAttention
            ? "账号任务暂停，处理下方原因后重新检查安排"
            : next
              ? `下一项安排 ${formatTime(next)}`
              : "暂无可执行安排，请检查下方原因";
  const settings = (
    <AutocareSettings
      snapshot={s}
      config={cfg}
      update={update}
      disabled={busy || s.busy || stale}
      changed={changed}
      onSave={() =>
        void action(
          () => saveConfig(s.revision),
          s.enabled
            ? "设置已应用于本轮未执行安排，截止时间不延长"
            : "设置已保存，开启后按2小时窗口安排",
        )
      }
      onReset={() => draft.update({ config: s.config, revision: s.revision })}
      onManageAccounts={() => navigate("website-accounts")}
      openSettings={openSettings}
    />
  );
  const published = s.jobs.filter((j) => j.status === "published" && j.url);
  const names = new Map(s.accounts.map((a) => [a.id, a.nickname || a.alias]));
  return (
    <>
      <Panel className="autocare-master">
        <div>
          <Status
            kind={
              !run.supported
                ? "warning"
                : s.enabled
                  ? needsAttention
                    ? "warning"
                    : blockedCount
                      ? "warning"
                      : "good"
                  : s.message.includes("待核") || s.message.includes("变化")
                    ? "warning"
                    : "normal"
            }
          >
            {!run.supported
              ? "待应用更新"
              : run.ended && !s.busy
                ? "本轮已结束"
                : s.enabled
                  ? needsAttention
                    ? "需要处理"
                    : s.busy
                      ? "正在处理"
                      : blockedCount
                        ? "部分需处理"
                        : "等待执行"
                  : s.busy
                    ? "正在收尾"
                    : "已关闭"}
          </Status>
          <strong>{statusMessage}</strong>
          {run.startedAt && run.deadlineAt ? (
            <small>
              开始 {formatTime(run.startedAt)} · 截止{" "}
              {formatTime(run.deadlineAt)}
            </small>
          ) : null}
          {s.lastHeartbeatAt ? (
            <small>最近检查 {formatTime(s.lastHeartbeatAt)}</small>
          ) : null}
        </div>
        <div className="autocare-master-controls">
          {s.enabled ? (
            <Button
              size="compact"
              disabled={
                busy ||
                s.busy ||
                stale ||
                changed ||
                !s.todayPlan ||
                !run.supported ||
                run.ended
              }
              title={
                !s.todayPlan
                  ? "应用后端更新后可用"
                  : "检查本地状态并补齐未执行安排"
              }
              onClick={() =>
                void action(
                  () => ipc("zhihu.autocare.recheck", { revision: s.revision }),
                  "已重新检查本地状态与未执行安排",
                )
              }
            >
              重新检查安排
            </Button>
          ) : null}
          <label className="autocare-power">
            <span>自动养号</span>
            <Switch
              aria-label="自动养号总开关"
              checked={s.enabled}
              disabled={
                busy ||
                (!s.enabled &&
                  (s.busy ||
                    !run.supported ||
                    stale ||
                    !cfg.accountIds.length ||
                    !(
                      cfg.publish ||
                      cfg.answerRecommended ||
                      cfg.readRecommended ||
                      cfg.likeCandidates ||
                      cfg.randomLikes ||
                      cfg.randomComments ||
                      cfg.followCandidates
                    )))
              }
              onCheckedChange={toggle}
            />
          </label>
        </div>
      </Panel>
      {error ? <Notice danger>{error}</Notice> : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {requiresBackendUpdate ? (
        <Notice warning>
          应用顶部更新后，数量自动调整为发布3、回答2、读取4、互动4，并采用启动后2小时方案；已消耗额度保留。
        </Notice>
      ) : null}
      {stale ? (
        <Notice warning>
          设置已在其他窗口更新。
          <Button
            size="compact"
            onClick={() =>
              draft.update({ config: s.config, revision: s.revision })
            }
          >
            载入最新设置
          </Button>
        </Notice>
      ) : null}
      {!s.enabled ? settings : null}
      <AutocareAgenda
        snapshot={s}
        onOpenTasks={() => openAdvanced("tasks")}
        onOpenParticipation={() => openAdvanced("participation")}
        onManageAccount={() => navigate("website-accounts")}
      />
      <AutocareLogs names={names} />
      {s.enabled ? settings : null}
      <details className="panel autocare-history">
        <summary>
          账号创作分与发布历史{" "}
          <span className="muted">累计发布 {published.length} 篇</span>
        </summary>
        <div className="autocare-history-content">
          <div className="autocare-overview">
            <span>
              本模式累计发布 <strong>{published.length}</strong> 篇
            </span>
            <span>
              官方曝光 / 浏览 <strong>暂不可获取</strong>
            </span>
            <span>
              随机点赞：{s.config.randomLikes ? "已启用" : "未启用"} ·
              随机评论：
              {s.config.randomComments ? "已启用" : "未启用"}
            </span>
            <Button quiet size="compact" onClick={() => openAdvanced("tasks")}>
              文章与任务详情
            </Button>
          </div>
          <div className="autocare-status-list">
            {s.accounts
              .filter((a) => s.config.accountIds.includes(a.id))
              .map((a) => (
                <div className="autocare-account-status" key={a.id}>
                  <div>
                    <strong>{a.nickname || a.alias}</strong>
                    <small>
                      {s.accountMessages[a.id] ||
                        "开启后先安排计划，到时再核对账号和素材"}
                    </small>
                    <small>
                      今日已尝试 {a.today} / 有效上限{" "}
                      {Math.min(a.plan.dailyLimit, s.config.dailyLimit)} · 本周{" "}
                      {a.week} /{" "}
                      {Math.min(a.plan.weeklyLimit, s.config.weeklyLimit)}
                    </small>
                  </div>
                  <ZhihuCreatorProgress
                    progress={a.plan.progress}
                    targetLevel={s.config.targetLevel}
                  />
                </div>
              ))}
          </div>
          {published.length ? (
            <div className="autocare-receipts">
              {published
                .slice(-3)
                .reverse()
                .map((j) => (
                  <Button
                    key={j.id}
                    size="compact"
                    onClick={() => void ipc("system.external", { url: j.url! })}
                  >
                    {names.get(j.accountId)} · 查看已发布
                    {j.kind === "answer" ? "回答" : "文章"}
                  </Button>
                ))}
            </div>
          ) : null}
          {s.jobs.some(
            (j) => j.status === "attention" || j.status === "skipped",
          ) ? (
            <details className="autocare-more">
              <summary>跳过与需处理记录</summary>
              {s.jobs
                .filter((j) => ["attention", "skipped"].includes(j.status))
                .slice(-10)
                .reverse()
                .map((j) => (
                  <p key={j.id} className="autocare-wrap">
                    {names.get(j.accountId)} · {j.message} <small>{j.id}</small>
                  </p>
                ))}
            </details>
          ) : null}
        </div>
      </details>
      <details className="autocare-records">
        <summary>自动互动结果与历史记录</summary>
        <AutocareParticipation snapshot={s} reload={reload} />
      </details>
    </>
  );
}
