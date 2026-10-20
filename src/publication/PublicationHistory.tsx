import type { ReadyPublicationModel } from "./usePublicationPreparation";
import { Button, Field, Panel } from "../ui/primitives";
import { Check } from "lucide-react";
import { formatTime } from "../lib/format";
import DeliveryCheck from "./DeliveryCheck";

export function PublicationHistory({
  model,
}: {
  model: Pick<
    ReadyPublicationModel,
    | "history"
    | "ownerUid"
    | "copy"
    | "openSearch"
    | "busy"
    | "draft"
    | "publishedUrl"
    | "setPublishedUrl"
    | "opened"
    | "recorded"
    | "splitTarget"
    | "ownReady"
    | "ownShareUrl"
    | "markPublication"
  >;
}) {
  const {
    history,
    ownerUid,
    copy,
    openSearch,
    busy,
    draft,
    publishedUrl,
    setPublishedUrl,
    opened,
    recorded,
    splitTarget,
    ownReady,
    ownShareUrl,
    markPublication,
  } = model;
  return (
    <>
      <Panel title="发布记录" extra={<small>人工回填</small>}>
        {draft.topicId ? (
          <Button quiet onClick={() => openSearch({ topicId: draft.topicId! })}>
            查看搜索选题与效果 →
          </Button>
        ) : null}
        <Field label="文章链接">
          <input
            aria-label="发布内容链接"
            type="url"
            placeholder="https://…"
            value={publishedUrl}
            onChange={(e) => setPublishedUrl(e.target.value)}
          />
        </Field>
        <small>
          提交后仍在审核时先记录待审核；确认文章已正常公开后再标记已发布。
        </small>
        <div className="actions">
          <Button
            disabled={!opened || !publishedUrl.trim() || !!recorded || busy > 0}
            onClick={() => void markPublication("submitted")}
          >
            记录已提交 · 待审核
          </Button>
          <Button
            disabled={
              !opened ||
              !publishedUrl.trim() ||
              recorded?.status === "published" ||
              busy > 0
            }
            onClick={() => void markPublication("published")}
          >
            <Check size={14} />
            人工标记已发布
          </Button>
        </div>
        <div className="publication-history">
          {history.map((p) => (
            <div key={p.id}>
              <strong>
                {p.status === "opened"
                  ? "已打开编辑器"
                  : p.status === "submitted"
                    ? "已提交 · 待审核"
                    : "人工确认已发布"}
              </strong>
              <small>
                v{p.draftVersion} · {formatTime(p.createdAt)}
              </small>
              {p.url ? <span>{p.url}</span> : null}
            </div>
          ))}
        </div>
      </Panel>
      {recorded?.status === "published" ? (
        <DeliveryCheck
          key={recorded.id}
          publication={recorded}
          platform={draft.platform}
          shareUrl={ownShareUrl}
          ownReady={!!ownReady}
          ownerUid={ownerUid}
          shareVersion={
            draft.splitItemId ? splitTarget?.shareVersion : copy?.shareVersion
          }
        />
      ) : null}
    </>
  );
}
