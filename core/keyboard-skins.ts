import {
  keyboardSkinsCategory,
  type KeyboardSkinOverview,
} from "../shared/keyboard-skins";
import { hasVerifiedShare } from "../shared/share-status";
import type { Provider, ShareCheck } from "../shared/types";
import { AppError } from "./errors";
import { parseShare } from "./links";
import type { Repository, Row } from "./repository";

export interface KeyboardSkinCandidate {
  id: string;
  title: string;
  coverId: string | null;
  copyId: string;
  shareVersion: number;
  share: ReturnType<typeof parseShare>;
}

type CandidateRow = Row & {
  resource_title: string;
  resource_cover_id: string | null;
  resource_provider: Provider;
  source_kind: string;
  source_url: string;
  check_status: ShareCheck["status"] | null;
  checked_at: string | null;
};

export function availableKeyboardSkins(repo: Repository) {
  const accounts = new Map(
    repo.accounts().map((account) => [account.id, account]),
  );
  const candidates = new Map<string, KeyboardSkinCandidate>();
  const urls = new Set<string>();
  for (const row of repo.db.all<CandidateRow>(
    `SELECT c.*, r.title resource_title, r.cover_id resource_cover_id,
            r.provider resource_provider, r.source_kind, r.source_url, sc.status check_status, sc.checked_at
     FROM resources r JOIN copies c ON c.resource_id=r.id
     LEFT JOIN share_checks sc ON sc.copy_id=c.id
     WHERE r.category=? AND c.status='ready' AND c.share_verified_at IS NOT NULL
     ORDER BY r.id, c.share_verified_at DESC, c.id`,
    keyboardSkinsCategory,
  )) {
    const copy = repo.copy(row);
    const account = accounts.get(copy.accountId);
    if (
      candidates.has(copy.resourceId) ||
      !hasVerifiedShare(copy, account) ||
      account?.provider !== row.resource_provider ||
      (row.check_status &&
        row.check_status !== "valid" &&
        Date.parse(row.checked_at ?? "") >= Date.parse(copy.shareVerifiedAt!))
    )
      continue;
    let share: ReturnType<typeof parseShare>;
    try {
      share = parseShare(copy.shareUrl!);
      if (
        share.provider !== row.resource_provider ||
        share.url.length > 4000 ||
        urls.has(share.url) ||
        (row.source_kind !== "owned" &&
          parseShare(row.source_url).url === share.url)
      )
        continue;
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_LINK") continue;
      throw error;
    }
    candidates.set(copy.resourceId, {
      id: copy.resourceId,
      title: row.resource_title,
      coverId: row.resource_cover_id,
      copyId: copy.id,
      shareVersion: copy.shareVersion,
      share,
    });
    urls.add(share.url);
  }
  return candidates;
}

export function keyboardSkinOverview(repo: Repository): KeyboardSkinOverview {
  return {
    total: repo.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM resources WHERE category=?",
      keyboardSkinsCategory,
    )!.n,
    available: availableKeyboardSkins(repo).size,
  };
}

export function requireKeyboardSkinCandidates(repo: Repository, ids: string[]) {
  const available = availableKeyboardSkins(repo);
  return ids.map((id) => {
    const candidate = available.get(id);
    if (!candidate)
      throw new AppError(
        "KEYBOARD_SKINS_CHANGED",
        "所选资源或分享状态已变化，请重新抽取。",
      );
    return candidate;
  });
}
