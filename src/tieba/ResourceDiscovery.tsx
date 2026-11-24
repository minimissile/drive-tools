import { ArrowUpRight, ChevronDown, List, Radar, Route } from "lucide-react";
import { useId, useRef, useState } from "react";
import { z } from "zod";
import {
  tiebaDiscoveryPageSize,
  tiebaDiscoveryCadenceMinutes,
  tiebaDiscoveryLogLimit,
  defaultOldTrafficThreshold,
  defaultPendingObservationHours,
  oldTrafficObservationDays,
  recentGrowthMaxReadingHours,
  pendingObservationMultiplier,
  defaultTiebaDiscoveryRules,
  tiebaDiscoveryRulesSchema,
  tiebaResourceSeedsSchema,
  type TiebaDiscoverySnapshot,
} from "../../shared/tieba-resource-discovery";
import {
  tiebaForumHomeUrl,
  tiebaForumInputName,
} from "../../shared/tieba-forums";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { useFeedbackActions } from "../state/feedback";
import { ClearableField } from "../ui/ClearableField";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { AnalysisPages } from "./AnalysisPages";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import {
  formatAnalysisCount,
  formatAnalysisTime,
} from "./AnalysisThreadsTable";
import { formatForumExposure } from "./TiebaPotentialFormula";
import { PostExposureCell } from "./PostExposureCell";
import { TrafficResults } from "./TrafficResults";
import { formatDiscoveryResource } from "./discovery-resource-label";
import { DiscoveryPageRefresh } from "./DiscoveryPageRefresh";
import { FilterAuditResults } from "./FilterAuditResults";
import { RecycledResults } from "./RecycledResults";
import "./resource-discovery.css";

const maxSeedInputLength = 10_004;
const ruleFields = [
  {
    key: "lookbackHours",
    label: "潜力帖观察期（小时）",
    min: 1,
    max: 720,
    step: 1,
  },
  {
    key: "pendingObservationHours",
    label: "待观察时长（小时）",
    min: 0.5,
    max: 719,
    step: "any",
  },
  {
    key: "minDailyViews",
    label: "监控门槛（次/天）",
    min: 0,
    max: Number.MAX_SAFE_INTEGER * 24,
    step: "any",
  },
  {
    key: "trafficThreshold",
    label: "高流量门槛（浏览）",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    step: 1,
  },
  {
    key: "recentGrowthMinDailyViews",
    label: "近期实测日均新增（次/天）",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    step: "any",
  },
  {
    key: "oldTrafficMinTotalViews",
    label: "累计浏览量",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    step: 1,
  },
  {
    key: "oldTrafficMinLifetimeDailyViews",
    label: "发帖以来日均（次/天）",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    step: "any",
  },
  {
    key: "oldTrafficMinViews",
    label: "实测日均新增（次/天）",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    step: "any",
  },
] as const;
const draftSchema = z.object({
  seeds: z.string().max(maxSeedInputLength).nullable(),
  rules: z
    .object({
      lookbackHours: z.string(),
      minDailyViews: z.string().optional(),
      minHourlyViews: z.string().optional(),
      recentGrowthMinDailyViews: z.string().optional(),
      trafficThreshold: z.string(),
      oldTrafficMinViews: z.string().optional(),
      oldTrafficMinTotalViews: z.string().optional(),
      oldTrafficMinLifetimeDailyViews: z.string().optional(),
      oldResourceCheckEnabled: z.boolean().optional(),
      pendingObservationHours: z.string().optional(),
    })
    .transform(({ minHourlyViews, minDailyViews, ...rules }) => ({
      ...rules,
      minDailyViews: minDailyViews ?? (minHourlyViews === undefined
        ? undefined
        : minHourlyViews.trim() ? String(Number(minHourlyViews) * 24) : ""),
    }))
    .nullable()
    .default(null),
});
const resultsTabSchema = z.enum([
  "potential",
  "pending",
  "traffic",
  "recycled",
  "filterAudit",
  "sources",
  "logs",
]);
type ResultsView = { tab: z.infer<typeof resultsTabSchema> };
const resultsSchema = z
  .object({
    tab: z.union([resultsTabSchema, z.enum(["posts", "trending", "oldTraffic"])]),
    postType: z
      .enum(["potential", "traffic", "trending", "watching"])
      .optional(),
  })
  .transform(({ tab, postType }): ResultsView => ({
    tab: tab === "trending" ? "potential" :
      tab === "oldTraffic" ? "traffic" :
      tab === "posts" ? postType === "traffic" ? "traffic" : "potential" : tab,
  }));
