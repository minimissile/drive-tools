import { ArrowUpRight, Radar } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import {
  tiebaDiscoveryPotentialPageSize,
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
import { Switch } from "../ui/Switch";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import {
  formatAnalysisCount,
  formatAnalysisTime,
} from "./AnalysisThreadsTable";
import "./resource-discovery.css";

const draftSchema = z.object({ seeds: z.string().max(2048).nullable() });
const datetime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
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
    { seeds: null },
    draftSchema.parse,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  const state = snapshot.data;

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
              <label className="tieba-discovery-auto">
                每小时自动扫描
                <Switch
                  aria-label="每小时自动扫描"
                  checked={state.auto}
                  disabled={
                    pending || (!state.auto && draft.value.seeds !== null)
                  }
                  onCheckedChange={(enabled) =>
                    void action(() => ipc("tieba.discovery.auto", { enabled }))
                  }
                />
              </label>
            }
          >
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
                  const updated = await ipc("tieba.discovery.seeds", { seeds });
                  draft.update({ seeds: null });
                  return updated;
                });
              }}
            >
              <Field label="种子贴吧（每行一个，最多五个）">
                <textarea
                  rows={3}
                  maxLength={2048}
                  disabled={pending}
                  value={draft.value.seeds ?? state.seeds.join("\n")}
                  onChange={(event) =>
                    draft.update({ seeds: event.target.value })
                  }
                />
              </Field>
              <div className="tieba-discovery-actions">
                <Button
                  type="submit"
                  disabled={state.busy || pending || draft.value.seeds === null}
                >
                  保存种子
                </Button>
                <Button
                  primary
                  disabled={state.busy || pending || draft.value.seeds !== null}
                  onClick={() => void action(() => ipc("tieba.discovery.scan"))}
                >
                  {state.busy ? "正在扫描…" : "扫描一轮"}
                </Button>
              </div>
            </form>
            <p className="muted tieba-discovery-note">
              从种子吧发现作者和新贴吧，追踪最近 48
              小时内读到的公开资源帖。潜力帖会自动入库，并在工作台运行期间优先复查。
            </p>
            {state.nextAt !== null ? (
              <small className="muted">
                下次扫描 {datetime.format(state.nextAt)}
              </small>
            ) : null}
            {state.busy ? <Loading label="正在读取贴吧并更新候选…" /> : null}
            {draft.error ? <Notice warning>{draft.error}</Notice> : null}
            {error ? <Notice danger>{error}</Notice> : null}
          </Panel>
          <DiscoveryResults state={state} />
        </>
      ) : null}
    </div>
  );
}

type DiscoveryTab = "potential" | "trending" | "watching" | "sources";

function DiscoveryResults({ state }: { state: TiebaDiscoverySnapshot }) {
  const { command } = useAppActions();
  const [tab, setTab] = useState<DiscoveryTab>("potential");
  const last = state.lastRun;
  return (
    <Panel
      title="发现结果"
      extra={
        last ? (
          <small className="muted">上轮 {datetime.format(last.at)}</small>
        ) : null
      }
    >
      {last ? (
        <p className="muted tieba-discovery-note">
          读到 {last.forums} 个贴吧 · 复查 {last.authors} 位作者 · 新发现{" "}
          {last.added} 个贴吧
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
      <Tabs<DiscoveryTab>
        className="tieba-analysis-tabs"
        value={tab}
        onChange={setTab}
      >
        <TabList
          label="资源发现结果"
          items={[
            [
              "potential",
              state.potentialCount == null
                ? "潜力帖"
                : `潜力帖 ${state.potentialCount}`,
            ],
            ["trending", `近期上涨 ${state.trending.length}`],
            ["watching", `观察中 ${state.watching.length}`],
            ["sources", `来源贴吧 ${state.sources.length}`],
          ]}
        />
        <TabPanel value="potential" keepMounted>
          <PotentialPosts enabled={tab === "potential"} revision={last?.at} />
        </TabPanel>
        <TabPanel value="trending" keepMounted>
          <DiscoveryPosts
            items={state.trending}
            empty={last ? "暂未发现达到增长门槛的帖子" : "扫描后开始记录浏览量"}
          />
        </TabPanel>
        <TabPanel value="watching" keepMounted>
          <DiscoveryPosts items={state.watching} empty="暂无观察中的资源帖" />
        </TabPanel>
        <TabPanel value="sources" keepMounted>
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
                  </div>
                  <small className="muted">
                    {source.status === "seed"
                      ? "种子贴吧"
                      : source.status === "active"
                        ? "常规监测"
                        : "观察中"}
                  </small>
                </li>
              );
            })}
          </ul>
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

function PotentialPosts({
  enabled,
  revision,
}: {
  enabled: boolean;
  revision?: number;
}) {
  const { command } = useAppActions();
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useIpcQuery(
    "tieba.discovery.potential",
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
        <LoadingState label="正在读取潜力帖…" compact />
      ) : null}
      {data && !data.items.length ? (
        <Empty icon={Radar} title="潜力帖库暂无记录" compact>
          扫描时按同吧同期的浏览量和已返回的互动数据筛选，符合条件的帖子会自动入库。
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
                  <small className="muted">
                    {post.first.comparedInteractions
                      ? "入库时综合"
                      : "入库时浏览量"}
                    同吧同期第 {post.first.rank.place} /{" "}
                    {post.first.rank.sample}
                    {post.first.comparedInteractions
                      ? ` · 浏览量第 ${post.first.viewRank.place}`
                      : ""}
                    {` · ${post.confirmedAt ? "已确认上涨" : post.active ? "优先复查" : "已归档"}`}
                  </small>
                  <small className="muted">
                    入库 {formatAnalysisTime(post.first.at)} · 最近读取{" "}
                    {formatAnalysisTime(post.checkedAt)}
                  </small>
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
            label="潜力帖分页"
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
                    : "等待下一次读数"}
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
