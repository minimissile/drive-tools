import { useEffect, useRef } from "react";
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
import { formatTime } from "../lib/format";

const formSchema = z.object({
  keyword: z.string(),
  sourceId: z.string(),
  copyId: z.string(),
  resourceTitle: z.string(),
  resourceQuery: z.string(),
  audience: z.string(),
  evidence: z.string(),
});
const defaults = {
  keyword: "",
  sourceId: "manual",
  copyId: "",
  resourceTitle: "",
  resourceQuery: "",
  audience: "",
  evidence: "",
};

export function WeiboSetup({ onCreated }: { onCreated(id: string): void }) {
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    { navigate } = useAppNavigation();
  const form = useLocalDraft(
    `panxu-weibo-setup-v1:${data!.dataPath}`,
    defaults,
    (raw) => formSchema.parse(raw),
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
    "weibo.words",
    { query: value.keyword },
    { delay: 180 },
  );
  const matches = useIpcQuery(
    "weibo.matches",
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
    const result = await command("weibo.create", {
      keyword: value.keyword,
      sourceId: value.sourceId,
      copyId: value.copyId,
      audience: value.audience,
      evidence: value.evidence,
    });
    if (result && alive.current) onCreated(result.run.id);
  };
  return (
    <Panel
      title="推荐哪份资料，给谁看？"
      extra={
        <Button quiet onClick={() => navigate("traffic")}>
          <Radar size={14} />
          去流量发现找词
        </Button>
      }
    >
      <p className="muted">
        一条微博围绕一个真实用途介绍资料。创建任务仅保存本地内容，生成、建链和发布各自显式操作。
      </p>
      <Field label="选题关键词" required hint="可手工输入，也可从已有词库选择">
        <input
          aria-label="微博选题关键词"
          value={value.keyword}
          maxLength={100}
          disabled={busy > 0}
          placeholder="例如：Excel 月度预算模板"
          onChange={(event) => chooseWord(event.target.value)}
        />
      </Field>
      <QueryError
        error={words.error}
        loading={words.loading}
        onRetry={words.reload}
      />
      {!words.data && words.loading ? (
        <LoadingState compact label="正在读取本地词库…" />
      ) : words.data?.length ? (
        <div className="weibo-keyword-list" aria-label="微博本地选题候选">
          {words.data.slice(0, 6).map((word) => (
            <button
              key={word.id}
              type="button"
              aria-pressed={word.id === value.sourceId}
              disabled={busy > 0}
              onClick={() => chooseWord(word.word, word.id)}
            >
              <strong>{word.word}</strong>
              <small>
                {word.source} ·{" "}
                {word.observedAt
                  ? formatTime(word.observedAt)
                  : "采集时间未提供"}
              </small>
            </button>
          ))}
        </div>
      ) : !words.error ? (
        <p className="muted">本地没有匹配词，可以直接使用手工选题。</p>
      ) : null}
      <p className="weibo-source-note">
        来源：
        {source?.source ??
          (value.sourceId === "manual" ? "手工选题" : "已选本地记录")}
        。已有指标保留原始口径，微博搜索热度未接入。
      </p>
      <div className="field-pair">
        <Field label="资料匹配关键词" hint="选题匹配不准时，改用资源名称">
          <input
            aria-label="微博资料匹配关键词"
            value={value.resourceQuery}
            maxLength={100}
            disabled={busy > 0}
            onChange={(event) => update({ resourceQuery: event.target.value })}
          />
        </Field>
        <Field label="配套本人资料" as="div" required>
          <SearchSelect
            label="微博配套本人资料"
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
        <Empty compact title="没有匹配的已核验本人资料">
          试试更短的主题词，或到资源库完成转存和本人分享核验。
        </Empty>
      ) : null}
      <Field label="适合人群" hint="可选；用于约束文案的表达和用途">
        <input
          aria-label="微博适合人群"
          value={value.audience}
          maxLength={100}
          disabled={busy > 0}
          placeholder="例如：刚开始记录家庭开支的人"
          onChange={(event) => update({ audience: event.target.value })}
        />
      </Field>
      <Field
        label="已核实的资源内容与用途"
        required
        hint="至少 10 字；填写实际包含什么、能做什么，以及适用限制"
      >
        <textarea
          aria-label="微博资源依据"
          className="weibo-evidence"
          value={value.evidence}
          maxLength={5000}
          disabled={busy > 0}
          placeholder="例如：包含月度收支表和分类汇总模板，适用于 Excel 2021。只提供记录模板，不包含理财建议。"
          onChange={(event) => update({ evidence: event.target.value })}
        />
      </Field>
      {form.error ? <Notice warning>{form.error}</Notice> : null}
      <div className="row weibo-actions">
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
          创建图文任务
          <ArrowRight size={15} />
        </Button>
        <small>配图可使用资源封面，也可沿用工作室生成的实际图片。</small>
      </div>
    </Panel>
  );
}
