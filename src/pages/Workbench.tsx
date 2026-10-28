import { ArrowRight, Plug, CircleCheck, CircleAlert } from "lucide-react";
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
import { discoveryEntries } from "../resources/navigation";
import { operationLabels } from "../../shared/zhidao";
import { formatTime } from "../lib/format";
import {
  contentOperations,
  csdnOperations,
  weiboOperations,
  zhihuOperations,
  smzdmOperations,
  resourceOperations,
  type WorkbenchEntry,
} from "../navigation";
import "../workbench/workbench.css";
import { useWorkbenchPosition } from "../workbench/useWorkbenchPosition";

export default function Workbench() {
  const { data } = useAppData(),
    { navigate, edit, openSettings } = useAppNavigation();
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
          <Panel title="资源发现与采集">
            <EntryList entries={discoveryEntries} onOpen={navigate} />
          </Panel>
          <Panel
            title="百度知道答题"
            extra={
              <Button
                quiet
                size="compact"
                onClick={() => navigate("zhidao-accounts")}
              >
                管理知道账号
                <ArrowRight size={13} />
              </Button>
            }
          >
            <EntryList entries={operationEntries} onOpen={navigate} />
          </Panel>
          <Panel
            title="CSDN 内容操作"
            extra={
              <Button
                quiet
                size="compact"
                onClick={() => openSettings("bindings")}
              >
                发布窗口设置
                <ArrowRight size={13} />
              </Button>
            }
          >
            <EntryList entries={csdnOperations} onOpen={navigate} />
          </Panel>
          <Panel title="微博内容操作" extra={<Button quiet size="compact" onClick={() => navigate("website-accounts")}>管理微博账号<ArrowRight size={13} /></Button>}>
            <EntryList entries={weiboOperations} onOpen={navigate} />
          </Panel>
          <Panel title="知乎内容操作">
            <EntryList entries={zhihuOperations} onOpen={navigate} />
          </Panel>
          <Panel title="什么值得买内容操作" extra={<Button quiet size="compact" onClick={() => navigate("smzdm-accounts")}>管理值得买账号<ArrowRight size={13} /></Button>}>
            <EntryList entries={smzdmOperations} onOpen={navigate} />
          </Panel>
          <Panel title="资源与网盘操作">
            <EntryList
              entries={resourceOperations}
              onOpen={(page) => {
                if (page === "intake") edit(null);
                else navigate(page);
              }}
            />
          </Panel>
          <Panel title="通用内容操作">
            <EntryList entries={contentOperations} onOpen={navigate} />
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

function EntryList({
  entries,
  onOpen,
}: {
  entries: readonly WorkbenchEntry[];
  onOpen(page: WorkbenchEntry["page"]): void;
}) {
  return (
    <div className="workbench-entry-list">
      {entries.map(({ page, title, description, Icon }) => (
        <button
          className="workbench-entry"
          key={page}
          aria-label={title}
          data-workbench-entry={page}
          onClick={() => onOpen(page)}
        >
          <Icon size={19} aria-hidden="true" />
          <span>
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      ))}
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
