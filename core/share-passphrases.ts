import { now } from "./database";
import { AppError } from "./errors";
import { parseShare } from "./links";
import type { SecretStore } from "./secrets";
import type { Provider } from "../shared/types";
import type { SavedSharePassphrase } from "../shared/share-passphrase";
import type { OwnShare } from "./providers/provider";

export interface PassphraseScope {
  key: string;
  provider: Provider;
  accountId: string;
  ownerUid: string;
  shareId: string;
  url: string;
  code: string;
}
interface StoredPassphrase extends SavedSharePassphrase {
  scope: Omit<PassphraseScope, "key">;
  /** Keep the complete official copy as evidence, encrypted like extraction codes. */
  original: string;
}
const binding = ({ key: _key, ...scope }: PassphraseScope) => scope;
const matches = (a: StoredPassphrase["scope"], b: PassphraseScope) =>
  a.provider === b.provider &&
  a.accountId === b.accountId &&
  a.ownerUid === b.ownerUid &&
  a.shareId === b.shareId &&
  a.url === b.url &&
  a.code === b.code;

/** Parse an official share, never manufacture a platform command from a URL. */
export function officialSharePassphrase(text: string, scope: PassphraseScope) {
  if (!["baidu", "quark"].includes(scope.provider))
    throw new AppError(
      "UNSUPPORTED",
      "目前仅支持保存百度、夸克的中文分享口令。",
    );
  const parsed = parseShare(text);
  if (
    parsed.provider !== scope.provider ||
    parsed.url !== scope.url ||
    (parsed.code && parsed.code !== scope.code)
  )
    throw new AppError(
      "PASSPHRASE_SHARE_MISMATCH",
      "这段内容中的分享链接或提取码与当前分享不一致，请复制当前分享的完整官方内容。",
    );
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // A Chinese command occupies its own line in the official copy. Baidu may
  // surround it with App delimiters; preserve those instead of normalizing them.
  const candidates = lines.filter(
    (line) =>
      /^[\p{Script=Han}]{3,40}$/u.test(line) ||
      (scope.provider === "baidu" &&
        /^[@#＃]{1,3}[\p{Script=Han}A-Za-z0-9]{3,80}[@#＃]{1,3}$/u.test(line)),
  );
  if (candidates.length !== 1)
    throw new AppError(
      "PASSPHRASE_REQUIRED",
      "未找到唯一的中文分享口令。请粘贴 App 复制的完整内容，保留口令所在行和分享链接。",
    );
  return candidates[0];
}

export async function saveSharePassphrase(
  secrets: SecretStore,
  scope: PassphraseScope,
  original: string,
): Promise<SavedSharePassphrase> {
  if (!original.trim() || original.length > 8000)
    throw new AppError(
      "PASSPHRASE_REQUIRED",
      "请粘贴 8000 字以内的完整官方分享内容。",
    );
  const value: StoredPassphrase = {
    scope: binding(scope),
    original,
    text: officialSharePassphrase(original, scope),
    savedAt: now(),
  };
  await secrets.set(scope.key, JSON.stringify(value));
  return { text: value.text, savedAt: value.savedAt };
}

export async function readSharePassphrase(
  secrets: SecretStore,
  scope: PassphraseScope,
): Promise<SavedSharePassphrase | null> {
  const raw = await secrets.get(scope.key);
  if (!raw) return null;
  let stored: StoredPassphrase;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !stored.scope ||
    !matches(stored.scope, scope) ||
    typeof stored.text !== "string" ||
    typeof stored.savedAt !== "string" ||
    (stored.issue != null && typeof stored.issue !== "string") ||
    (!stored.text && !stored.issue)
  )
    return null;
  return {
    text: stored.text,
    savedAt: stored.savedAt,
    ...(stored.issue ? { issue: stored.issue } : {}),
  };
}

/** Called by share workflows only after checking the provider/account/link binding. */
export async function saveReturnedSharePassphrase(
  secrets: SecretStore,
  scope: PassphraseScope,
  share: OwnShare,
) {
  if (!share.passphrase && !share.passphraseIssue) return;
  const parsed = parseShare(share.url, share.code);
  if (
    share.id !== scope.shareId ||
    share.ownerUid !== scope.ownerUid ||
    parsed.provider !== scope.provider ||
    parsed.url !== scope.url ||
    parsed.code !== scope.code
  )
    throw new AppError(
      "PASSPHRASE_SHARE_MISMATCH",
      "口令与本次分享的归属不一致，未保存。",
    );
  try {
    if (!share.passphrase) {
      const previous = await readSharePassphrase(secrets, scope);
      if (previous?.text) return previous;
      const value: StoredPassphrase = {
        scope: binding(scope),
        original: "",
        text: "",
        issue: share.passphraseIssue,
        savedAt: now(),
      };
      await secrets.set(scope.key, JSON.stringify(value));
      return { text: value.text, issue: value.issue, savedAt: value.savedAt };
    }
    return await saveSharePassphrase(
      secrets,
      scope,
      `${share.passphrase}\n${parsed.url}${parsed.code ? `?pwd=${encodeURIComponent(parsed.code)}` : ""}`,
    );
  } catch {
    throw new AppError(
      "PASSPHRASE_SAVE_FAILED",
      "分享链接已创建，但中文口令未能保存，请核对原分享，勿重复建链。",
      true,
    );
  }
}
