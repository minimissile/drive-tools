import { useEffect, useState } from "react";
import { BookmarkPlus, ExternalLink, LoaderCircle, Search } from "lucide-react";
import { baiduKeywordColumns } from "../../../shared/baidu-keywords";
import {
  useAppActions,
  useAppData,
  useAppSelection,
  useAppNavigation,
} from "../../state";
import { Button, Empty, Field, Notice, Panel } from "../../ui/primitives";
import { Loading, LoadingState, DataState } from "../../ui/DataState";
import { QueryError } from "../../ui/QueryError";
import { Select } from "../../ui/Select";
import { Pagination } from "../../ui/Pagination";
import { SelectionCheckbox } from "../../ui/SelectionCheckbox";
import { updateSelection } from "../../lib/selection";
import { formatTime } from "../../lib/format";
import { useBaiduKeywords } from "./useBaiduKeywords";
import { BaiduRegions } from "./BaiduRegions";
import { BaiduBusinessSelector } from "./BaiduBusinessSelector";
import { baiduMetric } from "./options";
import "./baidu-keywords.css";

const views = {
  core: ["averageMonthPv", "competition", "recommendPrice"],
  devices: [
    "averageMonthPvMobile",
    "averageMonthPvPc",
    "recommendPriceMobile",
    "recommendPricePc",
  ],
  forecast: ["show", "click", "intention", "intentionLevel"],
  reasons: ["showReasons", "groupName", "competitionPc", "competitionWise"],
  custom: [] as string[],
};
export default function BaiduKeywords({
  onOpenKnowledge,
  incomingSeeds,
}: {
  onOpenKnowledge(): void;
  incomingSeeds?: { id: number; words: string[] } | null;
}) {
  const { data } = useAppData();
  return (
    <BaiduKeywordWorkspace
      key={data!.dataPath}
      workspace={data!.dataPath}
      onOpenKnowledge={onOpenKnowledge}
      incomingSeeds={incomingSeeds}
    />
  );
}
function BaiduKeywordWorkspace({
  workspace,
  onOpenKnowledge,
  incomingSeeds,
}: {
  workspace: string;
  onOpenKnowledge(): void;
  incomingSeeds?: { id: number; words: string[] } | null;
}) {
  const model = useBaiduKeywords(workspace);
  const {
    draft,
    accounts,
    choices,
    account,
    accountId,
    latest,
    result,
    pending,
    error,
    query,
  } = model;
  useEffect(() => {
    if (incomingSeeds)
      draft.update({ seeds: incomingSeeds.words.join("\n"), mode: "seed" });
  }, [incomingSeeds?.id]);
  const { command } = useAppActions();
  const { navigate } = useAppNavigation();
  const { resource } = useAppSelection();
  const [filter, setFilter] = useState(""),
    [page, setPage] = useState(1),
    [view, setView] = useState<keyof typeof views>("core");
  const [selection, setSelection] = useState<{ runId: string; ids: string[] }>({
    runId: "",
    ids: [],
  });
  const [saving, setSaving] = useState(false);
  const selected = selection.runId === result?.id ? selection.ids : [];
  const visible = (result?.keywords ?? []).filter((k) =>
    k.word.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(visible.length / 25)),
  );
  const rows = visible.slice((currentPage - 1) * 25, currentPage * 25);
  const columns = baiduKeywordColumns.filter(([key]) =>
    (view === "custom" ? draft.value.columns : views[view]).includes(key),
  );
  const select = (ids: string[], checked: boolean) =>
    setSelection((prior) => ({
      runId: result!.id,
      ids: updateSelection(
        prior.runId === result!.id ? prior.ids : [],
        ids,
        checked,
        1000,
      ),
    }));
  const runQuery = async () => {
    const next = await query();
    if (next) setPage(1);
  };
  return (
    <div className="baidu-keywords-workspace">
      <Panel
        title="百度关键词检索"
        extra={<span className="tag">百度营销 · 关键词规划师</span>}
      >
        <div className="baidu-keyword-query-form">
          <p className="muted">
            按种子词、业务描述、落地页或推广业务拓词，查看搜索量和需求，再保存到词池。
          </p>
          <div className="baidu-keyword-connection">
            <Field label="查询账号" hint="在账号管理中登录后，自动识别身份">
              <Select
                aria-label="百度营销账号"
                value={accountId}
                disabled={pending || !choices.length}
                onValueChange={(value) => {
                  draft.update({ accountId: String(value) });
                  model.clearError();
                }}
                items={
                  choices.length
                    ? choices.map((item) => ({
                        value: item.id,
                        label: `${item.alias}${item.status === "connected" ? "" : " · 需登录"}`,
                      }))
                    : [{ value: "", label: "先在账号管理登录百度营销" }]
                }
              />
            </Field>
            <Button quiet onClick={() => navigate("website-accounts")}>
              <ExternalLink size={15} />
              管理网站账号
            </Button>
          </div>
          <QueryError
            error={accounts.error}
            loading={accounts.loading}
            onRetry={accounts.reload}
            title="无法读取网站账号"
          />
          {accounts.loading && !accounts.data ? (
            <Loading label="正在读取网站账号…" />
          ) : account?.status !== "connected" ? (
            <Notice>
              请在“账号管理 → 网站账号”登录百度营销，检索时直接选择账号。
            </Notice>
          ) : (
            <small>已选择 {account.alias}，查询时由百度核验会话。</small>
          )}
          <div className="baidu-form-grid">
            <Field label="拓词方式">
              <Select
                aria-label="百度拓词方式"
                value={draft.value.mode}
                onValueChange={(mode) =>
                  draft.update({ mode: mode as typeof draft.value.mode })
                }
                items={[
                  { value: "seed", label: "种子词拓词" },
                  { value: "prompt", label: "描述业务生成关键词" },
                  { value: "url", label: "落地页拓词" },
                  { value: "business", label: "推广业务拓词" },
                ]}
              />
            </Field>
            <Field label="返回内容">
              <Select
                aria-label="百度关键词与组合"
                value={draft.value.combinations ? "group" : "word"}
                onValueChange={(v) =>
                  draft.update({ combinations: v === "group" })
                }
                items={[
                  { value: "word", label: "关键词" },
                  { value: "group", label: "关键词组合" },
                ]}
              />
            </Field>
          </div>
          {draft.value.mode === "seed" ? (
            <Field label="种子词" hint="逗号、分号或换行分隔，最多10个种子词">
              <textarea
                aria-label="百度检索种子词"
                maxLength={1100}
                rows={3}
                placeholder="例如：网盘，知识管理，Obsidian"
                value={draft.value.seeds}
                onChange={(e) => draft.update({ seeds: e.target.value })}
                disabled={pending}
              />
            </Field>
          ) : draft.value.mode === "prompt" ? (
            <Field
              label="推广业务描述"
              hint="描述产品、品牌、客户需求等，最多2000字"
            >
              <textarea
                aria-label="百度业务描述"
                rows={4}
                maxLength={2000}
                value={draft.value.prompt}
                disabled={pending}
                onChange={(e) => draft.update({ prompt: e.target.value })}
              />
            </Field>
          ) : draft.value.mode === "url" ? (
            <Field label="落地页地址" hint="基木鱼或健康商城等推广落地页">
              <input
                aria-label="百度拓词落地页"
                type="url"
                maxLength={1024}
                value={draft.value.url}
                disabled={pending}
                onChange={(e) => draft.update({ url: e.target.value })}
              />
            </Field>
          ) : (
            <BaiduBusinessSelector
              accountId={accountId}
              uid={account?.uid}
              name={draft.value.businessName}
              value={draft.value.businessId}
              disabled={pending || account?.status !== "connected"}
              onChange={(businessId, businessName) =>
                draft.update({ businessId, businessName })
              }
            />
          )}
          <BaiduRegions
            value={draft.value.regions}
            disabled={pending}
            onChange={(regions) => draft.update({ regions })}
          />
          <details className="baidu-filter-details">
            <summary>过滤与排序设置</summary>
            <div className="baidu-form-grid">
              <Field label="包含词">
                <input
                  value={draft.value.positive}
                  onChange={(e) => draft.update({ positive: e.target.value })}
                />
              </Field>
              <Field label="排除词">
                <input
                  value={draft.value.negative}
                  onChange={(e) => draft.update({ negative: e.target.value })}
                />
              </Field>
              <Field label="最小月均搜索量">
                <input
                  type="number"
                  min={0}
                  value={draft.value.minimumMonthly}
                  onChange={(e) =>
                    draft.update({ minimumMonthly: e.target.value })
                  }
                />
              </Field>
              <Field label="竞争程度">
                <Select
                  value={draft.value.competition}
                  onValueChange={(competition) => draft.update({ competition })}
                  items={[
                    { value: "", label: "全部竞争程度" },
                    { value: "1", label: "高" },
                    { value: "2", label: "中" },
                    { value: "3", label: "低" },
                  ]}
                />
              </Field>
              <Field label="关键词特色">
                <Select
                  value={draft.value.reason}
                  onValueChange={(reason) => draft.update({ reason })}
                  items={[
                    { value: "", label: "全部特色" },
                    { value: "hot", label: "热搜词" },
                    { value: "rising", label: "黑马词" },
                    { value: "行业激增词", label: "行业激增词" },
                    { value: "行业高转化", label: "行业高转化词" },
                    { value: "搜索联想词", label: "搜索联想词" },
                    { value: "落地页相关词", label: "落地页相关词" },
                  ]}
                />
              </Field>
              <Field label="设备">
                <Select
                  value={draft.value.device}
                  onValueChange={(v) =>
                    draft.update({ device: Number(v) as 0 | 1 | 2 })
                  }
                  items={[
                    { value: 0, label: "全部设备" },
                    { value: 1, label: "计算机" },
                    { value: 2, label: "移动" },
                  ]}
                />
              </Field>
              <Field label="排序指标">
                <Select
                  value={draft.value.sort}
                  onValueChange={(v) =>
                    draft.update({ sort: v as typeof draft.value.sort })
                  }
                  items={[
                    { value: "averageMonthPv", label: "月均搜索量" },
                    { value: "recommendPrice", label: "点击指导价" },
                  ]}
                />
              </Field>
              <Field label="排序方向">
                <Select
                  value={draft.value.descending ? "desc" : "asc"}
                  onValueChange={(v) =>
                    draft.update({ descending: v === "desc" })
                  }
                  items={[
                    { value: "desc", label: "从高到低" },
                    { value: "asc", label: "从低到高" },
                  ]}
                />
              </Field>
            </div>
            <div className="row wrap">
              <label>
                <input
                  type="checkbox"
                  checked={draft.value.regionExtend}
                  onChange={(e) =>
                    draft.update({ regionExtend: e.target.checked })
                  }
                />{" "}
                包含地域词
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.value.removeDuplicate}
                  onChange={(e) =>
                    draft.update({ removeDuplicate: e.target.checked })
                  }
                />{" "}
                不包含账户已购词
              </label>
            </div>
          </details>
          <div className="row spread">
            <small>单次最多返回3000词 · 月搜索量大于10自动入库</small>
            <Button
              primary
              disabled={
                account?.status !== "connected" ||
                !(draft.value.mode === "seed"
                  ? draft.value.seeds.trim()
                  : draft.value.mode === "prompt"
                    ? draft.value.prompt.trim()
                    : draft.value.mode === "url"
                      ? draft.value.url.trim()
                      : draft.value.businessId &&
                        draft.value.businessName.trim()) ||
                pending
              }
              onClick={() => void runQuery()}
            >
              {pending ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Search size={16} />
              )}
              {pending ? "正在检索…" : "检索百度关键词"}
            </Button>
          </div>
          {draft.error ? <Notice warning>{draft.error}</Notice> : null}
          {error ? (
            <DataState kind="error" title="百度查询未完成" compact>
              {error}
            </DataState>
          ) : null}
        </div>
      </Panel>
      <Panel
        title="检索结果"
        extra={
          result ? (
            <small>{formatTime(result.fetchedAt)} · 最近一次成功查询</small>
          ) : undefined
        }
      >
        {result?.knowledge ? (
          <Notice>
            本次 {result.knowledge.indexed.toLocaleString()}{" "}
            个词符合月均搜索量大于10的收录规则，已入库或更新。
            {result.knowledge.refreshedBelowThreshold
              ? `另更新${result.knowledge.refreshedBelowThreshold}个已收录的低搜索量词。`
              : ""}
            <Button quiet onClick={onOpenKnowledge}>
              查看本地词库
            </Button>
          </Notice>
        ) : null}
        {result?.knowledgeWarning ? (
          <Notice warning>
            {result.knowledgeWarning}
            <Button quiet disabled={latest.loading} onClick={latest.reload}>
              重试本地入库
            </Button>
          </Notice>
        ) : null}
        {result?.warning ? <Notice warning>{result.warning}</Notice> : null}
        {latest.error && !result ? (
          <QueryError
            error={latest.error}
            loading={latest.loading}
            onRetry={latest.reload}
            title="无法读取本地查询记录"
          />
        ) : null}
        {pending && result ? (
          <Loading label="正在查询，保留上次成功结果…" />
        ) : null}
        {(pending || (!!accountId && latest.loading)) && !result ? (
          <LoadingState
            label={pending ? "正在检索百度关键词…" : "正在读取最近查询…"}
          />
        ) : !result ? (
          !latest.error ? (
            <Empty title="从一个种子词开始">
              输入主题并点击检索，百度返回的搜索需求会显示在这里。
            </Empty>
          ) : null
        ) : (
          <>
            <div className="row spread baidu-keyword-toolbar">
              <div>
                <strong>
                  {result.keywords.length.toLocaleString()} 个关键词
                </strong>
                <small>
                  {" "}
                  · 百度报告总数 {result.total.toLocaleString()} ·{" "}
                  {result.input.seeds.join("、")}
                </small>
              </div>
              <Select
                aria-label="百度关键词展示指标"
                value={view}
                onValueChange={(v) => setView(v as keyof typeof views)}
                items={[
                  { value: "core", label: "核心指标" },
                  { value: "devices", label: "设备拆分" },
                  { value: "forecast", label: "投放预估与意图" },
                  { value: "reasons", label: "特色与关键词组合" },
                  { value: "custom", label: "自定义展示列" },
                ]}
              />
            </div>
            <details className="baidu-filter-details">
              <summary>自定义展示列</summary>
              <div className="baidu-region-options">
                {baiduKeywordColumns.map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={draft.value.columns.includes(key)}
                      onChange={(e) => {
                        draft.update({
                          columns: e.target.checked
                            ? [...draft.value.columns, key]
                            : draft.value.columns.filter((c) => c !== key),
                        });
                        setView("custom");
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </details>
            <Button
              quiet
              onClick={() =>
                void command(
                  "baiduKeywords.export",
                  { accountId, resultId: result.id },
                  "本次全部关键词已导出",
                )
              }
            >
              导出本次全部关键词
            </Button>
            <Field label="筛选已返回关键词">
              <input
                aria-label="筛选百度关键词"
                value={filter}
                placeholder="输入关键词，在本次结果中筛选"
                maxLength={200}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            {!result.keywords.length ? (
              <Empty title="本次检索没有返回关键词">
                换一个主题词后再手动检索。
              </Empty>
            ) : !visible.length ? (
              <Empty title="没有符合筛选条件的关键词">
                清空或调整筛选条件可查看原结果。
              </Empty>
            ) : (
              <>
                <div className="baidu-keyword-table-scroll">
                  <table className="baidu-keyword-table" data-view={view}>
                    <thead>
                      <tr>
                        <th>
                          <SelectionCheckbox
                            aria-label="选择本页百度关键词"
                            selected={
                              rows.filter((k) => selected.includes(k.id)).length
                            }
                            total={rows.length}
                            onChange={(e) =>
                              select(
                                rows.map((k) => k.id),
                                e.target.checked,
                              )
                            }
                          />
                        </th>
                        <th>关键词</th>
                        {columns.map(([key, label]) => (
                          <th key={key}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`选择百度关键词 ${row.word}`}
                              checked={selected.includes(row.id)}
                              onChange={(e) =>
                                select([row.id], e.target.checked)
                              }
                            />
                          </td>
                          <td>{row.word}</td>
                          {columns.map(([key]) => (
                            <td key={key}>
                              {baiduMetric(row.metrics[key], key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  label="百度关键词分页"
                  page={currentPage}
                  pageSize={25}
                  total={visible.length}
                  onPageChange={setPage}
                />
              </>
            )}
            <div className="baidu-keyword-save">
              <Field label="百度词池名称">
                <input
                  aria-label="百度词池名称"
                  value={draft.value.name}
                  maxLength={100}
                  placeholder="留空使用本次种子词命名"
                  onChange={(e) => draft.update({ name: e.target.value })}
                />
              </Field>
              <Button
                disabled={!selected.length || saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await command(
                      "pool.save",
                      {
                        name:
                          draft.value.name.trim() ||
                          `${(result.input.seeds[0] || result.input.prompt || result.input.business?.businessPointName || "落地页").slice(0, 70)} · 百度关键词`,
                        resourceId: resource?.id ?? null,
                        keywords: result.keywords.filter((k) =>
                          selected.includes(k.id),
                        ),
                      },
                      "百度关键词已保存，可在“找词与词池”中使用。",
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <BookmarkPlus size={15} />
                {saving ? "正在保存…" : `保存已选 ${selected.length} 词`}
              </Button>
            </div>
            <small>
              最多选择1000词，跨页保留选择。
              {resource
                ? `保存时关联当前资源：${resource.title}。`
                : "保存后可在创作时选择词池。"}
              “—”表示百度未返回此项；预估数据仅供投放参考。
            </small>
          </>
        )}
      </Panel>
    </div>
  );
}