const datetime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const logTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const rate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const pageSize = tiebaDiscoveryPageSize;
const updateRequired = (message: string) =>
  /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
    ? "请在顶部点击「应用更新并重启」，然后重试。"
    : message;

export function ResourceDiscovery({
  workspace,
  snapshot,
}: {
  workspace: string;
  snapshot: ReturnType<typeof useIpcQuery<"tieba.discovery.snapshot">>;
}) {
  const { notify } = useFeedbackActions();
  const draft = useLocalDraft<z.infer<typeof draftSchema>>(
    `tieba-discovery-seeds:${workspace}`,
    { seeds: null, rules: null },
    draftSchema.parse,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(
    () => draft.value.seeds !== null || draft.value.rules !== null,
  );
  const settingsId = useId();
  const seedsId = useId();
  const seedHintId = useId();
  const rulesId = useId();
  const locked = useRef(false);
  const state = snapshot.data;
  const monitoringRulesReady = state?.rules?.minHourlyViews !== undefined;
  const oldTrafficReady = state?.oldTraffic?.total !== undefined;
  const seedInput = draft.value.seeds ?? state?.seeds.join("\n") ?? "";
  const rules = state?.rules ?? defaultTiebaDiscoveryRules;
  const ruleInputs = {
    lookbackHours: String(rules.lookbackHours),
    trafficThreshold: String(rules.trafficThreshold),
    oldTrafficMinViews: String(rules.oldTrafficMinViews ?? defaultOldTrafficThreshold),
    oldTrafficMinTotalViews: String(rules.oldTrafficMinTotalViews ?? defaultTiebaDiscoveryRules.oldTrafficMinTotalViews),
    oldTrafficMinLifetimeDailyViews: String(rules.oldTrafficMinLifetimeDailyViews ?? defaultTiebaDiscoveryRules.oldTrafficMinLifetimeDailyViews),
    oldResourceCheckEnabled: rules.oldResourceCheckEnabled ?? true,
    pendingObservationHours: String(rules.pendingObservationHours ?? defaultPendingObservationHours),
    ...draft.value.rules,
    recentGrowthMinDailyViews: draft.value.rules?.recentGrowthMinDailyViews ??
      String(rules.recentGrowthMinDailyViews ?? defaultTiebaDiscoveryRules.recentGrowthMinDailyViews),
    minDailyViews: draft.value.rules?.minDailyViews ?? String(
      (rules.minHourlyViews ?? defaultTiebaDiscoveryRules.minHourlyViews) * 24,
    ),
  };

  async function action(run: () => Promise<TiebaDiscoverySnapshot>) {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setError("");
    try {
      snapshot.setData(await run());
      snapshot.reload();
    } catch (cause) {
      setError(
        updateRequired(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        ),
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <div className="tieba-analysis-content tieba-resource-discovery">
      <QueryError
        error={updateRequired(snapshot.error)}
        loading={snapshot.loading}
        onRetry={snapshot.reload}
      />
      {!state && !snapshot.error ? (
        <Panel><LoadingState label="正在读取资源发现…" layout="list" compact /></Panel>
      ) : null}
      {state ? (
        <>
          <Panel
            title="资源发现"
            className="tieba-discovery-setup"
            extra={
              <div className="tieba-discovery-run-controls">
                {state.busy ? (
                  <Loading
                    label={`${state.scanningForum ? `正在扫描 ${state.scanningForum} 吧` : "正在核对帖子与作者"}${state.auto ? "" : " · 本批结束后待命"}`}
                  />
                ) : (
                  <small className="muted" role="status">
                    {state.nextAt !== null ? (
                      <>
                        {state.nextMode === "expand"
                          ? "下一批扩散"
                          : "下次巡查"}{" "}
                        {datetime.format(state.nextAt)}
                        {state.queuedForums
                          ? ` · ${state.queuedForums} 个候选吧待扫`
                          : ""}
                      </>
                    ) : state.auto ? (
                      "持续发现已开启"
                    ) : (
                      "持续发现已暂停"
                    )}
                  </small>
                )}
                <Button
                  size="compact"
                  aria-expanded={settingsOpen}
                  aria-controls={settingsId}
                  onClick={() => setSettingsOpen(!settingsOpen)}
                >
                  发现设置 <ChevronDown size={14} aria-hidden="true" />
                </Button>
                <Button
                  size="compact"
                  primary={!state.auto}
                  disabled={
                    pending ||
                    (!state.auto &&
                      (!monitoringRulesReady || draft.value.seeds !== null))
                  }
                  onClick={() =>
                    void action(() =>
                      ipc("tieba.discovery.auto", { enabled: !state.auto }),
                    )
                  }
                >
                  {state.auto ? "暂停持续发现" : "开始持续发现"}
                </Button>
              </div>
            }
          >
            <div
              id={settingsId}
              className="tieba-discovery-settings"
              hidden={!settingsOpen}
            >
              <div className="tieba-discovery-controls">
                <form
                  className="tieba-discovery-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      const seeds = tiebaResourceSeedsSchema.parse({
                        seeds: seedInput
                          .split(/\r?\n/u)
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map(tiebaForumInputName),
                      }).seeds;
                      const updated = await ipc("tieba.discovery.seeds", {
                        seeds,
                      });
                      draft.update({ seeds: null });
                      return updated;
                    });
                  }}
                >
                  <div className="tieba-discovery-setting-heading">
                    <label htmlFor={seedsId}>种子贴吧</label>
                    <Button
                      type="submit"
                      size="compact"
                      disabled={
                        state.busy ||
                        pending ||
                        draft.value.seeds === null ||
                        !seedInput.trim()
                      }
                    >
                      保存种子
                    </Button>
                  </div>
                  <ClearableField
                    multiline
                    id={seedsId}
                    aria-describedby={seedHintId}
                    clearLabel="清除种子贴吧输入"
                    placeholder="输入贴吧首页链接或吧名"
                    rows={Math.min(5, Math.max(3, state.seeds.length))}
                    maxLength={maxSeedInputLength}
                    disabled={pending}
                    value={seedInput}
                    onValueChange={(seeds) => draft.update({ seeds })}
                  />
                  <small id={seedHintId} className="muted">
                    首页链接或吧名，每行一个，最多五个。
                  </small>
                </form>
                <form
                  aria-labelledby={rulesId}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      const input = tiebaDiscoveryRulesSchema.safeParse({
                        lookbackHours: Number(ruleInputs.lookbackHours),
                        minHourlyViews: Number(ruleInputs.minDailyViews) / 24,
                        recentGrowthMinDailyViews: Number(ruleInputs.recentGrowthMinDailyViews),
                        trafficThreshold: Number(ruleInputs.trafficThreshold),
                        oldTrafficMinViews: Number(ruleInputs.oldTrafficMinViews),
                        oldTrafficMinTotalViews: Number(ruleInputs.oldTrafficMinTotalViews),
                        oldTrafficMinLifetimeDailyViews: Number(ruleInputs.oldTrafficMinLifetimeDailyViews),
                        oldResourceCheckEnabled: ruleInputs.oldResourceCheckEnabled,
                        pendingObservationHours: state.pendingCount === undefined
                          ? undefined
                          : Number(ruleInputs.pendingObservationHours),
                      });
                      if (!input.success) throw new Error(input.error.issues[0].message);
                      const updated = await ipc("tieba.discovery.rules", input.data);
                      draft.update({ rules: null });
                      notify("发现规则已保存", "success");
                      return updated;
                    });
                  }}
                >
                  <div className="tieba-discovery-setting-heading">
                    <h3 id={rulesId}>发现规则</h3>
                    <Button
                      type="submit"
                      size="compact"
                      disabled={
                        pending ||
                        !monitoringRulesReady ||
                        draft.value.rules === null ||
                        ruleFields.some(({ key }) => !ruleInputs[key])
                      }
                    >
                      保存规则
                    </Button>
                  </div>
                  {[
                    { label: "新帖与高流量", fields: ruleFields.slice(0, 4) },
                    { label: "近期增长", fields: ruleFields.slice(4, 5) },
                    { label: "老帖流量", fields: ruleFields.slice(5) },
                  ].map(({ label: groupLabel, fields }, group) => (
                    <fieldset className="tieba-discovery-rule-group" key={groupLabel}>
                      <legend>{groupLabel}</legend>
                      <div className="tieba-discovery-rule-fields">
                        {fields.map(({ key, label, min, max, step }) => (
                          <Field key={key} as="div" htmlFor={`${rulesId}-${key}`} label={label}>
                            <ClearableField
                              id={`${rulesId}-${key}`}
                              type="number"
                              required
                              min={min}
                              max={max}
                              step={step}
                              disabled={
                                pending || !monitoringRulesReady ||
                                (group === 2 && !oldTrafficReady) ||
                                (key === "pendingObservationHours" && state.pendingCount === undefined)
                              }
                              value={ruleInputs[key]}
                              clearLabel={`清除${label}输入`}
                              onValueChange={(value) =>
                                draft.update({ rules: { ...ruleInputs, [key]: value } })
                              }
                            />
                          </Field>
                        ))}
                      </div>
                      {group === 1 && (
                        <small className="muted">
                          发帖超过潜力帖观察期、未满 7 天，且累计浏览低于高流量门槛时适用。
                          两次读数相隔 30 分钟至 {recentGrowthMaxReadingHours} 小时，达标后进入潜力帖库。
                        </small>
                      )}
                      {group === 2 && (
                        <>
                          <label className="tieba-console-switch tieba-old-resource-switch">
                            老帖入库前校验资源
                            <Switch
                              checked={ruleInputs.oldResourceCheckEnabled}
                              disabled={pending || state.rules.oldResourceCheckEnabled === undefined}
                              onCheckedChange={(oldResourceCheckEnabled) =>
                                draft.update({ rules: { ...ruleInputs, oldResourceCheckEnabled } })
                              }
                            />
                          </label>
                          <small className="muted">
                            {ruleInputs.oldResourceCheckEnabled
                              ? "开启后，历史扫描会检查流量达标帖的标题、正文和最近最多 20 条回复。识别到网盘分享链接，或命中网盘、云盘、链接、提取码、口令、百度、夸克、//pan. 中任一关键词，即可通过。"
                              : "关闭：跳过资源筛查，老帖达到流量门槛即可进入流量帖库。"}{" "}
                            此开关适用于历史扫描。点“保存规则”后生效。开启时待核验记录由后台复查；未通过的记录会从列表隐藏但不会删除，关闭校验后可再次看到。
                            两次实测读数至少间隔 {oldTrafficObservationDays} 天，按实际间隔计算新增浏览量。
                          </small>
                        </>
                      )}
                    </fieldset>
                  ))}
                  <div className="tieba-discovery-settings-notes">
                    <small className="muted">
                      发帖未满待观察时长，达到监控门槛的 {pendingObservationMultiplier} 倍先进入待观察库。
                      到期按最新读数达到常规门槛后进入潜力帖库。
                    </small>
                    <small className="muted">
                      自动扫描随机等待，扩散{" "}
                      {tiebaDiscoveryCadenceMinutes.expand.min}–
                      {tiebaDiscoveryCadenceMinutes.expand.max} 分钟，巡查{" "}
                      {tiebaDiscoveryCadenceMinutes.survey.min}–
                      {tiebaDiscoveryCadenceMinutes.survey.max} 分钟。
                    </small>
                  </div>
                </form>
              </div>
            </div>
            {!monitoringRulesReady ? (
              <Notice warning>
                点击顶部「应用更新并重启」，启用新版监控门槛。
              </Notice>
            ) : null}
            {draft.error ? <Notice warning>{draft.error}</Notice> : null}
            {error ? <Notice danger>{error}</Notice> : null}
          </Panel>
          <DiscoveryResults
            workspace={workspace}
            state={state}
            scanDisabled={
              !monitoringRulesReady || state.busy || pending || draft.value.seeds !== null
            }
            onScan={() => void action(() => ipc("tieba.discovery.scan"))}
            onStartFilterAudit={() => void action(() => ipc("tieba.discovery.startFilterAudit"))}
            actionPending={pending}
            onScanOld={() => void action(() => ipc("tieba.discovery.scanOldForum"))}
            onStopOld={() => void action(() => ipc("tieba.discovery.auto", { enabled: false }))}
            scanOldDisabled={pending || draft.value.seeds !== null}
            refreshSnapshot={snapshot.reload}
            refreshingSnapshot={snapshot.loading}
          />
        </>
      ) : null}
    </div>
  );
}

