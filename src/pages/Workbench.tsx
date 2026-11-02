import { useTaskFocus } from "../tasks/TaskFocus";
import {
  ArrowRight,
  Plug,
  CircleCheck,
  CircleAlert,
  CircleHelp,
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
import { operationPage } from "../zhidao/navigation";
import { operationLabels } from "../../shared/zhidao";
import { formatTime } from "../lib/format";
import "../workbench/workbench.css";
import { useWorkbenchPosition } from "../workbench/useWorkbenchPosition";
import { WorkbenchTools } from "../workbench/WorkbenchTools";

export default function Workbench() {
  const { data } = useAppData(),
    { navigate, edit, openSettings } = useAppNavigation();
  const { request } = useTaskFocus();
  const summary = useIpcQuery("zhidao.summary", undefined, {
    refreshInterval: 3000,
    keepPrevious: true,
  });
  const accounts = summary.data?.accounts ?? [];
  const position = useWorkbenchPosition(data!.dataPath);
  return (
    <div
      className="workbench"
      ref={position.root}
      onClickCapture={position.remember}
    >
      <Header
        title="工作台"
        description="按功能组选择工具，开始处理项目任务。"
      />
      <div className="workbench-layout">
        <div className="workbench-primary">
          <WorkbenchTools
            onOpen={(page) => {
              if (page === "intake") edit(null);
              else navigate(page);
            }}
            onBindings={() => openSettings("bindings")}
          />
          <Panel
            title="最近运营任务"
            extra={<small>结果与断点保存在当前工作空间</small>}
          >
            {!summary.data && !summary.error ? (
              <LoadingState label="正在读取运营任务…" />
            ) : summary.data?.runs.length ? (
              <div className="operation-recent-list">
                {summary.data.runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => {
                      request({ id: run.id, kind: run.kind });
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
            <QueryError
              error={summary.error}
              loading={summary.loading}
              onRetry={summary.reload}
            />
            <div className="workbench-connections">
              <Connection
                ok={summary.data?.aiConfigured}
                title="AI 创作"
                detail={
                  summary.data
                    ? summary.data.aiConfigured
                      ? "使用现有模型与预算"
                      : "需要配置模型与 Key"
                    : summary.error
                      ? "暂未读取连接状态"
                      : "正在读取…"
                }
                onClick={() => openSettings("ai")}
              />
              <Connection
                ok={
                  summary.data
                    ? accounts.some((a) => a.status === "connected")
                    : undefined
                }
                title="百度知道"
                detail={
                  summary.data
                    ? `${accounts.filter((a) => a.status === "connected").length} 个账号已检查`
                    : summary.error
                      ? "暂未读取连接状态"
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
                    : summary.error
                      ? "暂未读取连接状态"
                      : "正在读取…"
                }
                onClick={() => navigate("zhidao-collect")}
              />
            </div>
          </Panel>
          <Panel title="需要继续处理" className="workbench-pending">
            <p>
              {summary.data
                ? `${summary.data.pending} 项运营任务待处理`
                : summary.error
                  ? "暂未读取运营任务"
                  : "正在读取运营任务…"}
            </p>
            <Button quiet onClick={() => navigate("tasks")}>
              {summary.data
                ? `${summary.data.transferPending} 项转存任务`
                : summary.error
                  ? "查看转存任务"
                  : "正在读取转存任务…"}
              <ArrowRight size={14} />
            </Button>
            <p className="muted">
              开始任务前核对账号。付费生成、转存和发布均由你主动启动。
            </p>
            <Button
              quiet
              size="compact"
              onClick={() => openSettings("maintenance")}
            >
              <Plug size={15} />
              工作空间与备份
            </Button>
          </Panel>
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
  const Icon = ok === undefined ? CircleHelp : ok ? CircleCheck : CircleAlert;
  return (
    <button type="button" onClick={onClick}>
      <Icon
        size={16}
        className={
          ok === undefined
            ? "connection-unknown"
            : ok
              ? "connection-good"
              : "connection-attention"
        }
        aria-hidden="true"
      />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowRight size={13} aria-hidden="true" />
    </button>
  );
}
