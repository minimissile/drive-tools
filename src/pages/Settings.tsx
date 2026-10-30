import "../settings/settings.css";
import { useEffect } from "react";
import { focusSection } from "../ui/SectionNav";
import { SettingsNav } from "../settings/SettingsNav";
import { SettingsActions } from "../settings/SettingsActions";
import { useSettingsEditor } from "../settings/useSettingsEditor";
import { BrowserBindings } from "../settings/BrowserBindings";
import { WorkspaceBackup } from "../settings/WorkspaceBackup";
import { SecretField } from "../settings/SecretField";
import { ApiPlanForm } from "../settings/ApiPlanForm";
import { ContentSourcesSettings } from "../settings/ContentSources";
import { ResourceLinksSettings } from "../settings/ResourceLinksSettings";

import { useState } from "react";
import { Database, FolderOpen, Link, Save } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import { Button, Field, Header, Notice, Panel, Status } from "../ui/primitives";
import { formatMoney } from "../lib/format";
import type { AiConnection } from "../../shared/types";

import ModelSettings from "../ai/ModelSettings";
import { UpdatePanel } from "../UpdatePanel";
const reportedDollars = (amount: number | null) =>
  amount == null ? "未返回" : formatMoney(amount, "USD");
export default function Settings() {
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const { settingsSection } = useAppNavigation();
  useEffect(() => {
    if (settingsSection !== "ai") focusSection(`settings-${settingsSection}`);
  }, [settingsSection]);
  const editor = useSettingsEditor();
  const { aiModels, exportCodes, bitUrl, aiBudget } = editor.value;
  const { save, dirty } = editor;
  const setAiModels = (
    aiModels: import("../../shared/ai-models").AiModelSelection,
  ) => editor.update({ aiModels });
  const setExportCodes = (exportCodes: boolean) =>
    editor.update({ exportCodes });
  const setBitUrl = (bitUrl: string) => {
    editor.update({ bitUrl });
    setWindows([]);
    setWindowsRead(false);
  };
  const setAiBudget = (aiBudget: string) => editor.update({ aiBudget });
  const [windowsRead, setWindowsRead] = useState(false);
  const [aiConnection, setAiConnection] = useState<AiConnection | null>(null),
    [windows, setWindows] = useState<
      { id: string; name: string; seq: number | null }[]
    >([]);
  return (
    <div className="settings-page">
      <Header
        title="连接与设置"
        description="凭据在本机加密存储。网盘账号通过独立登录窗口管理，不在这里填写密码。"
        action={
          <Button
            primary
            disabled={busy > 0 || !Object.values(dirty).some(Boolean)}
            onClick={() => void save()}
          >
            <Save size={15} />
            保存设置
          </Button>
        }
      />
      <div className="settings-save-summary">
        <p className="muted">
          通用设置包含 AI
          模型与预算、知识库提取码和比特地址。密钥、接口套餐与发布映射请在对应分区保存。
        </p>
      </div>
      <div className="settings-layout">
        <SettingsNav />
        <div className="settings-content">
          {editor.error ? <Notice danger>{editor.error}</Notice> : null}
          <div id="settings-ai" tabIndex={-1}>
            <Panel
              title="OpenRouter"
              extra={
                <Status
                  kind={
                    data!.settings.openrouterConfigured ? "good" : "warning"
                  }
                >
                  {data!.settings.openrouterConfigured
                    ? "已保存Key"
                    : "尚未配置"}
                </Status>
              }
            >
              <SecretField
                kind="openrouter"
                configured={data!.settings.openrouterConfigured}
                onSaved={() => setAiConnection(null)}
              />
              <div className="settings-operation-row">
                <Button
                  disabled={!data!.settings.openrouterConfigured || busy > 0}
                  onClick={async () => {
                    setAiConnection(null);
                    const result = await command("ai.connection");
                    if (result) setAiConnection(result);
                  }}
                >
                  <Link size={14} />
                  验证Key与用量
                </Button>
                <small>
                  只查询Key状态，不生成内容；刷新模型列表不会验证Key。
                </small>
              </div>
              {aiConnection ? (
                <Notice warning={aiConnection.managementKey}>
                  {aiConnection.managementKey
                    ? "这是管理Key，请换用普通推理Key后生成内容。"
                    : "Key身份已验证。"}
                  <div className="property">
                    <span>Key累计用量</span>
                    <span>{reportedDollars(aiConnection.usageMicros)}</span>
                  </div>
                  <div className="property">
                    <span>Key今日用量</span>
                    <span>
                      {reportedDollars(aiConnection.usageDailyMicros)}
                    </span>
                  </div>
                  <div className="property">
                    <span>Key额度上限</span>
                    <span>
                      {aiConnection.limitMicros == null
                        ? "未返回或未设上限"
                        : formatMoney(aiConnection.limitMicros, "USD")}
                    </span>
                  </div>
                  <div className="property">
                    <span>Key剩余额度</span>
                    <span>{reportedDollars(aiConnection.remainingMicros)}</span>
                  </div>
                  <small>
                    查询于 {new Date(aiConnection.checkedAt).toLocaleString()}
                    。这是当前Key的服务商用量与额度，包含其他客户端调用；本应用台账只记录本机发出的生成请求。
                  </small>
                </Notice>
              ) : null}
              <ModelSettings
                key={data!.dataPath}
                value={aiModels}
                onChange={setAiModels}
              />
              <Field label="每日AI预算" hint="美元；留空不设置金额上限">
                <input
                  id="settings-ai-budget"
                  aria-invalid={!!editor.budgetError}
                  aria-describedby={
                    editor.budgetError ? "settings-budget-error" : undefined
                  }
                  type="number"
                  min="0"
                  step="0.01"
                  value={aiBudget}
                  onChange={(e) => setAiBudget(e.target.value)}
                />
              </Field>
              {editor.budgetError ? (
                <p
                  id="settings-budget-error"
                  className="settings-error"
                  role="alert"
                >
                  {editor.budgetError}
                </p>
              ) : null}
              <small>
                文案、分析、识图、图片和视频共用此Key及预算。留空不限制本地每日金额，服务商额度仍以账号实际状态为准。费用台账继续保留。
              </small>
              <small>
                OpenRouter按实际返回的usage.cost记录美元金额。AI资源导出还会发送你提交的参考图片及范围内的资源文字、个人笔记片段；文字中的链接和常见凭据字段会剔除。图片请自行遮盖敏感信息。
              </small>
              <SettingsActions
                dirty={dirty.ai}
                disabled={busy > 0}
                onSave={() => void save("ai")}
              >
                保存AI配置
              </SettingsActions>
            </Panel>
          </div>
          <div id="settings-traffic" tabIndex={-1}>
            <Panel
              title="5118：各接口分别配置"
              extra={
                <Button
                  quiet
                  onClick={() =>
                    void command("system.external", {
                      url: "https://www.5118.com/apistore",
                    })
                  }
                >
                  官方API商城
                </Button>
              }
            >
              <Notice>
                一个网站会员不等于已购买所有API。按实际接口填Key与套餐单价；本地估算不会冒充官方实扣。
              </Notice>
              <div className="api-plan-grid">
                {data!.plans.map((plan) => (
                  <ApiPlanForm key={plan.endpoint} plan={plan} />
                ))}
              </div>
            </Panel>
          </div>
          <div id="settings-sources" tabIndex={-1}>
            <ContentSourcesSettings />
          </div>
          <div id="settings-resource-links" tabIndex={-1}>
            <ResourceLinksSettings />
          </div>
          <div id="settings-notes" tabIndex={-1}>
            <Panel title="Obsidian / 本地知识库" extra={<Database size={18} />}>
              <div className="settings-path-row">
                <Field label="Vault根目录">
                  <input
                    readOnly
                    value={data!.settings.vaultPath ?? ""}
                    placeholder="可选；不安装Obsidian也能使用盘序"
                  />
                </Field>
                <Button
                  disabled={busy > 0}
                  onClick={() => void command("settings.vault")}
                >
                  <FolderOpen size={14} />
                  选择目录
                </Button>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={exportCodes}
                  onChange={(e) => setExportCodes(e.target.checked)}
                />
                在知识笔记中明文导出本人分享提取码
              </label>
              {exportCodes ? (
                <Notice warning>
                  提取码将进入此Vault的同步与备份；默认关闭。更改后点击下方保存知识库设置。
                </Notice>
              ) : null}
              <small>
                SQLite保管资源与任务，笔记导出到Vault/盘序。检测到生成区域被外部修改时保留原文件并报告冲突。
              </small>
              <SettingsActions
                dirty={dirty.notes}
                disabled={busy > 0}
                onSave={() => void save("notes")}
              >
                保存知识库设置
              </SettingsActions>
            </Panel>
          </div>
          <div id="settings-browser" tabIndex={-1}>
            <Panel title="比特浏览器 Local API">
              <Field
                label="本地接口根地址"
                hint="从比特浏览器设置复制，不写死端口"
              >
                <input
                  disabled={busy > 0}
                  aria-label="比特接口地址"
                  value={bitUrl}
                  onChange={(e) => setBitUrl(e.target.value)}
                  placeholder="http://127.0.0.1:你的端口"
                />
              </Field>
              <SecretField
                onSaved={() => {
                  setWindows([]);
                  setWindowsRead(false);
                }}
                kind="bit"
                configured={data!.settings.bitConfigured}
                label="Local API Key（客户端需要时填写）"
              />
              <div className="settings-operation-row">
                <Button
                  disabled={!bitUrl || busy > 0}
                  onClick={async () => {
                    if (await save("browser"))
                      await command(
                        "bit.health",
                        undefined,
                        "比特本地服务连接正常。",
                      );
                  }}
                >
                  <Link size={14} />
                  检测连接
                </Button>
                <Button
                  disabled={!bitUrl || busy > 0}
                  onClick={async () => {
                    if (await save("browser")) {
                      const result = await command("bit.windows");
                      if (result) {
                        setWindows(result);
                        setWindowsRead(true);
                      }
                    }
                  }}
                >
                  读取指纹窗口列表
                </Button>
              </div>
              {windowsRead ? (
                <p className="settings-result" role="status">
                  {windows.length
                    ? `已读取 ${windows.length} 个指纹窗口，可在发布映射中选择。`
                    : "未找到指纹窗口。请先在比特浏览器中创建窗口，再重新读取。"}
                </p>
              ) : null}
              <SettingsActions
                dirty={dirty.browser}
                disabled={busy > 0}
                onSave={() => void save("browser")}
              >
                保存比特地址
              </SettingsActions>
            </Panel>
          </div>
          <div id="settings-bindings" tabIndex={-1}>
            <BrowserBindings windows={windows} />
          </div>
          <div id="settings-maintenance" tabIndex={-1}>
            <WorkspaceBackup />
            <UpdatePanel />
          </div>
        </div>
      </div>
    </div>
  );
}
