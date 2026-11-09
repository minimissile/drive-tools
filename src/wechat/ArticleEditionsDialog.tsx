import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type {
  WechatDetail,
  WechatEditionSummary,
  WechatDeliveryRecord,
} from "../../shared/wechat";
import { ipc } from "../api/client";
import { Dialog } from "../ui/Dialog";
import { Button, Notice, Status } from "../ui/primitives";
import { formatTime } from "../lib/format";
import { RewriteStyleBadge } from "./RewriteStyleBadge";
import { stageLabel } from "./labels";

const actionLabel: Record<WechatDeliveryRecord["action"], string> = {
  created: "新建微信草稿",
  updated: "更新微信草稿",
  verified: "核验通过，已保存",
  saved: "已保存微信草稿",
};

export function ArticleEditionsDialog({
  editions,
  currentId,
  onSelect,
  onClose,
  onRecorded,
}: {
  editions: WechatEditionSummary[];
  currentId: string;
  onSelect(id: string): void;
  onClose(): void;
  onRecorded(detail: WechatDetail): void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      title="版本与送稿记录"
      className="wechat-editions-dialog"
      busy={pending}
      onClose={onClose}
      footer={
        <Button disabled={pending} onClick={onClose}>
          关闭
        </Button>
      }
    >
      <p className="wechat-editor-dialog-help muted">
        每一稿独立编辑、独立保存到微信。这里记录送稿情况，实际发文仍在微信后台完成。
      </p>
      {error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      <ol className="wechat-edition-list">
        {editions.map((edition) => (
          <li key={edition.id}>
            <div className="wechat-edition-heading">
              <div className="wechat-toolbar">
                <strong>第 {edition.number} 稿</strong>
                <RewriteStyleBadge styleId={edition.rewriteStyleId} />
                <Status
                  kind={
                    edition.stage === "synced"
                      ? "good"
                      : edition.stage === "uncertain"
                        ? "warning"
                        : "normal"
                  }
                >
                  {stageLabel[edition.stage]}
                </Status>
                {edition.id === currentId ? (
                  <span className="muted">当前稿</span>
                ) : null}
              </div>
              {edition.id !== currentId ? (
                <Button
                  size="compact"
                  disabled={pending}
                  onClick={() => onSelect(edition.id)}
                >
                  切换到此稿
                </Button>
              ) : null}
            </div>
            <h3>{edition.title}</h3>
            {edition.deliveries.length ? (
              <ul className="wechat-delivery-history">
                {[...edition.deliveries].reverse().map((record, index) => (
                  <li key={`${record.sentAt}:${index}`}>
                    <div>
                      <p className="wechat-toolbar">
                        <span>
                          {actionLabel[record.action]} · {record.accountName}
                        </span>
                        {record.rewriteStyleId ? (
                          <RewriteStyleBadge styleId={record.rewriteStyleId} />
                        ) : null}
                        {record.publicationMarkedAt ? (
                          <Status kind="good">已标记发布</Status>
                        ) : null}
                      </p>
                      <p className="muted">
                        <time dateTime={record.sentAt}>
                          {formatTime(record.sentAt)}
                        </time>
                      </p>
                      {record.title && record.title !== edition.title ? (
                        <p className="muted">送稿标题：{record.title}</p>
                      ) : null}
                    </div>
                    <div className="wechat-toolbar">
                      <Button
                        quiet
                        size="compact"
                        disabled={pending}
                        title="仅记录你已在微信完成发文，不会代为发布"
                        onClick={async () => {
                          setPending(true);
                          setError("");
                          try {
                            onRecorded(
                              await ipc("wechat.markPublished", {
                                id: edition.id,
                                sentRevision: record.revision,
                                accountId: record.accountId,
                                published: !record.publicationMarkedAt,
                              }),
                            );
                          } catch (cause) {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : "发布标记保存失败，请重试。",
                            );
                          } finally {
                            setPending(false);
                          }
                        }}
                      >
                        {record.publicationMarkedAt
                          ? "取消发布标记"
                          : "标记已发布"}
                      </Button>
                      <Button
                        quiet
                        size="compact"
                        disabled={pending}
                        onClick={async () => {
                          setPending(true);
                          setError("");
                          try {
                            await ipc("wechat.open", {
                              id: edition.id,
                              accountId: record.accountId,
                            });
                          } catch (cause) {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : "微信草稿打开失败，请重试。",
                            );
                          } finally {
                            setPending(false);
                          }
                        }}
                      >
                        <ExternalLink size={14} />
                        打开微信草稿
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">尚未送到微信草稿箱</p>
            )}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
