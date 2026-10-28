import { useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { ipc } from "../api/client";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import { useBitBrowserWindows } from "./useBitBrowserWindows";
import { BitBrowserWindowRow } from "./BitBrowserWindowRow";
import { BitBrowserCloseDialog } from "./BitBrowserCloseDialog";
import { prepareEnvironmentAccounts } from "./environment-navigation";
import type {
  BrowserEnvironmentView,
  EnvironmentAccountRef,
} from "../../shared/browser-environments";
import type {
  BitBrowserProfile,
  BitBrowserWindow,
} from "../../shared/bitbrowser";
import "./bitbrowser-windows.css";

export function BitBrowserWindows({
  environments,
  onImport,
  onChanged,
}: {
  environments: BrowserEnvironmentView[] | null;
  onImport(
    profile: BitBrowserProfile & { connectorKey: string },
    trigger: HTMLButtonElement,
  ): void;
  onChanged(): void;
}) {
  const { data } = useAppData();
  const { notify } = useAppActions();
  const { navigate, openSettings } = useAppNavigation();
  const connector = data!.settings.bitUrl;
  const model = useBitBrowserWindows(connector, environments);
  const [expanded, setExpanded] = useState("");
  const [closing, setClosing] = useState<{
    profile: BitBrowserWindow;
    connectorKey: string;
  } | null>(null);
  const [pending, setPending] = useState("");
  const [failure, setFailure] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const lock = useRef(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const action = async (
    profile: BitBrowserWindow,
    account?: EnvironmentAccountRef,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(profile.id);
    setFailure(null);
    try {
      const command = { profileId: profile.id, connectorKey: connector };
      if (account) await ipc("bit.openAccount", { ...command, account });
      else await ipc("bit.openProfile", command);
      notify(
        account
          ? "已打开关联平台，请在窗口内核对当前账号。"
          : "比特窗口已打开。",
        "info",
      );
      model.reload();
      onChanged();
    } catch (cause) {
      setFailure({
        id: profile.id,
        message:
          cause instanceof Error ? cause.message : "窗口操作未完成，请重试。",
      });
    } finally {
      lock.current = false;
      setPending("");
    }
  };
  const accounts = (environmentId: string) => {
    prepareEnvironmentAccounts(data!.dataPath, environmentId);
    navigate("website-accounts");
  };
  const connected = !!model.snapshot;
  return (
    <Panel
      title="比特浏览器窗口"
      className="bit-windows-panel"
      extra={
        <div className="row">
          <Button quiet onClick={() => openSettings("browser")}>
            连接设置
          </Button>
          <Button
            disabled={!connector || model.loading || !!pending}
            onClick={model.reload}
          >
            <RefreshCw
              size={14}
              className={model.loading ? "spin" : undefined}
            />
            {model.loading ? "正在读取…" : "刷新窗口"}
          </Button>
        </div>
      }
    >
      <p className="muted">
        查看比特已有的全部窗口，选择接入盘序后关联平台账号。刷新只读取列表和运行状态。
      </p>
      {!connector ? (
        <Empty compact title="先连接比特浏览器">
          在“连接与设置”填写比特 Local API 地址，然后返回读取已有窗口。
          <Button onClick={() => openSettings("browser")}>配置比特连接</Button>
        </Empty>
      ) : (
        <>
          <QueryError
            error={model.error}
            loading={model.loading}
            onRetry={model.reload}
            title="暂时无法读取比特窗口"
          >
            请确认比特客户端已启动、Local API 地址正确且访问权限有效。
            {connected ? "当前保留上次列表，操作前请重新读取。" : ""}
          </QueryError>
          {!connected && !model.error ? (
            <LoadingState label="正在读取比特窗口和运行状态…" layout="list" />
          ) : null}
          {connected ? (
            <>
              <div className="bit-windows-toolbar" ref={toolbar}>
                <Field label="搜索窗口">
                  <div className="input-frame bit-window-search">
                    <Search size={15} aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="搜索比特窗口"
                      placeholder="名称、序号、ID 或备注"
                      value={model.search}
                      onChange={(event) => model.setSearch(event.target.value)}
                    />
                  </div>
                </Field>
                <Field label="运行状态">
                  <Select
                    aria-label="比特窗口运行状态"
                    value={model.running}
                    onValueChange={model.setRunning}
                    items={[
                      { value: "all", label: "全部运行状态" },
                      { value: "running", label: "运行中" },
                      { value: "closed", label: "未运行" },
                      { value: "unknown", label: "状态未知" },
                    ]}
                  />
                </Field>
                <Field label="接入状态">
                  <Select
                    aria-label="比特窗口接入状态"
                    value={model.registered}
                    onValueChange={model.setRegistered}
                    disabled={!environments}
                    items={[
                      { value: "all", label: "全部接入状态" },
                      { value: "yes", label: "已接入盘序" },
                      { value: "no", label: "未接入盘序" },
                    ]}
                  />
                </Field>
                <Field label="比特分组">
                  <Select
                    aria-label="比特窗口分组"
                    value={model.group}
                    onValueChange={model.setGroup}
                    items={[
                      { value: "all", label: "全部分组" },
                      { value: "none", label: "未分组" },
                      ...model.groups.map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ]}
                  />
                </Field>
              </div>
              <div className="bit-windows-summary" aria-live="polite">
                <span>
                  {model.snapshot!.windows.length} 个窗口 ·{" "}
                  {model.filtered.length} 个符合条件
                </span>
                {model.loading ? (
                  <Loading label="正在刷新，保留上次列表…" />
                ) : (
                  <span>上次读取 {formatTime(model.snapshot!.checkedAt)}</span>
                )}
                {model.hasFilters ? (
                  <Button quiet size="compact" onClick={model.clearFilters}>
                    清除筛选
                  </Button>
                ) : null}
              </div>
              {model.snapshot!.statusError && !model.error ? (
                <Notice warning>{model.snapshot!.statusError}</Notice>
              ) : null}
              {!environments ? (
                <Notice>
                  本地环境信息尚未读到，暂不能接入或操作窗口。请在下方“已登记环境”重试读取。
                </Notice>
              ) : null}
              {model.rows.length ? (
                <div className="table-scroll">
                  <table className="bit-windows-table">
                    <thead>
                      <tr>
                        <th>序号 / 窗口</th>
                        <th>分组与备注</th>
                        <th>运行状态</th>
                        <th>盘序环境与账号</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.rows.map((profile) => (
                        <BitBrowserWindowRow
                          key={profile.id}
                          profile={profile}
                          environment={model.environmentMap.get(profile.id)}
                          localReady={!!environments}
                          connector={connector}
                          readAt={model.snapshot!.checkedAt}
                          pending={pending}
                          listError={!!model.error}
                          expanded={expanded === profile.id}
                          failure={
                            failure?.id === profile.id ? failure.message : ""
                          }
                          onOpen={(account) => void action(profile, account)}
                          onAccounts={accounts}
                          onImport={onImport}
                          onToggle={() =>
                            setExpanded(
                              expanded === profile.id ? "" : profile.id,
                            )
                          }
                          onClose={() => {
                            setFailure(null);
                            setClosing({ profile, connectorKey: connector });
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  compact
                  title={
                    model.snapshot!.windows.length
                      ? "没有符合条件的窗口"
                      : "比特尚未返回可访问的窗口"
                  }
                >
                  {model.snapshot!.windows.length
                    ? "调整搜索或筛选条件后重试。"
                    : "请先在比特客户端创建窗口或确认窗口访问权限，再刷新列表。"}
                  {model.hasFilters ? (
                    <Button onClick={model.clearFilters}>清除筛选</Button>
                  ) : null}
                </Empty>
              )}
              <Pagination
                page={model.page}
                pageSize={model.pageSize}
                total={model.filtered.length}
                onPageChange={(page) => {
                  model.setPage(page);
                  toolbar.current?.scrollIntoView({ block: "start" });
                }}
                label="比特窗口分页"
              >
                <span>
                  第 {model.page} /{" "}
                  {Math.max(
                    1,
                    Math.ceil(model.filtered.length / model.pageSize),
                  )}{" "}
                  页 · 共 {model.filtered.length} 个窗口
                </span>
                <Select
                  aria-label="每页窗口数量"
                  value={String(model.pageSize)}
                  onValueChange={(value) => {
                    model.setPageSize(Number(value));
                    toolbar.current?.scrollIntoView({ block: "start" });
                  }}
                  items={[
                    { value: "10", label: "每页 10 个" },
                    { value: "20", label: "每页 20 个" },
                    { value: "50", label: "每页 50 个" },
                  ]}
                />
              </Pagination>
            </>
          ) : null}
        </>
      )}
      {closing ? (
        <BitBrowserCloseDialog
          profile={closing.profile}
          command={{
            profileId: closing.profile.id,
            connectorKey: closing.connectorKey,
          }}
          environment={model.environmentMap.get(closing.profile.id)}
          onClose={() => setClosing(null)}
          onClosed={() => {
            setClosing(null);
            model.reload();
            onChanged();
            notify("关闭请求已发送，请核对刷新后的窗口状态。", "info");
          }}
        />
      ) : null}
    </Panel>
  );
}
