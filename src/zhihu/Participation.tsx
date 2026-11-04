import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ZhihuParticipationSnapshot } from "../../shared/zhihu-participation";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { windowStorage } from "../storage/window-storage";
import { useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { SearchSelect } from "../ui/SearchSelect";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { ParticipationCandidates } from "./ParticipationCandidates";
import { ParticipationActivities } from "./ParticipationActivities";
import {
  useParticipationAction,
  type ParticipationAction,
} from "./participation-state";
import "./participation.css";

export interface ParticipationAccount {
  id: string;
  alias: string;
  nickname?: string | null;
  environmentName?: string;
  status?: string;
}
export interface ZhihuParticipationProps {
  accounts: ParticipationAccount[];
  workspace: string;
  planId?: string;
  accountIds?: readonly string[];
  onOpenContents?(): void;
}
const accountNavigation = z.object({ accountId: z.string().default("") });
const localNavigation = z.object({
  query: z.string().max(200).default(""),
  kind: z.enum(["question", "author"]).default("question"),
  view: z.enum(["candidates", "activities"]).default("candidates"),
  candidateId: z.string().default(""),
  activityId: z.string().default(""),
});

export function ZhihuParticipation({
  accounts,
  workspace,
  planId,
  accountIds,
  onOpenContents,
}: ZhihuParticipationProps) {
  const { navigate } = useAppNavigation();
  const scope = `${workspace}:${planId ?? "all"}`;
  const allowedAccounts = accountIds
    ? accounts.filter((a) => accountIds.includes(a.id))
    : accounts;
  const selection = useLocalDraft(
    `panxu-zhihu-participation-account-v1:${scope}`,
    accountNavigation.parse({}),
    (value) => accountNavigation.parse(value),
  );
  const account =
    allowedAccounts.find((a) => a.id === selection.value.accountId) ??
    allowedAccounts[0];
  const query = useIpcQuery("zhihu.participation.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const action = useParticipationAction(query.reload);
  return (
    <div className="zhihu-participation">
      <Panel
        title="日常参与"
        extra={
          <Button
            size="compact"
            disabled={query.loading}
            onClick={query.reload}
          >
            刷新本地记录
          </Button>
        }
      >
        <div className="participation-account-bar">
          <fieldset
            className="participation-account-choice"
            disabled={action.pending}
          >
            <Field label="参与账号" as="div">
              <SearchSelect
                label="选择知乎参与账号"
                placeholder="查找知乎账号"
                items={allowedAccounts.map((a) => ({
                  value: a.id,
                  label: `${a.nickname || a.alias}${a.environmentName ? ` · ${a.environmentName}` : ""}`,
                }))}
                value={{
                  value: account?.id ?? "",
                  label: account
                    ? `${account.nickname || account.alias}${account.environmentName ? ` · ${account.environmentName}` : ""}`
                    : "没有可选账号",
                }}
                onChange={(accountId) => selection.update({ accountId })}
              />
            </Field>
          </fieldset>
          <div>
            <Status kind={query.data?.busy ? "warning" : "normal"}>
              {query.data?.busy ? "账号操作进行中" : "本地候选与任务"}
            </Status>
            <p className="participation-meta">
              找题、读取上下文、准备回答与相关参与。自主互动须单独授权；官方执行证据与本人记录分开展示。
            </p>
          </div>
        </div>
        {selection.error ? <Notice warning>{selection.error}</Notice> : null}
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
          title="日常参与记录读取失败"
        >
          已保存的任务仍保留，请重试读取，不要重复创建。
        </QueryError>
        {action.error ? (
          <div role="alert">
            <Notice danger>{action.error}</Notice>
          </div>
        ) : null}
        {!query.data && !query.error ? (
          <LoadingState compact label="正在读取候选、上下文和参与任务…" />
        ) : null}
      </Panel>
      {!allowedAccounts.length ? (
        <Panel>
          <Empty
            compact
            title="当前范围没有已绑定的知乎账号"
            action={
              <Button
                size="compact"
                onClick={() => navigate("website-accounts")}
              >
                管理知乎账号
              </Button>
            }
          >
            先关联已登录的知乎账号，再发现真实问题与作者。
          </Empty>
        </Panel>
      ) : query.data && account ? (
        <ParticipationWorkspace
          key={`${account.id}:${planId ?? "all"}`}
          account={account}
          snapshot={query.data}
          workspace={workspace}
          planId={planId}
          busy={action.pending || query.data.busy}
          readError={!!query.error}
          run={action.run}
          onOpenContents={
            onOpenContents ??
            (() => {
              // This explicit navigation changes only the tab. The content
              // editor's existing unsaved draft remains untouched.
              try {
                windowStorage.setItem(
                  `panxu-zhihu-navigation-v1:${workspace}`,
                  JSON.stringify({ tab: "contents" }),
                );
              } catch {
                /* The workbench remains reachable when UI storage is unavailable. */
              }
              navigate("zhihu-operations");
            })
          }
        />
      ) : null}
      {query.data ? (
        <p className="participation-meta participation-log-location">
          日志目录：{query.data.logFolder} ·
          打开原页不会自动记为已读、已点赞或已关注。
        </p>
      ) : null}
    </div>
  );
}

function ParticipationWorkspace({
  account,
  snapshot,
  workspace,
  planId,
  busy,
  readError,
  run,
  onOpenContents,
}: {
  account: ParticipationAccount;
  snapshot: ZhihuParticipationSnapshot;
  workspace: string;
  planId?: string;
  busy: boolean;
  readError: boolean;
  run: ParticipationAction;
  onOpenContents(): void;
}) {
  const scope = `${workspace}:${account.id}:${planId ?? "all"}`;
  const navigation = useLocalDraft(
    `panxu-zhihu-participation-navigation-v1:${scope}`,
    localNavigation.parse({}),
    (value) => localNavigation.parse(value),
  );
  const [lastDiscovery, setLastDiscovery] = useState<{
    query: string;
    count: number;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = snapshot.candidates.filter(
    (c) => c.accountId === account.id,
  );
  const activities = snapshot.activities.filter(
    (a) => a.accountId === account.id && (!planId || a.planId === planId),
  );
  const discover = () => {
    const requested = navigation.value;
    void run(
      () =>
        ipc("zhihu.participation.discover", {
          accountId: account.id,
          query: requested.query.trim(),
          kind: requested.kind,
        }),
      (result) =>
        result.length
          ? `已更新 ${result.length} 个真实候选，本地历史保留`
          : "本次没有发现匹配候选，本地历史保留",
    ).then((result) => {
      if (result.ok && mounted.current)
        setLastDiscovery({
          query: requested.query,
          count: result.value.length,
        });
    });
  };
  const discoverRecommended = () =>
    void run(
      () =>
        ipc("zhihu.participation.discover", {
          accountId: account.id,
          kind: "question",
          source: "creator_recommend",
        }),
      (result) =>
        `推荐问题：浏览量大于1万的候选 ${result.length} 项，尚未准备或发布回答`,
    ).then((result) => {
      if (result.ok && mounted.current)
        setLastDiscovery({
          query: "创作者推荐 · 浏览量 > 1万",
          count: result.value.length,
        });
    });
  return (
    <>
      <Panel>
        <div className="row spread">
          <small className="participation-meta">
            优先读取此账号创作者推荐，筛选浏览量 &gt; 10,000
            的问题；热度不代替全文与回答依据。
          </small>
          <Button size="compact" disabled={busy} onClick={discoverRecommended}>
            推荐问题 · 浏览量大于1万
          </Button>
        </div>
        <form
          className="participation-discovery"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && navigation.value.query.trim()) discover();
          }}
        >
          <Field label="领域关键词">
            <input
              value={navigation.value.query}
              maxLength={200}
              disabled={busy}
              placeholder="输入关心的领域或具体问题"
              onChange={(e) => navigation.update({ query: e.target.value })}
            />
          </Field>
          <Field label="发现对象">
            <Select
              value={navigation.value.kind}
              disabled={busy}
              items={[
                { value: "question", label: "真实问题" },
                { value: "author", label: "相关作者" },
              ]}
              onValueChange={(kind) =>
                navigation.update({ kind: kind as "question" | "author" })
              }
            />
          </Field>
          <Button
            type="submit"
            disabled={busy || !navigation.value.query.trim()}
          >
            发现候选
          </Button>
        </form>
        {lastDiscovery ? (
          <p className="participation-meta">
            本次“{lastDiscovery.query}”发现 {lastDiscovery.count}{" "}
            项；下方清单包含此前保存的历史候选。
          </p>
        ) : null}
        {navigation.error ? <Notice warning>{navigation.error}</Notice> : null}
      </Panel>
      <Tabs
        value={navigation.value.view}
        onChange={(view) => navigation.update({ view })}
      >
        <TabList
          label="日常参与记录"
          items={[
            ["candidates", `候选与上下文 · ${candidates.length}`],
            ["activities", `参与任务 · ${activities.length}`],
          ]}
        />
        <TabPanel value="candidates">
          <ParticipationCandidates
            candidates={candidates}
            account={account}
            scope={scope}
            planId={planId}
            selectedId={navigation.value.candidateId}
            select={(candidateId) => navigation.update({ candidateId })}
            busy={busy}
            readError={readError}
            run={run}
            showActivity={(activityId) =>
              navigation.update({ view: "activities", activityId })
            }
          />
        </TabPanel>
        <TabPanel value="activities">
          <ParticipationActivities
            activities={activities}
            candidates={candidates}
            account={account}
            scope={scope}
            selectedId={navigation.value.activityId}
            select={(activityId) => navigation.update({ activityId })}
            busy={busy}
            readError={readError}
            run={run}
            onOpenContents={onOpenContents}
          />
        </TabPanel>
      </Tabs>
    </>
  );
}
