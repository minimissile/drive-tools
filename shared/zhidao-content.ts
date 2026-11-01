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

function readableAnswer(answer: string) {
  // 仅用于识别空正文或仅资料入口，不作为HTML清洗器。
  return answer
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?>/gi, "\n")
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
}

export function zhidaoAnswerIssue(answer: string) {
  if (!answer.trim()) return "请先填写回答内容";
  const text = readableAnswer(answer);
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

/** A narrow structural check, not a semantic judgement or a platform rejection reason. */
export function zhidaoMethodAnswerIssue(question: string, answer: string) {
  if (!/(?:如何|怎么|怎样|教程|操作步骤)/.test(question)) return "";
  const text = readableAnswer(answer);
  const resourceIntroduction =
    /(?:这份|该)(?:资料|资源|视频)|目前未提供|具体讲解.{0,15}(?:观看|判断)|播放器|播放前/.test(
      text,
    );
  if (!resourceIntroduction) return "";
  const steps =
    text.match(
      /(?:^|\n)\s*(?:\d{1,2}[.、．）)]|[一二三四五六七八九十]+[、．）)]|[-•]|第[一二三四五六七八九十\d]+步)[^\n]{6,}/g,
    ) ?? [];
  const sequence = text.match(/(?:首先|然后|接着|最后)[^。！？\n]{6,}/g) ?? [];
  const listSteps = [
    ...answer.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi),
  ].filter((entry) => readableAnswer(entry[1]).length >= 6);
  if (steps.length >= 2 || listSteps.length >= 2 || sequence.length >= 3)
    return "";
  return "方法类问题的回答仍主要是资料介绍，请补充清晰、可独立操作的步骤；不能用观看视频、播放器说明或资料链接代替教程";
}
