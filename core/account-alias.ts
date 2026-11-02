import type { Provider } from "../shared/types";
import { providerSpecs } from "../shared/providers";
import { now, type Database } from "./database";

export const pendingAccountAliasKey = (accountId: string) =>
  `account:alias:pending:${accountId}`;

const usernameAlias = (nickname: string) => nickname.trim().slice(0, 60);

/** Called inside the account-creation transaction; existing aliases are never enrolled. */
export function initializeAccountAlias(
  db: Database,
  accountId: string,
  provider: Provider,
  input: string,
  nickname = "",
) {
  const supplied = input.trim();
  if (supplied) return supplied;
  const username = usernameAlias(nickname);
  if (username) return username;
  const placeholder = `${providerSpecs[provider].name}账号`;
  db.setSetting(pendingAccountAliasKey(accountId), placeholder);
  return placeholder;
}

/** Use the first verified username only while this newly created alias is untouched. */
export function completeAccountAlias(
  db: Database,
  accountId: string,
  nickname: string,
) {
  const key = pendingAccountAliasKey(accountId);
  const pending = db.setting<string | null>(key, null);
  if (!pending) return;
  db.transaction(() => {
    const account = db.get<{ alias: string }>(
      "SELECT alias FROM accounts WHERE id=?",
      accountId,
    );
    if (account?.alias === pending) {
      const username = usernameAlias(nickname);
      // Some providers omit the nickname temporarily; keep waiting for a real one.
      if (!username) return;
      db.run(
        "UPDATE accounts SET alias=?,updated_at=? WHERE id=?",
        username,
        now(),
        accountId,
      );
    }
    db.run("DELETE FROM settings WHERE key=?", key);
  });
}
