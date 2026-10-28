import { useState } from "react";
import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData } from "../state";
import { ipc } from "../api/client";
import { Dialog } from "../ui/Dialog";
import { Button, Field, Notice } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { weiboPublishingSchema } from "../../shared/website-accounts";
import type { OtherAccount } from "./useOtherAccounts";

export function WeiboPublishingDialog({
  account,
  onClose,
  onSaved,
}: {
  account: OtherAccount;
  onClose(): void;
  onSaved(): void;
}) {
  const [allowLink, setAllowLink] = useState(
    account.publishing?.allowLink ?? false,
  );
  const { data } = useAppData();
  const note = useLocalDraft(
    `panxu-weibo-capability-note:${data!.dataPath}:${account.id}`,
    { ruleNote: account.publishing?.ruleNote ?? "" },
    (raw) => z.object({ ruleNote: z.string().max(2000) }).parse(raw),
  );
  const { ruleNote } = note.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const parsed = weiboPublishingSchema.safeParse({
      id: account.id,
      allowLink,
      ruleNote,
      confirmed: true,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await ipc("websiteAccounts.weiboPublishing", parsed.data);
      note.clear();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="核实微博发布能力" onClose={onClose} busy={busy}>
      <p>
        {account.nickname || account.alias} · UID {account.uid}
      </p>
      <p className="muted">
        请在此账号的官方窗口核对图文发布及网盘域名限制。登录成功不代表已获得正文外链权限。
      </p>
      <CheckboxField
        label="允许在正文附加本人网盘链接"
        checked={allowLink}
        disabled={busy}
        onChange={(event) => {
          setAllowLink(event.target.checked);
        }}
        hint="仅在已实际核实此账号及所用网盘域名可发布时勾选；链接权限 30 天后需复核。"
      />
      <Field
        label="账号能力核实依据"
        required
        hint="至少 10 字，记录已检查的图文形式、网盘域名和平台提示。"
      >
        <textarea
          value={ruleNote}
          maxLength={2000}
          rows={4}
          disabled={busy}
          onChange={(event) => {
            note.update({ ruleNote: event.target.value });
          }}
        />
      </Field>
      {error ? <Notice danger>{error}</Notice> : null}
      {note.error ? <Notice warning>{note.error}</Notice> : null}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          primary
          disabled={busy || ruleNote.trim().length < 10}
          onClick={() => void save()}
        >
          {busy ? "正在核实身份并保存…" : "保存已核实的发布能力"}
        </Button>
      </div>
    </Dialog>
  );
}
