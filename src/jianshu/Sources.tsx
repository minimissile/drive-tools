import { useRef, useState } from "react";
import { z } from "zod";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { updateSelection } from "../lib/selection";
import { formatTime } from "../lib/format";
import {
  jianshuSourcePresets,
  type JianshuCollectInput,
  type JianshuSourceMaterial,
} from "../../shared/jianshu-sources";
import { localServiceError } from "./labels";
const schema = z.object({
  preset: z.string(),
  input: z.string().max(4000),
  filter: z.string().max(150),
});
export function Sources({
  workspace,
  selected,
  onSelection,
  onInspect,
}: {
  workspace: string;
  selected: string[];
  onSelection(ids: string[]): void;
  onInspect(item: JianshuSourceMaterial): void;
}) {
  const form = useLocalDraft(
    `panxu:jianshu:${workspace}:collector`,
    { preset: "ruanyifeng", input: "", filter: "" },
    (v) => schema.parse(v),
  );
  const sources = useIpcQuery("jianshu.sources", undefined, {
    keepPrevious: true,
  });
  const [pending, setPending] = useState(false),
    [failure, setFailure] = useState(""),
    [page, setPage] = useState(1);
  const [latestThread, setLatestThread] =
    useState<JianshuSourceMaterial | null>(null);
  const lock = useRef(false),
    epoch = useRef(0);
  const preset = jianshuSourcePresets.find((p) => p.id === form.value.preset);
  const queryRequired =
    preset?.provider === "bangumi" || preset?.provider === "tvmaze";
  const isTieba = form.value.preset === "tieba";
  const custom =
    isTieba || form.value.preset === "web" || form.value.preset === "rss";
  const acceptsInput = queryRequired || custom;
  const keyword = form.value.filter.toLowerCase();
  const history = (sources.data ?? []).filter(
    (item) =>
      item.id !== latestThread?.id &&
      `${item.title} ${item.sourceName}`.toLowerCase().includes(keyword),
  );
  const rows = latestThread ? [latestThread, ...history] : history;
  const collect = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setFailure("");
    const current = ++epoch.current;
    try {
      let input: JianshuCollectInput;
      if (isTieba) {
        input = { provider: "tieba", url: form.value.input.trim(), limit: 1 };
      } else if (preset) {
        input = {
          presetId: preset.id,
          ...(queryRequired ? { query: form.value.input } : {}),
          limit: 20,
        };
      } else {
        input = {
          provider: form.value.preset === "rss" ? "rss" : "web",
          url: form.value.input,
          limit: 20,
        };
      }
      const collected = await ipc("jianshu.collect", input);
      if (epoch.current !== current) return;
      if (isTieba && collected[0]) {
        setLatestThread(collected[0]);
        setPage(1);
      }
      sources.reload();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "采集未完成，请重试。",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <div className="jianshu-sources">
      <div className="jianshu-source-controls">
        <Field label="采集来源">
          <Select
            aria-label="采集来源"
            value={form.value.preset}
            onValueChange={(preset) => {
              form.update({ preset, input: "" });
              setFailure("");
              setLatestThread(null);
              setPage(1);
            }}
            disabled={pending}
            items={[
              ...jianshuSourcePresets.map((p) => ({
                value: p.id,
                label: p.name,
              })),
              { value: "tieba", label: "百度贴吧 · 单帖" },
              { value: "web", label: "粘贴公开网页" },
              { value: "rss", label: "自定义 RSS / Atom" },
            ]}
          />
        </Field>
        <Field
          label={
            isTieba
              ? "贴吧帖子链接"
              : queryRequired
                ? "作品关键词"
                : custom
                  ? "来源网址"
                  : "来源地址"
          }
        >
          <input
            aria-label={isTieba ? "贴吧帖子链接" : "采集关键词或网址"}
            value={acceptsInput ? form.value.input : (preset?.url ?? "")}
            readOnly={!acceptsInput}
            disabled={pending}
            maxLength={4000}
            placeholder={
              isTieba
                ? "https://tieba.baidu.com/p/帖子编号"
                : queryRequired
                  ? "例如：作品名称"
                  : "https://…"
            }
            onChange={(e) => form.update({ input: e.target.value })}
          />
        </Field>
        <Button
          primary
          disabled={pending || (acceptsInput && !form.value.input.trim())}
          onClick={() => void collect()}
        >
          {pending ? "正在采集…" : "采集新内容"}
        </Button>
      </div>
      <small className="muted">
        {isTieba
          ? "采集公开主题帖的楼主首楼，保留原帖出处。"
          : (preset?.description ??
            "读取公开页面或订阅内容，保留原文出处；不会自动下载附件、转存或发布。")}
      </small>
      {failure ? <Notice danger>{localServiceError(failure)}</Notice> : null}
      {form.error ? <Notice warning>{form.error}</Notice> : null}
      <div className="jianshu-toolbar">
        <input
          aria-label="筛选已采集素材"
          placeholder="搜索已采集的标题或来源"
          value={form.value.filter}
          onChange={(e) => {
            form.update({ filter: e.target.value });
            setLatestThread(null);
            setPage(1);
          }}
        />
        <small className="muted">已选 {selected.length} 项 / 最多 20 项</small>
        {selected.length ? (
          <Button quiet size="compact" onClick={() => onSelection([])}>
            清空选择
          </Button>
        ) : null}
        <Button
          quiet
          size="compact"
          disabled={sources.loading}
          onClick={sources.reload}
        >
          刷新本地列表
        </Button>
      </div>
      <QueryError
        error={localServiceError(sources.error)}
        loading={sources.loading}
        onRetry={sources.reload}
      />
      {!rows.length && !sources.data && !sources.error ? (
        <LoadingState compact label="正在读取已采集素材…" />
      ) : null}
      {rows.length ? (
        <>
          <div className="jianshu-source-list">
            {rows.slice((page - 1) * 6, page * 6).map((item) => (
              <div className="jianshu-source-row" key={item.id}>
                <CheckboxField
                  checked={selected.includes(item.id)}
                  disabled={
                    !selected.includes(item.id) && selected.length >= 20
                  }
                  label={item.title}
                  onChange={(e) =>
                    onSelection(
                      updateSelection(
                        selected,
                        [item.id],
                        e.target.checked,
                        20,
                      ),
                    )
                  }
                />
                <div>
                  <small className="muted">
                    {item.id === latestThread?.id ? "本次采集 · " : null}
                    {item.sourceName} ·{" "}
                    {formatTime(item.publishedAt || item.collectedAt)}
                    {item.externalShares.length
                      ? ` · ${item.externalShares.length} 条外部分享线索`
                      : ""}
                  </small>
                  <p>{item.summary.slice(0, 160)}</p>
                </div>
                <Button quiet size="compact" onClick={() => onInspect(item)}>
                  查看素材
                </Button>
              </div>
            ))}
          </div>
          <Pagination
            page={page}
            pageSize={6}
            total={rows.length}
            onPageChange={setPage}
            label="采集素材分页"
          />
        </>
      ) : sources.data && !sources.error ? (
        <Empty
          compact
          title={
            form.value.filter
              ? "没有匹配的素材"
              : "采集一批内容，再选择用于创作"
          }
        >
          {form.value.filter
            ? "换个关键词，或清空搜索条件。"
            : "先选择来源并点击“采集新内容”；以后可以直接复用本地素材。"}
        </Empty>
      ) : null}
    </div>
  );
}
