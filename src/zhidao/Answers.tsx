import { useState } from "react";
import { z } from "zod";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Tabs, TabList } from "../ui/Tabs";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { OperationsWorkspace } from "./Workspace";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
const schema = z.object({
  mode: z.enum(["manual", "auto"]),
  question: z.string(),
  style: z.enum(["清晰实用", "步骤详解", "简洁回答"]),
  accountId: z.string(),
  count: z.number(),
});
export default function Answers() {
  const { data } = useAppData(),
    { navigate, openSettings } = useAppNavigation();
  const action = useOperationAction(),
    model = useOperation("answer"),
    accounts = useIpcQuery("zhidao.accounts", undefined, {});
  const [consent, setConsent] = useState(false);
  const draft = useLocalDraft(
    `panxu-answers:${data!.dataPath}`,
    {
      mode: "manual" as const,
      question: "",
      style: "清晰实用" as const,
      accountId: "",
      count: 50,
    },
    (v) => schema.parse(v),
  );
  return (
    <OperationsWorkspace
      title="智能问答"
      description="使用盘序现有 AI 生成回答。自动回答会向所选百度知道账号真实提交内容。"
    >
      <Panel title="创作回答">
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
        {draft.value.mode === "manual" ? (
          <Field label="你的问题">
            <textarea
              rows={5}
              value={draft.value.question}
              maxLength={5000}
              onChange={(e) => draft.update({ question: e.target.value })}
              placeholder="输入需要解答的问题…"
            />
          </Field>
        ) : (
          <>
            <QueryError
              error={accounts.error}
              loading={accounts.loading}
              onRetry={accounts.reload}
            />
            <div className="operations-form-grid">
              <Field label="回答账号">
                <Select
                  value={draft.value.accountId}
                  onValueChange={(accountId) => {
                    draft.update({ accountId });
                    setConsent(false);
                  }}
                  items={[
                    { value: "", label: "选择已检查的百度知道账号" },
                    ...(accounts.data ?? [])
                      .filter((a) => a.status === "connected")
                      .map((a) => ({ value: a.id, label: a.alias })),
                  ]}
                />
              </Field>
              <Field label="目标回答数" hint="1–200条">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={draft.value.count}
                  onChange={(e) => {
                    draft.update({ count: Number(e.target.value) });
                    setConsent(false);
                  }}
                />
              </Field>
            </div>
            <Notice warning>
              按情感、综合、教育题库取题；生成后真实提交。账号限额、审核或安全验证可能使任务提前停止，实际结果以返回的回答ID和平台审核为准。
            </Notice>
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              我已核对账号与数量，授权本次 AI 生成和自动提交
            </label>
          </>
        )}
        <Field label="回答风格">
          <Select
            value={draft.value.style}
            onValueChange={(style) =>
              draft.update({ style: style as typeof draft.value.style })
            }
            items={["清晰实用", "步骤详解", "简洁回答"].map((value) => ({
              value,
              label: value,
            }))}
          />
        </Field>
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        <div className="operations-actions">
          <Button
            primary
            disabled={
              !!action.pending ||
              model.running ||
              (draft.value.mode === "manual"
                ? !draft.value.question.trim()
                : !consent || !draft.value.accountId)
            }
            onClick={() =>
              void action.run(
                "zhidao.start",
                {
                  kind: "answer",
                  input: {
                    ...draft.value,
                    count:
                      draft.value.mode === "manual" ? 1 : draft.value.count,
                  },
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
          <Button quiet onClick={() => openSettings("ai")}>
            查看 AI 模型与预算
          </Button>
          {draft.value.mode === "auto" ? (
            <Button quiet onClick={() => navigate("zhidao-accounts")}>
              管理知道账号
            </Button>
          ) : null}
          <small>使用现有文案模型，费用记入原有 AI 台账。</small>
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
