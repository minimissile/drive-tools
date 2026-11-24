import { AppError } from "../errors";
import type { Identity, JsonObject } from "./provider";

/** Cookie UID is accepted only after the official account endpoint confirms login. */
export async function quarkIdentity(
  result: JsonObject,
  label: string,
  principal: () => Promise<string | null>,
): Promise<Identity> {
  const data = result?.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length === 0 ||
    result.success === false ||
    !["0", "OK"].includes(String(result.code ?? "0"))
  )
    throw new AppError(
      "AUTH_EXPIRED",
      `${label}官方账号接口尚未确认登录，请在原账号窗口完成登录。`,
    );
  const uid =
    data.user_id ??
    data.uid ??
    data.qid ??
    data.quark_id ??
    data.uc_id ??
    (await principal());
  if (uid == null || String(uid) === "")
    throw new AppError(
      "UID_UNAVAILABLE",
      `${label}已确认登录，但尚未取得稳定账号ID。请重新打开官方登录窗口后再次核验。`,
    );
  return {
    uid: String(uid),
    nickname: String(data.nickname ?? data.nick_name ?? ""),
  };
}
