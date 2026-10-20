import { Select } from "../ui/Select";
import { updateSelection } from "../lib/selection";
import { ipc } from "../api/client";
import { useEffect, useState } from "react";
import {
  ArrowDown,
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppSelection,
} from "../state";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { formatTime } from "../lib/format";
import type { IdeaContext, IdeaInput, IdeaRun } from "../../shared/ideas";
import { platformSpecs } from "../../shared/platforms";

const kinds = { seed: "种子词", longtail: "长尾词", question: "自然问句" };
const intents = {
  learn: "认知了解",
  howto: "操作教程",
  troubleshoot: "问题排查",
  compare: "比较分析",
  choose: "选择决策",
  template: "模板应用",
};
const priorities = { high: "优先创作", medium: "适合补充", low: "待补资料" };
export default function KeywordIdeas({
  seeds,
  onAppend,
}: {
  seeds: string;
  onAppend(words: string[]): boolean;
}) {
  const { data } = useAppData(),
    { resource } = useAppSelection(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [open, setOpen] = useState(false),
    [topic, setTopic] = useState(seeds),
    [bound, setBound] = useState(true),
    [audience, setAudience] = useState(""),
    [objective, setObjective] = useState(""),
    [focus, setFocus] = useState<IdeaInput["focus"]>("balanced"),
    [channel, setChannel] = useState<IdeaInput["channel"]>("all"),
    [count, setCount] = useState<12 | 20>(12),
    [useLocal, setUseLocal] = useState(true),
    [context, setContext] = useState<IdeaContext | null>(null),
    [history, setHistory] = useState<IdeaRun[]>([]),
    [run, setRun] = useState<IdeaRun | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [poolName, setPoolName] = useState(""),
    [generating, setGenerating] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void ipc("ai.ideas.history")
      .then((r) => {
        if (alive) {
          setHistory(r);
          setRun((prior) => prior ?? r[0] ?? null);
        }
      })
      .catch((e) => {
        if (alive) notify(e.message, "error");
      });
    return () => {
      alive = false;
    };
  }, [open, notify]);
  const input = (): IdeaInput => ({
    resourceId: bound ? (resource?.id ?? null) : null,
    seeds: topic
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
    audience,
    objective,
    focus,
    channel,
    count,
    useLocal,
  });
  const generate = async () => {
    setGenerating(true);
    const result = await command("ai.ideas.generate", input());
    setGenerating(false);
    if (!result) return;
    setRun(result);
    setContext(result.context);
    setSelected([]);
    setFilter("all");
    setSearch("");
    setHistory((prior) =>
      [result, ...prior.filter((r) => r.id !== result.id)].slice(0, 20),
    );
    notify("候选词已保存为本地联想历史。尚未调用5118，未验证流量。", "success");
  };
  const visible =
    run?.candidates.filter(
      (c) =>
        (filter === "all" || c.kind === filter) &&
        `${c.word} ${c.cluster} ${c.angle}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  const groups = [...new Set(visible.map((c) => c.cluster))];
  const chosen = run?.candidates.filter((c) => selected.includes(c.id)) ?? [];
  const save = async () => {
    if (!run) return;
    const saved = await command(
      "ai.ideas.save",
      {
        runId: run.id,
        selected,
        name:
          poolName.trim() ||
          `${run.context.resource?.title.slice(0, 22) || run.context.input.seeds[0] || "内容营销"} · AI候选`,
      },
      "已保存为待验证词池，保留内容思路与本地依据。",
    );
    if (saved) setPoolName("");
  };
  return (
    <Panel
      title="AI 流量词联想"
      extra={
        <Button
          quiet
          onClick={() => {
            if (!open && !topic.trim()) setTopic(seeds);
            setOpen((v) => !v);
          }}
          aria-expanded={open}
        >
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}{" "}
          {open ? "收起联想" : "配置与联想"}
        </Button>
      }
    >
      <div className="idea-intro">
        <Lightbulb size={19} />
        <div>
          <strong>从已有积累，找到下一篇值得写的内容。</strong>
          <p>资源与本地词库 → SEO / GEO 内容机会 → 选择候选 → 5118 验证</p>
        </div>
        <span className="tag">AI 建议 · 非流量实测</span>
      </div>
      {open ? (
        <div className="idea-workspace">
          <fieldset className="fields idea-form" disabled={generating}>
            <Field
              label="主题 / 起始词"
              hint="逗号或换行分隔，最多10个；也可仅关联资源"
            >
              <textarea
                aria-label="AI联想主题"
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value);
                  setContext(null);
                }}
                placeholder="例如：Obsidian，新手知识管理，读书笔记"
                maxLength={1200}
              />
            </Field>
            <div className="row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={bound}
                  disabled={!resource}
                  onChange={(e) => {
                    setBound(e.target.checked);
                    setContext(null);
                  }}
                />
                结合当前资源
                {resource ? `：${resource.title}` : "（未选择资源）"}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={useLocal}
                  onChange={(e) => {
                    setUseLocal(e.target.checked);
                    setContext(null);
                  }}
                />
                使用本地词池与历史长尾词
              </label>
            </div>
            <div className="field-pair">
              <Field label="目标受众">
                <input
                  aria-label="AI联想目标受众"
                  value={audience}
                  onChange={(e) => {
                    setAudience(e.target.value);
                    setContext(null);
                  }}
                  placeholder="例如：刚开始整理个人知识库的职场新人"
                  maxLength={200}
                />
              </Field>
              <Field label="内容目标">
                <input
                  aria-label="AI联想内容目标"
                  value={objective}
                  onChange={(e) => {
                    setObjective(e.target.value);
                    setContext(null);
                  }}
                  placeholder="例如：用可操作的教程吸引读者，配套提供原创模板"
                  maxLength={600}
                />
              </Field>
            </div>
            <div className="idea-options">
              <Field label="策略侧重">
                <Select
                  aria-label="AI联想策略"
                  value={focus}
                  onValueChange={(nextValue) => {
                    setFocus(nextValue as typeof focus);
                    setContext(null);
                  }}
                  items={[
                    { value: "balanced", label: "SEO + GEO 均衡" },
                    { value: "seo", label: "SEO：主题簇与搜索长尾" },
                    { value: "geo", label: "GEO：自然问句与答案依据" },
                  ]}
                />
              </Field>
              <Field label="内容平台">
                <Select
                  aria-label="AI联想内容平台"
                  value={channel}
                  onValueChange={(nextValue) => {
                    setChannel(nextValue as typeof channel);
                    setContext(null);
                  }}
                  items={[
                    { value: "all", label: "多平台内容" },
                    ...platformSpecs.map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  ]}
                />
              </Field>
              <Field label="候选数量">
                <Select
                  aria-label="AI联想候选数量"
                  value={count}
                  onValueChange={(nextValue) => {
                    setCount(Number(nextValue) as 12 | 20);
                    setContext(null);
                  }}
                  items={[
                    { value: "12", label: "最多12个 · 聚焦" },
                    { value: "20", label: "最多20个 · 扩展" },
                  ]}
                />
              </Field>
            </div>
            <Notice>
              只发送本次主题、资源文字和最多50条相关本地参考词给已配置的
              OpenRouter 模型。生成遵守美元预算并记账；本地参考是历史积累，AI
              候选的搜索量与竞争度均未验证。不会自动请求5118。
            </Notice>
            <div className="row">
              <Button
                primary
                disabled={
                  busy > 0 ||
                  !data?.settings.openrouterConfigured ||
                  (!topic.trim() && !(bound && resource))
                }
                onClick={() => void generate()}
              >
                {generating ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Sparkles size={15} />
                )}
                {generating ? "正在构思内容机会…" : "生成候选词"}
              </Button>
              <Button
                disabled={busy > 0}
                onClick={async () => {
                  const r = await command("ai.ideas.preview", input());
                  if (r) setContext(r);
                }}
              >
                查看本地参考
              </Button>
              {!data?.settings.openrouterConfigured ? (
                <span className="muted">
                  请先在连接与设置中配置 OpenRouter。
                </span>
              ) : null}
              <small>GEO 指生成式引擎优化，不是地理位置优化。</small>
            </div>
            {context ? (
              <details className="idea-context">
                <summary>
                  本次参考：{context.references.length} 个相关词 ·{" "}
                  {context.localCount} 条匹配历史记录
                </summary>
                {context.references.length ? (
                  <ul>
                    {context.references.map((r) => (
                      <li key={r.id}>
                        <strong>{r.word}</strong> · {r.poolName || r.source}
                        {r.platform ? ` · ${r.platform}` : ""}
                        {r.fetchedAt
                          ? ` · ${formatTime(r.fetchedAt)}`
                          : " · 时间未知"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    本地没有匹配参考；本次将依据主题和资源联想，不会假装有历史数据支持。
                  </p>
                )}
                <small>
                  已过滤链接与常见凭据字段；历史记录可能已过时，不代表实时流量。
                </small>
              </details>
            ) : null}
            <details className="idea-context">
              <summary>提示词设计与边界 · content-seo-geo/1</summary>
              <p>
                以受众、场景和真实问题组织主题簇；区分教程、排错、对比、决策和模板意图。GEO
                补充自然语言问题、实体消歧、直接回答与可核验证据；不保证排名、收录或
                AI 引用。
              </p>
              <p>
                核心提示词可在“查看本地参考”后展开查看；系统规则保留，不接受覆盖。
              </p>
              {context ? <pre>{context.instruction}</pre> : null}
            </details>
          </fieldset>
          {history.length ? (
            <div className="row idea-history">
              <label htmlFor="idea-history">本地联想历史</label>
              <Select
                id="idea-history"
                aria-label="AI联想历史"
                value={run?.id ?? ""}
                onValueChange={(nextValue) => {
                  const r = history.find((h) => h.id === nextValue) ?? null;
                  setRun(r);
                  setSelected([]);
                  setSearch("");
                  setFilter("all");
                }}
                items={[
                  ...history.map((r) => ({
                    value: r.id,
                    label: (
                      <>
                        {formatTime(r.createdAt)} ·{" "}
                        {r.context.input.seeds.join("、") ||
                          r.context.resource?.title}{" "}
                        · {r.candidates.length}词
                      </>
                    ),
                  })),
                ]}
              />
              <small>最近20轮，可离线查看</small>
            </div>
          ) : null}
          {run ? (
            <section aria-label="AI联想结果" className="idea-results">
              <div className="idea-strategy">
                <span className="eyebrow">内容布局建议</span>
                <p>{run.strategy}</p>
                <small>
                  {run.context.resource?.title ||
                    run.context.input.seeds.join("、")}{" "}
                  ·{" "}
                  {
                    {
                      balanced: "SEO + GEO",
                      seo: "SEO 搜索长尾",
                      geo: "GEO 自然问句",
                    }[run.context.input.focus]
                  }{" "}
                  · {run.model} · {formatTime(run.createdAt)}
                </small>
              </div>
              {run.context.input.resourceId !==
              (bound ? (resource?.id ?? null) : null) ? (
                <Notice warning>
                  当前表单关联已变化；下面结果属于历史生成范围，保存词池仍关联该轮原资源。
                </Notice>
              ) : null}
              <div className="row">
                <input
                  type="search"
                  aria-label="筛选AI候选词"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="筛选候选词或内容角度"
                />
                <Select
                  aria-label="AI候选词类型"
                  value={filter}
                  onValueChange={(nextValue) => setFilter(nextValue)}
                  items={[
                    { value: "all", label: "全部类型" },
                    ...Object.entries(kinds).map(([k, v]) => ({
                      value: k,
                      label: v,
                    })),
                  ]}
                />
                <Button
                  quiet
                  onClick={() =>
                    setSelected((prior) =>
                      updateSelection(
                        prior,
                        visible.map((c) => c.id),
                        true,
                      ),
                    )
                  }
                >
                  选中可见项
                </Button>
                <Button quiet onClick={() => setSelected([])}>
                  清空选择
                </Button>
                <small>{selected.length}项已选 · 优先级为AI内容建议</small>
              </div>
              {!visible.length ? (
                <p>没有匹配候选，请调整筛选。</p>
              ) : (
                groups.map((group) => (
                  <div className="idea-cluster" key={group}>
                    <h3>{group}</h3>
                    <div className="idea-cards">
                      {visible
                        .filter((c) => c.cluster === group)
                        .map((c) => (
                          <article
                            key={c.id}
                            className={`idea-card ${selected.includes(c.id) ? "is-selected" : ""}`}
                          >
                            <label className="idea-card-title">
                              <input
                                type="checkbox"
                                aria-label={`选择AI候选${c.word}`}
                                checked={selected.includes(c.id)}
                                onChange={(e) =>
                                  setSelected((prior) =>
                                    updateSelection(
                                      prior,
                                      [c.id],
                                      e.target.checked,
                                    ),
                                  )
                                }
                              />
                              <strong>{c.word}</strong>
                            </label>
                            <div className="row compact">
                              <span className="tag">{kinds[c.kind]}</span>
                              <span className="tag">{intents[c.intent]}</span>
                              <span className="tag">
                                {priorities[c.priority]}
                              </span>
                              {c.alreadyLocal ? (
                                <span className="tag">本地已有</span>
                              ) : null}
                            </div>
                            <p className="idea-reason">{c.reason}</p>
                            <dl>
                              <dt>内容切入</dt>
                              <dd>{c.angle}</dd>
                              <dt>要回答的问题</dt>
                              <dd>{c.answerQuestion}</dd>
                              <dt>待补证据</dt>
                              <dd>{c.evidenceNeeded}</dd>
                            </dl>
                            <div className="idea-evidence">
                              {c.localRefIds.length
                                ? `本地参考：${c.localRefIds.map((id) => run.context.references.find((r) => r.id === id)?.word).join("、")}`
                                : "独立联想 · 无直接本地参考"}
                            </div>
                          </article>
                        ))}
                    </div>
                  </div>
                ))
              )}
              <div className="idea-actions">
                <div className="row">
                  <Button
                    primary
                    disabled={!chosen.length || busy > 0}
                    onClick={() => {
                      if (onAppend(chosen.map((c) => c.word)))
                        notify(
                          "已追加到5118查询框，请检查方法、页数和预算后手动查询。",
                          "info",
                        );
                    }}
                  >
                    <ArrowDown size={15} />
                    送入5118查询框
                  </Button>
                  <small>只填写查询词，不自动计费</small>
                </div>
                <div className="row">
                  <input
                    aria-label="AI候选词池名称"
                    value={poolName}
                    onChange={(e) => setPoolName(e.target.value)}
                    placeholder="待验证词池名称（可选）"
                    maxLength={100}
                  />
                  <Button
                    disabled={!chosen.length || busy > 0}
                    onClick={() => void save()}
                  >
                    <BookmarkPlus size={15} />
                    保存待验证词池
                  </Button>
                </div>
              </div>
            </section>
          ) : (
            <div className="idea-empty">
              写下一个真实问题，让 AI
              帮你扩展内容方向。候选会保留内容切入点与待补证据，勾选后再验证流量。
            </div>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
