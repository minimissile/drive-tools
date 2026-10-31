import { Plus } from "lucide-react";
import type { BrowserEnvironmentView } from "../../shared/browser-environments";
import { isDocumentProvider } from "../../shared/document-platforms";
import { PlatformIcon } from "../platforms/PlatformIcon";
import { Button, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import {
  AccountBrowserChoice,
  type AccountBrowserSelection,
} from "./AccountBrowserChoice";
import { otherProviderItems, type OtherProvider } from "./useOtherAccounts";

export function OtherAccountConnection({
  provider,
  onProvider,
  alias,
  onAlias,
  cookie,
  onCookie,
  browser,
  onBrowser,
  environments,
  environmentsReady,
  hasSmzdm,
  busy,
  canAdd,
  failure,
  onAdd,
  onConfigure,
}: {
  provider: OtherProvider;
  onProvider(value: OtherProvider): void;
  alias: string;
  onAlias(value: string): void;
  cookie: string;
  onCookie(value: string): void;
  browser: AccountBrowserSelection;
  onBrowser(value: AccountBrowserSelection): void;
  environments: BrowserEnvironmentView[];
  environmentsReady: boolean;
  hasSmzdm: boolean;
  busy: boolean;
  canAdd: boolean;
  failure?: string;
  onAdd(): void;
  onConfigure(): void;
}) {
  const document = isDocumentProvider(provider);
  const nativeOnly = provider === "smzdm" || document;
  return (
    <section
      className="account-connect website-account-connect"
      aria-label="新增其他账号"
    >
      <div className="account-connect-heading">
        <h2>连接新账号</h2>
        <p>
          {nativeOnly
            ? "在官方窗口完成登录，再返回检查登录状态。"
            : provider === "baidu-marketing"
              ? "默认使用内置浏览器，在官方窗口登录后检查身份。"
              : "默认关联指纹浏览器。选择可用环境后关联，读取已有登录身份。"}
        </p>
      </div>
      <div className="website-account-add">
        <Field label="账号平台">
          <Select
            aria-label="其他账号平台"
            disabled={busy}
            value={provider}
            onValueChange={(value) => onProvider(value as OtherProvider)}
            items={otherProviderItems.map((item) => ({
              ...item,
              label: (
                <span className="platform-option">
                  <PlatformIcon platform={item.value} size="small" />
                  {item.label}
                </span>
              ),
            }))}
          />
        </Field>
        <Field label="账号备注" hint="可选">
          <input
            disabled={busy}
            value={alias}
            maxLength={60}
            onChange={(event) => onAlias(event.target.value)}
            placeholder="例如：运营主账号"
          />
        </Field>
        <Button primary disabled={!canAdd} onClick={onAdd}>
          <Plus size={15} aria-hidden="true" />
          {busy
            ? "正在连接…"
            : provider === "smzdm" && hasSmzdm
              ? "已添加单账号"
              : browser.fingerprint && !nativeOnly
                ? "关联并检查登录"
                : "登录新账号"}
        </Button>
      </div>
      {nativeOnly ? (
        <p className="website-account-connect-hint">
          {document
            ? "使用独立内置浏览器保存登录；文档的公开访问权限需在官方平台设置。"
            : hasSmzdm
              ? "什么值得买仅支持一个账号，请在下方账号中登录或检查身份。"
              : "什么值得买使用独立内置浏览器保存登录状态。"}
        </p>
      ) : (
        <AccountBrowserChoice
          platform={provider}
          value={browser}
          onChange={onBrowser}
          environments={environments}
          disabled={busy || !environmentsReady}
          onConfigure={onConfigure}
        />
      )}
      {!nativeOnly && browser.environmentId ? (
        <p className="website-account-connect-hint">
          新账号将关联到“
          {environments.find((env) => env.id === browser.environmentId)?.name ??
            "原环境不可用"}
          ”。已有账号可在更多操作中更换环境。
        </p>
      ) : null}
      {provider === "zhihu" && !browser.fingerprint ? (
        <p className="website-account-connect-hint">
          知乎养号和自动发布任务需关联指纹浏览器环境。
        </p>
      ) : null}
      {provider === "baidu-zhidao" ? (
        <p className="website-account-connect-hint">
          登录检查、资格与额度、知道采集、自动答题和问答上传均使用所选环境的登录状态与网络。
        </p>
      ) : provider === "tieba" ? (
        <p className="website-account-connect-hint">
          连接后可打开贴吧、核验账号身份。发帖能力仍需在发布能力中单独配置。
        </p>
      ) : null}
      {provider === "baidu-zhidao" ? (
        <details className="website-account-cookie">
          <summary>使用已有 Cookie（可选）</summary>
          <Field label="百度知道 Cookie" hint="仅本次提交，不随表单恢复">
            <input
              disabled={busy}
              type="password"
              autoComplete="off"
              value={cookie}
              onChange={(event) => onCookie(event.target.value)}
              maxLength={20000}
            />
          </Field>
        </details>
      ) : null}
      {failure ? <Notice danger>{failure}</Notice> : null}
    </section>
  );
}
