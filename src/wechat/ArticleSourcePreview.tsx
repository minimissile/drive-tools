import { useId, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { WechatSource } from "../../shared/wechat";
import { ipc } from "../api/client";
import { Button, Notice } from "../ui/primitives";
import { wechatPreviewHtml } from "./image-preview";

const sourceLabels: Record<NonNullable<WechatSource["kind"]>, string> = {
  "resource-catalog": "导出时的清单",
  "keyboard-skins": "初始合集",
  tieba: "贴吧原帖",
};

export function ArticleSourcePreview({
  source,
  comparison = false,
}: {
  source: WechatSource;
  comparison?: boolean;
}) {
  const readerHeadingId = useId();
  const headingId = comparison ? "wechat-comparison-source" : readerHeadingId;
  const [error, setError] = useState("");
  const sourceLabel = source.kind ? sourceLabels[source.kind] : "原文";
  const html = useMemo(() => wechatPreviewHtml(source.body), [source.body]);
  const author = source.author ? (
    <p className="muted">{source.author}</p>
  ) : null;

  return (
    <section
      className={comparison ? undefined : "wechat-source-reader"}
      aria-labelledby={headingId}
    >
      <header>
        {comparison ? (
          <h3 id={headingId}>{sourceLabel}</h3>
        ) : (
          <div>
            <h3 id={headingId}>{source.title}</h3>
            {author}
          </div>
        )}
        {source.url ? (
          <Button
            quiet
            size="compact"
            onClick={() => {
              setError("");
              void ipc("system.external", { url: source.url }).catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "无法打开原网页，请重试。",
                ),
              );
            }}
          >
            <ExternalLink size={14} /> 打开原网页
          </Button>
        ) : null}
      </header>
      <div
        className={comparison ? "wechat-comparison-scroll" : undefined}
        tabIndex={comparison ? 0 : undefined}
        aria-label={comparison ? `${sourceLabel}内容` : undefined}
      >
        {error ? (
          <Notice danger>
            <span role="alert">{error}</span>
          </Notice>
        ) : null}
        {comparison ? (
          <>
            <h4>{source.title}</h4>
            {author}
          </>
        ) : null}
        {source.warnings.length ? (
          <ul className="wechat-issues">
            {source.warnings.map((warning, i) => (
              <li key={i} data-severity="warning">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
        <article
          className="wechat-preview"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </section>
  );
}
