import type { ReactNode } from "react";
import { Save } from "lucide-react";
import { Button } from "../ui/primitives";

export function SettingsActions({
  dirty,
  disabled,
  onSave,
  children,
}: {
  dirty: boolean;
  disabled: boolean;
  onSave(): void;
  children: ReactNode;
}) {
  return (
    <footer className="settings-actions">
      <span className={dirty ? "settings-unsaved" : "muted"} role="status">
        {dirty ? "有未保存更改 · 已在本机暂存" : "此分区设置已保存"}
      </span>
      <Button primary disabled={disabled || !dirty} onClick={onSave}>
        <Save size={14} />
        {children}
      </Button>
    </footer>
  );
}
