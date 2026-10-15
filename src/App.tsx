import { lazy, Suspense } from "react";
import {
  Files,
  FolderDown,
  FolderTree,
  Library,
  ListChecks,
  NotebookPen,
  Plug,
  FilePlus2,
  Radar,
  Send,
  Users,
  X,
} from "lucide-react";
import { useApp, type Page } from "./state";
import { Loading } from "./components";
const Accounts = lazy(() => import("./pages/Accounts"));
const LibraryPage = lazy(() => import("./pages/Library"));
const Intake = lazy(() => import("./pages/Intake"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Traffic = lazy(() => import("./pages/Traffic"));
const Studio = lazy(() => import("./pages/Studio"));
const Publish = lazy(() => import("./pages/Publish"));
const Settings = lazy(() => import("./pages/Settings"));
const Bulk = lazy(() => import("./pages/Bulk"));
const Batch = lazy(() => import("./pages/Batch"));
const Split = lazy(() => import("./pages/Split"));
const navigation: {
  id: Page;
  title: string;
  Icon: typeof Users;
  group?: string;
}[] = [
  { id: "library", title: "资源库", Icon: Library },
  { id: "intake", title: "录入资源", Icon: FilePlus2 },
  { id: "bulk", title: "批量录入", Icon: Files },
  { id: "batch", title: "批量转存", Icon: FolderDown },
  { id: "split", title: "资料拆分", Icon: FolderTree },
  { id: "tasks", title: "转存任务", Icon: ListChecks },
  { id: "traffic", title: "流量发现", Icon: Radar, group: "内容运营" },
  { id: "studio", title: "内容工作室", Icon: NotebookPen },
  { id: "publish", title: "发布准备", Icon: Send },
  { id: "accounts", title: "账号管理", Icon: Users, group: "工作空间" },
  { id: "settings", title: "连接与设置", Icon: Plug },
];
const surfaces = {
  library: LibraryPage,
  accounts: Accounts,
  intake: Intake,
  tasks: Tasks,
  traffic: Traffic,
  studio: Studio,
  publish: Publish,
  settings: Settings,
  bulk: Bulk,
  batch: Batch,
  split: Split,
};
export default function App() {
  const {
    data,
    page,
    navigate,
    toast,
    busy,
    edit,
    editResourceId,
    editCopyId,
  } = useApp();
  const Surface = surfaces[page];
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
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">序</span>
          <div>
            <strong>盘序</strong>
            <small>PANXU STUDIO</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {navigation.map(({ id, title, Icon, group }) => (
            <div key={id}>
              {group ? <div className="nav-group">{group}</div> : null}
              <button
                aria-current={page === id ? "page" : undefined}
                onClick={() => {
                  if (id === "intake") edit(null);
                  else navigate(id);
                }}
              >
                <Icon size={17} aria-hidden="true" />
                {title}
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
        <div className="workspace">
          <span className="avatar">我</span>
          <div>
            我的工作空间<small>本地优先 · 单人使用</small>
          </div>
        </div>
        <small className="sidebar-version">
          盘序 {data?.appVersion ?? "…"}
        </small>
      </aside>
      <div className="app-body">
        <div className="topbar">
          <div>
            我的工作空间<span>/</span>
            <strong>{navigation.find((n) => n.id === page)?.title}</strong>
          </div>
          <span>
            {busy ? (
              <Loading />
            ) : (
              <>
                <i className="local-dot" />
                本地工作台
              </>
            )}
          </span>
        </div>
        <main key={page} className="main-content">
          {toast ? (
            <div
              className={`toast ${toast.error ? "danger" : ""}`}
              role={toast.error ? "alert" : "status"}
            >
              {toast.text}
            </div>
          ) : null}
          {data ? (
            <Suspense fallback={<Loading label="正在打开页面…" />}>
              <Surface
                key={
                  page === "intake"
                    ? `${editResourceId ?? "new"}:${editCopyId ?? "new"}`
                    : page
                }
              />
            </Suspense>
          ) : (
            <div className="boot-loading">
              <Loading label="正在打开本地知识库…" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
