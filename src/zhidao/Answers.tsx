import { useState } from "react";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, LoadingState, Notice, Panel } from "../ui/primitives";
import { answerInput } from "../../shared/zhidao";
import { Tabs, TabList } from "../ui/Tabs";
import { QueryError } from "../ui/QueryError";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
import { AutoAnswerSettings } from "./AutoAnswerSettings";
import { AnswerExpression } from "./AnswerExpression";
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
  const account = accounts.data?.find((a) => a.id === draft.value.accountId);
  const input =
    draft.value.mode === "manual"
      ? {
          mode: "manual" as const,
          question: draft.value.question,
          style: draft.value.style,
        }
      : draft.value;
  const validInput = answerInput.safeParse(input).success;
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
            aria-label={draft.value.mode === "auto" ? "账号与取题" : "填写问题"}
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
                    onChange={(e) => draft.update({ question: e.target.value })}
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
                  busy={!!action.pending || model.running}
                  onAccounts={() => navigate("zhidao-accounts")}
                  onCheck={() => {
                    setConsent(false);
                    void action.run(
                      "zhidao.account.check",
                      { id: draft.value.accountId },
                      accounts.reload,
                      "账号状态已更新",
                    );
                  }}
                  onLogin={() =>
                    void action.run("zhidao.account.login", {
                      id: draft.value.accountId,
                    })
                  }
                  onQuota={() =>
                    void action.run("zhidao.account.openRights", {
                      id: draft.value.accountId,
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
                label="我已核对账号与数量，授权本次 AI 生成和自动提交"
              />
            ) : null}
            <small>
              {draft.value.mode === "auto"
                ? "安全验证会暂停任务；提交与审核结果以百度记录为准。"
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
                model.running ||
                !!aiIssue ||
                !validInput ||
                (draft.value.mode === "manual"
                  ? !draft.value.question.trim()
                  : !consent ||
                    account?.status !== "connected" ||
                    !draft.value.categories.length)
              }
              onClick={() =>
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
                )
              }
            >
              {draft.value.mode === "manual" ? "生成回答" : "开始自动回答"}
            </Button>
          </div>
        </div>
      </Panel>
      <RunPanel model={model}>
        {(items) => (
          <ResultTable
            items={items}
            editable
            running={model.running}
            onChanged={model.refresh}
          />
        )}
      </RunPanel>
    </OperationsWorkspace>
  );
}
