// 只检查可确定的内容结构；语义、事实、广告性质与权利仍需人工及平台审核。
export const zhidaoQuestionTitleLimit = 49;

export function zhidaoQuestionIssue(question: string) {
  const title = question.trim();
  if (!title) return "请先填写问题标题";
  if (title.length > zhidaoQuestionTitleLimit)
    return `标题当前${title.length}字，需缩短到${zhidaoQuestionTitleLimit}字以内`;
  if (!/[\p{L}\p{N}]/u.test(title))
    return "标题需明确描述问题，不能只包含标点或符号";
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(title))
    return "标题不能只有网址，请明确描述需要解答的问题";
  return "";
}

export function zhidaoAnswerIssue(answer: string) {
  if (!answer.trim()) return "请先填写回答内容";
  // 仅用于识别空正文或仅资料入口，不作为HTML清洗器。
  const text = answer
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, value: string) => {
      const code =
        value[0].toLowerCase() === "x"
          ? parseInt(value.slice(1), 16)
          : Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&(nbsp|ensp|emsp|thinsp|ZeroWidthSpace);/gi, " ")
    .replace(/&(amp|lt|gt|quot|apos);/gi, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return "回答需包含可阅读的文字正文";
  const substance = text
    .replace(/(?:https?:\/\/|www\.)[^\s<>，。；！？、（）“”]+/gi, " ")
    .replace(/(?:提取码|访问码|密码)\s*[:：]?\s*[a-z\d]{4}\b/gi, " ")
    .replace(
      /(?:相关资料|资料入口|下载链接|网盘链接|分享链接|链接|点击查看|点击下载|点击领取|点击这里)/g,
      " ",
    )
    .replace(/[\p{P}\p{S}\s]/gu, "");
  if (!substance) return "回答不能只有链接、提取码或图片，请补充具体解答";
  if (/^(?:顶|同上|赞同|支持|路过)+$/.test(substance))
    return "回答需针对问题提供具体内容，不能只有无意义附和";
  return "";
}
