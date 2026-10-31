/** These functions run in the actual share page, after its own scripts initialize. */
export function inspectBaiduSharePage() {
  const body = document.body?.innerText || "";
  const visible = (node: Element) => node.getClientRects().length > 0;
  if (
    /安全验证|访问验证/.test(document.title) ||
    location.hostname === "wappass.baidu.com" ||
    [
      ...document.querySelectorAll("#vcode-spin, .verify-wrap, .geetest_panel"),
    ].some(visible)
  )
    return { kind: "verification" as const };
  if (
    /分享的文件已经被取消|分享已过期|分享不存在|链接已失效|你来晚了|文件涉嫌违规/.test(
      body,
    )
  )
    return { kind: "expired" as const };
  if (/提取码错误|提取码不正确/.test(body))
    return { kind: "bad-code" as const };
  if (location.hostname === "passport.baidu.com")
    return { kind: "login" as const };
  const scope = window as unknown as {
    yunData?: Record<string, unknown>;
    locals?: { get?(key: string): unknown } & Record<string, unknown>;
  };
  const read = (keys: string[]) => {
    for (const key of keys) {
      const values = [scope.yunData?.[key], scope.locals?.[key]];
      try {
        values.push(scope.locals?.get?.(key));
      } catch {
        /* Page is still initializing. */
      }
      for (const value of values)
        if (
          (typeof value === "number" && value > 0) ||
          (typeof value === "string" && /^\d+$/.test(value))
        )
          return String(value);
    }
    return "";
  };
  const shareId = read(["shareid", "share_id", "SHARE_ID"]);
  const uk = read(["share_uk", "shareuk", "SHARE_UK"]);
  if (shareId && uk)
    return { kind: "ready" as const, shareId, uk, title: document.title };
  const password = [
    ...document.querySelectorAll<HTMLInputElement>(
      '#accessCode, #share_pwd, .pickpw input, input[placeholder*="提取码"]',
    ),
  ].find(visible);
  if (password) return { kind: "password" as const };
  if (/登录后查看|请先登录|登录百度账号后/.test(body))
    return { kind: "login" as const };
  return { kind: "loading" as const };
}

export function enterBaiduShareCode(code: string) {
  const input = [
    ...document.querySelectorAll<HTMLInputElement>(
      '#accessCode, #share_pwd, .pickpw input, input[placeholder*="提取码"]',
    ),
  ].find((node) => node.getClientRects().length > 0);
  if (!input) return false;
  const button = [
    ...document.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="submit"]',
    ),
  ].find(
    (node) =>
      node.getClientRects().length > 0 &&
      (node.id === "submitBtn" ||
        /^(提取文件|提取|确认提取|访问文件)$/.test(
          (node.innerText || node.getAttribute("value") || "").trim(),
        )),
  );
  if (!button) return false;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, code);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  button.click();
  return true;
}

export async function readBaiduShareDirectory(input: {
  shareId: string;
  uk: string;
  parentId: string;
  page: number;
}) {
  if (location.origin !== "https://pan.baidu.com")
    throw new Error("SHARE_ORIGIN_CHANGED");
  const query = new URLSearchParams({
    uk: input.uk,
    shareid: input.shareId,
    page: String(input.page),
    num: "100",
    order: "name",
    desc: "0",
    channel: "chunlei",
    clienttype: "0",
    web: "1",
    ...(input.parentId === "0"
      ? { root: "1" }
      : { root: "0", dir: input.parentId }),
  });
  const response = await fetch(`/share/list?${query}`, {
    credentials: "include",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`SHARE_HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}
