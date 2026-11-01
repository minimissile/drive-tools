import { useState } from "react";
import { Search } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { Empty, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import {
  pageDiscoveryInput,
  type PageDiscoveryInput,
} from "../../shared/zhidao-page-discovery";
import { useOperationAction } from "./hooks";
import { PageDiscoverySetup } from "./PageDiscoverySetup";
import { PageDiscoveryResults } from "./PageDiscoveryResults";
import {
  PageDiscoveryProgress,
  PageDiscoveryLogs,
} from "./PageDiscoveryActivity";
import "./page-discovery.css";
export default function PageDiscovery() {
  const query = useIpcQuery("zhidaoPages.latest", undefined, {
    keepPrevious: true,
    refreshInterval: 1500,
  });
  const action = useOperationAction();
  const [error, setError] = useState("");
  const run = query.data;
  const start = (input: PageDiscoveryInput) => {
    const parsed = pageDiscoveryInput.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "请检查输入参数。");
      return;
    }
    setError("");
    void action.run(
      "zhidaoPages.start",
      parsed.data,
      query.reload,
      undefined,
      (e) => setError(e.message),
    );
  };
  return (
    <OperationsWorkspace
      title="网盘回答发现"
      description="批量检索百度知道，逐页确认回答正文中的网盘链接，保留可直接打开的回答页。"
    >
      <PageDiscoverySetup
        running={run?.status === "running"}
        busy={!!action.pending || !!query.error || (!run && query.loading)}
        error={error}
        start={start}
      />
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!run && query.loading && !query.error ? (
        <LoadingState label="正在读取最近检索…" />
      ) : null}
      {run ? (
        <>
          <PageDiscoveryProgress
            run={run}
            refresh={query.reload}
            loading={query.loading}
          />
          <PageDiscoveryResults key={run.id} run={run} />
          <PageDiscoveryLogs key={run.id} run={run} />
        </>
      ) : !query.loading && !query.error ? (
        <Panel>
          <Empty icon={Search} compact title="发现可直接打开的网盘回答页">
            输入关键词开始检索，或先检查你提供的示例页。
          </Empty>
        </Panel>
      ) : null}
    </OperationsWorkspace>
  );
}