function DiscoveryResults({
  workspace,
  state,
  scanDisabled,
  onScan,
  onStartFilterAudit,
  actionPending,
  onScanOld,
  onStopOld,
  scanOldDisabled,
  refreshSnapshot,
  refreshingSnapshot,
}: {
  workspace: string;
  state: TiebaDiscoverySnapshot;
  scanDisabled: boolean;
  onScan: () => void;
  onStartFilterAudit: () => void;
  actionPending: boolean;
  onScanOld: () => void;
  onStopOld: () => void;
  scanOldDisabled: boolean;
  refreshSnapshot: () => void;
  refreshingSnapshot: boolean;
}) {
  const { command } = useAppActions();
  const view = useLocalDraft<ResultsView>(
    `tieba-discovery-results:${workspace}`,
    { tab: "potential" },
    resultsSchema.parse,
  );
  const { tab } = view.value;
  const last = state.lastRun;
  const [sourcesPage, setSourcesPage] = useState(1);
  const [logsPage, setLogsPage] = useState(1);

  const sources = state.sources.toReversed().sort(
    (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0),
  );
  const currentSourcesPage = Math.min(sourcesPage, Math.max(1, Math.ceil(sources.length / pageSize)));
  const logs = (state.logs ?? []).slice(-tiebaDiscoveryLogLimit).reverse();
  const currentLogsPage = Math.min(logsPage, Math.max(1, Math.ceil(logs.length / pageSize)));
  return (
    <Panel
      title="发现结果"
      className="tieba-discovery-results"
      extra={last ? (
        <small className="muted">
          {state.rounds ? `第 ${state.rounds} 批 · ` : ""}
          {last.mode === "expand" ? "扩散扫描" : "巡查"} · 读到{" "}
          {last.forums} 个贴吧 · 查看 {last.authors} 位作者 · 新发现{" "}
          {last.added} 个贴吧 · {datetime.format(last.at)}
        </small>
      ) : null}
    >
      <Tabs<ResultsView["tab"]>
        className="tieba-analysis-tabs"
        value={tab}
        onChange={(tab) => view.update({ tab })}
      >
        <div className="tieba-discovery-list-toolbar">
          <TabList
            label="资源发现结果"
            items={[
              [
                "potential",
                state.potentialCount == null
                  ? "潜力帖"
                  : `潜力帖 ${state.potentialCount}`,
              ],
              ["pending", state.pendingCount === undefined ? "待观察" : `待观察 ${state.pendingCount}`],
              [
                "traffic",
                state.trafficCount == null || state.oldTraffic?.tracked == null
                  ? "流量帖"
                  : `流量帖 ${formatAnalysisCount(state.trafficCount + state.oldTraffic.tracked)}`,
              ],
              ["recycled", state.recycledCount === undefined ? "回收贴" : `回收贴 ${state.recycledCount}`],
              ["filterAudit", state.filterAudit?.count ? `筛查抽查 ${state.filterAudit.count}` : "筛查抽查"],
              ["sources", `扩散路径 ${state.sources.length}`],
              ["logs", "扫描日志"],
            ]}
          />
          {tab === "logs" ? (
            <div className="tieba-discovery-run-controls">
              <Button size="compact" disabled={scanDisabled} onClick={onScan}>
                手动扫一轮
              </Button>
              <DiscoveryPageRefresh disabled={refreshingSnapshot} onRefresh={refreshSnapshot} />
            </div>
          ) : null}
        </div>
        <TabPanel value="potential" keepMounted>
          <ArchivedPosts
            kind="potential"
            enabled={tab === "potential"}
            revision={last?.at}
            refreshSnapshot={refreshSnapshot}
          />
        </TabPanel>
        <TabPanel value="pending" keepMounted>
          {state.pendingCount === undefined ? (
            <Notice warning>点击顶部「应用更新并重启」，启用待观察库。</Notice>
          ) : (
            <ArchivedPosts kind="pending" enabled={tab === "pending"} revision={last?.at} refreshSnapshot={refreshSnapshot} />
          )}
        </TabPanel>
        <TabPanel value="traffic" keepMounted>
          <TrafficResults
            result={state.oldTraffic}
            resourceReady={state.oldResourceReady === true}
            resourceAdmission={state.oldResourceAdmission === true}
            resourcePending={state.oldResourcePending}
            progress={state.historyProgress}
            threshold={state.rules?.oldTrafficMinViews ?? defaultOldTrafficThreshold}
            enabled={tab === "traffic"}
            revision={last?.at}
            refreshSnapshot={refreshSnapshot}
            resourceCheckEnabled={state.rules.oldResourceCheckEnabled ?? true}
            scanDisabled={scanOldDisabled}
            onScan={onScanOld}
            onStop={state.auto ? undefined : onStopOld}
          />
        </TabPanel>
        <TabPanel value="recycled">
          <RecycledResults count={state.recycledCount} reviewReady={state.recycledReviewReady === true} refreshSnapshot={refreshSnapshot} />
        </TabPanel>
        <TabPanel value="filterAudit">
          <FilterAuditResults
            key={state.filterAudit?.batch ?? "not-started"}
            audit={state.filterAudit}
            auto={state.auto}
            starting={actionPending}
            sortReady={state.filterAuditSortReady === true}
            onStart={onStartFilterAudit}
            refreshSnapshot={refreshSnapshot}
          />
        </TabPanel>
        <TabPanel value="sources" keepMounted>
          {tab === "sources" ? <div className="tieba-discovery-page-actions">
            <DiscoveryPageRefresh
              disabled={state.busy}
              request={{ kind: "sources", names: sources.slice((currentSourcesPage - 1) * pageSize, currentSourcesPage * pageSize).map(({ name }) => name) }}
              onRefresh={refreshSnapshot}
            />
          </div> : null}
          {state.sources.length ? (
            <AnalysisPages
              page={currentSourcesPage}
              pageSize={pageSize}
              total={state.sources.length}
              onPageChange={setSourcesPage}
              label="扩散路径分页"
            >
              <ul className="tieba-discovery-sources">
                {sources.slice((currentSourcesPage - 1) * pageSize, currentSourcesPage * pageSize).map((source) => {
                  const url = tiebaForumHomeUrl(source.name);
                  return (
                    <li key={source.name}>
                      <div>
                        {url ? (
                          <Button
                            quiet
                            size="compact"
                            className="tieba-analysis-link"
                            onClick={() => void command("system.external", { url })}
                          >
                            {source.name}
                            <ArrowUpRight size={14} />
                          </Button>
                        ) : (
                          source.name
                        )}
                        {source.via ? (
                          <small className="muted">
                            {source.via.reason === "posted"
                              ? "来自作者发帖"
                              : "来自作者公开关注"}
                          </small>
                        ) : null}
                      </div>
                      <div className="tieba-discovery-source-reading">
                        <strong>
                          曝光潜力 {formatForumExposure(source.exposure, "day")}
                        </strong>
                        <small className="muted">
                          {source.status === "seed"
                            ? "种子贴吧"
                            : source.scannedAt === null
                              ? source.lastAttemptAt
                                ? "本批未读到"
                                : "待扫描"
                              : source.status === "active"
                                ? "常规监测"
                                : "已扫描"}
                          {source.exposure
                            ? ` · ${source.exposure.sample} 篇样本`
                            : ""}
                          {source.addedAt
                            ? ` · 发现 ${datetime.format(source.addedAt)}`
                            : ""}
                          {source.scannedAt
                            ? ` · 扫描 ${datetime.format(source.scannedAt)}`
                            : ""}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </AnalysisPages>
          ) : (
            <Empty icon={Route} title="暂无扩散路径" compact>
              保存种子贴吧后开始扫描，即可查看发现来源。
            </Empty>
          )}
        </TabPanel>
        <TabPanel value="logs">
          {logs.length ? (
            <AnalysisPages
              page={currentLogsPage}
              pageSize={pageSize}
              total={logs.length}
              onPageChange={setLogsPage}
              label="扫描日志分页"
            >
            <div role="log" aria-label="扫描进程" aria-live="polite">
              <ul className="tieba-discovery-log">
                {logs.slice((currentLogsPage - 1) * pageSize, currentLogsPage * pageSize).map((entry) => (
                  <li key={entry.id}>
                    <time
                      className="muted"
                      dateTime={new Date(entry.at).toISOString()}
                    >
                      {logTime.format(entry.at)}
                    </time>
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ul>
            </div>
            </AnalysisPages>
          ) : (
            <Empty icon={List} title="暂无扫描日志" compact>
              开始持续发现或手动扫一轮后，这里会显示扫描进度。
            </Empty>
          )}
        </TabPanel>
      </Tabs>
    </Panel>
  );
}

const potentialMetrics = [
  ["views", "浏览量"],
  ["replies", "回复数"],
  ["likes", "点赞数"],
  ["shares", "分享数"],
] as const;

const discoveryLists = {
  potential: {
    label: "潜力帖",
    method: "tieba.discovery.potential",
    empty: "发帖满待观察时长后，最新曝光潜力达到常规监控门槛即可入库。",
  },
  pending: {
    label: "待观察",
    method: "tieba.discovery.pending",
    empty: "新帖达到监控门槛的两倍后会在这里等待到期复查。",
  },
} as const;

function ArchivedPosts({
  kind,
  enabled,
  revision,
  refreshSnapshot,
}: {
  kind: keyof typeof discoveryLists;
  enabled: boolean;
  revision?: number;
  refreshSnapshot: () => void;
}) {
  const { command } = useAppActions();
  const [page, setPage] = useState(1);
  const [grew, setGrew] = useState(false);
  const { label, method, empty } = discoveryLists[kind];
  const { data, error, loading, reload } = useIpcQuery(
    method,
    { page, ...(kind === "potential" && grew ? { grew: true } : {}) },
    { enabled, revision, keepPrevious: true },
  );
  if (!enabled) return null;

  return (
    <>
      <div className="tieba-discovery-page-actions">
        {kind === "potential" ? (
          <Select
            aria-label="潜力帖筛选"
            items={[
              { value: "all", label: "全部潜力帖" },
              { value: "grew", label: "有实测增长" },
            ]}
            value={grew ? "grew" : "all"}
            onValueChange={(value) => {
              setGrew(value === "grew");
              setPage(1);
            }}
          />
        ) : null}
        <DiscoveryPageRefresh
          request={{ kind, ids: data?.items.map(({ id }) => id) ?? [] }}
          disabled={loading}
          onRefresh={() => { reload(); refreshSnapshot(); }}
        />
      </div>
      <QueryError
        error={updateRequired(error)}
        loading={loading}
        onRetry={reload}
      />
      {!data && !error ? (
        <LoadingState label={`正在读取${label}…`} layout="list" compact />
      ) : null}
      {data && !data.items.length ? (
        <Empty icon={Radar} title={grew ? "暂无有实测增长的潜力帖" : `${label}库暂无记录`} compact>
          {grew ? "达到近期增长门槛的已入库帖子会显示在这里。" : empty}
        </Empty>
      ) : null}
      {data?.items.length ? (
        <AnalysisPages
          page={data.page}
          pageSize={tiebaDiscoveryPageSize}
          total={data.total}
          loading={loading}
          loadingLabel={`正在读取${label}…`}
          onPageChange={setPage}
          label={`${label}分页`}
        >
          <div className="table-scroll">
            <table
              className="tieba-discovery-post-table"
              aria-label={label}
            >
              <thead>
                <tr>
                  <th scope="col">帖子</th>
                  {potentialMetrics.map(([key, metric]) => (
                    <th scope="col" key={key}>
                      {metric}
                    </th>
                  ))}
                  <th scope="col" className="tieba-post-exposure" title="按最近一次读取时的浏览量和发帖时长计算">
                    曝光潜力
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <Button
                        quiet
                        size="compact"
                        className="tieba-analysis-link"
                        onClick={() =>
                          void command("system.external", { url: post.url })
                        }
                      >
                        <span>{post.title}</span>
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </Button>
                      <small className="muted">
                        {post.forum}
                        {post.author ? ` · ${post.author}` : ""} · 发布于{" "}
                        <time dateTime={post.publishedAt}>
                          {formatAnalysisTime(post.publishedAt)}
                        </time>
                      </small>
                      {post.resource ? <small className="muted">{formatDiscoveryResource(post.resource)}</small> : null}
                      {"first" in post ? (
                        <div className="tieba-discovery-post-facts">
                          <small className="muted">
                            {post.awaitingMatureReading
                              ? "仅有待观察期读数"
                              : post.first.recentGrowth
                              ? `入库实测日均新增 ${rate.format(post.first.recentGrowth.hourly * 24)} 次/天`
                              : post.confirmedGrowth
                                ? `实测日均新增 ${rate.format(post.confirmedGrowth.hourly * 24)} 次/天`
                              : post.confirmedAt ? "已确认上涨" : post.active ? "优先复查" : "已归档"}
                          </small>
                          <small className="muted">
                            入库 {formatAnalysisTime(post.first.at)} · 最近读取{" "}
                            {formatAnalysisTime(post.checkedAt)}
                          </small>
                        </div>
                      ) : (
                        <small className="muted">
                          {post.dueAt <= Date.now() ? "已到期，等待复查" : "待观察"}
                          {" · 到期 "}
                          <time dateTime={new Date(post.dueAt).toISOString()}>{formatAnalysisTime(post.dueAt)}</time>
                          {" · 最近读取 "}
                          {formatAnalysisTime(post.checkedAt)}
                        </small>
                      )}
                    </td>
                    {potentialMetrics.map(([key]) => (
                      <td key={key}>
                        {key === "views" ? (
                          <strong>{formatAnalysisCount(post[key])}</strong>
                        ) : (
                          formatAnalysisCount(post[key])
                        )}
                      </td>
                    ))}
                    {"first" in post && post.awaitingMatureReading ? (
                      <td className="tieba-post-exposure">
                        <span className="muted">待重新读取</span>
                      </td>
                    ) : (
                      <PostExposureCell
                        views={post.views}
                        publishedAt={post.publishedAt}
                        observedAt={post.checkedAt}
                        unit="day"
                      />
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AnalysisPages>
      ) : null}
    </>
  );
}
