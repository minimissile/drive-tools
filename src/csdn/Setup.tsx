import { useRef, useEffect } from "react";
import { z } from "zod";
import { ArrowRight, Radar } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { SearchSelect } from "../ui/SearchSelect";
import type { CsdnWorkflowInput } from "../../shared/csdn-workflow";
import { formatTime } from "../lib/format";
import { keywordMetricNames } from "../traffic/knowledge";

const setup = z.object({
  keyword: z.string(),
  sourceId: z.string(),
  copyId: z.string(),
  resourceTitle: z.string(),
  resourceQuery: z.string(),
  softwareVersion: z.string(),
  operatingSystem: z.string(),
  evidence: z.string(),
});
const defaults: z.infer<typeof setup> = {
  keyword: "",
  sourceId: "manual",
  copyId: "",
  resourceTitle: "",
  resourceQuery: "",
  softwareVersion: "",
  operatingSystem: "",
  evidence: "",
};

export function CsdnSetup({ onCreated }: { onCreated(id: string): void }) {
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    { navigate } = useAppNavigation();
  const form = useLocalDraft(
    `panxu-csdn-setup-v1:${data!.dataPath}`,
    defaults,
    (value) => setup.parse(value),
  );
  const { value, update } = form;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const words = useIpcQuery(
    "csdn.words",
    { query: value.keyword },
    { delay: 180 },
  );
  const matches = useIpcQuery(
    "csdn.matches",
    { keyword: value.resourceQuery || value.keyword },
    { delay: 200, revision: data?.resources },
  );
  const source = words.data?.find((word) => word.id === value.sourceId);
  const chooseWord = (keyword: string, sourceId = "manual") =>
    update({
      keyword,
      sourceId,
      resourceQuery: keyword,
      copyId: "",
      resourceTitle: "",
    });
  const create = async () => {
    const input: CsdnWorkflowInput = {
      keyword: value.keyword,
      sourceId: value.sourceId,
      copyId: value.copyId,
      splitItemId: null,
      intent: "操作教程与配套资料",
      softwareVersion: value.softwareVersion,
      operatingSystem: value.operatingSystem,
      evidence: value.evidence,
    };
    const result = await command("csdn.create", input);
    if (!result || !alive.current) return;
    onCreated(result.run.id);
  };
  return (
    <div className="csdn-setup">
      <Panel
        title="选词与配套资料"
        extra={
          <Button quiet onClick={() => navigate("traffic")}>
            <Radar size={14} />
            去流量发现找词
          </Button>
        }
      >
        <Notice>
          从本地词库选词，或输入已确定的搜索问题。百度、5118
          指标保留原始来源，不当作 CSDN 站内搜索量。
        </Notice>
        <Field label="目标关键词" required hint="一篇文章解决一个具体问题">
          <input
            aria-label="CSDN 目标关键词"
            maxLength={100}
            value={value.keyword}
            disabled={busy > 0}
            onChange={(e) => chooseWord(e.target.value)}
            placeholder="例如：Matplotlib 中文乱码"
          />
        </Field>
        <QueryError
          error={words.error}
          loading={words.loading}
          onRetry={words.reload}
        />
        {!words.data && words.loading ? (
          <LoadingState compact label="正在读取本地关键词…" />
        ) : words.data?.length ? (
          <div className="csdn-word-list" aria-label="本地关键词候选">
            {words.data.slice(0, 8).map((word) => (
              <button
                type="button"
                key={word.id}
                aria-pressed={word.id === value.sourceId}
                onClick={() => chooseWord(word.word, word.id)}
                disabled={busy > 0}
              >
                <strong>{word.word}</strong>
                <span>
                  {word.source} ·{" "}
                  {word.observedAt ? formatTime(word.observedAt) : "时间未提供"}
                </span>
                {Object.entries(word.metrics)
                  .filter(
                    ([name, metric]) =>
                      name in keywordMetricNames &&
                      (typeof metric === "string" ||
                        typeof metric === "number"),
                  )
                  .slice(0, 3)
                  .map(([name, metric]) => (
                    <small key={name}>
                      {keywordMetricNames[name]}：{String(metric)}
                    </small>
                  ))}
              </button>
            ))}
          </div>
        ) : !words.error ? (
          <p className="muted">
            本地没有匹配词，可直接使用手工选题；搜索需求仍需核实。
          </p>
        ) : null}
        <p className="muted csdn-source-note">
          当前来源：
          {source?.source ??
            (value.sourceId === "manual"
              ? "手工选题 · 搜索量待核实"
              : "已选本地记录")}
        </p>
        <div className="field-pair">
          <Field
            label="资料匹配关键词"
            hint="自动按选题匹配，也可改用资源名称搜索"
          >
            <input
              aria-label="资料匹配关键词"
              value={value.resourceQuery}
              maxLength={100}
              disabled={busy > 0}
              onChange={(e) => update({ resourceQuery: e.target.value })}
            />
          </Field>
          <Field label="配套本人资料" as="div" required>
            <SearchSelect
              label="CSDN 配套资料"
              value={{
                value: value.copyId,
                label: value.resourceTitle || "选择已核验的本人资料",
              }}
              items={(matches.data ?? []).map((match) => ({
                value: match.copyId,
                label: `${match.title} · ${match.accountAlias}`,
              }))}
              loading={matches.loading}
              error={matches.error}
              onRetry={matches.reload}
              onChange={(copyId) => {
                const match = matches.data?.find(
                  (item) => item.copyId === copyId,
                );
                if (match) update({ copyId, resourceTitle: match.title });
              }}
            />
          </Field>
        </div>
        {matches.data && !matches.data.length && !matches.error ? (
          <Empty compact title="没有匹配的已核验资料">
            试试更短的软件名或主题词；也可先在资源库完成本人分享核验。
          </Empty>
        ) : null}
        {value.copyId ? (
          <p className="csdn-selected-resource">
            配套资料：<strong>{value.resourceTitle}</strong>
            。匹配依据为标题、摘要、标签与文件名，未自动阅读网盘文件正文。
          </p>
        ) : null}
      </Panel>
      <Panel title="教程依据" extra={<small>随本次选题保存</small>}>
        <div className="field-pair">
          <Field label="软件版本">
            <input
              aria-label="CSDN 软件版本"
              value={value.softwareVersion}
              maxLength={100}
              onChange={(e) => update({ softwareVersion: e.target.value })}
            />
          </Field>
          <Field label="适用系统">
            <input
              aria-label="CSDN 适用系统"
              value={value.operatingSystem}
              maxLength={100}
              onChange={(e) => update({ operatingSystem: e.target.value })}
            />
          </Field>
        </div>
        <Field
          label="已核实的操作、资料内容与参考依据"
          required
          hint="至少10字；不确定的内容明确说明"
        >
          <textarea
            aria-label="CSDN 教程依据"
            className="csdn-evidence-input"
            maxLength={10000}
            value={value.evidence}
            onChange={(e) => update({ evidence: e.target.value })}
            placeholder="填写实际运行过的步骤、文件内容、许可或官方参考来源，以及尚未验证的范围。"
          />
        </Field>
        {form.error ? <Notice warning>{form.error}</Notice> : null}
        <div className="row csdn-actions">
          <Button
            primary
            disabled={
              busy > 0 ||
              value.keyword.trim().length < 2 ||
              !value.copyId ||
              value.evidence.trim().length < 10
            }
            onClick={() => void create()}
          >
            创建单篇任务 <ArrowRight size={15} />
          </Button>
          <small>创建只保存本地任务，下一步显式生成教程。</small>
        </div>
      </Panel>
    </div>
  );
}
