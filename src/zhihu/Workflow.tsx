import AutocarePanel from "./AutocarePanel";
import { useEffect, useRef, useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { Button, Header, LoadingState, Notice, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { zhihuSourceUrl } from "../../shared/zhihu";
import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { ZhihuOverview } from "./Overview";
import { ZhihuLogs } from "./Logs";
import { ZhihuAccounts, type ZhihuAction } from "./Accounts";
import { ZhihuContents } from "./Contents";
import { ZhihuTasks } from "./Tasks";
import { ZhihuParticipation } from "./Participation";
import "./zhihu.css";
export default function ZhihuWorkflow() {
  const [advanced, setAdvanced] = useState(false);
  return advanced ? (
    <>
      <Button size="compact" onClick={() => setAdvanced(false)}>
        返回自动养号
      </Button>
      <LegacyZhihuWorkflow />
    </>
  ) : (
    <AutocarePanel openAdvanced={() => setAdvanced(true)} />
  );
}
function LegacyZhihuWorkflow() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    { notify } = useAppActions();
  const query = useIpcQuery("zhihu.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const navigation = useLocalDraft(
    `panxu-zhihu-navigation-v1:${data?.dataPath ?? ""}`,
    { tab: "overview" },
    (value) =>
      z
        .object({
          tab: z.enum([
            "overview",
            "accounts",
            "contents",
            "tasks",
            "participation",
            "logs",
            "guide",
          ]),
        })
        .parse(value),
  );
  const tab = navigation.value.tab;
  const setTab = (tab: string) => navigation.update({ tab });
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Query reload is safe after navigation; no async completion changes the active page.
  const run: ZhihuAction = async (action, message, onError) => {
    if (lock.current) return false;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      await action();
      notify(message, "success");
      query.reload();
      return true;
    } catch (e) {
      if (alive.current) {
        const message = e instanceof Error ? e.message : "操作未完成，请重试。";
        if (onError) onError(message);
        else setError(message);
      }
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const s = query.data;
  return (
    <div className="zhihu-workflow">
      <Header
        title="知乎多号运营"
        description="账号进度、日常参与与发布记录，在账号绑定的比特环境中处理。"
        action={
          <div className="row">
            <Button size="compact" onClick={() => navigate("pipix-sources")}>
              公共素材采集
            </Button>
            <Button
              size="compact"
              onClick={() => navigate("browser-environments")}
            >
              浏览器环境
            </Button>
          </div>
        }
      />
      <div className="zhihu-scheduler-bar">
        <div>
          <Status kind={s?.running ? "good" : "normal"}>
            {!s
              ? query.error
                ? "调度状态未知"
                : "正在读取调度状态…"
              : s.running
                ? "本地调度运行中"
                : "本地调度已停止"}
          </Status>
          <span className="muted">
            {!s
              ? query.error
                ? "请重试读取运行状态"
                : "正在连接本地运行服务"
              : s.busy
                ? "正在执行发布任务"
                : s?.running
                  ? "等待下一项计划任务"
                  : "启用账号计划后启动调度"}
          </span>
          {s?.lastHeartbeatAt ? (
            <small>最近心跳 {formatTime(s.lastHeartbeatAt)}</small>
          ) : null}
        </div>
        <Button
          primary={!s?.running}
          size="compact"
          disabled={!s || pending}
          onClick={() =>
            void run(
              () =>
                ipc("zhihu.scheduler", {
                  running: !s!.running,
                  confirmed: true,
                }),
              s?.running
                ? "已停止调度；已提交的任务仍需核对回执"
                : "本地调度已启动",
            )
          }
        >
          {s?.running ? "停止调度" : "启动调度"}
        </Button>
      </div>
      {navigation.error ? <Notice warning>{navigation.error}</Notice> : null}
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {error ? (
        <div role="alert">
          <Notice danger>{error}</Notice>
        </div>
      ) : null}
      {!s && !query.error ? (
        <LoadingState label="正在读取知乎账号、素材与发布任务…" />
      ) : null}
      {s ? (
        <Tabs value={tab} onChange={setTab}>
          <TabList
            label="知乎运营功能"
            items={[
              ["overview", "运行总览"],
              ["accounts", "账号与养号"],
              ["participation", "日常参与"],
              ["contents", `素材池 · ${s.contents.length}`],
              [
                "tasks",
                `发布队列 · ${s.tasks.filter((t) => t.status === "queued").length}`,
              ],
              ["logs", "运行日志"],
              ["guide", "规则与来源"],
            ]}
          />
          <TabPanel value="overview">
            <ZhihuOverview snapshot={s} open={setTab} />
          </TabPanel>
          <TabPanel value="accounts">
            <ZhihuAccounts
              accounts={s.accounts}
              busy={pending || s.busy}
              run={run}
              manage={() => navigate("website-accounts")}
            />
          </TabPanel>
          <TabPanel value="participation">
            <ZhihuParticipation
              accounts={s.accounts}
              workspace={data!.dataPath}
              onOpenContents={() => setTab("contents")}
            />
          </TabPanel>
          <TabPanel value="contents">
            <ZhihuContents
              snapshot={s}
              workspace={data!.dataPath}
              busy={pending || s.busy}
              run={run}
            />
          </TabPanel>
          <TabPanel value="tasks">
            <ZhihuTasks
              tasks={s.tasks}
              accounts={s.accounts}
              busy={pending || s.busy}
              run={run}
            />
          </TabPanel>
          <TabPanel value="logs">
            <ZhihuLogs accounts={s.accounts} workspace={data!.dataPath} />
          </TabPanel>
          <TabPanel value="guide">
            <div className="zhihu-guide">
              <h2>养号标准</h2>
              <p>
                先入驻创作者中心，记录实际等级；默认目标五级。养号计划使用无推广的已审核内容，达到目标后停止。不会按天数推算等级。
              </p>
              <h3>多号错峰</h3>
              <p>
                每个知乎身份关联独立比特配置。账号及同出口默认至少间隔 60
                分钟，初始日限 3 篇、周限 15
                篇，可在账号规则中调整。每次执行会检查实际出口，失败时暂停。
              </p>
              <h3>异常恢复</h3>
              <p>
                验证码、账号限制、内容变化或结果未知都会暂停任务。核对官方页面后登记结果，避免重复发布。没有素材时暂停计划，补充审核素材后重新启用。
              </p>
              <h3>文章经验与实际反馈</h3>
              <p>
                文章介绍了文案、图片等素材和多账号错峰经验，升到四至五级是其运营目标。等级耗时、发文上限和内容留存以平台实际反馈为准。
              </p>
              <a
                href={zhihuSourceUrl}
                onClick={(e) => {
                  e.preventDefault();
                  void ipc("system.external", { url: zhihuSourceUrl });
                }}
              >
                阅读原文：知乎相关问题
              </a>
            </div>
          </TabPanel>
        </Tabs>
      ) : null}
    </div>
  );
}
