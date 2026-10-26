import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import {
  defaultGenerationRules,
  generationRules,
} from "../../shared/zhidao-generation";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { CheckboxField } from "../ui/CheckboxField";
import {
  GenerationTableSource,
  GenerationOwnedSource,
} from "./GenerationSources";
import { GenerationRuleFields } from "./GenerationRules";
import { GenerationPreview } from "./GenerationPreview";
import { useGenerationForm } from "./useGenerationForm";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
import "./generation.css";

export function GenerationWorkbench({ onReady }: { onReady(): void }) {
  const model = useGenerationForm(),
    run = useOperation("template"),
    action = useOperationAction();
  const { data } = useAppData(),
    { notify } = useAppActions(),
    { openSettings, navigate } = useAppNavigation();
  const [consent, setConsent] = useState(false);
  const { source, rules, copyIds } = model.form.value;
  const owned = useIpcQuery(
    "zhidao.template.sources",
    { copyIds },
    { enabled: source === "owned" && copyIds.length > 0 },
  );
  const resources =
    source === "table" ? model.mapped.resources : (owned.data ?? []);
  const count = source === "table" ? resources.length : copyIds.length;
  const parsed = generationRules.safeParse(rules);
  const busy = !!action.pending || run.running || model.loadingFile;
  const aiIssue =
    rules.mode !== "ai"
      ? ""
      : !data!.settings.openrouterConfigured
        ? "请先保存OpenRouter API Key。"
        : !data!.settings.aiModels.copy
          ? "请先选择文案创作模型并保存。"
          : "";
  const sourceIssue =
    source === "table"
      ? model.mappingIssue ||
        (model.mapped.issues.length
          ? "请先处理表格中的错误或重复行，再生成。"
          : "")
      : owned.error ||
        (copyIds.length && !owned.data ? "正在读取选中的本人资料…" : "");
  useEffect(() => {
    setConsent(false);
  }, [JSON.stringify(model.form.value), model.attachment.value]);
  const canGenerate =
    !!count &&
    parsed.success &&
    !sourceIssue &&
    !aiIssue &&
    !busy &&
    consent &&
    (source !== "table" || !model.error);
  return (
    <div className="generation-workbench">
      <Panel
        title="数据与规则"
        className="generation-config"
        extra={
          <div className="generation-config-actions">
            <Button
              quiet
              size="compact"
              disabled={busy}
              onClick={() => {
                const saved = model.saveConfig();
                notify(
                  saved
                    ? "生成配置已保存到当前工作空间"
                    : "配置暂存失败，请保留当前页面后重试。",
                  saved ? "success" : "error",
                );
              }}
            >
              <Save size={14} />
              保存配置
            </Button>
            <Button
              quiet
              size="compact"
              disabled={busy}
              onClick={() =>
                model.form.update({ rules: defaultGenerationRules })
              }
            >
              <RotateCcw size={14} />
              恢复默认
            </Button>
          </div>
        }
      >
        <div className="generation-config-body">
          <Field label="资料来源">
            <Select
              value={source}
              disabled={busy}
              onValueChange={(source) =>
                model.form.update({ source: source as "table" | "owned" })
              }
              items={[
                { value: "table", label: "导入XLSX / CSV资源表" },
                { value: "owned", label: "选择本人已核验分享" },
              ]}
            />
          </Field>
          {source === "table" ? (
            <GenerationTableSource model={model} disabled={busy} />
          ) : (
            <>
              <GenerationOwnedSource
                selected={copyIds}
                onChange={(copyIds) => model.form.update({ copyIds })}
                disabled={busy}
              />
              <Button
                quiet
                size="compact"
                disabled={busy || !copyIds.length}
                onClick={() => model.form.update({ copyIds: [] })}
              >
                清空资料选择
              </Button>
              <Button
                quiet
                size="compact"
                onClick={() => navigate("drive-files")}
              >
                管理网盘文件与分享
              </Button>
              <QueryError
                error={owned.error}
                loading={owned.loading}
                onRetry={owned.reload}
              />
            </>
          )}
          <GenerationRuleFields
            value={rules}
            onChange={model.updateRules}
            disabled={busy}
          />
          <CheckboxField
            checked={model.form.value.verifyFacts}
            disabled={busy}
            onChange={(event) =>
              model.form.update({ verifyFacts: event.target.checked })
            }
            label="生成前检索公开网页核对资料"
            hint="仅在开始生成时检索，并保存公开来源供审核参考。"
          />
          {!parsed.success ? (
            <Notice warning>{parsed.error.issues[0].message}</Notice>
          ) : null}
          {model.form.error ? <Notice danger>{model.form.error}</Notice> : null}
        </div>
        <div className="generation-submit">
          {aiIssue ? (
            <Notice warning>
              {aiIssue}
              <Button quiet size="compact" onClick={() => openSettings("ai")}>
                去配置
              </Button>
            </Notice>
          ) : null}
          {sourceIssue && !owned.error ? (
            <p className="generation-caption">{sourceIssue}</p>
          ) : null}
          <CheckboxField
            checked={consent}
            disabled={
              busy || !count || !!sourceIssue || !!aiIssue || !parsed.success
            }
            onChange={(event) => setConsent(event.target.checked)}
            label={
              rules.mode === "ai"
                ? "已核对资料及使用权限，确认调用AI生成"
                : "已核对资料内容及使用权限"
            }
            hint={
              rules.mode === "ai"
                ? `将使用文案模型处理${count}份资料，可能产生费用。生成不会自动发布。`
                : "模板整理不调用AI。生成后需逐条审核，再确认真实上传。"
            }
          />
          <div className="generation-submit-actions">
            <Button
              primary
              disabled={!canGenerate}
              onClick={() =>
                void action.run(
                  "zhidao.start",
                  {
                    kind: "template",
                    input: {
                      copyIds: source === "owned" ? copyIds : [],
                      resources: source === "table" ? resources : [],
                      rules,
                      confirmedResources: source === "table",
                      verifyFacts: model.form.value.verifyFacts,
                    },
                    authorized: true,
                  },
                  (result) => {
                    setConsent(false);
                    run.pick(result);
                  },
                  "问答生成任务已开始",
                )
              }
            >
              {action.pending === "zhidao.start"
                ? "正在创建…"
                : `生成${count ? ` ${count} 条` : ""}问答`}
            </Button>
            <span>
              {count ? `已准备${count}份资料` : "导入表格或选择本人资料后开始"}
            </span>
          </div>
        </div>
      </Panel>
      <div className="generation-results">
        <GenerationPreview resources={resources} rules={rules} />
        <div className="generation-next">
          <div>
            <strong>生成后，先审核再上传</strong>
            <p>已生成问答会进入待发布列表，统一核对账号、额度和内容。</p>
          </div>
          <Button onClick={onReady}>审核并上传</Button>
        </div>
        <RunPanel model={run}>
          {(items) => (
            <ResultTable
              items={items}
              editable
              running={run.running}
              onChanged={run.refresh}
            />
          )}
        </RunPanel>
      </div>
    </div>
  );
}
