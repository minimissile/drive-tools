import { useId } from "react";
import type { BrowserEnvironmentView } from "../../shared/browser-environments";
import { Field } from "../ui/primitives";
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
}: {
  value: AccountBrowserSelection;
  onChange: (value: AccountBrowserSelection) => void;
  environments: BrowserEnvironmentView[];
  disabled?: boolean;
  existing?: boolean;
}) {
  const hintId = useId();
  const choices = environments.filter(
    (env) => env.engine === (value.fingerprint ? "bitbrowser" : "electron"),
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
              ...choices.map((env) => ({ value: env.id, label: env.name })),
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
    </div>
  );
}
