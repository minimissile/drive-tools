import { AppError } from "./errors";
import { now } from "./database";
import { parseShare } from "./links";
import type {
  Account,
  RemoteFile,
  Resource,
  ResourceCopy,
} from "../shared/types";
import type { DriveProvider } from "./providers/provider";
import type { Repository } from "./repository";
import type { SecretStore } from "./secrets";

/** Explicit, read-only remote verification of a previously recorded own share. Never transfers or creates links. */
export async function verifyRecordedOwnShare(
  repo: Repository,
  secrets: SecretStore,
  account: Account,
  provider: DriveProvider,
  resource: Resource,
  copy: ResourceCopy,
) {
  // Another explicit check may have finished while waiting for the account mutex.
  const current = repo.getCopy(copy.id);
  if (current.status === "ready") {
    if (
      current.ownerUid === account.uid &&
      current.shareOwnerUid === account.uid &&
      current.shareVerifiedAt
    )
      return;
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      "此分享的账号归属已变化，请重新核对。",
    );
  }
  if (
    resource.sourceKind !== "owned" ||
    copy.status !== "recorded" ||
    !account.uid
  )
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      "请先选择已登录的资源所属账号。",
    );
  const source = parseShare(
    resource.sourceUrl,
    (await secrets.get(`source:${resource.id}`)) ?? "",
  );
  const files: RemoteFile[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 100; page++) {
    const inspection = await provider.inspect(
      account,
      source,
      "0",
      page,
      cursor,
    );
    files.push(...inspection.files);
    if (files.length > 100 || (page === 100 && inspection.hasMore))
      throw new AppError(
        "OWNED_MANIFEST_TOO_LARGE",
        "分享内容超过100项，请拆分分享后核验；本地录入资料仍保留。",
      );
    if (!inspection.hasMore) break;
    cursor = inspection.nextCursor;
  }
  if (!files.length)
    throw new AppError(
      "OWNED_SHARE_EMPTY",
      "此分享没有可核验的文件，本地资料已保留。",
    );
  const share = await provider.recoverOwnShare(account, source, files);
  const parsed = parseShare(share.url, share.code);
  if (
    parsed.provider !== account.provider ||
    parsed.url !== source.url ||
    share.ownerUid !== account.uid ||
    !(await provider.verifyShare(account, share.id, files, share.code))
  )
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      "未能确认此链接属于所选账号，本地资料已保留。",
    );
  await secrets.set(`share:${copy.id}`, share.code);
  repo.db.run(
    "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at=?,share_id=?,share_url=?,share_owner_uid=?,share_version=share_version+1,share_verified_at=?,error=NULL,updated_at=? WHERE id=? AND status='recorded'",
    JSON.stringify(files),
    account.uid,
    now(),
    share.id,
    parsed.url,
    account.uid,
    now(),
    now(),
    copy.id,
  );
}
