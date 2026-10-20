import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { useIpcQuery } from "../api/useIpcQuery";
import { Pagination } from "../ui/Pagination";

import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, FilePenLine, Plus } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
  Panel,
  SearchField,
} from "../ui/primitives";
import { formatTime } from "../lib/format";
import { platformSpecs } from "../../shared/platforms";

import type { SearchTopic, TopicStage } from "../../shared/search";
import {
  BindingDialog,
  CreateTopicDialog,
  PoolTopicDialog,
} from "../search/Dialogs";
import { Effects } from "../search/Effects";
const stageNames = {
  unbound: "待关联资料",
  writing: "待创作与审阅",
  published: "已发布",
};
const platformName = (id: string) =>
  platformSpecs.find((p) => p.id === id)?.name ?? id;
export default function SearchOperations() {
  const { data } = useAppData(),
    { select } = useAppSelection(),
    { searchFocus, openDraft, navigate } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [view, setView] = useState<"board" | "list" | "effects">("board"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [stage, setStage] = useState<"all" | TopicStage>("all"),
    [topicId, setTopicId] = useState(""),
    [dialog, setDialog] = useState<"create" | "pool" | "binding" | null>(null),
    [revision, setRevision] = useState(0),
    [seed, setSeed] = useState<
      { copyId: string; splitItemId?: string } | undefined
    >();
  useEffect(() => {
    if (searchFocus?.topicId) {
      setTopicId(searchFocus.topicId);
      setDialog(null);
    } else if (searchFocus?.poolId) {
      setDialog("pool");
      setTopicId("");
    } else if (searchFocus?.copyId) {
      setSeed({
        copyId: searchFocus.copyId,
        splitItemId: searchFocus.splitItemId,
      });
      setDialog("create");
      setTopicId("");
    } else if (searchFocus) {
      setTopicId("");
      setDialog(null);
      setSeed(undefined);
    }
  }, [searchFocus]);
  const relatedData = useMemo(
    () => ({
      resources: data?.resources,
      drafts: data?.drafts,
      publications: data?.publications,
      pools: data?.pools,
      bindings: data?.bindings,
    }),
    [
      data?.resources,
      data?.drafts,
      data?.publications,
      data?.pools,
      data?.bindings,
    ],
  );
  const {
    data: result,
    loading,
    error,
    reload: retryList,
  } = useIpcQuery(
    "search.list",
    {
      query,
      page,
      pageSize: 60,
      stage: view === "effects" ? "published" : stage,
    },
    {
      delay: 150,
      revision,
      invalidate: relatedData,
      keepPrevious: true,
    },
  );
  const {
    data: detail,
    error: detailError,
    reload: retryDetail,
  } = useIpcQuery(
    "search.get",
    { id: topicId },
    {
      enabled: !!topicId,
      revision,
      invalidate: relatedData,
    },
  );
  const reload = () => setRevision((n) => n + 1);
  const selectTopic = (topic: SearchTopic) => {
    setTopicId(topic.id);
    setDialog(topic.copyId ? null : "binding");
  };
  const write = async (
    topic: SearchTopic,
    destination: "studio" | "publish" = "studio",
  ) => {
    if (!topic.copyId) {
      setTopicId(topic.id);
      setDialog("binding");
      return;
    }
    const draft = await command("search.write", { id: topic.id });
    if (draft) openDraft(draft, destination);
  };
  const hasDetail = !!topicId;
  return (
    <>
      <Header
        title={hasDetail ? "从一个搜索问题，完成一篇有用的文章。" : "搜索运营"}
        description={
          hasDetail
            ? "关键词、配套本人资料、草稿与发布效果保持关联。"
            : "把选题、资料、内容和效果放在一条工作流中。"
        }
        action={
          !hasDetail ? (
            <Button
              primary
              onClick={() => {
                setSeed(undefined);
                setDialog("create");
              }}
            >
              <Plus size={15} />
              新建选题
            </Button>
          ) : (
            <Button
              onClick={() => {
                setTopicId("");
                setDialog(null);
              }}
            >
              <ArrowLeft size={14} />
              返回选题
            </Button>
          )
        }
      />
      <QueryError error={error} loading={loading} onRetry={retryList} />
      <QueryError error={detailError} onRetry={retryDetail} />
      {!hasDetail ? (
        <Tabs
          value={view}
          onChange={(next) => {
            setView(next);
            setPage(1);
          }}
        >
          <TabList
            label="搜索运营视图"
            items={[
              ["board", "运营看板"],
              ["list", "全部选题"],
              ["effects", "发布与效果"],
            ]}
          />
          <TabPanel value={view}>
            <div className="toolbar search-operations-toolbar">
              <SearchField
                loading={loading}
                value={query}
                onChange={(v) => {
                  setQuery(v);
                  setPage(1);
                }}
                placeholder="搜索关键词、意图或资料标题…"
              />
              {view !== "effects" ? (
                <Select
                  aria-label="选题进度"
                  value={stage}
                  onValueChange={(nextValue) => {
                    setStage(nextValue as typeof stage);
                    setPage(1);
                  }}
                  items={[
                    { value: "all", label: "全部进度" },
                    ...Object.entries(stageNames).map(([id, label]) => ({
                      value: id,
                      label: label,
                    })),
                  ]}
                />
              ) : null}
              <Button
                onClick={() => setDialog("pool")}
                disabled={!data!.pools.length}
              >
                从词池创建
              </Button>
              <Button quiet onClick={() => navigate("traffic")}>
                整理词池 <ArrowRight size={14} />
              </Button>
            </div>
            {loading && (!result || !result.total) ? (
              <LoadingState label="正在读取搜索选题…" />
            ) : result?.total ? (
              <>
                {view === "board" ? (
                  <div className="search-board" aria-busy={loading}>
                    {(Object.keys(stageNames) as TopicStage[]).map((key) => (
                      <section
                        className="search-lane"
                        key={key}
                        aria-label={stageNames[key]}
                      >
                        <div className="row spread">
                          <h2>{stageNames[key]}</h2>
                          <small>{result.counts[key]}</small>
                        </div>
                        {result.items
                          .filter((t) => t.stage === key)
                          .map((t) => (
                            <button
                              type="button"
                              className="search-topic-card"
                              key={t.id}
                              onClick={() => selectTopic(t)}
                            >
                              <span className="tag">
                                {platformName(t.platform)} ·{" "}
                                {t.intent || "待补充意图"}
                              </span>
                              <strong>{t.keyword}</strong>
                              <small>{t.resourceTitle ?? "尚未关联资料"}</small>
                              <small>
                                {t.targetPath ?? "选择整份资料或本人拆分链接"}
                              </small>
                              {t.attention.length ? (
                                <span className="search-attention">
                                  {t.attention[0]}
                                </span>
                              ) : null}
                              <span className="search-card-action">
                                {t.stage === "unbound"
                                  ? "关联资料"
                                  : t.stage === "published"
                                    ? "查看效果"
                                    : t.reviewed
                                      ? "准备发布"
                                      : "继续创作"}{" "}
                                →
                              </span>
                            </button>
                          ))}
                        {!result.items.some((t) => t.stage === key) ? (
                          <p className="muted">当前页暂无选题</p>
                        ) : null}
                      </section>
                    ))}
                  </div>
                ) : (
                  <Panel
                    title={view === "effects" ? "已发布选题" : "全部搜索选题"}
                  >
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>关键词 / 意图</th>
                            <th>平台</th>
                            <th>配套资料</th>
                            <th>进度</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.items.map((t) => (
                            <tr key={t.id}>
                              <td>
                                <strong>{t.keyword}</strong>
                                <small>{t.intent || "待补充意图"}</small>
                              </td>
                              <td>{platformName(t.platform)}</td>
                              <td>
                                {t.resourceTitle ?? "待关联"}
                                <small>{t.targetPath}</small>
                              </td>
                              <td>
                                {stageNames[t.stage]}
                                {t.reviewed && t.stage === "writing" ? (
                                  <small>已审阅，待发布</small>
                                ) : null}
                                {t.attention.map((x) => (
                                  <small key={x} className="search-attention">
                                    {x}
                                  </small>
                                ))}
                              </td>
                              <td>
                                <Button quiet onClick={() => selectTopic(t)}>
                                  {view === "effects" ? "查看效果" : "查看选题"}{" "}
                                  →
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}
                <Pagination
                  label="搜索选题翻页"
                  className="search-pagination"
                  page={result.page}
                  pageSize={60}
                  total={result.total}
                  disabled={loading}
                  onPageChange={setPage}
                >
                  第 {result.page} / {Math.max(1, Math.ceil(result.total / 60))}{" "}
                  页 · 共 {result.total} 个选题
                </Pagination>
              </>
            ) : error ? null : (
              <Empty
                title={
                  view === "effects"
                    ? "还没有已发布的搜索选题"
                    : query
                      ? "没有匹配选题"
                      : "从一个关键词开始"
                }
                action={
                  <Button
                    primary
                    onClick={() => {
                      setSeed(undefined);
                      setDialog("create");
                    }}
                  >
                    新建搜索选题
                  </Button>
                }
              >
                可以从已有词池选择，也可以手工录入关键词。创建选题不调用付费接口。
              </Empty>
            )}
          </TabPanel>
        </Tabs>
      ) : detailError ? null : !detail ? (
        <LoadingState label="正在读取选题与历史记录…" />
      ) : (
        <>
          <Panel className="search-topic-summary">
            <div className="row spread">
              <div>
                <span className="tag">
                  {platformName(detail.topic.platform)} ·{" "}
                  {stageNames[detail.topic.stage]}
                </span>
                <h2>{detail.topic.keyword}</h2>
                <p>
                  {detail.topic.resourceTitle ?? "尚未关联资料"}
                  {detail.topic.targetPath
                    ? ` / ${detail.topic.targetPath}`
                    : ""}
                </p>
              </div>
              <Button disabled={busy > 0} onClick={() => setDialog("binding")}>
                更换配套资料
              </Button>
            </div>
            {detail.topic.attention.map((text) => (
              <Notice key={text} warning>
                {text}
              </Notice>
            ))}
            <div className="search-workflow">
              <Button onClick={() => setDialog("binding")}>
                1 · 关联本人资料
              </Button>
              <Button
                disabled={busy > 0}
                onClick={() => void write(detail.topic)}
              >
                2 · {detail.draft ? "继续编辑文章" : "创建教程草稿"}
              </Button>
              <Button
                disabled={!detail.draft || busy > 0}
                onClick={() => void write(detail.topic, "publish")}
              >
                3 · 去发布准备
              </Button>
              <Button
                onClick={() =>
                  document
                    .getElementById("search-effects")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                4 · 发布效果
              </Button>
            </div>
          </Panel>
          <div className="form-layout">
            <div>
              <Panel
                title="文章与发布记录"
                extra={
                  detail.draft ? (
                    <span className="tag">
                      v{detail.draft.version} ·{" "}
                      {detail.draft.reviewed ? "已审阅" : "待审阅"}
                    </span>
                  ) : null
                }
              >
                {detail.draft ? (
                  <>
                    <h3>{detail.draft.title}</h3>
                    <p className="muted">
                      {detail.draft.body.slice(0, 200)}
                      {detail.draft.body.length > 200 ? "…" : ""}
                    </p>
                    <div className="actions">
                      <Button
                        primary
                        disabled={busy > 0}
                        onClick={() => void write(detail.topic)}
                      >
                        <FilePenLine size={15} />
                        在内容工作室编辑
                      </Button>
                    </div>
                  </>
                ) : (
                  <Empty
                    title="还没有文章草稿"
                    action={
                      <Button
                        primary
                        disabled={!detail.topic.copyId || busy > 0}
                        onClick={() => void write(detail.topic)}
                      >
                        使用本地教程模板
                      </Button>
                    }
                  >
                    先关联本人资料，模板会保留待填写步骤和截图。
                  </Empty>
                )}
                {detail.publications.map((p) => (
                  <div className="search-publication" key={p.id}>
                    <strong>人工确认已发布 · v{p.draftVersion}</strong>
                    <span className="break-word">{p.url}</span>
                    <small>{formatTime(p.createdAt)}</small>
                  </div>
                ))}
              </Panel>
              <div id="search-effects">
                <Effects detail={detail} onSaved={reload} />
              </div>
            </div>
            <div>
              <TopicFacts
                key={`${detail.topic.id}:${detail.topic.updatedAt}`}
                topic={detail.topic}
                onSaved={reload}
              />
              <Panel title="配套资料维护">
                <p>{detail.topic.targetPath ?? "尚未关联本人资料"}</p>
                <div className="actions">
                  <Button
                    disabled={!detail.topic.copyId || busy > 0}
                    onClick={async () => {
                      const r = await command("search.check", {
                        id: detail.topic.id,
                      });
                      if (r) {
                        notify(
                          "配套分享检查已完成，请查看最新状态。",
                          "success",
                        );
                        reload();
                      }
                    }}
                  >
                    核验配套分享
                  </Button>
                  <Button
                    quiet
                    onClick={() => {
                      if (detail.topic.resourceId && detail.topic.copyId)
                        select(detail.topic.resourceId, detail.topic.copyId);
                      navigate("split");
                    }}
                  >
                    进入资料拆分
                  </Button>
                </div>
                <small>
                  链接失效、文件变更或资源资料更新时，在这里提示需要复查的文章。
                </small>
              </Panel>
            </div>
          </div>
        </>
      )}
      {dialog === "create" ? (
        <CreateTopicDialog
          seed={seed}
          topics={result?.items ?? []}
          onClose={() => {
            setDialog(null);
            setSeed(undefined);
          }}
          onSaved={async (topic) => {
            setTopicId(topic.id);
            setSeed(undefined);
            setDialog(null);
            reload();
            if (seed) {
              const draft = await command("search.write", {
                id: topic.id,
              });
              if (draft) openDraft(draft);
            } else if (!topic.copyId) setDialog("binding");
          }}
        />
      ) : null}
      {dialog === "pool" ? (
        <PoolTopicDialog
          poolId={searchFocus?.poolId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
      {dialog === "binding" && detail ? (
        <BindingDialog
          key={detail.topic.id}
          topic={detail.topic}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}
function TopicFacts({
  topic,
  onSaved,
}: {
  topic: SearchTopic;
  onSaved(): void;
}) {
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    [intent, setIntent] = useState(topic.intent),
    [version, setVersion] = useState(topic.softwareVersion),
    [system, setSystem] = useState(topic.operatingSystem),
    [evidence, setEvidence] = useState(topic.evidence);
  const dirty =
    intent !== topic.intent ||
    version !== topic.softwareVersion ||
    system !== topic.operatingSystem ||
    evidence !== topic.evidence;
  return (
    <Panel title="教程依据">
      <Field label="搜索意图">
        <input
          maxLength={100}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
        />
      </Field>
      <div className="field-pair">
        <Field label="软件版本">
          <input
            maxLength={100}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="待本人核对"
          />
        </Field>
        <Field label="适用系统">
          <input
            maxLength={100}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="例如 Windows 11"
          />
        </Field>
      </div>
      <Field label="本人操作记录与依据">
        <textarea
          maxLength={10000}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="填写实际步骤、可核对的事实、截图说明与限制"
        />
      </Field>
      <small>
        更新依据后，现有草稿需要重新审阅。AI生成仅使用你提供的资料。
      </small>
      <div className="actions">
        <Button
          disabled={!dirty || busy > 0}
          onClick={async () => {
            if (
              await command(
                "search.facts",
                {
                  id: topic.id,
                  intent,
                  softwareVersion: version,
                  operatingSystem: system,
                  evidence,
                },
                "教程依据已保存，请核对草稿。",
              )
            )
              onSaved();
          }}
        >
          保存依据
        </Button>
      </div>
    </Panel>
  );
}
