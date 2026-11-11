import { useRef, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { z } from "zod";
import type { TiebaAnalysisForumPage } from "../../shared/tieba-analysis";
import { tiebaForumNameSchema } from "../../shared/tieba-forums";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { AnalysisThreadsTable } from "./AnalysisThreadsTable";

const draftSchema = z.object({ name: z.string().max(100) });
type ForumRequest = { name: string; page: number };

export function ForumPosts({ workspace }: { workspace: string }) {
  const { command } = useAppActions();
  const draft = useLocalDraft(
    `tieba-analysis-forum:${workspace}`,
    { name: "" },
    draftSchema.parse,
  );
  const [result, setResult] = useState<TiebaAnalysisForumPage>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const inFlight = useRef(false);
  const retry = useRef<ForumRequest | null>(null);

  async function query(input: ForumRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    retry.current = input;
    setError("");
    setPending(true);
    try {
      const next = await ipc("tieba.analysis.forumPosts", input);
      if (
        input.page !== next.page ||
        (input.page > 1 && next.id !== result?.id)
      )
        throw new Error("贴吧返回的页面与请求不一致，请重试。");
      setResult(next);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "读取失败，请稍后重试。";
      setError(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试读取。"
          : message,
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="tieba-analysis-content">
      <Panel aria-label="查询吧内帖子">
        <form
          className="tieba-analysis-form"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = tiebaForumNameSchema.safeParse(draft.value.name);
            if (!parsed.success) {
              setValidationError(
                parsed.error.issues[0]?.message ?? "请输入有效的贴吧名称。",
              );
              return;
            }
            setValidationError("");
            void query({ name: parsed.data, page: 1 });
          }}
        >
          <Field label="贴吧名称">
            <input
              placeholder="例如：网盘资源"
              maxLength={100}
              value={draft.value.name}
              aria-invalid={!!validationError}
              onChange={(event) => {
                draft.update({ name: event.target.value });
                setValidationError("");
              }}
            />
          </Field>
          <Button
            primary
            type="submit"
            disabled={pending || !draft.value.name.trim()}
          >
            <Search size={15} />
            查询吧内帖子
          </Button>
        </form>
        {validationError ? <Notice danger>{validationError}</Notice> : null}
        {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      </Panel>
      <QueryError
        error={error}
        title="暂时无法读取吧内帖子"
        onRetry={() => {
          if (retry.current) void query(retry.current);
        }}
      />
      {!result && pending ? (
        <LoadingState label="正在查询吧内公开主题帖…" layout="list" />
      ) : null}
      {!result && !pending && !error ? (
        <Panel>
          <Empty title="输入吧名后开始查询" compact />
        </Panel>
      ) : null}
      {result ? (
        <Panel
          title={`${result.name} · 公开主题帖`}
          extra={
            pending ? (
              <Loading label="正在读取帖子…" />
            ) : (
              <Button
                quiet
                size="compact"
                onClick={() =>
                  void command("system.external", { url: result.url })
                }
              >
                打开贴吧 <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            )
          }
        >
          {result.threads.length ? (
            <AnalysisThreadsTable threads={result.threads} scope="forum" />
          ) : (
            <Empty title="本页没有可读取的公开主题帖" compact />
          )}
          <Pagination
            page={result.page}
            hasNextPage={result.hasMore}
            disabled={pending}
            label="吧内帖子分页"
            onPageChange={(page) => {
              const parsed = tiebaForumNameSchema.safeParse(result.name);
              if (parsed.success) void query({ name: parsed.data, page });
            }}
          >
            第 {result.page} 页 · 本页 {result.threads.length} 篇
          </Pagination>
        </Panel>
      ) : null}
    </div>
  );
}
