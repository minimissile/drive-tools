/** Extracts a web share from Tieba's Baidu Netdisk mini-program link without opening it. */
export function tiebaBaiduMiniAppShare(value: string): URL | null {
  if (value.length > 8000) return null;
  const wrapper = URL.parse(value);
  if (
    !wrapper ||
    wrapper.protocol !== "tiebaclient:" ||
    wrapper.hostname !== "swan" ||
    wrapper.username ||
    wrapper.password ||
    wrapper.port ||
    !/^\/[a-zA-Z0-9]{32}\/pages\/outsite-chain\/share-code\/index\/?$/.test(
      wrapper.pathname,
    ) ||
    wrapper.searchParams.getAll("url").length !== 1 ||
    wrapper.searchParams.getAll("pwdcode").length > 1
  )
    return null;

  const target = URL.parse(wrapper.searchParams.get("url") ?? "");
  if (
    !target ||
    target.protocol !== "https:" ||
    !["pan.baidu.com", "yun.baidu.com"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.port ||
    target.href.length > 4000 ||
    !/^\/s\/[a-zA-Z0-9_-]+\/?$/.test(target.pathname) ||
    target.searchParams.getAll("pwd").length > 1
  )
    return null;

  const code = wrapper.searchParams.get("pwdcode") || "";
  const targetCode = target.searchParams.get("pwd") || "";
  if (
    (code && !/^[a-zA-Z0-9]{4}$/.test(code)) ||
    (targetCode && !/^[a-zA-Z0-9]{4}$/.test(targetCode)) ||
    (code && targetCode && code !== targetCode)
  )
    return null;

  const share = new URL(target.pathname, "https://pan.baidu.com");
  if (code || targetCode) share.searchParams.set("pwd", code || targetCode);
  return share;
}

function unlinkedBaiduShares(body: string) {
  return Array.from(
    body.matchAll(
      /(^|\n)([\t ]*)百度网盘(?=[\t ]*[:：]?[\t ]*\r?\n(?:[\t ]*\r?\n)*[\t ]*(?:提取码|访问码|密码)[\t ]*[:：]?[\t ]*([a-zA-Z0-9]{4})(?![a-zA-Z0-9]))/g,
    ),
  );
}

export function hasUnlinkedTiebaBaiduShare(body: string) {
  return unlinkedBaiduShares(body).length > 0;
}

/** An original link can only be restored at the single plain label with its own code. */
export function linkTiebaBaiduShare(body: string, url: URL) {
  const code = url.searchParams.get("pwd");
  if (!code) return body;
  const positions = unlinkedBaiduShares(body).filter(
    (match) => match[3] === code,
  );
  if (positions.length !== 1) return body;
  const match = positions[0];
  const start = match.index + match[1].length + match[2].length;
  return `${body.slice(0, start)}[百度网盘](${url.href})${body.slice(start + "百度网盘".length)}`;
}
