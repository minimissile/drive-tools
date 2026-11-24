import { Check, History } from "lucide-react";
import { Header } from "../ui/primitives";
import "./intake-header.css";

const stages = ["资源信息", "检索流量词", "校验与转存", "本人分享", "本地归档"];

export function IntakeHeader({
  editing,
  step,
  mode,
  restored,
  needsFileRead,
}: {
  editing: boolean;
  step: "info" | "keywords" | "files";
  mode: "transfer" | "owned" | "edit" | "setup";
  restored: boolean;
  needsFileRead: boolean;
}) {
  const active = step === "info" ? 0 : step === "keywords" ? 1 : 2;
  const labels = mode === "transfer" ? stages : stages.slice(0, 2);
  return (
    <div className="intake-header">
      <Header
        title={editing ? "继续整理这份资源。" : "录入一份资源。"}
        action={
          mode !== "setup" ? (
            <ol className="intake-progress" aria-label="资源归档流程">
              {labels.map((label, index) => (
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
