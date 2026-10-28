import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
import { formatTime } from "../lib/format";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import type { PipixCandidate } from "../../shared/pipix";
import { useAppNavigation } from "../state";

const formSchema = z.object({
  mode: z.enum(["local", "search", "home", "user", "topic"]),
  keyword: z.string(),
  targetId: z.string(),
  onlyImages: z.boolean(),
});
const kinds = {
  images: "图文",
  text: "文字",
  video: "视频",
  unknown: "类型待确认",
};
export function PipixDiscovery({
  workspace,
  disabled,
  collectedIds,
  onCollect,
  onBusy,
}: {
  workspace: string;
  disabled: boolean;
  collectedIds: string[];
  onCollect(urls: string[]): Promise<void>;
  onBusy(value: boolean): void;
}) {
  const { openSettings } = useAppNavigation();
  const config = useIpcQuery("pipix.discoveryConfig", undefined, {
    keepPrevious: true,
  });
  const form = useLocalDraft(
    "panxu-pipix-discovery-v1:" + workspace,
    { mode: "local", keyword: "", targetId: "", onlyImages: true } as z.infer<
      typeof formSchema
    >,
    (raw) => formSchema.parse(raw),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<PipixCandidate[]>([]),
    [page, setPage] = useState(1);
  const query = useIpcQuery(
    "pipix.knowledge",
    { ...form.value, page },
    { keepPrevious: true, delay: 150 },
  );
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const localOnly = form.value.mode === "local",
    hasKey = config.data?.configured ?? false;
  const blocked = disabled || busy,
    reading = query.loading;
  const update = (patch: Partial<z.infer<typeof formSchema>>) => {
    form.update(patch);
    setSelected([]);
    setError("");
    setMessage("");
    setPage(1);
  };
  const run = async (action: "first" | "next" | "force" | "reindex") => {
    if (lock.current || disabled || reading) return;
    if (action !== "reindex" && (localOnly || !hasKey)) return;
    if (
      action !== "reindex" &&
      form.value.mode === "search" &&
      !form.value.keyword.trim()
    ) {
      setError("请填写搜索关键词。");
      return;
    }
    if (
      action !== "reindex" &&
      (form.value.mode === "user" || form.value.mode === "topic") &&
      !/^\d{1,30}$/.test(form.value.targetId)
    ) {
      setError("请填写作者或话题的数字 ID。");
      return;
    }
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    setMessage("");
    try {
      if (action === "reindex") {
        const result = await ipc("pipix.reindex");
        if (alive.current)
          setMessage(
            "本地重建完成：" +
              result.indexed +
              " 份响应已入库，" +
              result.failed +
              " 份仍待解析；没有请求远端。",
          );
      } else if (form.value.mode !== "local") {
        const next =
          action === "next" ? query.data?.next : { cursor: "0", page: 0 };
        if (!next) return;
        const result = await ipc("pipix.discover", {
          mode: form.value.mode,
          keyword: form.value.mode === "search" ? form.value.keyword : "",
          targetId:
            form.value.mode === "user" || form.value.mode === "topic"
              ? form.value.targetId
              : "",
          ...next,
          force: action === "force" || ("retry" in next && next.retry === true),
        });
        if (alive.current) {
          setMessage(
            result.cached
              ? "复用已存响应，共 " +
                  result.items.length +
                  " 条，没有请求远端。"
              : "本次返回 " +
                  result.items.length +
                  " 条已完整入库，原始响应同步保存。",
          );
        }
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "操作失败，请检查后重试。");
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
        query.reload();
      }
    }
  };
  const choose = (items: PipixCandidate[], checked: boolean) =>
    setSelected((old) => {
      const pool = new Map([...old, ...items].map((v) => [v.id, v]));
      return updateSelection(
        old.map((v) => v.id),
        items.map((v) => v.id),
        checked,
        20,
      ).map((id) => pool.get(id)!);
    });
  const result = query.data,
    current = result?.items ?? [];
  return (
    <div className="pipix-discovery">
      <p className="muted pipix-hint">
        请求结果整页进入本地知识库，未勾选的内容也会保存。浏览、搜索和本地翻页不请求远端。
      </p>
      <QueryError
        error={config.error}
        loading={config.loading}
        onRetry={config.reload}
      />
      {!config.data && !config.error ? (
        <LoadingState label="正在读取数据源配置…" />
      ) : null}
      <div className="row">
        {config.data ? (
          <small>TikHub · {hasKey ? "已配置" : "未配置"}</small>
        ) : null}
        <Button
          size="compact"
          disabled={blocked}
          onClick={() => openSettings("sources")}
        >
          前往数据源设置
        </Button>
      </div>
      <Field label="列表来源">
        <Select
          value={form.value.mode}
          disabled={blocked}
          items={[
            { value: "local", label: "本地知识库 · 无需请求" },
            { value: "search", label: "关键词 · 图文搜索" },
            { value: "home", label: "首页推荐" },
            { value: "user", label: "作者作品" },
            { value: "topic", label: "话题作品" },
          ]}
          onValueChange={(mode) =>
            update({ mode: mode as typeof form.value.mode })
          }
        />
      </Field>
      {localOnly || form.value.mode === "search" ? (
        <Field label={localOnly ? "搜索本地内容" : "搜索关键词"}>
          <input
            aria-label={localOnly ? "搜索本地内容" : "搜索关键词"}
            maxLength={100}
            value={form.value.keyword}
            disabled={blocked}
            placeholder={localOnly ? "正文、作者或帖子 ID" : "例如：生活趣事"}
            onChange={(e) => update({ keyword: e.target.value })}
          />
        </Field>
      ) : null}
      {form.value.mode === "user" || form.value.mode === "topic" ? (
        <Field label={form.value.mode === "user" ? "作者 ID" : "话题 ID"}>
          <input
            aria-label={form.value.mode === "user" ? "作者 ID" : "话题 ID"}
            inputMode="numeric"
            maxLength={30}
            value={form.value.targetId}
            disabled={blocked}
            placeholder="填写数字 ID"
            onChange={(e) => update({ targetId: e.target.value })}
          />
        </Field>
      ) : null}
      <CheckboxField
        label="仅显示图文与文字"
        checked={form.value.onlyImages}
        disabled={blocked}
        onChange={(e) => update({ onlyImages: e.target.checked })}
      />
      {form.error || error ? (
        <Notice danger>{form.error || error}</Notice>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      {!error &&
        result?.warnings.map((warning, i) => (
          <Notice key={i}>{warning}</Notice>
        ))}
      <div className="row">
        <Button disabled={blocked || reading} onClick={query.reload}>
          刷新本地
        </Button>
        {!localOnly ? (
          <Button
            primary
            disabled={
              blocked ||
              reading ||
              !hasKey ||
              (!!result?.hasQuery && !result.next)
            }
            onClick={() => void run(result?.hasQuery ? "next" : "first")}
          >
            {busy
              ? "处理中…"
              : result?.hasQuery
                ? result.next
                  ? result.next.retry
                    ? "重新请求未完成页"
                    : "获取下一页并入库"
                  : "暂无可续页进度"
                : "获取列表并入库"}
          </Button>
        ) : null}
        {!localOnly && result?.hasQuery ? (
          <Button
            disabled={blocked || reading || !hasKey}
            onClick={() => void run("force")}
          >
            重新请求第一页
          </Button>
        ) : null}
        {result?.responses ? (
          <Button
            disabled={blocked || reading}
            onClick={() => void run("reindex")}
          >
            重建本地索引
          </Button>
        ) : null}
      </div>
      {!localOnly ? (
        <p className="muted pipix-hint">
          远端查询可能计费；按上游单页返回量完整保存。重新请求第一页会访问服务商；相同查询和游标默认复用已存响应。
        </p>
      ) : null}
      {message && query.error ? (
        <Notice warning>
          本次操作已完成，刷新本地内容失败。请点“刷新本地”，避免重复请求。
        </Notice>
      ) : (
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
        />
      )}
      {!result && !query.error ? (
        <LoadingState label="正在读取本地知识库…" />
      ) : null}
      {result ? (
        <>
          <p className="muted pipix-hint" aria-live="polite">
            知识库 {result.allPosts} 条 · 归档响应 {result.responses} 份 ·
            当前结果 {result.total} 条 · 已选 {selected.length}/20
            {result.latestAt ? " · 最近 " + formatTime(result.latestAt) : ""}
          </p>
          {result.items.length ? (
            <>
              <div className="row">
                <CheckboxField
                  label="选择本页"
                  checked={current.every((v) =>
                    selected.some((item) => item.id === v.id),
                  )}
                  disabled={blocked || reading}
                  onChange={(e) => choose(current, e.target.checked)}
                />
                <Button
                  primary
                  disabled={blocked || reading || !selected.length}
                  onClick={() => void onCollect(selected.map((v) => v.url))}
                >
                  采集所选 {selected.length || ""} 条
                </Button>
              </div>
              <div className="pipix-candidates">
                {current.map((v) => (
                  <div className="pipix-candidate" key={v.id}>
                    <CheckboxField
                      checked={selected.some((item) => item.id === v.id)}
                      disabled={
                        blocked ||
                        reading ||
                        (!selected.some((item) => item.id === v.id) &&
                          selected.length >= 20)
                      }
                      onChange={(e) => choose([v], e.target.checked)}
                      label={
                        <span className="pipix-candidate-copy">
                          <strong title={v.text}>
                            {v.text || "帖子 " + v.id}
                          </strong>
                          <small>
                            {v.author} · {kinds[v.kind]}
                            {collectedIds.includes(v.id) ? " · 已采集" : ""}
                          </small>
                        </span>
                      }
                    />
                  </div>
                ))}
              </div>
              <Pagination
                page={result.page}
                pageSize={result.pageSize}
                total={result.total}
                onPageChange={setPage}
                disabled={blocked || reading}
                label="本地知识库分页"
              />
            </>
          ) : (
            <Empty
              title={
                result.allPosts
                  ? "没有符合条件的本地内容"
                  : result.responses
                    ? "响应已归档，暂无可显示的图文"
                    : "本地知识库还没有内容"
              }
            >
              {localOnly
                ? "可选择远端来源获取数据，所有返回结果都会自动入库。"
                : "可获取新的列表；已存响应无需重复请求。"}
            </Empty>
          )}
        </>
      ) : null}
    </div>
  );
}
