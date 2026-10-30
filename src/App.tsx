import { StartupScreen } from "./startup/StartupScreen";
import { ipc } from "./api/client";
import { ToastMessage, useAppActivity } from "./state/feedback";
import { lazy, Suspense } from "react";
import { Code2 } from "lucide-react";
import {
  useAppActions,
  useWorkspaceStatus,
  useAppData,
  useAppNavigation,
} from "./state";
import { QueryError } from "./ui/QueryError";
import { Loading, LoadingState } from "./ui/primitives";
import { UpdateBanner } from "./UpdatePanel";
import brandMark from "./assets/brand/panxu-mark.svg";
import { sidebarEntries, sidebarPage } from "./navigation";
import { ActiveTaskSwitcher } from "./tasks/ActiveTaskSwitcher";
import { WorkbenchNavigation } from "./workbench/WorkbenchNavigation";
import { SessionWindows } from "./dev/SessionWindows";
const Workbench = lazy(() => import("./pages/Workbench"));
const BaiduDiscovery = lazy(() => import("./pages/BaiduDiscovery"));
const KeywordMining = lazy(() => import("./pages/KeywordMining"));
const ResourceCollection = lazy(() => import("./pages/ResourceCollection"));
const ZhidaoAnswers = lazy(() => import("./zhidao/Answers"));
const ZhidaoTemplates = lazy(() => import("./zhidao/Templates"));
const ZhidaoPublish = lazy(() => import("./zhidao/Publish"));
const DriveFiles = lazy(() => import("./pages/DriveFiles"));
const Accounts = lazy(() => import("./pages/Accounts"));
const FingerprintBrowser = lazy(() => import("./pages/FingerprintBrowser"));
const ResourceCatalog = lazy(() => import("./pages/ResourceCatalog"));
const LibraryPage = lazy(() => import("./pages/Library"));
const Intake = lazy(() => import("./pages/Intake"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Traffic = lazy(() => import("./pages/Traffic"));
const Studio = lazy(() => import("./pages/Studio"));
const Publish = lazy(() => import("./pages/Publish"));
const Distribution = lazy(() => import("./pages/Distribution"));
const CsdnWorkflow = lazy(() => import("./csdn/Workflow"));
const WeiboWorkflow = lazy(() => import("./weibo/Workflow"));
const PipixWorkflow = lazy(() => import("./pipix/Workflow"));
const ZhihuWorkflow = lazy(() => import("./zhihu/Workflow"));
const SmzdmWorkflow = lazy(() => import("./smzdm/Workflow"));
const Settings = lazy(() => import("./pages/Settings"));
const BatchProcessing = lazy(() => import("./pages/BatchProcessing"));

const SearchOperations = lazy(() => import("./pages/SearchOperations"));
const Split = lazy(() => import("./pages/Split"));
const ShareStatistics = lazy(() => import("./pages/ShareStatistics"));
const ResourceAnswers = lazy(() => import("./pages/ResourceAnswers"));
const ResourceExport = lazy(() => import("./pages/ResourceExport"));
function CsdnStudio() {
  return <Studio initialPlatform="csdn" />;
}
function CsdnPublish() {
  return <Publish platform="csdn" />;
}
const surfaces = {
  distribution: Distribution,
  workbench: Workbench,
  "baidu-discovery": BaiduDiscovery,
  "zhidao-mine": KeywordMining,
  "zhidao-collect": ResourceCollection,
  "zhidao-qa": ZhidaoAnswers,
  "zhidao-templates": ZhidaoTemplates,
  "zhidao-publish": ZhidaoPublish,
  "zhidao-accounts": Accounts,
  "drive-files": DriveFiles,
  library: LibraryPage,
  "resource-catalog": ResourceCatalog,
  accounts: Accounts,
  "website-accounts": Accounts,
  "smzdm-accounts": Accounts,
  "smzdm-workflow": SmzdmWorkflow,
  "browser-environments": FingerprintBrowser,
  intake: Intake,
  tasks: Tasks,
  traffic: Traffic,
  studio: Studio,
  publish: Publish,
  "csdn-studio": CsdnStudio,
  "csdn-publish": CsdnPublish,
  "csdn-workflow": CsdnWorkflow,
  "weibo-marketing": WeiboWorkflow,
  "zhihu-operations": ZhihuWorkflow,
  "pipix-sources": PipixWorkflow,
  settings: Settings,
  bulk: BatchProcessing,
  batch: BatchProcessing,
  split: Split,
  search: SearchOperations,
  "share-statistics": ShareStatistics,
  "resource-export": ResourceExport,
  "resource-answers": ResourceAnswers,
};
export default function App() {
  const { data } = useAppData(),
    { page, navigate, editResourceId, editCopyId, openSearch } =
      useAppNavigation();
  const Surface = surfaces[page];
  const pendingJobs =
    data?.jobs.filter((job) => !["completed", "cancelled"].includes(job.stage))
      .length ?? 0;
  const status = useWorkspaceStatus();
  const { refresh } = useAppActions();
  const retry = () => {
    void refresh().catch(() => {});
  };
  if (!window.panxu)
    return (
      <div className="launch-error">
        <h1>请在盘序桌面程序中打开</h1>
        <p>
          这个界面需要本地桌面服务。请运行 npm run dev，或打开已安装的盘序。
        </p>
      </div>
    );
  if (!data)
    return (
      <StartupScreen
        error={status.error}
        loading={status.loading}
        onRetry={retry}
      />
    );
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-mark"
            src={brandMark}
            width="36"
            height="36"
            alt=""
          />
          <div>
            <strong>盘序</strong>
            <small>PANXU STUDIO</small>
          </div>
        </div>
        <nav id="main-navigation" aria-label="主导航">
          {sidebarEntries.map(({ page: id, title, Icon, group }) => (
            <div key={id}>
              {group ? <div className="nav-group">{group}</div> : null}
              <button
                aria-label={title}
                aria-current={sidebarPage(page) === id ? "page" : undefined}
                onClick={() => {
                  if (id === "search") openSearch();
                  else navigate(id);
                }}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="nav-label">{title}</span>
                {id === "workbench" && pendingJobs > 0 ? (
                  <span className="nav-count" title="待处理转存任务">
                    {pendingJobs}
                  </span>
                ) : null}
              </button>
            </div>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <span className="sidebar-version">
            盘序 {data?.appVersion ?? "…"}
          </span>
          {import.meta.env.DEV ? (
            <button
              className="dev-mode"
              title="当前工作区源码 · 前端热更新 · 后端空闲时自动重启。点击打开开发者工具。"
              onClick={() => void ipc("dev.tools")}
            >
              <Code2 size={13} aria-hidden="true" />
              开发调试
            </button>
          ) : null}
        </footer>
      </aside>
      <div className="app-body">
        <div className="topbar">
          <div>
            <WorkbenchNavigation />
          </div>
          <div className="topbar-task-actions">
            <SessionWindows />
            <ActiveTaskSwitcher />
            <BusyStatus />
          </div>
        </div>
        <main
          key={page}
          id="main-content"
          tabIndex={-1}
          className="main-content"
          data-page={page}
        >
          <UpdateBanner />
          <ToastMessage />
          <QueryError
            error={status.error}
            loading={status.loading}
            onRetry={retry}
          />
          <Suspense fallback={<LoadingState label="正在打开页面…" fill />}>
            <Surface
              key={
                page === "intake"
                  ? `${editResourceId ?? "new"}:${editCopyId ?? "new"}`
                  : page
              }
            />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function BusyStatus() {
  const { busy } = useAppActivity();
  return busy ? (
    <Loading />
  ) : (
    <>
      <i className="local-dot" />
      本地工作台
    </>
  );
}
