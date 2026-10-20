import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { providerIds, providerSpecs } from "../../shared/providers";
import type { Account, Provider } from "../../shared/types";
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
    { provider: "quark" as Provider, alias: "" },
    (value) => accountInput.parse(value),
  );
  const { provider, alias } = editor.value;
  const setProvider = (provider: Provider) => editor.update({ provider });
  const setAlias = (alias: string) => editor.update({ alias });
  const [adding, setAdding] = useState(false);
  const hintId = useId();
  return (
    <form
      className="account-connect"
      aria-label="添加本人网盘账号"
      aria-describedby={hintId}
      onSubmit={async (event) => {
        event.preventDefault();
        if (adding || busy > 0 || !alias.trim()) return;
        setAdding(true);
        try {
          const account = await command(
            "account.add",
            { provider, alias },
            "账号已建立，请在隔离窗口中完成登录并核验UID。",
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
        <p id={hintId}>添加别名后，在官方窗口登录，再核验本人 UID。</p>
      </div>
      {editor.error ? <Notice warning>{editor.error}</Notice> : null}
      <div className="account-connect-fields">
        <Field label="网盘服务">
          <Select
            aria-label="新增账号网盘"
            value={provider}
            disabled={busy > 0}
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
            disabled={busy > 0}
            onChange={(e) => setAlias(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Button type="submit" primary disabled={!alias.trim() || busy > 0}>
          <Plus size={16} aria-hidden="true" />
          {adding ? "正在添加…" : "添加账号"}
        </Button>
      </div>
    </form>
  );
}
