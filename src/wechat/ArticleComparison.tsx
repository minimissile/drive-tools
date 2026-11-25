import type { WechatArticle, WechatText } from "../../shared/wechat";
import { Dialog } from "../ui/Dialog";
import { wechatPreviewHtml } from "./image-preview";
import { ArticleTemplateSelect } from "./ArticleTemplateSelect";
import type { WechatTemplateId } from "../../shared/wechat-templates";
import { ArticleSourcePreview } from "./ArticleSourcePreview";

export function ArticleComparison({
  source,
  current,
  readMoreResourceUrl,
  templateDisabled = true,
  onTemplateChange,
  onClose,
}: {
  source: WechatArticle["source"];
  current: Pick<WechatText, "title" | "body" | "author" | "templateId">;
  readMoreResourceUrl?: string;
  templateDisabled?: boolean;
  onTemplateChange?(id: WechatTemplateId): void;
  onClose(): void;
}) {
  return (
    <Dialog
      title="全屏预览"
      size="fullscreen"
      focus="container"
      onClose={onClose}
    >
      <div className="wechat-comparison">
        <ArticleSourcePreview source={source} comparison />
        <section aria-labelledby="wechat-comparison-current">
          <header>
            <h3 id="wechat-comparison-current">当前草稿</h3>
            {onTemplateChange ? (
              <ArticleTemplateSelect
                value={current.templateId}
                disabled={templateDisabled}
                onChange={onTemplateChange}
              />
            ) : null}
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
                  __html: wechatPreviewHtml(
                    current.body,
                    readMoreResourceUrl,
                    current.templateId,
                  ),
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
