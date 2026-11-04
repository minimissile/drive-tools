import { ipc } from "../api/client";
import { Button, Panel, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import type { PipixItem } from "../../shared/pipix";
import type { SupplyEditorial } from "../../shared/content-supply";
import { PipixCommentsLibrary } from "../pipix/CommentsLibrary";
import { usePipixCommentRules } from "../pipix/useCommentRules";
function SupplyImage({
  draftId,
  imageId,
  sha256,
  index,
}: {
  draftId: string;
  imageId: string;
  sha256: string;
  index: number;
}) {
  const query = useIpcQuery("contentSupply.image", {
    id: draftId,
    imageId,
    sha256,
  });
  return (
    <>
      {query.data ? (
        <img src={query.data} alt={`采集快照配图 ${index + 1}`} />
      ) : (
        <div className="pipix-image-placeholder">
          {query.error ? "配图暂不可用" : "正在读取快照配图…"}
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
export function SupplySourcePanel({
  source,
  editorial: e,
  draftId,
  disabled,
  showRefresh,
  refreshDisabled,
  onRefresh,
  selection,
  onAttachComments,
}: {
  source: PipixItem;
  editorial: SupplyEditorial;
  draftId: string;
  disabled: boolean;
  showRefresh: boolean;
  refreshDisabled: boolean;
  onRefresh(): void;
  selection(key: "imageIds" | "commentIds", id: string, checked: boolean): void;
  onAttachComments?(ids: string[]): Promise<void>;
}) {
  const rules = usePipixCommentRules();
  return (
    <Panel
      title="来源与选材"
      extra={
        <Button
          size="compact"
          onClick={() => void ipc("system.external", { url: source.url })}
        >
          打开原帖
        </Button>
      }
    >
      <p className="supply-muted">
        {source.author} · {formatTime(source.collectedAt)}
      </p>
      <p className="supply-source-text">{source.text || "原帖没有正文"}</p>
      <div className="supply-source-coverage">
        <Status>
          {source.images.filter((v) => v.asset).length}/{source.images.length}{" "}
          图已落地
        </Status>
        <Status>{source.comments.length} 条实际评论</Status>
      </div>
      {source.warnings.length ? (
        <details className="supply-details" open>
          <summary>来源提示 · {source.warnings.length}</summary>
          <ul>
            {source.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {source.commentCount != null ? (
        <p className="supply-muted">
          原帖标注 {source.commentCount} 条评论，本地 {source.comments.length}{" "}
          条；不代表完整评论列表。
        </p>
      ) : null}
      {showRefresh &&
      (source.images.some((image) => !image.asset) ||
        (source.commentCount != null &&
          source.commentCount > source.comments.length)) ? (
        <Button size="compact" disabled={refreshDisabled} onClick={onRefresh}>
          补全原素材 · 不调用付费接口
        </Button>
      ) : null}
      {source.images.length ? (
        <div className="supply-images">
          {source.images.map((image, index) => (
            <div key={image.id}>
              {image.asset ? (
                <SupplyImage
                  draftId={draftId}
                  imageId={image.id}
                  sha256={image.asset.sha256}
                  index={index}
                />
              ) : (
                <p className="supply-muted">
                  图片未落地：{image.error || "等待补全"}
                </p>
              )}
              <CheckboxField
                label={`采用配图 ${index + 1}`}
                checked={e.imageIds.includes(image.id)}
                disabled={disabled || !image.asset}
                onChange={(event) =>
                  selection("imageIds", image.id, event.target.checked)
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      <h3 className="supply-subheading">原帖评论</h3>
      <QueryError
        error={rules.error}
        loading={rules.loading}
        onRetry={rules.reload}
      />
      {source.comments.length ? (
        <div className="supply-comments">
          {source.comments.map((comment) => (
            <div className="supply-comment" key={comment.id}>
              <CheckboxField
                label={
                  <>
                    <span>{comment.text}</span>
                    <small>
                      {comment.author} ·{" "}
                      {comment.likes == null
                        ? "赞数未知"
                        : `${comment.likes} 赞`}
                      {comment.label
                        ? ` · 原标签：${comment.label}`
                        : " · 未标注神评"}
                      {rules.hits(comment).length
                        ? ` · 已过滤：${rules.hits(comment).join("、")}`
                        : ""}
                    </small>
                  </>
                }
                checked={e.commentIds.includes(comment.id)}
                disabled={
                  disabled ||
                  !rules.data ||
                  (!!rules.hits(comment).length &&
                    !e.commentIds.includes(comment.id))
                }
                onChange={(event) =>
                  selection("commentIds", comment.id, event.target.checked)
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="supply-muted">
          本次响应未提供评论，不补写或推测“神评”。可先编辑，或回到采集页补全原帖。
        </p>
      )}
      <small className="supply-muted supply-id">
        来源 {source.id}
        <br />
        编辑单 {draftId}
      </small>
      <PipixCommentsLibrary
        sourceId={source.id}
        disabled={disabled}
        onAttach={onAttachComments}
      />
    </Panel>
  );
}
