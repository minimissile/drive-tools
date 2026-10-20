export const csdnPublishingSteps = [
  "核对比特窗口中的CSDN账号及发文权限。",
  "切换到Markdown编辑器，分别填写标题和正文。",
  "上传实测图片，检查代码块、图片和参考来源。",
  "核对读者获取资料的入口：正文须含获准的本人分享，或已实际挂载的官方组件；发布后点击验证，只有作者参考链接不算资源交付。",
  "选择站内已有标签并填写摘要，按实际情况设置AI辅助标识和可见范围。",
  "提交时如要求绑定微信或扫码确认，请本人在当前窗口完成账号验证。",
  "核对文章链接与审核状态，审核中先记录待审核，正常公开后再确认已发布。",
] as const;

export function csdnHandoff(article: {
  title: string;
  body: string;
  tags: string[];
}) {
  const prose = article.body
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !/^#{1,6}\s/.test(part));
  const summary = Array.from(
    (prose ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*~]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 200)
    .join("");
  return {
    title: article.title,
    body: article.body,
    markdown: `# ${article.title}\n\n${article.body}\n`,
    tags: [...new Set(article.tags)],
    summary,
    titleTooLong: Array.from(article.title).length > 100,
  };
}
