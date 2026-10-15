import { useState } from "react";
import {
  Check,
  Database,
  FolderOpen,
  ExternalLink,
  KeyRound,
  Link,
  RefreshCw,
  Save,
} from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Field,
  Header,
  Notice,
  Panel,
  Status,
  formatMoney,
  formatTime,
} from "../components";
import type {
  AiConnection,
  ApiPlan,
  BrowserBinding,
  BackupPreview,
  Platform,
} from "../../shared/types";
import { endpointSpecs, platformSpecs } from "../../shared/platforms";
import type { AiModel } from "../../core/ai";
const reportedDollars = (amount: number | null) =>
  amount == null ? "未返回" : formatMoney(amount, "USD");
export default function Settings() {
  const { data, command, busy, notify } = useApp();
  const [model, setModel] = useState(data!.settings.model),
    [exportCodes, setExportCodes] = useState(data!.settings.exportCodes),
    [bitUrl, setBitUrl] = useState(data!.settings.bitUrl),
    [aiBudget, setAiBudget] = useState(
      data!.settings.dailyAiBudgetMicros == null
        ? ""
        : String(data!.settings.dailyAiBudgetMicros / 1_000_000),
    ),
    [models, setModels] = useState<AiModel[]>([]),
    [aiConnection, setAiConnection] = useState<AiConnection | null>(null),
    [windows, setWindows] = useState<
      { id: string; name: string; seq: number | null }[]
    >([]),
    [bindingId, setBindingId] = useState<string | undefined>(),
    [bindingPlatform, setBindingPlatform] = useState<Platform>("xiaohongshu"),
    [alias, setAlias] = useState(""),
    [windowId, setWindowId] = useState(""),
    [editorUrl, setEditorUrl] = useState(platformSpecs[0].defaultUrl),
    [allowLink, setAllowLink] = useState(false),
    [ruleNote, setRuleNote] = useState("");
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
      null,
    ),
    [restoreAck, setRestoreAck] = useState(false);
  const save = async () =>
    command(
      "settings.save",
      {
        model,
        exportCodes,
        bitUrl,
        dailyAiBudgetMicros:
          aiBudget === "" ? null : Math.round(Number(aiBudget) * 1_000_000),
      },
      "连接与工作空间设置已保存。",
    );
  const bindingSpec = platformSpecs.find((p) => p.id === bindingPlatform)!;
  return (
    <>
      <Header
        title="把工具接到你的工作方式里。"
        description="凭据在本机加密存储。网盘账号通过独立登录窗口管理，不在这里填写密码。"
        action={
          <Button primary disabled={busy > 0} onClick={() => void save()}>
            <Save size={15} />
            保存设置
          </Button>
        }
      />
      <Panel
        title="OpenRouter"
        extra={
          <Status
            kind={data!.settings.openrouterConfigured ? "good" : "warning"}
          >
            {data!.settings.openrouterConfigured ? "已保存Key" : "尚未配置"}
          </Status>
        }
      >
        <SecretField
          kind="openrouter"
          configured={data!.settings.openrouterConfigured}
          onSaved={() => setAiConnection(null)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <Button
            disabled={!data!.settings.openrouterConfigured || busy > 0}
            onClick={async () => {
              setAiConnection(null);
              const result = await command<AiConnection>("ai.connection");
              if (result) setAiConnection(result);
            }}
          >
            <Link size={14} />
            验证Key与用量
          </Button>
          <small>只查询Key状态，不生成内容；刷新模型列表不会验证Key。</small>
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
              <span>{reportedDollars(aiConnection.usageDailyMicros)}</span>
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
        <div className="row" style={{ marginTop: 16 }}>
          <Field label="模型" hint="请选择支持结构化输出的模型">
            <input
              className="model-input"
              list="ai-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="刷新列表后选择模型ID"
            />
            <datalist id="ai-models">
              {models
                .filter((m) => m.structured)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </datalist>
          </Field>
          <Button
            disabled={busy > 0}
            onClick={async () => {
              const list = await command<AiModel[]>("ai.models");
              if (list) {
                setModels(list);
                notify(
                  `已读取${list.length}个模型，列表筛选支持结构化输出的模型。`,
                );
              }
            }}
          >
            <RefreshCw size={14} />
            刷新模型列表
          </Button>
        </div>
        <Field label="每日AI预算" hint="美元；留空不设置金额上限">
          <input
            type="number"
            min="0"
            step="0.01"
            value={aiBudget}
            onChange={(e) => setAiBudget(e.target.value)}
          />
        </Field>
        <small>
          OpenRouter按实际返回的usage.cost记录美元金额。输入只包含资源文字和所选关键词，不发送Cookie、提取码或来源链接。
        </small>
      </Panel>
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
      <Panel title="Obsidian / 本地知识库" extra={<Database size={18} />}>
        <div className="row">
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
            提取码将进入此Vault的同步与备份；默认关闭。更改后点击顶部保存设置。
          </Notice>
        ) : null}
        <small>
          SQLite保管资源与任务，笔记导出到Vault/盘序。检测到生成区域被外部修改时保留原文件并报告冲突。
        </small>
      </Panel>
      <Panel title="比特浏览器 Local API">
        <Field label="本地接口根地址" hint="从比特浏览器设置复制，不写死端口">
          <input
            aria-label="比特接口地址"
            value={bitUrl}
            onChange={(e) => setBitUrl(e.target.value)}
            placeholder="http://127.0.0.1:你的端口"
          />
        </Field>
        <SecretField
          kind="bit"
          configured={data!.settings.bitConfigured}
          label="Local API Key（客户端需要时填写）"
        />
        <div className="row" style={{ marginTop: 12 }}>
          <Button
            disabled={!bitUrl || busy > 0}
            onClick={async () => {
              if (await save())
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
              if (await save()) {
                const result = await command<typeof windows>("bit.windows");
                if (result) setWindows(result);
              }
            }}
          >
            读取指纹窗口列表
          </Button>
        </div>
      </Panel>
      <Panel title="平台账号与指纹窗口映射">
        <div className="field-pair">
          <Field label="内容平台">
            <select
              disabled={!!bindingId}
              value={bindingPlatform}
              onChange={(e) => {
                const platform = e.target.value as Platform;
                setBindingPlatform(platform);
                setEditorUrl(
                  platformSpecs.find((p) => p.id === platform)!.defaultUrl,
                );
                setAllowLink(false);
              }}
            >
              {platformSpecs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="发布账号别名">
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="例如：效率分享小红书账号"
            />
          </Field>
          <Field label="比特窗口ID">
            <input
              list="bit-windows"
              value={windowId}
              onChange={(e) => setWindowId(e.target.value)}
              placeholder="读取窗口列表后选择，也可以手填ID"
            />
            <datalist id="bit-windows">
              {windows.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name} {w.seq}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="编辑器入口">
            <input
              value={editorUrl}
              onChange={(e) => setEditorUrl(e.target.value)}
            />
          </Field>
        </div>
        <Notice warning>{bindingSpec.rule}</Notice>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={allowLink}
            disabled={bindingSpec.linkMode === "blocked"}
            onChange={(e) => setAllowLink(e.target.checked)}
          />
          已核实此账号与场景允许相关网盘链接
        </label>
        {allowLink ? (
          <Field
            label="核实依据"
            hint="至少10字，记录具体后台能力、场景与规则来源"
          >
            <textarea
              value={ruleNote}
              onChange={(e) => setRuleNote(e.target.value)}
              placeholder="记录允许的发布场景和核实依据"
            />
          </Field>
        ) : null}
        <div className="actions">
          <Button
            primary
            disabled={!alias || !windowId || !editorUrl || busy > 0}
            onClick={async () => {
              const saved = await command<BrowserBinding>(
                "binding.save",
                {
                  id: bindingId,
                  platform: bindingPlatform,
                  alias,
                  windowId,
                  editorUrl,
                  linkPermission: allowLink ? "allowed" : "none",
                  ruleNote,
                },
                "平台账号与窗口映射已保存。",
              );
              if (saved) {
                setBindingId(undefined);
                setAlias("");
                setWindowId("");
                setRuleNote("");
                setAllowLink(false);
              }
            }}
          >
            <Save size={14} />
            {bindingId ? "更新映射" : "保存映射"}
          </Button>
          {bindingId ? (
            <Button
              quiet
              onClick={() => {
                setBindingId(undefined);
                setAlias("");
                setWindowId("");
                setAllowLink(false);
                setRuleNote("");
              }}
            >
              取消修改
            </Button>
          ) : null}
        </div>
        {data!.bindings.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>平台账号</th>
                  <th>指纹窗口</th>
                  <th>链接策略</th>
                  <th>编辑器入口</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data!.bindings.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.alias}
                      <br />
                      <small>
                        {platformSpecs.find((p) => p.id === b.platform)?.name}
                      </small>
                    </td>
                    <td>{b.windowId}</td>
                    <td>
                      {b.linkPermission === "allowed"
                        ? "按核实场景允许"
                        : "不附链接"}
                    </td>
                    <td className="break-word">
                      {b.editorUrl}
                      {b.lastCheckedAt ? (
                        <small className="table-note">
                          最近检查：{formatTime(b.lastCheckedAt)}
                        </small>
                      ) : null}
                      {b.openError ? (
                        <Notice warning>{b.openError}</Notice>
                      ) : b.lastOpenedAt ? (
                        <small className="table-note">
                          上次导航成功，发布前仍需核对窗口内的登录账号。
                        </small>
                      ) : (
                        <small className="table-note">
                          尚未检查页面访问状态
                        </small>
                      )}
                    </td>
                    <td>
                      <Button
                        quiet
                        disabled={busy > 0}
                        onClick={() =>
                          void command(
                            "binding.open",
                            { id: b.id },
                            "编辑器已打开，请在窗口内核对平台登录账号。",
                          )
                        }
                      >
                        <ExternalLink size={14} />
                        打开编辑器
                      </Button>
                      <Button
                        quiet
                        onClick={() => {
                          setBindingId(b.id);
                          setBindingPlatform(b.platform);
                          setAlias(b.alias);
                          setWindowId(b.windowId);
                          setEditorUrl(b.editorUrl);
                          setAllowLink(b.linkPermission === "allowed");
                          setRuleNote(b.ruleNote);
                        }}
                      >
                        编辑
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
      <Panel title="本地数据与备份">
        <div className="property">
          <span>数据目录</span>
          <span className="break-word">{data!.dataPath}</span>
        </div>
        <div className="row">
          <Button onClick={() => void command("system.dataFolder")}>
            <FolderOpen size={14} />
            打开数据目录
          </Button>
          <Button
            disabled={busy > 0}
            onClick={async () => {
              const folder = await command<string | null>("system.backup");
              if (folder)
                notify(`备份已保存到：${folder}。不含网盘登录态和API Key。`);
            }}
          >
            导出一致性备份
          </Button>
          <Button
            disabled={busy > 0}
            onClick={async () => {
              setBackupPreview(null);
              setRestoreAck(false);
              const preview = await command<BackupPreview | null>(
                "system.backupPreview",
              );
              if (preview) setBackupPreview(preview);
            }}
          >
            选择备份并预检
          </Button>
          {data!.settings.previousWorkspace ? (
            <Button
              disabled={busy > 0}
              onClick={() => void command("system.previousWorkspace")}
            >
              切回恢复前工作空间
            </Button>
          ) : null}
        </div>
        <small>
          备份包括SQLite快照和封面附件，排除凭据。升级前建议保留一份；不会联动删除网盘文件。
        </small>
        {backupPreview ? (
          <div className="restore-preview">
            <h3>备份预检通过</h3>
            <p className="break-word">{backupPreview.folder}</p>
            <p>
              {formatTime(backupPreview.createdAt)} · {backupPreview.resources}{" "}
              份资源 · {backupPreview.accounts} 个账号 · {backupPreview.drafts}{" "}
              份草稿 · {backupPreview.covers} 张封面
            </p>
            <Notice>
              恢复会建立新工作空间，保留当前数据。恢复后需要重新登录网盘、配置
              API Key 和
              Vault、复核分享及草稿；未完成任务暂停，避免重复转存。新空间的每日
              AI 预算默认设为 0。
            </Notice>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={restoreAck}
                onChange={(e) => setRestoreAck(e.target.checked)}
              />
              已保存正在编辑的内容，同意恢复到新工作空间并重启
            </label>
            <Button
              primary
              disabled={!restoreAck || busy > 0}
              onClick={() =>
                void command("system.restore", {
                  token: backupPreview.token,
                  confirmed: true,
                })
              }
            >
              恢复到新工作空间并重启
            </Button>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
function SecretField({
  kind,
  configured,
  label = "API Key",
  onSaved,
}: {
  kind: string;
  configured: boolean;
  label?: string;
  onSaved?: () => void;
}) {
  const { command, busy } = useApp(),
    [value, setValue] = useState("");
  return (
    <div className="row secret-row">
      <Field
        label={label}
        hint={configured ? "已保存；不回显原值" : "保存到系统加密存储"}
      >
        <input
          type="password"
          aria-label={`${kind}密钥`}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            configured ? "输入新Key可替换，留空不修改" : "粘贴你的Key"
          }
        />
      </Field>
      <Button
        disabled={!value.trim() || busy > 0}
        onClick={async () => {
          if (
            await command(
              "secret.save",
              { kind, value },
              "密钥已加密保存在本机。",
            )
          ) {
            setValue("");
            onSaved?.();
          }
        }}
      >
        <KeyRound size={14} />
        保存Key
      </Button>
      {configured ? (
        <Button
          quiet
          disabled={busy > 0}
          onClick={async () => {
            if (
              await command(
                "secret.save",
                { kind, value: "" },
                "本地Key已移除。",
              )
            )
              onSaved?.();
          }}
        >
          移除
        </Button>
      ) : null}
    </div>
  );
}
function ApiPlanForm({ plan }: { plan: ApiPlan }) {
  const { command, busy } = useApp(),
    [price, setPrice] = useState(
      plan.unitPriceMicros == null
        ? ""
        : String(plan.unitPriceMicros / 1_000_000),
    ),
    [units, setUnits] = useState(plan.dailyUnits),
    [budget, setBudget] = useState(
      plan.dailyBudgetMicros == null
        ? ""
        : String(plan.dailyBudgetMicros / 1_000_000),
    ),
    [enabled, setEnabled] = useState(plan.enabled);
  const spec = endpointSpecs[plan.endpoint];
  return (
    <section className="api-plan">
      <div className="panel-heading">
        <h3>{spec.name}</h3>
        <span className="tag">{spec.unit}</span>
      </div>
      <SecretField
        kind={`5118:${plan.endpoint}`}
        configured={plan.configured}
      />
      <div className="field-pair">
        <Field label="实际套餐单价" hint="人民币/计费单位，试用可填0">
          <input
            aria-label={`${spec.name}单价`}
            type="number"
            min="0"
            step="0.001"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field label="每日计费单位上限">
          <input
            type="number"
            min="1"
            max="1000000"
            value={units}
            onChange={(e) => setUnits(Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="每日金额预算" hint="人民币；留空仅限制计费单位">
        <input
          type="number"
          min="0"
          step="0.01"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {plan.endpoint === "radar"
          ? "已确认热点API开通权限并启用"
          : "启用此接口"}
      </label>
      <div className="row spread">
        <Button
          disabled={busy > 0}
          onClick={() =>
            void command(
              "api.plan",
              {
                endpoint: plan.endpoint,
                unitPriceMicros:
                  price === "" ? null : Math.round(Number(price) * 1_000_000),
                dailyUnits: units,
                dailyBudgetMicros:
                  budget === "" ? null : Math.round(Number(budget) * 1_000_000),
                enabled,
              },
              "接口计价与预算已保存。",
            )
          }
        >
          <Check size={14} />
          保存配置
        </Button>
        <Button
          quiet
          onClick={() =>
            void command("system.external", { url: spec.referenceUrl })
          }
        >
          官方计费说明
        </Button>
      </div>
    </section>
  );
}
