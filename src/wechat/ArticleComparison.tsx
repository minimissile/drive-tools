import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { WechatArticle, WechatText } from "../../shared/wechat";
import { ipc } from "../api/client";
import { Dialog } from "../ui/Dialog";
import { Button, Notice } from "../ui/primitives";
import { wechatPreviewHtml } from "./image-preview";

export function ArticleComparison({
  source,
  current,
  onClose,
}: {
  source: WechatArticle["source"];
  current: Pick<WechatText, "title" | "body" | "author">;
  onClose(): void;
}) {
  const [error, setError] = useState("");
  return (
    <Dialog
      title="全屏预览"
      size="fullscreen"
      focus="container"
      onClose={onClose}
    >
      <div className="wechat-comparison">
        <section aria-labelledby="wechat-comparison-source">
          <header>
            <h3 id="wechat-comparison-source">原文</h3>
            <Button
              quiet
              size="compact"
              onClick={() => {
                setError("");
                void ipc("system.external", { url: source.url }).catch(
                  (cause) =>
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
          </header>
          <div
            className="wechat-comparison-scroll"
            tabIndex={0}
            aria-label="原文内容"
          >
            {error ? (
              <Notice danger>
                <span role="alert">{error}</span>
              </Notice>
            ) : null}
            <h4>{source.title}</h4>
            {source.author ? <p className="muted">{source.author}</p> : null}
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
              dangerouslySetInnerHTML={{
                __html: wechatPreviewHtml(source.body),
              }}
            />
          </div>
        </section>
        <section aria-labelledby="wechat-comparison-current">
          <header>
            <h3 id="wechat-comparison-current">当前草稿</h3>
          </header>
          <div
            className="wechat-comparison-scroll"
            tabIndex={0}
            aria-label="当前草稿内容"
          >
            <h4>{current.title || "未填写标题"}</h4>
            {current.author ? <p className="muted">{current.author}</p> : null}
            {current.body.trim() ? (
              <article
                className="wechat-preview"
                dangerouslySetInnerHTML={{
                  __html: wechatPreviewHtml(current.body),
                }}
              />
            ) : (
              <p className="muted">尚未填写正文。</p>
            )}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
