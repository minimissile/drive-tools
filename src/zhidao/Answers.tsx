import { useState } from "react";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, LoadingState, Notice, Panel } from "../ui/primitives";
import { answerInput, autoAnswersStart } from "../../shared/zhidao";
import { Tabs, TabList } from "../ui/Tabs";
import { QueryError } from "../ui/QueryError";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { useOperation, useOperationAction } from "./hooks";
import { AnswerActivity } from "./AnswerActivity";
import { AnswerLogs } from "./AnswerLogs";
import { AutoAnswerSettings } from "./AutoAnswerSettings";
import { AnswerExpression } from "./AnswerExpression";
import { AnswerAccountsProgress } from "./AnswerAccountsProgress";
import { CheckboxField } from "../ui/CheckboxField";
import "./answers.css";
import {
  answerDraftKey,
  answerDraftSchema,
  defaultAnswerDraft,
} from "./answer-draft";
export default function Answers() {
  const { data } = useAppData(),
    { navigate, openSettings } = useAppNavigation();
  const action = useOperationAction(),
    model = useOperation("answer"),
    accounts = useIpcQuery("zhidao.accounts", undefined, {});
  const [consent, setConsent] = useState(false);
  const draft = useLocalDraft(
    answerDraftKey(data!.dataPath),
    defaultAnswerDraft,
    (v) => answerDraftSchema.parse(v),
  );
  const update: typeof draft.update = (patch) => {
    draft.update(patch);
    setConsent(false);
  };
  const sessions = useIpcQuery("zhidao.answer.sessions", undefined, {
    enabled: draft.value.mode === "auto",
    refreshInterval: 2000,
    keepPrevious: true,
  });
  const runningAccounts = new Set(
    (sessions.data ?? [])
      .filter((run) => run.status === "running")
      .map((run) => String(run.config.accountId)),
  );
  const selectedRunning = draft.value.accountIds.some((id) =>
    runningAccounts.has(id),
  );
  const accountsReady =
    draft.value.accountIds.length > 0 &&
    draft.value.accountIds.every((id) =>
      accounts.data?.some((a) => a.id === id && a.status === "connected"),
    );
  const input =
    draft.value.mode === "manual"
      ? {
          mode: "manual" as const,
          question: draft.value.question,
          style: draft.value.style,
        }
      : draft.value;
  const batchInput = { ...draft.value, authorized: true as const };
  const validInput =
    draft.value.mode === "manual"
      ? answerInput.safeParse(input).success
      : autoAnswersStart.safeParse(batchInput).success;
  const manualRunning =
    model.running && model.detail.data?.run.config.mode === "manual";
  const aiIssue = !data!.settings.openrouterConfigured
    ? "请先到连接与设置保存 OpenRouter API Key。"
    : !data!.settings.aiModels.copy
      ? "请先到连接与设置选择文案创作模型，并点击“保存设置”。"
      : "";
  return (
    <OperationsWorkspace
      title="智能问答"
      description="使用盘序现有 AI 生成回答。自动回答会向所选百度知道账号真实提交内容。"
    >
      <div className="answers-workbench">
        <Panel
          title="创作回答"
          className="answer-composer"
          extra={
            <Tabs
              value={draft.value.mode}
              onChange={(mode) => {
                draft.update({ mode });
                setConsent(false);
              }}
            >
              <TabList
                label="问答方式"
                items={[
                  ["manual", "手动回答"],
                  ["auto", "自动回答"],
                ]}
              />
            </Tabs>
          }
        >
          {aiIssue ? <Notice warning>{aiIssue}</Notice> : null}
          <div className="answer-layout">
            <section
              className="answer-source"
              aria-label={
                draft.value.mode === "auto" ? "账号与取题" : "填写问题"
              }
            >
              {draft.value.mode === "manual" ? (
                <>
                  <div className="answer-section-heading">
                    <h3>填写问题</h3>
                    <p>生成后可编辑回答，手动模式不会自动提交。</p>
                  </div>
                  <Field label="你的问题">
                    <textarea
                      rows={8}
                      value={draft.value.question}
                      maxLength={5000}
                      onChange={(e) =>
                        draft.update({ question: e.target.value })
                      }
                      placeholder="输入需要解答的问题…"
                    />
                  </Field>
                </>
              ) : (
                <>
                  {!accounts.data && !accounts.error ? (
                    <LoadingState compact label="正在读取知道账号…" />
                  ) : null}
                  <QueryError
                    error={accounts.error}
                    loading={accounts.loading}
                    onRetry={accounts.reload}
                  />
                  <AutoAnswerSettings
                    value={draft.value}
                    update={update}
                    accounts={accounts.data ?? null}
                    busy={!!action.pending}
                    runningAccounts={runningAccounts}
                    onAccounts={() => navigate("zhidao-accounts")}
                    onCheck={(id) => {
                      setConsent(false);
                      void action.run(
                        "zhidao.account.check",
                        { id },
                        accounts.reload,
                        "账号状态已更新",
                      );
                    }}
                    onLogin={(id) =>
                      void action.run("zhidao.account.login", {
                        id,
                      })
                    }
                    onQuota={(id) =>
                      void action.run("zhidao.account.openRights", {
                        id,
                        page: "quota",
                      })
                    }
                  />
                </>
              )}
            </section>
            <AnswerExpression value={draft.value} update={update} />
          </div>
          {draft.error ? <Notice danger>{draft.error}</Notice> : null}
          <div className="answer-launch">
            <div className="answer-launch-context">
              {draft.value.mode === "auto" ? (
                <CheckboxField
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  label={`我已核对${draft.value.accountIds.length}个账号与每号${draft.value.count}条，授权本次 AI 生成和自动提交`}
                />
              ) : null}
              <small>
                {draft.value.mode === "auto"
                  ? `本次目标共${draft.value.accountIds.length * draft.value.count}条。各账号独立执行，安全验证只暂停对应账号。`
                  : "使用现有文案模型，生成费用计入 AI 台账。"}
              </small>
            </div>
            <div className="answer-launch-actions">
              <Button quiet onClick={() => openSettings("ai")}>
                {aiIssue ? "配置 AI 连接与模型" : "AI 模型与预算"}
              </Button>
              <Button
                primary
                disabled={
                  !!action.pending ||
                  (draft.value.mode === "manual"
                    ? manualRunning
                    : selectedRunning) ||
                  !!aiIssue ||
                  !validInput ||
                  (draft.value.mode === "manual"
                    ? !draft.value.question.trim()
                    : !consent ||
                      !accountsReady ||
                      !!sessions.error ||
                      !sessions.data ||
                      !draft.value.categories.length)
                }
                onClick={() => {
                  if (draft.value.mode === "auto") {
                    void action.run(
                      "zhidao.answer.startMany",
                      autoAnswersStart.parse(batchInput),
                      (runs) => {
                        setConsent(false);
                        if (runs[0]) model.pick(runs[0]);
                        sessions.reload();
                      },
                      "所选账号的回答任务已开始",
                    );
                    return;
                  }
                  void action.run(
                    "zhidao.start",
                    {
                      kind: "answer",
                      input,
                      authorized: true,
                    },
                    (run) => {
                      setConsent(false);
                      model.pick(run);
                    },
                    "问答任务已开始",
                  );
                }}
              >
                {draft.value.mode === "manual"
                  ? "生成回答"
                  : selectedRunning
                    ? "所选账号正在回答"
                    : "开始自动回答"}
              </Button>
            </div>
          </div>
        </Panel>
        <AnswerActivity
          model={model}
          accounts={accounts.data ?? []}
          accountOverview={
            draft.value.mode === "auto" ? (
              <AnswerAccountsProgress
                sessions={sessions.data ?? []}
                accounts={accounts.data ?? []}
                selected={draft.value.accountIds}
                currentId={model.id}
                onPick={model.pick}
                onChanged={() => {
                  sessions.reload();
                  model.refresh();
                }}
                error={sessions.error}
                loading={sessions.loading}
                onRetry={sessions.reload}
              />
            ) : undefined
          }
        />
        <AnswerLogs
          key={model.id || "idle"}
          runId={model.id}
          running={model.running}
        />
      </div>
    </OperationsWorkspace>
  );
}
