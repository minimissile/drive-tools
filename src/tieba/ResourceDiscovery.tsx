import { ArrowUpRight, Radar } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import {
  tiebaDiscoveryPotentialPageSize,
  tiebaDiscoveryCadenceMinutes,
  defaultTiebaDiscoveryRules,
  tiebaDiscoveryRulesSchema,
  tiebaResourceSeedsSchema,
  type TiebaDiscoveryCandidate,
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
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import {
  formatAnalysisCount,
  formatAnalysisTime,
} from "./AnalysisThreadsTable";
import {
  formatForumExposure,
  TiebaPotentialFormula,
} from "./TiebaPotentialFormula";
import "./resource-discovery.css";

const maxSeedInputLength = 10_004;
const ruleFields = [
  { key: "lookbackHours", label: "潜力帖观察期（小时）", min: 1, max: 720 },
  { key: "potentialThreshold", label: "监控门槛（分）", min: 0, max: 100 },
  {
    key: "trafficThreshold",
    label: "高流量门槛（浏览）",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
] as const;
const draftSchema = z.object({
  seeds: z.string().max(maxSeedInputLength).nullable(),
  rules: z
    .object({
      lookbackHours: z.string(),
      potentialThreshold: z.string(),
      trafficThreshold: z.string(),
    })
    .nullable()
    .default(null),
});
const resultsSchema = z.object({
  tab: z.enum(["posts", "sources", "logs"]),
  postType: z.enum(["potential", "traffic", "trending", "watching"]),
});
type ResultsView = z.infer<typeof resultsSchema>;
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
const pageSize = 8;
const updateRequired = (message: string) =>
  /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
    ? "请在顶部点击「应用更新并重启」，然后重试。"
    : message;

export function ResourceDiscovery({ workspace }: { workspace: string }) {
  const snapshot = useIpcQuery("tieba.discovery.snapshot", undefined, {
    keepPrevious: true,
  });
  const draft = useLocalDraft<z.infer<typeof draftSchema>>(
    `tieba-discovery-seeds:${workspace}`,
    { seeds: null, rules: null },
    draftSchema.parse,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  const state = snapshot.data;
  const rules = state?.rules ?? defaultTiebaDiscoveryRules;
  const ruleInputs = draft.value.rules ?? {
    lookbackHours: String(rules.lookbackHours),
    potentialThreshold: String(rules.potentialThreshold),
    trafficThreshold: String(rules.trafficThreshold),
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
        <LoadingState label="正在读取资源发现…" />
      ) : null}
      {state ? (
        <>
          <Panel
            title="资源发现"
            extra={
              <div className="tieba-discovery-run-controls">
                {!state.auto && state.busy ? (
                  <small className="muted" role="status">
                    本批结束后待命
                  </small>
                ) : null}
                <Button
                  size="compact"
                  primary={!state.auto}
                  disabled={
                    pending || (!state.auto && draft.value.seeds !== null)
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
            <div className="tieba-discovery-controls">
              <form
                className="tieba-discovery-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(async () => {
                    const seeds = tiebaResourceSeedsSchema.parse({
                      seeds: (draft.value.seeds ?? state.seeds.join("\n"))
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
                <Field label="种子贴吧（首页链接或吧名，每行一个，最多五个）">
                  <textarea
                    rows={3}
                    maxLength={maxSeedInputLength}
                    disabled={pending}
                    value={draft.value.seeds ?? state.seeds.join("\n")}
                    onChange={(event) =>
                      draft.update({ seeds: event.target.value })
                    }
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={state.busy || pending || draft.value.seeds === null}
                >
                  保存种子
                </Button>
              </form>
              <form
                className="tieba-discovery-rules"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(async () => {
                    const input = tiebaDiscoveryRulesSchema.parse({
                      lookbackHours: Number(ruleInputs.lookbackHours),
                      potentialThreshold: Number(ruleInputs.potentialThreshold),
                      trafficThreshold: Number(ruleInputs.trafficThreshold),
                    });
                    const updated = await ipc("tieba.discovery.rules", input);
                    draft.update({ rules: null });
                    return updated;
                  });
                }}
              >
                <fieldset>
                  <legend>发现规则</legend>
                  <div className="tieba-discovery-rule-fields">
                    {ruleFields.map(({ key, label, min, max }) => (
                      <Field key={key} label={label}>
                        <input
                          type="number"
                          required
                          min={min}
                          max={max}
                          step={1}
                          disabled={pending}
                          value={ruleInputs[key]}
                          onChange={(event) =>
                            draft.update({
                              rules: {
                                ...ruleInputs,
                                [key]: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                    <Button
                      type="submit"
                      disabled={pending || draft.value.rules === null}
                    >
                      保存规则
                    </Button>
                  </div>
                </fieldset>
              </form>
            </div>
            <p className="muted tieba-discovery-note">
              从种子吧发现作者和新贴吧。按已保存的规则，追踪最近{" "}
              {rules.lookbackHours} 小时内的潜力帖，达到{" "}
              {rules.potentialThreshold} 分后优先复查，达到{" "}
              {formatAnalysisCount(rules.trafficThreshold)} 浏览后直接入库。
            </p>
            <TiebaPotentialFormula />
            <p className="muted tieba-discovery-note">
              自动扫描每批随机等待。扩散{" "}
              {tiebaDiscoveryCadenceMinutes.expand.min}–
              {tiebaDiscoveryCadenceMinutes.expand.max} 分钟，巡查{" "}
              {tiebaDiscoveryCadenceMinutes.survey.min}–
              {tiebaDiscoveryCadenceMinutes.survey.max} 分钟。
            </p>
            {state.nextAt !== null ? (
              <small className="muted">
                {state.nextMode === "expand" ? "下一批扩散" : "下次定时巡查"}{" "}
                {datetime.format(state.nextAt)}
                {state.queuedForums
                  ? ` · ${state.queuedForums} 个候选吧待扫`
                  : ""}
              </small>
            ) : null}
            {state.busy ? (
              <Loading
                label={
                  state.scanningForum
                    ? `正在扫描 ${state.scanningForum} 吧…`
                    : "正在核对帖子与作者…"
                }
              />
            ) : null}
            {draft.error ? <Notice warning>{draft.error}</Notice> : null}
            {error ? <Notice danger>{error}</Notice> : null}
          </Panel>
          <DiscoveryResults
            workspace={workspace}
            state={state}
            scanDisabled={state.busy || pending || draft.value.seeds !== null}
            onScan={() => void action(() => ipc("tieba.discovery.scan"))}
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
}: {
  workspace: string;
  state: TiebaDiscoverySnapshot;
  scanDisabled: boolean;
  onScan: () => void;
}) {
  const { command } = useAppActions();
  const view = useLocalDraft<ResultsView>(
    `tieba-discovery-results:${workspace}`,
    { tab: "posts", postType: "potential" },
    resultsSchema.parse,
  );
  const { tab, postType } = view.value;
  const postTypes = [
    {
      value: "potential",
      label:
        state.potentialCount == null
          ? "潜力帖"
          : `潜力帖 ${state.potentialCount}`,
    },
    {
      value: "traffic",
      label:
        state.trafficCount == null
          ? "高流量帖"
          : `高流量帖 ${state.trafficCount}`,
    },
    { value: "trending", label: `近期上涨 ${state.trending.length}` },
    { value: "watching", label: `其他样本 ${state.watching.length}` },
  ] as const;
  const last = state.lastRun;
  return (
    <Panel
      title="发现结果"
      extra={
        last || tab === "logs" ? (
          <div className="tieba-discovery-run-controls">
            {last ? (
              <small className="muted">上轮 {datetime.format(last.at)}</small>
            ) : null}
            {tab === "logs" ? (
              <Button size="compact" disabled={scanDisabled} onClick={onScan}>
                手动扫一轮
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {last ? (
        <p className="muted tieba-discovery-note">
          {state.rounds ? `第 ${state.rounds} 批 · ` : ""}
          {last.mode === "expand" ? "扩散扫描" : "巡查"} · 读到 {last.forums}{" "}
          个贴吧 · 查看 {last.authors} 位作者 · 新发现 {last.added} 个贴吧
        </p>
      ) : null}
      {last?.warnings.length ? (
        <Notice warning>
          <details>
            <summary>上轮有 {last.warnings.length} 条读取提示</summary>
            <ul>
              {last.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </Notice>
      ) : null}
      <Tabs<ResultsView["tab"]>
        className="tieba-analysis-tabs"
        value={tab}
        onChange={(tab) => view.update({ tab })}
      >
        <TabList
          label="资源发现结果"
          items={[
            ["posts", "帖子"],
            ["sources", `扩散路径 ${state.sources.length}`],
            ["logs", "扫描日志"],
          ]}
        />
        <TabPanel value="posts" keepMounted>
          <div className="tieba-analysis-toolbar">
            <Select
              aria-label="帖子类型"
              items={[...postTypes]}
              value={postType}
              onValueChange={(value) => {
                const selection = postTypes.find(
                  (item) => item.value === value,
                );
                if (selection) view.update({ postType: selection.value });
              }}
            />
          </div>
          <ArchivedPosts
            kind="potential"
            enabled={tab === "posts" && postType === "potential"}
            revision={last?.at}
          />
          <ArchivedPosts
            kind="traffic"
            enabled={tab === "posts" && postType === "traffic"}
            revision={last?.at}
          />
          <div hidden={postType !== "trending"}>
            <DiscoveryPosts
              items={state.trending}
              empty={
                last ? "暂未发现达到增长门槛的帖子" : "扫描后开始记录浏览量"
              }
            />
          </div>
          <div hidden={postType !== "watching"}>
            <DiscoveryPosts items={state.watching} empty="暂无其他资源帖样本" />
          </div>
        </TabPanel>
        <TabPanel value="sources" keepMounted>
          <p className="muted tieba-discovery-note">
            沿贴吧 → 公开发帖作者 →
            新贴吧继续扩散。待扫描的候选吧在持续发现开启时进入下一批。
          </p>
          <ul className="tieba-discovery-sources">
            {state.sources.map((source) => {
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
                    <small className="muted">{source.path.join(" → ")}</small>
                    {source.via ? (
                      <small className="muted">
                        {source.via.reason === "posted"
                          ? "来自作者发帖"
                          : "来自作者公开关注"}{" "}
                        · 第 {Math.floor((source.path.length - 1) / 2)} 层
                      </small>
                    ) : null}
                  </div>
                  <div className="tieba-discovery-source-reading">
                    <strong>
                      曝光潜力 {formatForumExposure(source.exposure)}
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
                      {source.scannedAt
                        ? ` · ${datetime.format(source.scannedAt)}`
                        : ""}
                    </small>
                  </div>
                </li>
              );
            })}
          </ul>
        </TabPanel>
        <TabPanel value="logs">
          {state.logs?.length ? (
            <div role="log" aria-label="扫描进程" aria-live="polite">
              <ul className="tieba-discovery-log">
                {state.logs.toReversed().map((entry) => (
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
          ) : (
            <Empty title="暂无扫描日志" compact />
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

function ArchivedPosts({
  kind,
  enabled,
  revision,
}: {
  kind: "potential" | "traffic";
  enabled: boolean;
  revision?: number;
}) {
  const { command } = useAppActions();
  const [page, setPage] = useState(1);
  const label = kind === "potential" ? "潜力帖" : "高流量帖";
  const { data, error, loading, reload } = useIpcQuery(
    kind === "potential"
      ? "tieba.discovery.potential"
      : "tieba.discovery.traffic",
    { page },
    { enabled, revision, keepPrevious: true },
  );
  if (!enabled) return null;

  return (
    <>
      <QueryError
        error={updateRequired(error)}
        loading={loading}
        onRetry={reload}
      />
      {!data && !error ? (
        <LoadingState label={`正在读取${label}…`} compact />
      ) : null}
      {data && !data.items.length ? (
        <Empty icon={Radar} title={`${label}库暂无记录`} compact>
          {kind === "potential"
            ? "按发帖时长折算浏览速度，与同吧同期的帖子比较。达标后自动入库并复查。"
            : "扫描最近 30 天的资源帖，达到浏览量门槛后自动入库。"}
        </Empty>
      ) : null}
      {data?.items.length ? (
        <>
          <ul className="tieba-discovery-posts tieba-discovery-potential">
            {data.items.map((post) => (
              <li key={post.id}>
                <div>
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
                  {"first" in post ? (
                    <>
                      <small className="muted">
                        {post.score == null
                          ? "历史入库记录"
                          : `潜力值 ${post.score} / 100`}
                        {post.first.score != null
                          ? ` · 同吧同期浏览速度第 ${post.first.rank.place} / ${post.first.rank.sample}`
                          : ""}
                        {` · ${post.confirmedAt ? "已确认上涨" : post.active ? "优先复查" : "已归档"}`}
                      </small>
                      <small className="muted">
                        入库 {formatAnalysisTime(post.first.at)} · 最近读取{" "}
                        {formatAnalysisTime(post.checkedAt)}
                      </small>
                    </>
                  ) : (
                    <small className="muted">
                      入库 {formatAnalysisTime(post.checkedAt)} ·{" "}
                      {post.fromPotential
                        ? "潜力帖转入，已结束复查"
                        : "已达流量门槛，直接入库"}
                    </small>
                  )}
                </div>
                <dl className="tieba-discovery-metrics" aria-label="已读取指标">
                  {potentialMetrics.map(([key, label]) => (
                    <div key={key}>
                      <dt className="muted">{label}</dt>
                      <dd>{formatAnalysisCount(post[key])}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <Pagination
            page={data.page}
            pageSize={tiebaDiscoveryPotentialPageSize}
            total={data.total}
            disabled={loading}
            onPageChange={setPage}
            label={`${label}分页`}
          />
        </>
      ) : null}
    </>
  );
}

function DiscoveryPosts({
  items,
  empty,
}: {
  items: TiebaDiscoveryCandidate[];
  empty: string;
}) {
  const { command } = useAppActions();
  const [page, setPage] = useState(1);
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(items.length / pageSize)),
  );
  if (!items.length)
    return (
      <Empty icon={Radar} title={empty} compact>
        有两次有效读数后才能判断涨势，上榜需要新增至少 10
        次浏览且进入同吧同期资源帖前 25%。
      </Empty>
    );
  return (
    <>
      <ul className="tieba-discovery-posts">
        {items
          .slice((current - 1) * pageSize, current * pageSize)
          .map((post) => (
            <li key={post.id}>
              <div>
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
                  {[
                    post.forum,
                    post.author,
                    datetime.format(new Date(post.publishedAt)),
                    post.linked ? "有网盘链接" : "链接待核实",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                <small className="muted">
                  {post.paths[0].join(" → ")}
                  {post.copies > 1
                    ? ` · 已合并 ${post.copies} 篇相同资源帖`
                    : ""}
                </small>
                {post.paths.length > 1 ? (
                  <details className="muted">
                    <summary>其他发现路径</summary>
                    {post.paths.slice(1).map((path) => (
                      <div key={path.join("\n")}>{path.join(" → ")}</div>
                    ))}
                  </details>
                ) : null}
              </div>
              <div className="tieba-discovery-growth">
                <strong>
                  {post.growth
                    ? `+${post.growth.delta} 浏览`
                    : `${formatAnalysisCount(post.views)} 浏览`}
                </strong>
                <small className="muted">
                  {post.growth
                    ? `${Math.round((post.growth.to - post.growth.from) / 60000)} 分钟 · 每小时 ${rate.format(post.growth.hourly)}`
                    : "本轮读取"}
                </small>
                {post.rank ? (
                  <small className="muted">
                    同吧同期第 {post.rank.place} / {post.rank.sample}
                    {post.streak > 1 ? ` · 连续 ${post.streak} 轮达标` : ""}
                  </small>
                ) : null}
              </div>
            </li>
          ))}
      </ul>
      <Pagination
        page={current}
        pageSize={pageSize}
        total={items.length}
        onPageChange={setPage}
        label="资源帖分页"
      />
    </>
  );
}
