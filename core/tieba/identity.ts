/** Only accepts the official current-viewer payload, never a profile URL or a cookie value. */
export function tiebaCurrentUser(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  const rawUid = user.user_id ?? user.id ?? user.uid;
  if (typeof rawUid === "number" && !Number.isSafeInteger(rawUid)) return null;
  const uid = String(rawUid ?? "");
  if (!/^[1-9][0-9]{0,19}$/.test(uid)) return null;
  const nickname =
    user.user_nickname ?? user.name_show ?? user.user_name ?? user.name ?? "";
  return {
    uid,
    nickname: typeof nickname === "string" ? nickname.slice(0, 100) : "",
  };
}

export function tiebaHomeIdentityScript() {
  return `(() => {
    if (location.origin !== 'https://tieba.baidu.com' || location.pathname !== '/') return null;
    const user = window.PageData?.user;
    if ([false, 0, '0'].includes(user?.is_login)) return null;
    return (${tiebaCurrentUser.toString()})(user);
  })()`;
}

/** Read only the signed-in viewer on the official home page; never infer identity from a profile URL. */
export function tiebaIdentityScript() {
  return `(async () => {
    if (location.origin !== 'https://tieba.baidu.com') return null;
    const viewer = ${tiebaHomeIdentityScript()};
    if (viewer) return viewer;
    const read = async path => {
      let response;
      try {
        response = await fetch(path, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      } catch {
        throw Error('贴吧身份接口请求失败，请检查此浏览器环境的网络或完成官方安全验证后重试');
      }
      if (new URL(response.url).origin !== location.origin)
        throw Error('贴吧身份接口跳转至登录或验证页面，请在官方窗口完成验证后重试');
      if (!response.ok) throw Error('贴吧身份接口暂时不可用（HTTP ' + response.status + '）');
      const text = await response.text();
      if (text.length > 128000) throw Error('贴吧身份响应异常');
      try { return JSON.parse(text); } catch {
        throw Error('贴吧身份接口未返回账号数据，请在官方窗口完成登录或安全验证后重试');
      }
    };
    const login = await read('/dc/common/tbs');
    if ([false, 0, '0'].includes(login.is_login)) return null;
    if (![true, 1, '1'].includes(login.is_login))
      throw Error('贴吧登录状态响应已变化，请稍后重试');
    let info;
    try { info = (await read('/f/user/json_userinfo')).data; } catch {}
    const candidates = [info?.user, info];
    const currentUser = (${tiebaCurrentUser.toString()});
    for (const user of candidates) {
      const identity = currentUser(user);
      if (identity) return identity;
    }
    throw Error('未能读取贴吧当前账号的 UID，请在官方窗口完成登录或验证后重试');
  })()`;
}
