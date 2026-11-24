import { ArrowUpRight, Search } from "lucide-react";
import { useId, useRef, useState } from "react";
import { z } from "zod";
import { tiebaPostExposure, type TiebaAnalysisThreadDetail } from "../../shared/tieba-analysis";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { ClearableField } from "../ui/ClearableField";
import { Button, Field, Loading, LoadingState, Notice, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { formatAnalysisCount, formatAnalysisTime } from "./AnalysisThreadsTable";
import { tiebaBackendError } from "./useTiebaAction";

const draftSchema = z.object({ target: z.string().max(2048) });
const rate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function ThreadLookup({ workspace }: { workspace: string }) {
  const inputId = useId();
  const { command } = useAppActions();
  const draft = useLocalDraft(`tieba-analysis-thread:${workspace}`, { target: "" }, draftSchema.parse);
  const [result, setResult] = useState<TiebaAnalysisThreadDetail>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef("");
  const lock = useRef(false);

  async function query(target: string) {
    if (lock.current || !target) return;
    lock.current = true;
    request.current = target;
    setError("");
    setPending(true);
    try {
      setResult(await ipc("tieba.analysis.thread", { target }));
    } catch (cause) {
      setError(tiebaBackendError(cause instanceof Error ? cause.message : "暂时无法查询这条帖子。"));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  const exposure = result ? tiebaPostExposure(result.views, result.publishedAt, result.observedAt) : null;
  const metrics = result ? [
    ["浏览量", formatAnalysisCount(result.views)],
    ["回复", formatAnalysisCount(result.replies)],
    ["获赞", formatAnalysisCount(result.likes)],
    ["分享数", formatAnalysisCount(result.shares)],
    ["曝光潜力", exposure === null ? "未知" : `${rate.format(exposure)} 次/小时`],
  ] : [];

  return (
    <div className="tieba-analysis-content">
      <Panel aria-label="查询单个主题帖">
        <form className="tieba-analysis-form" onSubmit={(event) => {
          event.preventDefault();
          void query(draft.value.target.trim());
        }}>
          <Field as="div" htmlFor={inputId} label="帖子链接或帖子 ID">
            <ClearableField
              id={inputId}
              value={draft.value.target}
              onValueChange={(target) => { draft.update({ target }); setError(""); }}
              clearLabel="清除帖子查询输入"
              placeholder="粘贴百度贴吧主题帖链接，或输入数字 ID"
              maxLength={2048}
            />
          </Field>
          <Button primary type="submit" disabled={pending || !draft.value.target.trim()}>
            <Search size={15} aria-hidden="true" />
            查询帖子
          </Button>
        </form>
        {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      </Panel>

      <QueryError error={error} loading={pending} onRetry={() => void query(request.current)} />
      {!result && pending ? (
        <Panel><LoadingState label="正在读取帖子…" layout="list" compact /></Panel>
      ) : null}
      {result ? (
        <Panel title={result.title} className="tieba-thread-result" extra={
          <div className="row compact">
            {pending ? <Loading label="正在读取帖子…" /> : null}
            <Button size="compact" onClick={() => void command("system.external", { url: result.url })}>
              查看原帖 <ArrowUpRight size={14} aria-hidden="true" />
            </Button>
          </div>
        }>
          <div className="tieba-thread-details muted">
            <span>作者 {result.author || "未知"}</span>
            <span>贴吧 {result.forum || "未知"}</span>
            <span>发布于 {result.publishedAt ? formatAnalysisTime(result.publishedAt) : "未知"}</span>
            <span>帖子 ID {result.id}</span>
          </div>
          <div className="tieba-analysis-overview">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <small className="muted">{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {result.bodyText ? <div className="tieba-thread-body">
            <h3>正文</h3>
            <p>{result.bodyText}</p>
          </div> : null}
        </Panel>
      ) : null}
    </div>
  );
}
