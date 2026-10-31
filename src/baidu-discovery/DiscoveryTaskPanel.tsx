import { useMemo, useState } from "react";
import { ExternalLink, Pause, Play, SkipForward, X } from "lucide-react";
import { Button, Empty, LoadingState, Notice, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { SearchSelect } from "../ui/SearchSelect";
import { formatTime } from "../lib/format";
import type { DiscoveryModel } from "./useBaiduDiscovery";

const labels = {
  running: "采集中",
  paused: "已暂停",
  waiting: "等待验证",
  completed: "已完成",
};

export function DiscoveryTaskPanel({ model }: { model: DiscoveryModel }) {
  const run = model.run;
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const tasks = useMemo(
    () =>
      (model.history.data || []).map((item) => ({
        value: item.id,
        label: `${item.input.seeds.slice(0, 2).join("、")}${item.input.seeds.length > 2 ? "等" : ""} · ${item.wordCount}词 · ${labels[item.status]} · ${formatTime(item.createdAt)}`,
        seeds: item.input.seeds.join(" "),
      })),
    [model.history.data],
  );
  const terms = query
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matches = tasks.filter((task) => {
    const text = `${task.seeds} ${task.label}`
      .normalize("NFKC")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const selectedTask = tasks.find((task) => task.value === model.id) || {
    value: model.id,
    label: "请选择采集任务",
  };
  const completed =
    run?.queries.filter((query) => query.status !== "pending").length ?? 0;
  return (
    <section className="baidu-discovery-task" aria-label="采集任务">
      <div className="baidu-discovery-task-toolbar">
        <h2>采集任务</h2>
        {model.history.data?.length ? (
          <SearchSelect
            label="搜索采集任务"
            placeholder="搜索关键词、状态或日期…"
            emptyMessage="没有匹配的采集任务，试试其他关键词"
            value={selectedTask}
            inputValue={searching ? query : selectedTask.label}
            items={matches}
            onQueryChange={setQuery}
            onOpenChange={setSearching}
            onChange={model.pick}
          />
        ) : (
          <small>默认后台查询</small>
        )}
        {run ? (
          <div className="baidu-discovery-task-summary">
            <Status
              kind={
                run.status === "completed"
                  ? "good"
                  : run.status === "running"
                    ? "normal"
                    : "warning"
              }
            >
              {labels[run.status]}
            </Status>
            <span className="baidu-discovery-query-count">
              {completed} / {run.queries.length} 已处理 · {run.words.length}{" "}
              个词
            </span>
          </div>
        ) : null}
        <DiscoveryTaskActions model={model} />
      </div>
      <QueryError
        title="无法读取采词任务"
        error={model.history.error}
        loading={model.history.loading}
        onRetry={model.history.reload}
      />
      {!model.history.data && !model.history.error ? (
        <LoadingState label="正在读取采词任务…" compact />
      ) : model.history.data?.length ? (
        <>
          <QueryError
            title="无法读取采集进度"
            error={model.detail.error}
            loading={model.detail.loading}
            onRetry={model.detail.reload}
          />
          {!run && !model.detail.error ? (
            <LoadingState label="正在读取采集进度…" compact />
          ) : run ? (
            <div className="baidu-discovery-progress" aria-live="polite">
              {run.status !== "completed" ? (
                <progress
                  aria-label="采词任务进度"
                  value={completed}
                  max={Math.max(1, run.queries.length)}
                />
              ) : null}
              <p className="baidu-discovery-message">{run.message}</p>
              {run.queries.some((query) => query.status === "skipped") ? (
                <small>
                  已跳过：
                  {run.queries
                    .filter((query) => query.status === "skipped")
                    .map((query) => query.word)
                    .join("、")}
                </small>
              ) : null}
            </div>
          ) : null}
        </>
      ) : model.history.data && !model.history.error ? (
        <Empty title="还没有采集任务" compact>
          输入关键词开始，结果和断点会保存在本机。
        </Empty>
      ) : null}
      {model.error ? <Notice danger>{model.error}</Notice> : null}
    </section>
  );
}

function DiscoveryTaskActions({ model }: { model: DiscoveryModel }) {
  const run = model.run;
  if (!run) return null;
  return (
    <div className="baidu-discovery-task-actions">
      {run.status === "running" ? (
        <Button
          size="compact"
          disabled={!!model.pending}
          onClick={() => void model.control("pause")}
        >
          <Pause size={14} />
          暂停采集
        </Button>
      ) : run.status !== "completed" ? (
        <>
          <Button
            primary
            size="compact"
            disabled={!!model.pending || model.running}
            onClick={() => void model.control("resume")}
          >
            <Play size={14} />
            继续采集
          </Button>
          <Button
            quiet
            size="compact"
            disabled={!!model.pending || model.running}
            onClick={() => void model.control("skip")}
          >
            <SkipForward size={14} />
            跳过当前词
          </Button>
        </>
      ) : null}
      <Button
        quiet
        size="compact"
        disabled={!!model.pending}
        onClick={() => void model.open()}
      >
        <ExternalLink size={14} />
        {run.status === "waiting" || run.status === "paused"
          ? "查看异常页"
          : "查看浏览器"}
      </Button>
      <Button
        quiet
        size="compact"
        disabled={!!model.pending || model.running}
        onClick={() => void model.closeBrowser()}
        title="结束浏览器会话，采集结果保留"
      >
        <X size={14} />
        结束会话
      </Button>
    </div>
  );
}
