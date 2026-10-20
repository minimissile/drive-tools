import { useRef, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useAppActions, useAppActivity } from "../state";
import { Button, Field } from "../ui/primitives";

export function SecretField({
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
  const { command } = useAppActions();
  const { busy } = useAppActivity();
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const save = async (next: string) => {
    if (
      await command(
        "secret.save",
        { kind, value: next },
        next ? "密钥已加密保存在本机。" : "本地Key已移除。",
      )
    ) {
      setValue("");
      setVisible(false);
      setConfirmRemove(false);
      onSaved?.();
      if (!next) input.current?.focus();
    }
  };
  return (
    <div className="settings-secret">
      <div className="secret-row">
        <Field
          label={label}
          hint={configured ? "已保存；不回显原值" : "保存到系统加密存储"}
        >
          <div className="input-frame settings-secret-input">
            <input
              ref={input}
              type={visible ? "text" : "password"}
              aria-label={`${kind}密钥`}
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                configured ? "输入新Key可替换，留空不修改" : "粘贴你的Key"
              }
            />
            <button
              type="button"
              aria-label={visible ? "隐藏输入的密钥" : "显示输入的密钥"}
              aria-pressed={visible}
              disabled={!value}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </Field>
        <div className="settings-secret-actions">
          <Button
            disabled={!value.trim() || busy > 0}
            onClick={() => void save(value)}
          >
            <KeyRound size={14} />
            保存Key
          </Button>
          {configured ? (
            <Button
              ref={remove}
              quiet
              disabled={busy > 0}
              onClick={() => setConfirmRemove(true)}
            >
              移除
            </Button>
          ) : null}
        </div>
      </div>
      {confirmRemove ? (
        <div
          className="settings-remove-confirm"
          role="group"
          aria-label="移除密钥确认"
        >
          <p>移除此密钥后，对应连接将不可用。已保存的业务数据会保留。</p>
          <div className="row">
            <Button
              disabled={busy > 0}
              autoFocus
              onClick={() => {
                setConfirmRemove(false);
                remove.current?.focus();
              }}
            >
              取消移除
            </Button>
            <Button
              className="danger"
              disabled={busy > 0}
              onClick={() => void save("")}
            >
              确认移除密钥
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
