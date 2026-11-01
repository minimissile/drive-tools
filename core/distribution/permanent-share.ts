import type { Account } from "../../shared/types";
import type { DriveProvider } from "../providers/provider";
import { AppError } from "../errors";
import { parseShare } from "../links";

/** Read the existing share's settings. Never creates or replaces a link. */
export async function requirePermanentShare(
  account: Account,
  provider: DriveProvider,
  shareId: string | null,
  text: string,
) {
  const expected = parseShare(text);
  const share =
    shareId && provider.readCreatedShare
      ? await provider.readCreatedShare(
          account,
          shareId,
          { expiresInDays: 0 },
          expected.code,
        )
      : null;
  if (
    !share ||
    share.id !== shareId ||
    share.ownerUid !== account.uid ||
    parseShare(share.url).url !== expected.url ||
    share.expiresAt !== null ||
    (share.code && share.code !== expected.code)
  )
    throw new AppError(
      "DISTRIBUTION_PERMANENT_REQUIRED",
      "易搜要求永久有效且提取码完整的分享；当前有效期或提取码未通过核实，未提交，也未修改原链接。",
    );
}
