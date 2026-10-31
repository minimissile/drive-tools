import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { providerIds, providerSpecs } from "../../shared/providers";
import type { Account, Provider } from "../../shared/types";
import type { NewDriveBrowserPreview } from "../../shared/drive-browser";
import { DriveBrowserCreation } from "./DriveBrowserCreation";
import {
  useAppActions,
  useAppActivity,
  useAppSelection,
  useAppData,
} from "../state";
import { ProviderIcon } from "../resources/ProviderIcon";
import { Select } from "../ui/Select";
import { Button, Field, Notice } from "../ui/primitives";

import { useLocalDraft } from "../hooks/useLocalDraft";
import { z } from "zod";
import { providerSchema } from "../../shared/schemas";
const accountInput = z.object({
  provider: providerSchema,
  alias: z.string().max(60),
  browserEngine: z.enum(["electron", "bitbrowser"]).default("electron"),
  profileId: z.string().max(200).default(""),
});

export function AddAccountForm({
  onAdded,
}: {
  onAdded(account: Account): void;
}) {
  const { command } = useAppActions();
  const { busy } = useAppActivity();
  const { setActiveAccount } = useAppSelection();
  const { data } = useAppData();
  const editor = useLocalDraft(
    `panxu-account-input-v1:${data!.dataPath}`,
    {
      provider: "quark" as Provider,
      alias: "",
      browserEngine: "electron" as "electron" | "bitbrowser",
      profileId: "",
    },
    (value) => accountInput.parse(value),
  );
  const { provider, alias, browserEngine, profileId } = editor.value;
  const setProvider = (provider: Provider) => {
    editor.update({ provider, browserEngine: "electron", profileId: "" });
    setPreview(null);
  };
  const setAlias = (alias: string) => editor.update({ alias });
  const [adding, setAdding] = useState(false);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<NewDriveBrowserPreview | null>(null);
  const fingerprint = provider === "baidu" && browserEngine === "bitbrowser";
  const validPreview =
    fingerprint && preview?.profileId === profileId ? preview : null;
  const disabled = busy > 0 || adding || reading;
  const hintId = useId();
  return (
    <form
      className="account-connect"
      aria-label="添加本人网盘账号"
      aria-describedby={hintId}
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || !alias.trim() || (fingerprint && !validPreview)) return;
        setAdding(true);
        try {
          const account = await command(
            "account.add",
            {
              provider,
              alias,
              browser: fingerprint
                ? { engine: "bitbrowser", previewToken: validPreview!.token }
                : { engine: "electron" },
            },
            fingerprint
              ? "账号已创建并固定使用所选指纹环境。"
              : "账号已创建并固定使用内置浏览器，请完成登录和核验。",
          );
          if (account) {
            setAlias("");
            setActiveAccount(account.provider, account.id);
            editor.clear();
            onAdded(account);
          }
        } finally {
          setAdding(false);
        }
      }}
    >
      <div className="account-connect-heading">
        <h2>添加本人账号</h2>
        <p id={hintId}>创建时确定浏览器方式，保存后不能切换或改绑。</p>
      </div>
      {editor.error ? <Notice warning>{editor.error}</Notice> : null}
      <div className="account-connect-fields">
        <Field label="网盘服务">
          <Select
            aria-label="新增账号网盘"
            value={provider}
            disabled={disabled}
            onValueChange={(value) => setProvider(value as Provider)}
            items={providerIds.map((id) => ({
              value: id,
              label: (
                <span className="provider-option">
                  <ProviderIcon provider={id} size="small" decorative />
                  {providerSpecs[id].name}
                </span>
              ),
            }))}
          />
        </Field>
        <Field label="账号别名">
          <input
            aria-label="新增账号别名"
            placeholder="例如：夸克资料号、百度归档号"
            value={alias}
            maxLength={60}
            disabled={disabled}
            onChange={(e) => setAlias(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="浏览器方式">
          <Select
            aria-label="新增账号浏览器方式"
            value={fingerprint ? "bitbrowser" : "electron"}
            disabled={disabled}
            onValueChange={(value) => {
              editor.update({
                browserEngine: value as "electron" | "bitbrowser",
                profileId: "",
              });
              setPreview(null);
            }}
            items={[
              { value: "electron", label: "内置浏览器" },
              {
                value: "bitbrowser",
                label: "比特指纹浏览器",
                disabled: provider !== "baidu",
              },
            ]}
          />
        </Field>
        <Button
          type="submit"
          primary
          disabled={!alias.trim() || disabled || (fingerprint && !validPreview)}
        >
          <Plus size={16} aria-hidden="true" />
          {adding ? "正在添加…" : "添加账号"}
        </Button>
      </div>
      {fingerprint ? (
        <DriveBrowserCreation
          profileId={profileId}
          onProfileChange={(profileId) => editor.update({ profileId })}
          preview={validPreview}
          onPreview={setPreview}
          disabled={busy > 0 || adding}
          onBusy={setReading}
        />
      ) : null}
    </form>
  );
}
