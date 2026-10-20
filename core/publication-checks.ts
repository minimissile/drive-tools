import {
  deliveryCheckInput,
  type PublicationDeliveryCheck,
} from "../shared/publication-checks";
import { canUseLinkPosition } from "../shared/publication";
import type { Repository } from "./repository";
import type { SearchOperations } from "./search";
import { id, now } from "./database";
import { AppError } from "./errors";
import type { Draft } from "../shared/types";

/** Manual evidence only: recording a check never fetches a platform or a drive. */
export class PublicationChecks {
  constructor(
    private repo: Repository,
    private search: SearchOperations,
    private changed: () => void,
  ) {}
  list(publicationId: string) {
    this.publication(publicationId);
    return this.repo.deliveryChecks(publicationId);
  }
  private publication(publicationId: string) {
    const p = this.repo.db.get<{
      id: string;
      draft_id: string;
      draft_version: number;
      binding_id: string;
      status: string;
    }>(
      "SELECT id,draft_id,draft_version,binding_id,status FROM publications WHERE id=?",
      publicationId,
    );
    if (!p) throw new AppError("NOT_FOUND", "发布记录不存在。");
    return p;
  }
  snapshot(draft: Draft) {
    const copy = this.repo.getCopy(draft.copyId);
    const split = draft.splitItemId
      ? this.repo.db.get<{ share_url: string | null }>(
          "SELECT share_url FROM split_items WHERE id=?",
          draft.splitItemId,
        )
      : null;
    return {
      copyId: copy.id,
      splitItemId: draft.splitItemId,
      shareUrl: draft.splitItemId ? (split?.share_url ?? null) : copy.shareUrl,
      shareVersion: draft.splitItemId
        ? draft.splitShareVersion
        : draft.shareVersion,
      ownerUid: draft.splitItemId
        ? (this.repo.db.get<{ owner_uid: string | null }>(
            "SELECT owner_uid FROM split_items WHERE id=?",
            draft.splitItemId,
          )?.owner_uid ?? null)
        : copy.shareOwnerUid,
    };
  }
  capture(publicationId: string, draft: Draft) {
    this.repo.db.run(
      "INSERT OR IGNORE INTO publication_targets(publication_id,data) VALUES(?,?)",
      publicationId,
      JSON.stringify(this.snapshot(draft)),
    );
  }
  save(raw: unknown): PublicationDeliveryCheck {
    const input = deliveryCheckInput.parse(raw),
      publication = this.publication(input.publicationId);
    if (publication.status !== "published")
      throw new AppError(
        "PUBLICATION_NOT_PUBLISHED",
        "文章尚未确认公开发布，不能记录发布后的资源入口验收。",
      );
    const draft = this.repo.draft(publication.draft_id),
      copy = this.repo.getCopy(draft.copyId),
      account = this.repo.getAccount(copy.accountId),
      split = draft.splitItemId
        ? this.repo.db.get<{
            share_url: string | null;
            share_version: number;
            owner_uid: string | null;
          }>(
            "SELECT share_url,share_version,owner_uid FROM split_items WHERE id=?",
            draft.splitItemId,
          )
        : null;
    const shareVersion = draft.splitItemId
        ? (split?.share_version ?? draft.splitShareVersion ?? 0)
        : copy.shareVersion,
      shareUrl = draft.splitItemId ? (split?.share_url ?? null) : copy.shareUrl;
    if (input.status === "verified") {
      this.search.assertTarget(copy.id, draft.splitItemId);
      const original = this.repo.db.get<{ data: string }>(
        "SELECT data FROM publication_targets WHERE publication_id=?",
        publication.id,
      );
      const target = original
        ? (JSON.parse(original.data) as ReturnType<
            PublicationChecks["snapshot"]
          >)
        : null;
      if (
        (draft.splitItemId ? draft.splitShareVersion : draft.shareVersion) !==
          shareVersion ||
        draft.version !== publication.draft_version ||
        (target &&
          (target.shareUrl !== shareUrl ||
            target.shareVersion !== shareVersion ||
            target.ownerUid !== account.uid))
      )
        throw new AppError(
          "STALE_PUBLICATION_SHARE",
          "本人分享已更新，不能将旧版文章验收为当前资料入口；请核对文章并使用对应的新稿件记录。",
        );
      const binding = this.repo
        .bindings()
        .find((b) => b.id === publication.binding_id);
      if (
        !canUseLinkPosition(
          draft.platform,
          binding,
          draft.contentFormat,
          input.position!,
        )
      )
        throw new AppError(
          "CHANNEL_LINK_BLOCKED",
          "此账号、内容形式与入口位置的权限尚未核实或已到期，请先复核账号能力。",
        );
    }
    const record: PublicationDeliveryCheck = {
      id: id("deliverycheck"),
      publicationId: publication.id,
      status: input.status,
      position: input.position,
      note: input.note,
      source: "manual",
      checkedAt: now(),
      draftVersion: publication.draft_version,
      copyId: copy.id,
      splitItemId: draft.splitItemId,
      shareVersion,
      shareUrl,
      ownerUid: draft.splitItemId
        ? (split?.owner_uid ?? null)
        : copy.shareOwnerUid,
    };
    this.repo.db.transaction(() => {
      this.repo.db.run(
        "INSERT INTO publication_delivery_checks(id,publication_id,data,created_at) VALUES(?,?,?,?)",
        record.id,
        record.publicationId,
        JSON.stringify(record),
        record.checkedAt,
      );
      // A failed or missing legacy entry does not establish a trusted resource baseline.
      if (input.status === "verified") this.capture(publication.id, draft);
    });
    this.changed();
    return record;
  }
}
