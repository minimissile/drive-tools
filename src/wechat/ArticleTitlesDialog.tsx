import { ArrowRight } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button, Notice } from "../ui/primitives";

export function ArticleTitlesDialog({
  titles,
  disabled,
  onSelect,
  onClose,
}: {
  titles: string[];
  disabled: boolean;
  onSelect(title: string): void;
  onClose(): void;
}) {
  return (
    <Dialog
      title="选择文章标题"
      focus="container"
      className="wechat-titles-dialog"
      onClose={onClose}
      footer={<Button onClick={onClose}>取消</Button>}
    >
      <p className="wechat-editor-dialog-copy">选择一条作为当前标题。</p>
      {disabled ? (
        <Notice warning>稿件状态已更新，请关闭后检查当前稿件。</Notice>
      ) : null}
      <ol className="wechat-title-candidates">
        {titles.map((title, index) => (
          <li key={title}>
            <Button
              className="wechat-title-candidate"
              disabled={disabled}
              onClick={() => onSelect(title)}
            >
              <span className="muted" aria-hidden="true">
                {index + 1}
              </span>
              <span>{title}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
