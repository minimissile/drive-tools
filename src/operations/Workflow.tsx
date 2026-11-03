import { z } from "zod";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData, useAppNavigation } from "../state";
import { formatTime } from "../lib/format";
import { Button, Header, LoadingState, Notice, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { OperationsPlans } from "./Plans";
import { OperationsTasks } from "./Tasks";
import { OperationsLogs } from "./Logs";
import { OperationsAdvice } from "./Advice";
import { OperationsAutonomy } from "./Autonomy";
import { useOperationAction } from "./useOperationAction";
import "./operations.css";

const navigationSchema = z.object({
  tab: z
    .enum(["autonomy", "tasks", "plans", "logs", "advice"])
    .default("autonomy"),
  planId: z.string().default(""),
});

export default function IntelligentOperationsWorkflow() {
  const { data } = useAppData();
  const { openSettings, navigate } = useAppNavigation();
  const query = useIpcQuery("intelligentOps.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const nav = useLocalDraft(
    `panxu-intelligent-operations-navigation-v1:${data?.dataPath ?? ""}`,
    navigationSchema.parse({}),
    (value) => navigationSchema.parse(value),
  );
  const { busy, interrupting, error, run, runInterrupt } = useOperationAction(
    query.reload,
  );
  const s = query.data;
  const runtime = s?.runtime;
  return (
    <div className="operations-workflow">
      <Header
        title="智能运营"
        description="AI在授权范围内读取状态、决策并执行，逐轮查看计划、工具与实际费用。"
        action={
          <Button size="compact" onClick={() => openSettings("ai")}>
            AI模型与预算
          </Button>
        }
      />
      <div className="operations-runtime">
        <div className="operations-runtime-copy">
          <Status kind={runtime?.running ? "good" : "normal"}>
            {!runtime
              ? query.error
                ? "运行状态未知"
                : "正在读取运行状态…"
              : runtime.running
                ? "统一调度运行中"
                : "统一调度已停止"}
          </Status>
          <span className="operations-quiet">
            {runtime?.message ?? "正在连接本地运营服务"}
          </span>
          {runtime?.lastHeartbeatAt ? (
            <small className="operations-quiet">
              心跳 {formatTime(runtime.lastHeartbeatAt)}
            </small>
          ) : null}
        </div>
        <Button
          size="compact"
          primary={!runtime?.running}
          disabled={
            !runtime || (runtime.running ? interrupting : busy || runtime.busy)
          }
          onClick={() => {
            if (!runtime) return;
            if (runtime.running) {
              void runInterrupt(
                () =>
                  ipc("intelligentOps.scheduler", {
                    running: false,
                    confirmed: true,
                  }),
                "统一调度已停止，已提交任务仍会保留结果",
              );
              return;
            }
            void run(
              () =>
                ipc("intelligentOps.scheduler", {
                  running: true,
                  confirmed: true,
                }),
              "统一调度已启动，将按启用计划与审核状态执行",
            );
          }}
        >
          {runtime?.running
            ? interrupting
              ? "正在停止…"
              : "停止调度"
            : "启动调度"}
        </Button>
      </div>
      {nav.error ? <Notice warning>{nav.error}</Notice> : null}
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="运营状态读取失败"
      >
        已完成的保存与操作不会撤销，请仅重试读取。
      </QueryError>
      {error ? (
        <div role="alert">
          <Notice danger>{error}</Notice>
        </div>
      ) : null}
      {!s && !query.error ? (
        <LoadingState label="正在读取运营计划与渠道能力…" />
      ) : null}
      {s ? (
        <Tabs value={nav.value.tab} onChange={(tab) => nav.update({ tab })}>
          <TabList
            label="智能运营功能"
            items={[
              ["autonomy", "自主运行"],
              ["tasks", "任务计划"],
              ["plans", `运营计划 · ${s.plans.length}`],
              ["logs", "决策日志"],
              ["advice", "单次AI建议"],
            ]}
          />
          <TabPanel value="autonomy">
            <OperationsAutonomy
              snapshot={s}
              workspace={data!.dataPath}
              busy={busy || s.runtime.busy}
              interrupting={interrupting}
              run={run}
              runInterrupt={runInterrupt}
              editPlan={(planId) => nav.update({ tab: "plans", planId })}
              openSettings={() => openSettings("ai")}
            />
          </TabPanel>
          <TabPanel value="tasks">
            <OperationsTasks
              snapshot={s}
              workspace={data!.dataPath}
              busy={busy || s.runtime.busy}
              run={run}
              createPlan={() => nav.update({ tab: "plans", planId: "" })}
              navigate={navigate}
            />
          </TabPanel>
          <TabPanel value="plans">
            <OperationsPlans
              snapshot={s}
              workspace={data!.dataPath}
              selected={nav.value.planId}
              select={(planId) => nav.update({ planId })}
              busy={busy || s.runtime.busy}
              run={run}
            />
          </TabPanel>
          <TabPanel value="logs">
            <OperationsLogs plans={s.plans} workspace={data!.dataPath} />
          </TabPanel>
          <TabPanel value="advice">
            <OperationsAdvice
              snapshot={s}
              busy={busy || s.runtime.busy}
              run={run}
              openSettings={() => openSettings("ai")}
            />
          </TabPanel>
        </Tabs>
      ) : null}
    </div>
  );
}
