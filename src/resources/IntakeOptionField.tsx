import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { TextSuggestions } from "../ui/TextSuggestions";
import { Button, Field } from "../ui/primitives";
import { useAppActions } from "../state";
import "./intake.css";
export function IntakeOptionField({
  kind,
  label,
  value,
  items,
  accountId,
  disabled = false,
  onValueChange,
  onAdded,
}: {
  kind: "category" | "directory";
  label: string;
  value: string;
  items: string[];
  accountId: string;
  disabled?: boolean;
  onValueChange: (v: string) => void;
  onAdded: () => void;
}) {
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [saving, setSaving] = useState(false),
    mounted = useRef(true);
  const { command } = useAppActions();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const add = async () => {
    setSaving(true);
    try {
      const result = await command(
        "resource.addIntakeOption",
        { kind, value: name, accountId },
        `${label}选项已保存`,
      );
      if (result && mounted.current) {
        if (!disabled) onValueChange(result.value);
        onAdded();
        setAdding(false);
        setName("");
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <div className="intake-option-field">
      <div className="intake-option-row">
        <TextSuggestions
          aria-label={label}
          aria-required={kind === "category"}
          value={value}
          disabled={disabled}
          maxLength={kind === "category" ? 60 : 500}
          items={[...new Set([value, ...items])]
            .filter(Boolean)
            .map((value) => ({ value, label: value }))}
          onValueChange={onValueChange}
        />
        <Button
          quiet
          disabled={saving || (kind === "directory" && !accountId)}
          onClick={() => {
            setName(items.includes(value) ? "" : value);
            setAdding(!adding);
          }}
          aria-label={`新增${label}`}
        >
          <Plus size={14} />
          新增
        </Button>
      </div>
      {adding ? (
        <div className="intake-option-editor">
          <Field label={`新${label}`}>
            <input
              aria-label={`新${label}`}
              autoFocus
              value={name}
              maxLength={kind === "category" ? 60 : 500}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (name.trim() && !saving) void add();
                }
                if (e.key === "Escape" && !saving) setAdding(false);
              }}
            />
          </Field>
          <div className="row">
            <Button
              disabled={!name.trim() || saving}
              onClick={() => void add()}
            >
              {saving ? "保存中…" : "保存选项"}
            </Button>
            <Button quiet disabled={saving} onClick={() => setAdding(false)}>
              取消
            </Button>
          </div>
          {disabled ? (
            <small>当前副本位置已锁定；新增选项可用于后续资料。</small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
