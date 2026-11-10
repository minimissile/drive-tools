import { z } from "zod";
import { wechatTextInput } from "../../shared/wechat";
import { AppError } from "../errors";
import { formatArticle } from "../smzdm/content";
import { redactPromptText } from "../text-safety";

const protectedText =
  /(?:https?:|panxu-media:)\/\/|www\.|!\[|\[[^\]\n]+\]\s*\(|(?:提取码|访问码|密码)\s*[:：]?\s*(?:\*\*|\x60)?\s*[a-zA-Z0-9]{4,8}/i;
const htmlMarkup =
  /<\/?[a-z][^>]*>|<!--[\s\S]*?-->|<![a-z][^>]*>|<\?[\s\S]*?\?>/i;

export const wechatRewriteResponse = z
  .object({
    title: wechatTextInput.shape.title,
    digest: wechatTextInput.shape.digest,
    sections: z.array(
      z.object({ id: z.number().int(), text: z.string() }).strict(),
    ),
  })
  .strict();

export function wechatRewriteBody(body: string) {
  const blocks = body.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/);
  // A fetched paragraph can contain prose and a link separated by single
  // newlines. Protect only those lines instead of locking the entire article.
  const parts = blocks.flatMap((block) => {
    if (
      !protectedText.test(block) ||
      !/\r?\n/.test(block) ||
      /^(?:```|~~~)/m.test(block)
    )
      return [block];
    const result: string[] = [];
    let prose = "";
    const flush = () => {
      const separator = prose.match(/\r?\n$/)?.[0] ?? "";
      const content = separator ? prose.slice(0, -separator.length) : prose;
      if (content) result.push(content);
      if (separator) result.push(separator);
      prose = "";
    };
    for (const line of block.split(/(\r?\n)/)) {
      if (protectedText.test(line)) {
        flush();
        result.push(line);
      } else if (/^\r?\n$/.test(line) && !prose) result.push(line);
      else prose += line;
    }
    flush();
    return result;
  });
  const sections: { id: number; text: string; locked: boolean }[] = [];
  const entries: { id: number | null; text: string }[] = [];
  for (const block of parts) {
    if (!block.trim()) {
      entries.push({ id: null, text: block });
      continue;
    }
    const locked = protectedText.test(block);
    const id = sections.length;
    const text = locked
      ? redactPromptText(
          block.replace(/panxu-media:\/\/[^\s)\]]+/gi, "[本地图片]"),
        )
      : block;
    sections.push({ id, text, locked });
    entries.push({ id: locked ? null : id, text: block });
  }
  const expectedIds = sections
    .filter((section) => !section.locked)
    .map((section) => section.id);
  return { sections, entries, expectedIds };
}

export function checkRewriteText(value: string) {
  if (protectedText.test(value) || htmlMarkup.test(value))
    throw new AppError(
      "WECHAT_REWRITE",
      "改写结果加入了链接、图片或不支持的排版，原稿已保留。",
    );
}

/** Detect unmistakably unfinished endings even if a provider reports stop. */
export function unfinishedWechatRewriteIds(
  sections: { id: number; text: string }[],
) {
  return sections
    .filter(({ text }) => {
      const last =
        text
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .at(-1)
          ?.trim() ?? "";
      if (/^(?:#{1,6}\s|```|~~~)/.test(last)) return false;
      const prose = last.replace(/\*\*|__/g, "").trim();
      return (
        prose.length > 6 &&
        /(?:将|由于|以及|从而|某种|分别是|例如|包括)$/.test(prose)
      );
    })
    .map(({ id }) => id);
}

export function restoreWechatRewrite(
  entries: ReturnType<typeof wechatRewriteBody>["entries"],
  output: z.infer<typeof wechatRewriteResponse>["sections"],
) {
  const texts = new Map(
    output.map(({ id, text }) => {
      const normalized = formatArticle(text.replace(/<br\s*\/?>/gi, "\n"));
      checkRewriteText(normalized);
      return [id, normalized];
    }),
  );
  const body = entries
    .map((entry) => {
      if (entry.id === null) return entry.text;
      const rewritten = texts.get(entry.id);
      if (!rewritten)
        throw new AppError(
          "WECHAT_REWRITE",
          "改写结果缺少有效正文，原稿已保留。",
        );
      const fenceParity = (text: string) =>
        (text.match(/^```/gm)?.length ?? 0) % 2;
      if (fenceParity(rewritten) !== fenceParity(entry.text))
        throw new AppError(
          "WECHAT_REWRITE",
          "改写结果的代码块边界不完整，原稿已保留。",
        );
      return rewritten;
    })
    .join("");
  const parsed = wechatTextInput.shape.body.safeParse(body);
  if (!parsed.success)
    throw new AppError(
      "WECHAT_REWRITE",
      "改写结果超出正文长度限制，原稿已保留。",
    );
  return parsed.data;
}
