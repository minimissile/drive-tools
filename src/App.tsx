import { ipc } from "./api/client";
import { ToastMessage, useAppActivity } from "./state/feedback";
import { lazy, Suspense } from "react";
import {
  Files,
  FolderTree,
  Library,
  ListChecks,
  NotebookPen,
  Plug,
  FilePlus2,
  Radar,
  Send,
  Users,
  Workflow,
  ChartNoAxesCombined,
  FileOutput,
  Code2,
  LayoutDashboard,
} from "lucide-react";
import {
  useAppActions,
  useWorkspaceStatus,
  useAppData,
  useAppNavigation,
  type Page,
} from "./state";
import { QueryError } from "./ui/QueryError";
import { Loading, LoadingState } from "./ui/primitives";
import { UpdateBanner } from "./UpdatePanel";
import brandMark from "./assets/brand/panxu-mark.svg";
import { operationEntries } from "./zhidao/navigation";
const Workbench = lazy(() => import("./pages/Workbench"));
const ZhidaoMining = lazy(() => import("./zhidao/Mining"));
const ZhidaoCollection = lazy(() => import("./zhidao/Collection"));
const ZhidaoAnswers = lazy(() => import("./zhidao/Answers"));
const ZhidaoTemplates = lazy(() => import("./zhidao/Templates"));
const ZhidaoPublish = lazy(() => import("./zhidao/Publish"));
const ZhidaoAccounts = lazy(() => import("./zhidao/Accounts"));
const DriveFiles = lazy(() => import("./zhidao/DriveFiles"));
const Accounts = lazy(() => import("./pages/Accounts"));
const LibraryPage = lazy(() => import("./pages/Library"));
const Intake = lazy(() => import("./pages/Intake"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Traffic = lazy(() => import("./pages/Traffic"));
const Studio = lazy(() => import("./pages/Studio"));
const Publish = lazy(() => import("./pages/Publish"));
const Settings = lazy(() => import("./pages/Settings"));
const BatchProcessing = lazy(() => import("./pages/BatchProcessing"));

const SearchOperations = lazy(() => import("./pages/SearchOperations"));
const Split = lazy(() => import("./pages/Split"));
const ShareStatistics = lazy(() => import("./pages/ShareStatistics"));
const ResourceExport = lazy(() => import("./pages/ResourceExport"));
const navigation: {
  id: Page;
  title: string;
  Icon: typeof Users;
  group?: string;
}[] = [
  { id: "workbench", title: "工作台", Icon: LayoutDashboard },
  { id: "library", title: "资源库", Icon: Library, group: "资料管理" },
  { id: "resource-export", title: "AI 资源导出", Icon: FileOutput },
  { id: "intake", title: "录入资源", Icon: FilePlus2 },
  { id: "batch", title: "批量处理", Icon: Files, group: "转存与归档" },
  { id: "split", title: "资料拆分", Icon: FolderTree },
  { id: "tasks", title: "转存任务", Icon: ListChecks },
  { id: "search", title: "搜索运营", Icon: Workflow, group: "内容运营" },
  { id: "traffic", title: "流量发现", Icon: Radar },
  { id: "share-statistics", title: "分享统计", Icon: ChartNoAxesCombined },
  { id: "studio", title: "内容工作室", Icon: NotebookPen },
  { id: "publish", title: "发布准备", Icon: Send },
  { id: "accounts", title: "账号管理", Icon: Users, group: "工作空间" },
  { id: "settings", title: "连接与设置", Icon: Plug },
];
const surfaces = {
  workbench: Workbench,
  "zhidao-mine": ZhidaoMining,
  "zhidao-collect": ZhidaoCollection,
  "zhidao-qa": ZhidaoAnswers,
  "zhidao-templates": ZhidaoTemplates,
  "zhidao-publish": ZhidaoPublish,
  "zhidao-accounts": ZhidaoAccounts,
  "drive-files": DriveFiles,
  library: LibraryPage,
  accounts: Accounts,
  "website-accounts": Accounts,
  intake: Intake,
  tasks: Tasks,
  traffic: Traffic,
  studio: Studio,
  publish: Publish,
  settings: Settings,
  bulk: BatchProcessing,
  batch: BatchProcessing,
  split: Split,
  search: SearchOperations,
  "share-statistics": ShareStatistics,
  "resource-export": ResourceExport,
};
export default function App() {
  const { data } = useAppData(),
    { page, navigate, edit, editResourceId, editCopyId, openSearch } =
      useAppNavigation();
  const Surface = surfaces[page];
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
          {navigation.map(({ id, title, Icon, group }) => (
            <div key={id}>
              {group ? <div className="nav-group">{group}</div> : null}
              <button
                aria-label={title}
                aria-current={
                  page === id || (id === "batch" && page === "bulk") || (id === "accounts" && page === "website-accounts")
                    ? "page"
                    : undefined
                }
                onClick={() => {
                  if (id === "intake") edit(null);
                  else if (id === "search") openSearch();
                  else navigate(id);
                }}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="nav-label">{title}</span>
                {id === "tasks" &&
                data?.jobs.some(
                  (j) => !["completed", "cancelled"].includes(j.stage),
                ) ? (
                  <span className="nav-count">
                    {
                      data.jobs.filter(
                        (j) => !["completed", "cancelled"].includes(j.stage),
                      ).length
                    }
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
            我的工作空间<span>/</span>
            <strong>
              {
                navigation.find(
                  (n) => n.id === (page === "bulk" ? "batch" : page === "website-accounts" ? "accounts" : page),
                )?.title ?? operationEntries.find(entry => entry.page === page)?.title
              }
            </strong>
          </div>
          <span>
            <BusyStatus />
          </span>
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
          {data ? (
            <QueryError
              error={status.error}
              loading={status.loading}
              onRetry={retry}
            />
          ) : null}
          {data ? (
            <Suspense fallback={<LoadingState label="正在打开页面…" fill />}>
              <Surface
                key={
                  page === "intake"
                    ? `${editResourceId ?? "new"}:${editCopyId ?? "new"}`
                    : page
                }
              />
            </Suspense>
          ) : status.error ? (
            <QueryError
              error={status.error}
              loading={status.loading}
              onRetry={retry}
              title="本地知识库暂未打开"
              compact={false}
              fill
            >
              数据仍保存在本机。请重试读取；若仍失败，可查看开发控制台或重新打开盘序。
            </QueryError>
          ) : (
            <LoadingState label="正在打开本地知识库…" fill />
          )}
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
