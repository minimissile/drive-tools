import type { ZhihuResearchDocument } from "../../shared/zhihu-participation";
import { formatTime } from "../lib/format";
import { researchKindLabels } from "./participation-state";
import { Notice } from "../ui/primitives";

export function ParticipationContext({
  document,
  open,
  busy,
}: {
  document: ZhihuResearchDocument;
  open(url: string): void;
  busy: boolean;
}) {
  return (
    <div className="participation-context">
      <p className="participation-meta">
        {researchKindLabels[document.kind]}上下文快照 ·{" "}
        {formatTime(document.observedAt)}
      </p>
      {document.truncated ? (
        <Notice warning>
          仅保存正文前段，请打开原文核对；不能据此准备完整回答。
        </Notice>
      ) : null}
      <div
        className="participation-context-text"
        tabIndex={0}
        role="region"
        aria-label={
          document.truncated
            ? "已保存的官方上下文正文前段"
            : "已保存的官方上下文"
        }
      >
        {document.text}
      </div>
      {document.related.length ? (
        <details>
          <summary>上下文中的相关内容 · {document.related.length}</summary>
          <ul className="participation-related">
            {document.related.map((item) => (
              <li key={item.url}>
                <button
                  type="button"
                  className="participation-text-link"
                  disabled={busy}
                  onClick={() => open(item.url)}
                >
                  {item.title}
                </button>
                <small>
                  {researchKindLabels[item.kind]} ·{" "}
                  {item.author || "作者未提供"}
                </small>
                <small>{item.url}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
