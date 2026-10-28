import { useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { SettingsSecretKind } from "../../shared/settings";
import { useAppActivity, useAppData } from "../state";
import { Button, Field } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { useSecretEditor } from "./useSecretEditor";

type Props = {
  kind: SettingsSecretKind;
  configured: boolean;
  label?: string;
  onSaved?: () => void;
};
export function SecretField(props: Props) {
  const { data } = useAppData();
  return <SecretEditor key={`${data!.dataPath}:${props.kind}`} {...props} />;
}
function SecretEditor({ kind, configured, label = "API Key", onSaved }: Props) {
  const { busy } = useAppActivity();
  const editor = useSecretEditor(kind, configured);
  const { value } = editor;
  const disabled = busy > 0 || editor.loading || editor.saving;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const save = async (next: string) => {
    if (await editor.save(next)) {
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
          hint={
            editor.loading
              ? "正在读取已保存的密钥…"
              : editor.configured
                ? "已保存；仅回显脱敏值，更换时输入新Key"
                : "保存到系统加密存储"
          }
        >
          <div className="input-frame settings-secret-input">
            <input
              ref={input}
              type={editor.editing ? "password" : "text"}
              readOnly={!editor.editing}
              aria-label={`${kind}密钥`}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={20000}
              disabled={disabled}
              aria-busy={editor.loading}
              value={editor.editing ? value : editor.masked}
              onChange={(e) => editor.update(e.target.value)}
              placeholder={
                editor.loading
                  ? "正在读取…"
                  : editor.configured
                    ? editor.editing
                      ? "粘贴新Key；取消更换可保留原Key"
                      : editor.masked
                        ? ""
                        : "已保存；脱敏信息暂不可用"
                    : "粘贴你的Key"
              }
            />
          </div>
        </Field>
        <div className="settings-secret-actions">
          {editor.editing ? (
            <Button
              disabled={!value.trim() || !editor.dirty || disabled}
              onClick={() => void save(value)}
            >
              <KeyRound size={14} />
              保存Key
            </Button>
          ) : (
            <Button
              disabled={disabled}
              onClick={() => {
                setConfirmRemove(false);
                editor.startEditing();
                input.current?.focus();
              }}
            >
              更换Key
            </Button>
          )}
          {editor.configured && editor.editing ? (
            <Button
              quiet
              disabled={disabled}
              onClick={() => editor.cancelEditing()}
            >
              取消更换
            </Button>
          ) : null}
          {editor.configured && !editor.editing ? (
            <Button
              ref={remove}
              quiet
              disabled={disabled}
              onClick={() => setConfirmRemove(true)}
            >
              移除
            </Button>
          ) : null}
        </div>
      </div>
      <QueryError
        title="密钥脱敏信息读取失败"
        error={editor.error}
        loading={editor.loading}
        onRetry={editor.retry}
      />
      {confirmRemove ? (
        <div
          className="settings-remove-confirm"
          role="group"
          aria-label="移除密钥确认"
        >
          <p>移除此密钥后，对应连接将不可用。已保存的业务数据会保留。</p>
          <div className="row">
            <Button
              disabled={disabled}
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
              disabled={disabled}
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
