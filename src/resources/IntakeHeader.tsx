import { ArrowDownToLine, Check, History } from "lucide-react";
import { Header } from "../ui/primitives";
import "./intake-header.css";

const stages = ["资源信息", "校验与转存", "本人分享", "本地归档"];

export function IntakeHeader({
  editing,
  step,
  mode,
  restored,
  needsFileRead,
}: {
  editing: boolean;
  step: "info" | "files";
  mode: "transfer" | "owned" | "edit" | "setup";
  restored: boolean;
  needsFileRead: boolean;
}) {
  const active = step === "info" ? 0 : 1;
  return (
    <div className="intake-header">
      <Header
        title={editing ? "继续整理这份资源。" : "录入一份资源。"}
        action={
          mode === "transfer" ? (
            <ol className="intake-progress" aria-label="资源归档流程">
              {stages.map((label, index) => (
                <li
                  key={label}
                  data-state={
                    index === active
                      ? "current"
                      : index < active
                        ? "complete"
                        : "upcoming"
                  }
                  aria-current={index === active ? "step" : undefined}
                >
                  <span className="intake-progress-marker" aria-hidden="true">
                    {index < active ? <Check size={13} /> : index + 1}
                  </span>
                  <span>{label}</span>
                </li>
              ))}
            </ol>
          ) : mode === "owned" ? (
            <span className="intake-header-mode">
              <ArrowDownToLine size={14} aria-hidden="true" />
              自有资源 · 直接入库
            </span>
          ) : mode === "edit" ? (
            <span className="intake-header-mode">文件与分享在资源库中维护</span>
          ) : null
        }
      />
      {restored ? (
        <p className="intake-draft-restored" role="status">
          <History size={14} aria-hidden="true" />
          <span>
            已恢复未保存的输入
            {needsFileRead ? "，转存前请重新读取并选择文件。" : "。"}
          </span>
        </p>
      ) : null}
    </div>
  );
}
