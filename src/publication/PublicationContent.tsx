import type { ReadyPublicationModel } from "./usePublicationPreparation";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Copy, Download } from "lucide-react";
import { contentFormats } from "../../shared/channels";
import { csdnHandoff, csdnPublishingSteps } from "../../shared/csdn";
import { MediaGallery } from "../studio/MediaGallery";

export function PublicationContent({
  model,
}: {
  model: Pick<
    ReadyPublicationModel,
    | "navigate"
    | "openDraft"
    | "draft"
    | "deliveryDisabled"
    | "copyText"
    | "exportPackage"
  >;
}) {
  const {
    navigate,
    openDraft,
    draft,
    deliveryDisabled,
    copyText,
    exportPackage,
  } = model;
  return (
    <>
      <Panel
        title="内容包"
        extra={
          <small>
            {contentFormats[draft.contentFormat].name} · 草稿 v{draft.version}
          </small>
        }
      >
        <article className="content-preview">
          <h2>{draft.title}</h2>
          {draft.platform === "csdn" ? (
            <p className="muted">正文 · Markdown 原文</p>
          ) : null}
          <div
            className="publication-body-preview"
            role="region"
            aria-label="已保存正文预览"
            tabIndex={0}
          >
            {draft.body}
          </div>
          <p>{draft.tags.join(" ")}</p>
        </article>
        {draft.creative && draft.creative.format !== "text" ? (
          <MediaGallery draftId={draft.id} />
        ) : null}
        <div className="row" style={{ marginTop: 14 }}>
          <Button
            disabled={deliveryDisabled}
            onClick={() =>
              void copyText(draft.platform === "csdn" ? "body" : "text")
            }
          >
            <Copy size={15} />
            {draft.platform === "csdn"
              ? "复制正文（Markdown）"
              : "核验并复制文案"}
          </Button>
          <Button
            disabled={deliveryDisabled}
            onClick={() => void copyText("title")}
          >
            <Copy size={15} />
            复制标题
          </Button>
          <Button
            disabled={deliveryDisabled}
            onClick={() => void exportPackage()}
          >
            <Download size={15} />
            导出内容包
          </Button>
          <Button
            quiet
            onClick={() => (draft ? openDraft(draft) : navigate("studio"))}
          >
            回到编辑
          </Button>
        </div>
      </Panel>
      <Panel title={draft.platform === "csdn" ? "CSDN发布步骤" : "发布字段"}>
        {draft.platform === "csdn" ? (
          <>
            <ol>
              {csdnPublishingSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {csdnHandoff(draft).titleTooLong ? (
              <Notice warning>
                当前标题超过100字，请回到编辑缩短后再提交CSDN。
              </Notice>
            ) : null}
          </>
        ) : null}
        <Field
          label="摘要建议"
          hint={
            draft.platform === "csdn"
              ? "自动取正文开头，可在发布时继续编辑"
              : "根据正文提取，提交前按平台后台要求调整"
          }
        >
          <textarea readOnly value={csdnHandoff(draft).summary} />
        </Field>
        <Button
          disabled={deliveryDisabled}
          onClick={() => void copyText("summary")}
        >
          <Copy size={15} />
          复制摘要建议
        </Button>
        <small>
          {draft.platform === "csdn"
            ? "导出内容包另含文章.md及CSDN发布字段。发布结果以文章页和平台审核状态为准。"
            : "标题、正文、标签分别填写。导出包含文章Markdown、平台字段及素材清单；按平台要求检查AI标识和可见范围。"}
        </small>
      </Panel>
    </>
  );
}
