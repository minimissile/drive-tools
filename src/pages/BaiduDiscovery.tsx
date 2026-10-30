import { ExternalLink, Pause, Play, SkipForward, X } from "lucide-react";
import { useAppData } from "../state";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import {
  Button,
  Empty,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import { useBaiduDiscovery } from "../baidu-discovery/useBaiduDiscovery";
import { DiscoveryForm } from "../baidu-discovery/DiscoveryForm";
import { DiscoveryResults } from "../baidu-discovery/DiscoveryResults";
import "../baidu-discovery/discovery.css";

export default function BaiduDiscoveryPage() {
  const { data } = useAppData();
  return <DiscoveryWorkspace key={data!.dataPath} workspace={data!.dataPath} />;
}
function DiscoveryWorkspace({ workspace }: { workspace: string }) {
  const model = useBaiduDiscovery(workspace),
    run = model.run;
  const completed =
    run?.queries.filter((q) => q.status !== "pending").length ?? 0;
  const labels = {
    running: "采集中",
    paused: "已暂停",
    waiting: "等待验证",
    completed: "已完成",
  };
  return (
    <OperationsWorkspace
      title="百度批量扩词"
      description="批量采集下拉联想词与相关搜索，保留来源，按需扩词后去重导出。"
    >
      <DiscoveryForm
        workspace={workspace}
        disabled={
          !!model.pending ||
          model.running ||
          !!model.history.error ||
          (!model.history.data && model.history.loading)
        }
        onStart={model.start}
      />
      <Panel
        title="采集任务"
        extra={
          <div className="row">
            <Button
              quiet
              size="compact"
              disabled={!!model.pending}
              onClick={() => void model.open()}
            >
              <ExternalLink size={14} />
              打开百度窗口
            </Button>
            <Button
              quiet
              size="compact"
              disabled={!!model.pending || model.running}
              onClick={() => void model.closeBrowser()}
            >
              <X size={14} />
              关闭采集窗口
            </Button>
          </div>
        }
      >
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
            <Select
              aria-label="选择采词任务"
              value={model.id}
              items={model.history.data.map((item) => ({
                value: item.id,
                label: `${item.input.seeds.slice(0, 2).join("、")} · ${item.wordCount}词 · ${labels[item.status]} · ${formatTime(item.createdAt)}`,
              }))}
              onValueChange={model.pick}
            />
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
                <div className="baidu-discovery-progress-heading">
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
                  <span>
                    已处理 {completed} / {run.queries.length} 个查询词 · 去重后{" "}
                    {run.words.length} 词
                  </span>
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
                </div>
                <progress
                  aria-label="采词任务进度"
                  value={completed}
                  max={Math.max(1, run.queries.length)}
                />
                <p className="baidu-discovery-message">{run.message}</p>
                {run.queries.some((q) => q.status === "skipped") ? (
                  <small>
                    已跳过：
                    {run.queries
                      .filter((q) => q.status === "skipped")
                      .map((q) => q.word)
                      .join("、")}
                  </small>
                ) : null}
              </div>
            ) : null}
          </>
        ) : model.history.data && !model.history.error ? (
          <Empty title="开始第一轮百度采词" compact>
            输入关键词后开始采集。任务和已采集结果会保存在当前工作空间，切换页面后可继续查看。
          </Empty>
        ) : null}
        {model.error ? <Notice danger>{model.error}</Notice> : null}
      </Panel>
      {run ? (
        <DiscoveryResults
          key={run.id}
          workspace={workspace}
          run={run}
          model={model}
        />
      ) : null}
    </OperationsWorkspace>
  );
}
