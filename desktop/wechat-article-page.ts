/** Runs only inside the public WeChat article window. All returned material is untrusted data. */
export function readWechatArticle() {
  const root = document.querySelector("#js_content");
  if (!root || !root.textContent?.trim())
    throw new Error(
      "未读取到公众号正文，请检查文章是否已删除、需要登录或安全验证。",
    );
  let imageCount = 0,
    skippedImages = 0;
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return (node.textContent ?? "").replace(/\u00a0/g, " ");
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "iframe", "video", "audio", "svg"].includes(tag))
      return "";
    if (getComputedStyle(node).display === "none") return "";
    if (tag === "br") return "\n";
    if (tag === "img") {
      const raw =
        node.getAttribute("data-src") || node.getAttribute("src") || "";
      try {
        const u = new URL(raw, location.href);
        if (
          u.protocol !== "https:" ||
          !["mmbiz.qpic.cn", "mmbiz.qlogo.cn"].includes(u.hostname)
        )
          throw new Error();
        imageCount++;
        return `\n\n![${(node.getAttribute("alt") || "文章配图").replace(/[\[\]\n]/g, "")}](${u.href})\n\n`;
      } catch {
        skippedImages++;
        return "";
      }
    }
    const content = Array.from(node.childNodes).map(walk).join("");
    if (!content.trim()) return "";
    if (tag === "a") {
      try {
        let u = new URL(node.getAttribute("href") || "", location.href);
        if (
          u.hostname === "mp.weixin.qq.com" &&
          u.pathname === "/s" &&
          u.searchParams.has("url")
        )
          u = new URL(u.searchParams.get("url")!);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.port
        )
          return content;
        return `[${content.trim().replace(/[\[\]]/g, "")}](${u.href})`;
      } catch {
        return content;
      }
    }
    if (/^h[1-6]$/.test(tag))
      return `\n\n${"#".repeat(Number(tag[1]))} ${content}\n\n`;
    if (["strong", "b"].includes(tag)) return `**${content}**`;
    if (tag === "li") return `\n- ${content}\n`;
    if (
      ["p", "section", "div", "blockquote", "ul", "ol", "table", "tr"].includes(
        tag,
      )
    )
      return `\n\n${content}\n\n`;
    return content;
  };
  const body = Array.from(root.childNodes)
    .map(walk)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    url: location.href,
    title: (
      document.querySelector("#activity-name")?.textContent || document.title
    ).trim(),
    author: (document.querySelector("#js_name")?.textContent || "").trim(),
    publishedAt: (
      document.querySelector("#publish_time")?.textContent || ""
    ).trim(),
    body,
    imageCount,
    warnings: [
      ...(skippedImages
        ? [`${skippedImages} 张非标准图片未导入，请对照原文补充。`]
        : []),
      ...(root.querySelector("video, audio, iframe, svg")
        ? ["原文含音视频或交互内容，请核对未导入部分。"]
        : []),
    ],
  };
}
