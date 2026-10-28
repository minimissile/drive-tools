import { useState } from "react";
import { z } from "zod";
import type { PipixSource } from "../../shared/pipix";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { updateSelection } from "../lib/selection";
import { formatTime } from "../lib/format";
import { Button, Panel, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { PipixExport } from "./PipixExport";
import type { WebsiteAccountView } from "../../shared/website-accounts";

const selectionSchema = z.object({
  title: z.string(),
  imageIds: z.array(z.string()),
  commentIds: z.array(z.string()),
});
function SourceImage({
  source,
  imageId,
}: {
  source: PipixSource;
  imageId: string;
}) {
  const query = useIpcQuery(
    "pipix.image",
    { id: source.id, imageId },
    { revision: source.collectedAt },
  );
  return (
    <>
      {query.data ? (
        <img
          src={query.data}
          alt={`原帖配图 ${imageId.replace("image-", "")}`}
        />
      ) : (
        <div className="pipix-image-placeholder">
          {query.error ? "图片暂不可用" : "正在读取图片…"}
        </div>
      )}
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
    </>
  );
}
export function PipixDetail({
  source,
  workspace,
  busy,
  onExportBusy,
  reload,
  onOpenWeibo,
}: {
  source: PipixSource;
  workspace: string;
  busy: boolean;
  onExportBusy(busy: boolean): void;
  reload(): void;
  onOpenWeibo(account: WebsiteAccountView, postId: string): void;
}) {
  const draft = useLocalDraft(
    `panxu-pipix-selection-v1:${workspace}:${source.id}`,
    {
      title:
        source.text.split("\n")[0].slice(0, 100) ||
        `${source.author}的趣味图文`,
      imageIds: source.images.filter((v) => v.asset).map((v) => v.id),
      commentIds: [] as string[],
    },
    (raw) => selectionSchema.parse(raw),
  );
  const [sort, setSort] = useState("page");
  const value = draft.value;
  const comments =
    sort === "likes"
      ? [...source.comments].sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1))
      : source.comments;
  const selectedImages = value.imageIds.filter((v) =>
    source.images.some((i) => i.id === v),
  );
  const selectedComments = value.commentIds.filter((v) =>
    source.comments.some((c) => c.id === v),
  );
  const unavailable = selectedImages.some(
    (v) => !source.images.find((i) => i.id === v)?.asset,
  );
  return (
    <Panel
      title="挑选图文与评论"
      extra={
        <Status kind={source.exports.length ? "good" : "normal"}>
          {source.exports.length
            ? `已用于 ${source.exports.length} 个去向`
            : "待挑选"}
        </Status>
      }
    >
      <div className="row spread">
        <small>
          {source.author} · {formatTime(source.collectedAt)}
        </small>
        <Button
          size="compact"
          onClick={() => void ipc("system.external", { url: source.url })}
        >
          查看原帖
        </Button>
      </div>
      {source.warnings.map((v) => (
        <p className="muted pipix-hint" key={v}>
          {v}
        </p>
      ))}
      <p className="pipix-original">{source.text || "原帖没有提供正文"}</p>
      {source.images.length ? (
        <div className="pipix-images">
          {source.images.map((image) => (
            <div className="pipix-image" key={image.id}>
              {image.asset ? (
                <SourceImage source={source} imageId={image.id} />
              ) : (
                <div className="pipix-image-placeholder">图片采集失败</div>
              )}
              <CheckboxField
                label={`配图 ${image.id.replace("image-", "")}${image.animated ? "（静态）" : ""}`}
                checked={selectedImages.includes(image.id)}
                disabled={busy}
                onChange={(e) =>
                  draft.update({
                    imageIds: updateSelection(
                      selectedImages,
                      [image.id],
                      e.target.checked,
                      9,
                    ),
                  })
                }
              />
              {image.error ? (
                <small className="pipix-image-error">{image.error}</small>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="pipix-comment-heading">
        <h3>
          页面评论 · {source.comments.length} 条
          {source.commentCount !== null
            ? ` / 原帖 ${source.commentCount} 条`
            : ""}
        </h3>
        <Select
          aria-label="评论排序"
          value={sort}
          items={[
            { value: "page", label: "页面顺序" },
            { value: "likes", label: "点赞从高到低" },
          ]}
          onValueChange={setSort}
        />
      </div>
      {comments.length ? (
        <div className="pipix-comments">
          {comments.map((comment) => (
            <div className="pipix-comment" key={comment.id}>
              <CheckboxField
                label={
                  <>
                    <span className="pipix-comment-copy">{comment.text}</span>
                    <small>
                      {comment.author} ·{" "}
                      {comment.likes === null
                        ? "点赞数未知"
                        : `${comment.likes} 赞`}
                      {comment.label ? ` · ${comment.label}` : ""}
                    </small>
                  </>
                }
                checked={selectedComments.includes(comment.id)}
                disabled={busy}
                onChange={(e) =>
                  draft.update({
                    commentIds: updateSelection(
                      selectedComments,
                      [comment.id],
                      e.target.checked,
                      50,
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">分享页没有返回文字评论，可继续导入原帖图文。</p>
      )}
      <PipixExport
        source={source}
        workspace={workspace}
        busy={busy}
        onBusy={onExportBusy}
        reload={reload}
        title={value.title}
        onTitle={(title) => draft.update({ title })}
        imageIds={selectedImages}
        commentIds={selectedComments}
        unavailable={unavailable}
        storageError={draft.error}
        onOpenWeibo={onOpenWeibo}
      />
    </Panel>
  );
}
