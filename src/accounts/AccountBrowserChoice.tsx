import { useId } from "react";
import type { BrowserEnvironmentView } from "../../shared/browser-environments";
import { environmentAllowsAccount } from "../../shared/browser-environment-sharing";
import { Button, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";

export type AccountBrowserSelection = {
  fingerprint: boolean;
  environmentId: string;
};

/** Login choice only; changing the switch never changes an account binding. */
export function AccountBrowserChoice({
  value,
  onChange,
  environments,
  disabled,
  existing = false,
  onConfigure,
  platform,
}: {
  value: AccountBrowserSelection;
  onChange: (value: AccountBrowserSelection) => void;
  environments: BrowserEnvironmentView[];
  disabled?: boolean;
  existing?: boolean;
  onConfigure?(): void;
  platform: string;
}) {
  const hintId = useId();
  const choices = environments.filter(
    (env) =>
      env.engine === (value.fingerprint ? "bitbrowser" : "electron") &&
      environmentAllowsAccount(env, {
        kind: platform === "baidu-zhidao" ? "zhidao" : "website",
        platform,
      }),
  );
  const selected = choices.find((env) => env.id === value.environmentId);
  return (
    <div className="account-browser-choice">
      <label className="account-browser-toggle">
        <Switch
          checked={value.fingerprint}
          disabled={disabled}
          aria-label="关联指纹浏览器"
          aria-describedby={hintId}
          onCheckedChange={(fingerprint) =>
            onChange({ fingerprint, environmentId: "" })
          }
        />
        <span>关联指纹浏览器</span>
      </label>
      <p className="muted" id={hintId}>
        {value.fingerprint
          ? "通过所选指纹浏览器环境登录，适合多账号运营。"
          : "通过内置浏览器登录，无需安装或配置指纹浏览器。"}
      </p>
      {value.fingerprint || existing || value.environmentId ? (
        <Field label={value.fingerprint ? "指纹浏览器环境" : "内置浏览器环境"}>
          <Select
            aria-label={value.fingerprint ? "指纹浏览器环境" : "内置浏览器环境"}
            value={value.environmentId}
            disabled={disabled}
            onValueChange={(environmentId) =>
              onChange({ ...value, environmentId })
            }
            items={[
              {
                value: "",
                label: value.fingerprint
                  ? "请选择指纹浏览器环境"
                  : "自动新建独立内置环境",
              },
              ...choices.map((env) => ({
                value: env.id,
                label: `${env.name}${env.accounts.some((a) => a.kind === "drive") ? " · 百度共用后台" : ""}`,
              })),
              ...(value.environmentId && !selected
                ? [
                    {
                      value: value.environmentId,
                      label: "原环境不可用，请重新选择",
                    },
                  ]
                : []),
            ]}
          />
        </Field>
      ) : null}
      {value.fingerprint && !disabled && !choices.length ? (
        <Notice>
          暂无可用于此平台的指纹环境。网盘后台仅可与贴吧、知道共用。
          {onConfigure ? (
            <Button quiet onClick={onConfigure}>
              配置指纹浏览器
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {selected?.accounts.some((a) => a.kind === "drive") ? (
        <Notice>
          与百度网盘共用此窗口的
          IP、指纹和登录态，日常操作在后台串行执行。打开登录窗口会将共用环境切到可见模式；完成后请在网盘账号中转为后台，再检查各平台登录。
        </Notice>
      ) : null}
    </div>
  );
}
