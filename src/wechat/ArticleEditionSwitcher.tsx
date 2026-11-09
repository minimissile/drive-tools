import { useEffect, useRef } from "react";
import { CopyPlus, History } from "lucide-react";
import type { WechatEditionSummary } from "../../shared/wechat";
import { wechatRewriteStyleLabel } from "../../shared/wechat-rewrite";
import { Button } from "../ui/primitives";
import { Select } from "../ui/Select";

export function ArticleEditionSwitcher({
  currentId,
  editions,
  busy,
  canCreate,
  creating,
  focusOnMount,
  onSelect,
  onCreate,
  onHistory,
}: {
  currentId: string;
  editions: WechatEditionSummary[];
  busy: boolean;
  canCreate: boolean;
  creating: boolean;
  focusOnMount?: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  onHistory(): void;
}) {
  const active = useRef<HTMLButtonElement>(null);
  const ordered = [...editions].sort((a, b) => a.number - b.number);
  const label = (item: WechatEditionSummary) =>
    `第 ${item.number} 稿 · ${wechatRewriteStyleLabel(item.rewriteStyleId)}`;
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = requestAnimationFrame(() =>
      active.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusOnMount, currentId]);
  return (
    <div className="wechat-edition-navigation">
      <div className="wechat-edition-picker">
        <span className="muted">稿件</span>
        {ordered.length > 4 ? (
          <Select
            ref={active}
            className="wechat-edition-select"
            aria-label="选择稿件"
            value={currentId}
            disabled={busy}
            items={ordered.map((item) => ({
              value: item.id,
              label: label(item),
            }))}
            onValueChange={onSelect}
          />
        ) : (
          <div
            className="wechat-edition-choices"
            role="group"
            aria-label="稿件切换"
          >
            {ordered.map((item) => (
              <Button
                key={item.id}
                ref={item.id === currentId ? active : undefined}
                quiet
                size="compact"
                className="wechat-edition-choice"
                aria-pressed={item.id === currentId}
                disabled={busy}
                onClick={() => {
                  if (item.id !== currentId) onSelect(item.id);
                }}
              >
                {label(item)}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="wechat-edition-navigation-actions">
        <Button quiet size="compact" disabled={busy} onClick={onHistory}>
          <History size={14} />
          送稿记录
        </Button>
        <Button size="compact" disabled={busy || !canCreate} onClick={onCreate}>
          <CopyPlus size={14} />
          {creating ? "正在创建…" : "再发一篇"}
        </Button>
      </div>
    </div>
  );
}
