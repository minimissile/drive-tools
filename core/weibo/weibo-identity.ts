export type WeiboViewer =
  | { kind: "identity"; identity: { uid: string; nickname: string | null } }
  | { kind: "guest" }
  | { kind: "unknown" };
export type WeiboViewerResponse = WeiboViewer & { status: number };

/** Only the viewer config endpoint may supply an identity; never infer it from a visited profile. */
export function readWeiboViewer(payload: unknown): WeiboViewer {
  const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const root = object(payload);
  if (!root) return { kind: "unknown" };
  const data = object(root.data) ?? root;
  const no = (value: unknown) =>
    value === false || value === 0 || value === "0" || value === "false";
  if (no(data.login) || no(data.islogin) || no(data.isLogin))
    return { kind: "guest" };
  if (no(root.ok)) return { kind: "unknown" };
  const user = object(data.user) ?? object(data.userInfo);
  const value = data.uid ?? user?.idstr ?? user?.uid ?? user?.id;
  const uid =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof uid === "string" && /^[1-9]\d{4,19}$/.test(uid)) {
    const name =
      data.screen_name ??
      data.nick ??
      data.nickname ??
      user?.screen_name ??
      user?.name;
    return {
      kind: "identity",
      identity: {
        uid,
        nickname:
          typeof name === "string" && name.trim()
            ? name.trim().slice(0, 100)
            : null,
      },
    };
  }
  if (value === 0 || value === "0" || value === "") return { kind: "guest" };
  return { kind: "unknown" };
}

/** Run only in a newly loaded official homepage, never a stale or visited profile document. */
export const weiboViewerScript = `
(() => {
  const __name = (fn) => fn;
  const normalize = (${readWeiboViewer.toString()});
  if (location.protocol !== 'https:' || !['weibo.com', 'www.weibo.com'].includes(location.hostname) || !['/', '/mygroups'].includes(location.pathname)) return { kind: 'unknown' };
  return normalize(window.$CONFIG);
})()
`;
