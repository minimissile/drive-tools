import type { WebsiteSessionState } from "../../shared/website-accounts";

/** The signed-in viewer response only: never infer identity from profile links or cookies. */
export function bilibiliCurrentUser(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (payload.code !== 0 || !payload.data || typeof payload.data !== "object")
    return null;
  const data = payload.data as Record<string, unknown>;
  if (data.isLogin !== true) return null;
  if (typeof data.mid === "number" && !Number.isSafeInteger(data.mid))
    return null;
  const uid =
    typeof data.mid === "string" || typeof data.mid === "number"
      ? String(data.mid)
      : "";
  if (
    !/^[1-9]\d{0,19}$/.test(uid) ||
    typeof data.uname !== "string" ||
    !data.uname.trim()
  )
    return null;
  return { uid, nickname: data.uname.trim().slice(0, 100) };
}

/** Risk-control and unknown responses are not proof that the user signed out. */
export function bilibiliLoggedOut(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.code === -101 ||
    (payload.code === 0 &&
      !!payload.data &&
      typeof payload.data === "object" &&
      (payload.data as Record<string, unknown>).isLogin === false)
  );
}

/** The native helper timestamps only a successful reader run, including explicit logout. */
export function bilibiliSessionObservation(
  state: WebsiteSessionState,
): WebsiteSessionState {
  if (state.hasSession && state.uid) return state;
  if (state.checkedAt && !state.unverified) return { ...state, expired: true };
  return {
    ...state,
    hasSession: false,
    uid: null,
    unverified: true,
    expired: false,
  };
}

/** Read nav in an official API document, retaining this browser profile's cookies and proxy. */
export function bilibiliIdentityScript() {
  return `(() => {
    if (location.origin !== 'https://api.bilibili.com' || location.pathname !== '/x/web-interface/nav')
      throw Error('哔哩哔哩身份检查页面已变化，请完成官方验证后重试');
    const text = document.body?.innerText ?? '';
    if (text.length > 128000) throw Error('哔哩哔哩身份响应异常');
    let value;
    try { value = JSON.parse(text); } catch { throw Error('哔哩哔哩身份接口未返回账号数据，请完成官方验证后重试'); }
    if ((${bilibiliLoggedOut.toString()})(value)) return null;
    const identity = (${bilibiliCurrentUser.toString()})(value);
    if (!identity) throw Error('哔哩哔哩当前身份尚未核实，接口可能受限或响应已变化，请稍后重试');
    return identity;
  })()`;
}
