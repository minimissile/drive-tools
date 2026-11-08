import {
  distributionPlatforms,
  distributionPlatformId,
  distributionStatus,
  type DistributionPlatformId,
  type DistributionStatus,
} from "../../shared/distribution";
import { useAppData } from "../state";
import { LoadingState, Notice, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useDistribution } from "../distribution/useDistribution";
import { PlatformRules } from "../distribution/PlatformRules";
import { PlatformProgress } from "../distribution/PlatformProgress";
import { TaskBoard, BatchHistory } from "../distribution/TaskBoard";
import "../ui/workspace.css";
import "../distribution/distribution.css";

type View = "records" | "rules" | "batches";
interface PageState {
  platformId: DistributionPlatformId;
  query: string;
  status: DistributionStatus | "all";
  page: number;
  view: View;
}
export default function DistributionPage() {
  const { data } = useAppData();
  const workspace = data!.dataPath;
  return <DistributionWorkspace key={workspace} workspace={workspace} />;
}
function DistributionWorkspace({ workspace }: { workspace: string }) {
  const ui = useLocalDraft<PageState>(
    `distribution:page:v1:${workspace}`,
    { platformId: "esoua", query: "", status: "all", page: 1, view: "records" },
    (value) => {
      const saved = value as Partial<PageState>;
      return {
        platformId:
          distributionPlatformId.safeParse(saved?.platformId).data ?? "esoua",
        query:
          typeof saved?.query === "string" ? saved.query.slice(0, 200) : "",
        status: distributionStatus.safeParse(saved?.status).data ?? "all",
        page:
          Number.isSafeInteger(saved?.page) && saved.page! > 0
            ? saved.page!
            : 1,
        view:
          saved?.view === "rules" || saved?.view === "batches"
            ? saved.view
            : "records",
      };
    },
  );
  const { platformId, query, status, page, view } = ui.value;
  const model = useDistribution(platformId, query, status, page);
  const overview = model.overview;
  const item = overview.data?.platforms.find(
    (item) => item.platform.id === platformId,
  );
  return (
    <div className="workspace-frame distribution-workspace">
      <aside className="distribution-platforms" aria-label="分发平台">
        <h2>分发平台</h2>
        <nav aria-label="选择分发平台" tabIndex={0}>
          {distributionPlatforms.map((platform) => {
            const summary = overview.data?.platforms.find(
              (item) => item.platform.id === platform.id,
            );
            return (
              <button
                type="button"
                key={platform.id}
                aria-current={platformId === platform.id ? "page" : undefined}
                onClick={() =>
                  ui.update({
                    platformId: platform.id,
                    query: "",
                    status: "all",
                    page: 1,
                    view: "records",
                  })
                }
              >
                <span className="distribution-platform-name">
                  {platform.name}
                  <small>
                    {platform.format === "unverified"
                      ? "暂不可用"
                      : platform.manualVerification === "website"
                        ? "人工验证"
                        : platform.manualVerification
                          ? "人工打码"
                          : platform.login === "required"
                            ? "需登录"
                            : ""}
                  </small>
                </span>
                {summary ? (
                  <>
                    <span className="distribution-platform-counts">
                      已提交 {summary.delivered} / {summary.total}
                    </span>
                    <progress
                      max={Math.max(1, summary.total)}
                      value={summary.delivered}
                      aria-label={`${platform.name}提交进度`}
                    />
                  </>
                ) : (
                  <span className="distribution-platform-counts">
                    {overview.error ? "进度读取失败" : "正在读取…"}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="distribution-library-summary">
          {overview.data ? (
            <>
              <span>
                资源库共有 {overview.data.library.readyShares.toLocaleString()}{" "}
                条本人分享
              </span>
              {overview.data.library.unreadyResources > 0 ? (
                <span>
                  {overview.data.library.unreadyResources} 份资源尚无分享链接
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
      <div
        key={platformId}
        className="distribution-main"
        role="region"
        aria-label="平台分发内容"
        tabIndex={0}
      >
        {ui.error ? <Notice warning>{ui.error}</Notice> : null}
        <QueryError
          error={overview.error}
          loading={overview.loading}
          onRetry={overview.reload}
          title="分发进度读取失败"
        />
        {!item && overview.loading ? (
          <Panel>
            <LoadingState label="正在读取分发进度…" />
          </Panel>
        ) : item ? (
          <>
            <PlatformProgress
              item={item}
              model={model}
              onReview={() =>
                ui.update({
                  view: "records",
                  status: "uncertain",
                  query: "",
                  page: 1,
                })
              }
            />
            <Tabs<View>
              value={view}
              onChange={(view) => ui.update({ view })}
              className="distribution-detail-tabs"
            >
              <TabList
                label="分发详情"
                items={[
                  ["records", "分发记录"],
                  ["rules", "投稿须知"],
                  ["batches", "提交历史"],
                ]}
              />
              <TabPanel value="records">
                <TaskBoard
                  key={`tasks:${platformId}`}
                  workspace={workspace}
                  platformId={platformId}
                  model={model}
                  query={query}
                  status={status}
                  onQuery={(query) => ui.update({ query, page: 1 })}
                  onStatus={(status) => ui.update({ status, page: 1 })}
                  onPage={(page) => ui.update({ page })}
                />
              </TabPanel>
              <TabPanel value="rules">
                <PlatformRules
                  item={item}
                  workspace={workspace}
                  model={model}
                />
              </TabPanel>
              <TabPanel value="batches">
                <BatchHistory platformId={platformId} />
              </TabPanel>
            </Tabs>
          </>
        ) : null}
      </div>
    </div>
  );
}
