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
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { Switch } from "../ui/Switch";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import { ZhihuCreatorProgress } from "./CreatorProgress";
import { AutocareParticipation } from "./AutocareParticipation";
import { AutocareLogs } from "./AutocareLogs";
import "./autocare.css";
export default function AutocarePanel({
  openAdvanced,
}: {
  openAdvanced(): void;
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
        description="规则安排任务，AI整理内容。选择账号后开启，运行结果直接看下方。"
        action={
          <Button size="compact" onClick={openAdvanced}>
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
  openAdvanced,
}: {
  snapshot: AutocareSnapshot;
  workspace: string;
  reload(): void;
  openAdvanced(): void;
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
    stale = draft.value.revision !== s.revision,
    changed = JSON.stringify(cfg) !== JSON.stringify(s.config);
  const update = (patch: Partial<AutocareConfig>) =>
    draft.update({ config: { ...cfg, ...patch } });
  const action = async (
    fn: () => Promise<AutocareSnapshot>,
    message: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      draft.clear();
      draft.update({ config: result.config, revision: result.revision });
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
        let revision = s.revision;
        if (enabled && changed) {
          const saved = await ipc("zhihu.autocare.save", {
            config: cfg,
            revision,
          });
          revision = saved.revision;
        }
        return ipc("zhihu.autocare.toggle", {
          enabled,
          revision,
          confirmed: true,
        });
      },
      enabled
        ? "计划已保存，到随机任务时间才开始无头执行"
        : "已停止新任务；已提交的任务继续核对结果",
    );
  const latest = s.jobs.filter((j) =>
    ["queued", "ready", "collecting", "generating"].includes(j.status),
  );
  const next = [
    ...latest.filter((j) => j.scheduledAt).map((j) => j.scheduledAt!),
    ...Object.values(s.cycles).map((c) => c.at),
  ].sort()[0];
  const published = s.jobs.filter((j) => j.status === "published" && j.url);
  const names = new Map(s.accounts.map((a) => [a.id, a.nickname || a.alias]));
  return (
    <>
      <Panel className="autocare-master">
        <div>
          <Status
            kind={
              s.enabled
                ? s.needsAttention
                  ? "warning"
                  : "good"
                : s.message.includes("待核") || s.message.includes("变化")
                  ? "warning"
                  : "normal"
            }
          >
            {s.enabled
              ? s.needsAttention
                ? "需要处理"
                : s.busy
                  ? "正在处理"
                  : "已开启"
              : s.busy
                ? "正在收尾"
                : "已关闭"}
          </Status>
          <strong>{s.message}</strong>
          {s.lastHeartbeatAt ? (
            <small>最近检查 {formatTime(s.lastHeartbeatAt)}</small>
          ) : null}
        </div>
        <label className="autocare-power">
          <span>自动养号</span>
          <Switch
            aria-label="自动养号总开关"
            checked={s.enabled}
            disabled={
              busy ||
              (!s.enabled &&
                (s.busy ||
                  stale ||
                  !cfg.accountIds.length ||
                  !(
                    cfg.publish ||
                    cfg.answerRecommended ||
                    cfg.readRecommended ||
                    cfg.likeCandidates ||
                    cfg.followCandidates
                  )))
            }
            onCheckedChange={toggle}
          />
        </label>
      </Panel>
      {error ? <Notice danger>{error}</Notice> : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
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
      <Panel
        title="本次设置"
        extra={
          <Button
            primary
            size="compact"
            disabled={busy || s.busy || stale || !changed}
            onClick={() =>
              void action(
                () =>
                  ipc("zhihu.autocare.save", {
                    config: cfg,
                    revision: s.revision,
                  }),
                s.enabled ? "设置已应用，未执行任务将重新排期" : "设置已保存",
              )
            }
          >
            {s.enabled ? "保存并应用" : "保存设置"}
          </Button>
        }
      >
        <fieldset
          disabled={busy || s.busy || stale}
          className="autocare-settings"
        >
          <div className="autocare-accounts">
            {s.accounts.map((a) => (
              <CheckboxField
                key={a.id}
                label={
                  <>
                    <strong>{a.nickname || a.alias}</strong>
                    <small>
                      {a.environmentName} ·{" "}
                      {a.status === "connected" ? "已登录" : "需检查登录"}
                    </small>
                  </>
                }
                checked={cfg.accountIds.includes(a.id)}
                disabled={s.enabled}
                onChange={(e) =>
                  update({
                    accountIds: e.target.checked
                      ? [...new Set([...cfg.accountIds, a.id])]
                      : cfg.accountIds.filter((id) => id !== a.id),
                  })
                }
              />
            ))}
            {!s.accounts.length ? (
              <Empty
                compact
                title="还没有知乎账号"
                action={
                  <Button
                    size="compact"
                    onClick={() => navigate("website-accounts")}
                  >
                    连接账号
                  </Button>
                }
              >
                先关联已登录的比特窗口。
              </Empty>
            ) : null}
          </div>
          <div className="autocare-actions">
            <CheckboxField
              label="自动发文"
              checked={cfg.publish}
              onChange={(e) => update({ publish: e.target.checked })}
            />
            <CheckboxField
              label="回答推荐问题"
              checked={cfg.answerRecommended}
              onChange={(e) => update({ answerRecommended: e.target.checked })}
            />
            <CheckboxField
              label="读取推荐内容"
              checked={cfg.readRecommended}
              onChange={(e) => update({ readRecommended: e.target.checked })}
            />
            <CheckboxField
              label="准备点赞"
              checked={cfg.likeCandidates}
              onChange={(e) => update({ likeCandidates: e.target.checked })}
            />
            <CheckboxField
              label="发现作者与关注"
              checked={cfg.followCandidates}
              onChange={(e) => update({ followCandidates: e.target.checked })}
            />
          </div>
          <p className="autocare-flow autocare-help">
            文章由皮皮虾资料成稿；回答筛选官方推荐浏览量大于1万的问题，共用发布额度。点赞、关注准备具体待办，由本人在本页确认。
          </p>
          <div className="autocare-actions">
            <Button
              size="compact"
              onClick={() =>
                update({
                  ...autocareConfigSchema.parse({}),
                  accountIds: cfg.accountIds,
                  answerRecommended: true,
                  readRecommended: true,
                  likeCandidates: true,
                  followCandidates: true,
                })
              }
            >
              应用完整运营预设
            </Button>
          </div>
          <div className="autocare-primary-fields">
            <Field label="推荐预设">
              <div className="autocare-preset">日常养号 · 不限领域</div>
            </Field>
            <Field label="每号每日发布总上限">
              <input
                aria-label="每号每日文章与回答总上限"
                type="number"
                min={1}
                max={10}
                value={cfg.dailyLimit}
                onChange={(e) => update({ dailyLimit: Number(e.target.value) })}
              />
            </Field>
            <Field label="开始时间">
              <input
                aria-label="养号开始时间"
                type="time"
                value={cfg.windowStart}
                onChange={(e) => update({ windowStart: e.target.value })}
              />
            </Field>
            <Field label="结束时间">
              <input
                aria-label="养号结束时间"
                type="time"
                value={cfg.windowEnd}
                onChange={(e) => update({ windowEnd: e.target.value })}
              />
            </Field>
          </div>
          <details className="autocare-more">
            <summary>更多设置与预算</summary>
            <div className="autocare-primary-fields">
              <Field label="目标等级">
                <input
                  type="number"
                  min={4}
                  max={10}
                  value={cfg.targetLevel}
                  onChange={(e) =>
                    update({ targetLevel: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="每号每周最多">
                <input
                  type="number"
                  min={1}
                  max={70}
                  value={cfg.weeklyLimit}
                  onChange={(e) =>
                    update({ weeklyLimit: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="最小间隔（分钟）">
                <input
                  type="number"
                  min={60}
                  max={1440}
                  value={cfg.gapMinutes}
                  onChange={(e) =>
                    update({ gapMinutes: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="每日生成尝试上限">
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={cfg.generationsPerDay}
                  onChange={(e) =>
                    update({ generationsPerDay: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <div className="autocare-primary-fields">
              <Field label="其中回答每日最多">
                <input
                  type="number"
                  min={1}
                  max={2}
                  value={cfg.answersPerDay}
                  onChange={(e) =>
                    update({ answersPerDay: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="每日自动读取上限">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={cfg.researchPerDay}
                  onChange={(e) =>
                    update({ researchPerDay: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="每日点赞关注上限">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={cfg.interactionDailyLimit}
                  onChange={(e) =>
                    update({ interactionDailyLimit: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <CheckboxField
              label="补采原帖评论作为生成参考（使用额外采集请求）"
              checked={cfg.includeComments}
              onChange={(e) => update({ includeComments: e.target.checked })}
            />
            <p className="muted">
              原图有已保存的使用依据时附图；其余采用有来源的文字稿。自动读取默认每日3次。开启只保存计划，账号任务随机延后并错峰，到时以无头模式执行；可见登录窗口不会被静默接管。
            </p>
            <Button
              size="compact"
              onClick={() =>
                update({
                  ...autocareConfigSchema.parse({}),
                  accountIds: cfg.accountIds,
                })
              }
            >
              恢复推荐预设
            </Button>
          </details>
        </fieldset>
        <div className="autocare-budget">
          <span>
            模型：{s.modelName || "未设置"} · 今日生成 {s.generationCount}/
            {cfg.generationsPerDay} 次 · 全局AI日预算
            {s.globalAiBudgetMicros === null
              ? "未设置金额上限"
              : ` $${(s.globalAiBudgetMicros / 1e6).toFixed(2)}`}
          </span>
          <span>
            采集今日剩余 {s.requestsRemaining}/{s.requestsLimit} 次 ·{" "}
            {s.listPagesPerRun
              ? "库存不足时自动补采"
              : "新列表采集已关闭，仅用本地库存"}
          </span>
          <Button quiet size="compact" onClick={() => openSettings("sources")}>
            数据源设置
          </Button>
          <Button quiet size="compact" onClick={() => openSettings("ai")}>
            模型与预算
          </Button>
        </div>
        <small className="muted">
          开启只做本地检查和排期，所有自动浏览操作使用比特无头模式；到时核验身份再执行。手动登录和验证在账号管理处理。
        </small>
      </Panel>
      <Panel
        title="运行情况"
        extra={
          <span className="muted">
            下次执行 {next ? formatTime(next) : "等待安排"}
          </span>
        }
      >
        <div className="autocare-overview">
          <span>
            本模式累计发布 <strong>{published.length}</strong> 篇
          </span>
          <span>
            官方曝光 / 浏览 <strong>暂不可获取</strong>
          </span>
          <Button quiet size="compact" onClick={openAdvanced}>
            文章与任务详情
          </Button>
        </div>
        <div className="autocare-status-list">
          {s.accounts
            .filter((a) => cfg.accountIds.includes(a.id))
            .map((a) => (
              <div className="autocare-account-status" key={a.id}>
                <div>
                  <strong>{a.nickname || a.alias}</strong>
                  <small>
                    {s.accountMessages[a.id] ||
                      "开启后先安排计划，到时再核对账号和素材"}
                  </small>
                  {s.cycles[a.id] ? (
                    <small>
                      下次
                      {s.cycles[a.id].kind === "research"
                        ? "内容读取"
                        : "任务准备"}{" "}
                      · {formatTime(s.cycles[a.id].at)} · 无头
                    </small>
                  ) : null}
                  <small>
                    今日已尝试 {a.today} / 有效上限{" "}
                    {Math.min(a.plan.dailyLimit, cfg.dailyLimit)} · 本周{" "}
                    {a.week} / {Math.min(a.plan.weeklyLimit, cfg.weeklyLimit)}
                  </small>
                </div>
                <ZhihuCreatorProgress
                  progress={a.plan.progress}
                  targetLevel={cfg.targetLevel}
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
      </Panel>
      <AutocareParticipation snapshot={s} reload={reload} />
      <AutocareLogs names={names} />
    </>
  );
}
