import {
  ArrowRight,
  FolderOpen,
  Library,
  Files,
  FolderTree,
  NotebookPen,
  Workflow,
  ChartNoAxesCombined,
  Plug,
  CircleCheck,
  CircleAlert,
} from "lucide-react";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { operationEntries, operationPage } from "../zhidao/navigation";
import { operationLabels } from "../../shared/zhidao";
import { formatTime } from "../lib/format";
import "../zhidao/zhidao.css";

const tools = [
  { page: "library", title: "资源库", Icon: Library },
  { page: "batch", title: "批量处理", Icon: Files },
  { page: "split", title: "资料拆分", Icon: FolderTree },
  { page: "studio", title: "内容工作室", Icon: NotebookPen },
  { page: "search", title: "搜索运营", Icon: Workflow },
  { page: "share-statistics", title: "分享统计", Icon: ChartNoAxesCombined },
] as const;
export default function Workbench() {
  const { data } = useAppData(),
    { navigate, openSettings } = useAppNavigation();
  const summary = useIpcQuery("zhidao.summary", undefined, {
    refreshInterval: 3000,
    keepPrevious: true,
  });
  const accounts = summary.data?.accounts ?? [];
  return (
    <div className="workbench">
      <Header
        title="工作台"
        description="找资源、整理分享、创作问答，从这里开始。"
        action={
          <Button onClick={() => navigate("tasks")}>
            <FolderOpen size={15} />
            查看转存任务
          </Button>
        }
      />
      <section className="workbench-flow" aria-label="资源运营流程">
        <div>
          <h2>把资源变成可用的内容</h2>
          <p>发现名称 → 采集链接 → 转存分享 → 生成问答 → 审核发布</p>
        </div>
        <Button primary onClick={() => navigate("zhidao-collect")}>
          开始采集
          <ArrowRight size={15} />
        </Button>
      </section>
      <div className="workbench-layout">
        <div className="workbench-primary">
          <Panel
            title="百度知道运营"
            extra={
              <Button
                quiet
                size="compact"
                onClick={() => navigate("zhidao-accounts")}
              >
                管理账号
                <ArrowRight size={13} />
              </Button>
            }
          >
            <div className="workbench-entry-list">
              {operationEntries
                .slice(0, 6)
                .map(({ page, title, description, Icon }) => (
                  <button
                    className="workbench-entry"
                    key={page}
                    onClick={() => navigate(page)}
                  >
                    <Icon size={19} />
                    <span>
                      <strong>{title}</strong>
                      <small>{description}</small>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ))}
            </div>
          </Panel>
          <Panel title="常用工具">
            <div className="workbench-tools">
              {tools.map(({ page, title, Icon }) => (
                <Button quiet key={page} onClick={() => navigate(page)}>
                  <Icon size={17} />
                  {title}
                  <ArrowRight size={13} />
                </Button>
              ))}
            </div>
          </Panel>
          <Panel
            title="最近运营任务"
            extra={<small>结果与断点保存在当前工作空间</small>}
          >
            <QueryError
              error={summary.error}
              loading={summary.loading}
              onRetry={summary.reload}
            />
            {!summary.data && !summary.error ? (
              <LoadingState label="正在读取运营任务…" />
            ) : summary.data?.runs.length ? (
              <div className="operation-recent-list">
                {summary.data.runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => {
                      localStorage.setItem(
                        `panxu-operation-focus:${data!.dataPath}:${run.kind}`,
                        JSON.stringify({ id: run.id }),
                      );
                      navigate(operationPage[run.kind]);
                    }}
                  >
                    <span>
                      <strong>{run.title}</strong>
                      <small>
                        {operationLabels[run.kind]} ·{" "}
                        {formatTime(run.updatedAt)}
                      </small>
                    </span>
                    <Status
                      kind={
                        run.status === "completed"
                          ? "good"
                          : run.status === "running"
                            ? "normal"
                            : "warning"
                      }
                    >
                      {run.status === "running"
                        ? "进行中"
                        : run.status === "completed"
                          ? "已完成"
                          : run.status === "draft"
                            ? "待开始"
                            : "待处理"}
                    </Status>
                    <ArrowRight size={14} />
                  </button>
                ))}
              </div>
            ) : summary.data ? (
              <Empty title="从第一项运营任务开始" compact>
                采集、问答和模板的历史会显示在这里。
              </Empty>
            ) : null}
          </Panel>
        </div>
        <aside className="workbench-aside">
          <Panel title="连接状态">
            <div className="workbench-connections">
              <Connection
                ok={summary.data?.aiConfigured}
                title="AI 创作"
                detail={
                  summary.data
                    ? summary.data.aiConfigured
                      ? "使用现有模型与预算"
                      : "需要配置模型与 Key"
                    : "正在读取…"
                }
                onClick={() => openSettings("ai")}
              />
              <Connection
                ok={accounts.some((a) => a.status === "connected")}
                title="百度知道"
                detail={
                  summary.data
                    ? `${accounts.filter((a) => a.status === "connected").length} 个账号已检查`
                    : "正在读取…"
                }
                onClick={() => navigate("zhidao-accounts")}
              />
              <Connection
                ok={data!.accounts.some(
                  (a) => a.provider === "baidu" && a.status === "connected",
                )}
                title="百度网盘"
                detail="管理本人账号与登录状态"
                onClick={() => navigate("accounts")}
              />
              <Connection
                ok={summary.data?.pansouConfigured}
                title="PanSou 搜索"
                detail={
                  summary.data
                    ? summary.data.pansouConfigured
                      ? "已配置，采集时启动"
                      : "可连接本地服务"
                    : "正在读取…"
                }
                onClick={() => navigate("zhidao-collect")}
              />
            </div>
          </Panel>
          <Panel title="需要继续处理">
            <p>
              {summary.data
                ? `${summary.data.pending} 项运营任务待处理`
                : "正在读取运营任务…"}
            </p>
            <Button quiet onClick={() => navigate("tasks")}>
              {summary.data
                ? `${summary.data.transferPending} 项转存任务`
                : "正在读取转存任务…"}
              <ArrowRight size={14} />
            </Button>
            <p className="muted">
              开始任务前核对账号。付费生成、转存和发布均由你主动启动。
            </p>
          </Panel>
          <Button quiet onClick={() => openSettings("maintenance")}>
            <Plug size={15} />
            工作空间与备份
          </Button>
        </aside>
      </div>
    </div>
  );
}
function Connection({
  ok,
  title,
  detail,
  onClick,
}: {
  ok?: boolean;
  title: string;
  detail: string;
  onClick(): void;
}) {
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <button onClick={onClick}>
      <Icon
        size={16}
        className={ok ? "connection-good" : "connection-attention"}
      />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowRight size={13} />
    </button>
  );
}
