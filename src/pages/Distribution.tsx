import { useState } from "react";
import {
  distributionPlatforms,
  type DistributionPlatformId,
  type DistributionStatus,
} from "../../shared/distribution";
import { useAppData } from "../state";
import { Header, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { useDistribution } from "../distribution/useDistribution";
import { PlatformRules } from "../distribution/PlatformRules";
import { PlatformProgress } from "../distribution/PlatformProgress";
import { TaskBoard, BatchHistory } from "../distribution/TaskBoard";
import "../distribution/distribution.css";

export default function DistributionPage() {
  const { data } = useAppData();
  const [platformId, setPlatform] = useState<DistributionPlatformId>("esoua");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DistributionStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [view, setView] = useState("records");
  const model = useDistribution(platformId, query, status, page),
    overview = model.overview;
  const item = overview.data?.platforms.find(
    (item) => item.platform.id === platformId,
  );
  return (
    <>
      <Header
        title="内容分发"
        description="每个平台独立分发资源库的全部本人分享，自动分批、保留断点，分别跟进提交进度。"
      />
      <div className="distribution-library-summary">
        {overview.data ? (
          <>
            <strong>
              资源库 {overview.data.library.resources.toLocaleString()} 份资源
            </strong>
            <span>
              {overview.data.library.readyShares.toLocaleString()}{" "}
              条已就绪本人分享（含拆分链接，平台入队时去重）
            </span>
            <span>
              {overview.data.library.unreadyResources.toLocaleString()}{" "}
              份资源尚无可分发分享
            </span>
          </>
        ) : overview.loading ? (
          "正在读取资源库概况…"
        ) : (
          "资源库概况暂不可用"
        )}
      </div>
      <div className="distribution-workspace">
        <aside className="distribution-platforms" aria-label="分发平台">
          <h2>分发平台</h2>
          <nav aria-label="选择分发平台">
            {distributionPlatforms.map((platform) => {
              const summary = overview.data?.platforms.find(
                (item) => item.platform.id === platform.id,
              );
              const accepted = summary?.delivered ?? null;
              return (
                <button
                  type="button"
                  key={platform.id}
                  aria-current={platformId === platform.id ? "page" : undefined}
                  onClick={() => {
                    setPlatform(platform.id);
                    setQuery("");
                    setStatus("all");
                    setPage(1);
                    setView("records");
                  }}
                >
                  <span className="distribution-platform-name">
                    {platform.name}
                    <small>
                      {platform.login === "required" ? "需登录" : "开放投稿页"}
                    </small>
                  </span>
                  <span className="distribution-platform-host">
                    {platform.host}
                  </span>
                  {summary ? (
                    <>
                      <span className="distribution-platform-counts">
                        已提交 {accepted} / {summary.total}
                        <span>{summary.published} 已收录</span>
                      </span>
                      <progress
                        max={Math.max(1, summary.total)}
                        value={accepted ?? 0}
                        aria-label={`${platform.name}提交进度`}
                      />
                    </>
                  ) : (
                    <span className="distribution-platform-counts">
                      {overview.error ? "进度暂不可用" : "正在读取进度…"}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <p>各平台独立开始、暂停和统计。无需选择资源，也不跨平台批量操作。</p>
        </aside>
        <div className="distribution-main">
          <QueryError
            error={overview.error}
            loading={overview.loading}
            onRetry={overview.reload}
            title="平台进度读取失败"
          />
          {!item && overview.loading ? (
            <Panel>
              <LoadingState label="正在恢复分发进度…" />
            </Panel>
          ) : item ? (
            <>
              <PlatformProgress
                key={`progress:${platformId}`}
                item={item}
                model={model}
              />
              <PlatformRules
                key={`rules:${platformId}`}
                item={item}
                workspace={data!.dataPath}
                model={model}
              />
            </>
          ) : null}
          <div
            className="distribution-view-tabs"
            role="group"
            aria-label="分发记录视图"
          >
            <button
              type="button"
              aria-pressed={view === "records"}
              onClick={() => setView("records")}
            >
              逐条记录
            </button>
            <button
              type="button"
              aria-pressed={view === "batches"}
              onClick={() => setView("batches")}
            >
              提交批次
            </button>
          </div>
          {view === "records" ? (
            <TaskBoard
              key={`tasks:${platformId}`}
              workspace={data!.dataPath}
              platformId={platformId}
              model={model}
              query={query}
              status={status}
              onQuery={(value) => {
                setQuery(value);
                setPage(1);
              }}
              onStatus={(value) => {
                setStatus(value);
                setPage(1);
              }}
              onPage={setPage}
            />
          ) : (
            <BatchHistory
              key={`batches:${platformId}`}
              platformId={platformId}
            />
          )}
        </div>
      </div>
    </>
  );
}
