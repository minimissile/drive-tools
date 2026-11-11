import { z } from "zod";

export const tiebaInitialForums = [
  { name: "电子书资源", topic: "电子书、阅读资料与目录整理" },
  { name: "office技巧", topic: "Office使用技巧与办公问题" },
  { name: "ppt制作教程", topic: "演示文稿排版与制作方法" },
  { name: "办公文秘", topic: "办公资料、文书与实务交流" },
  { name: "极速office", topic: "办公软件使用与资料协作" },
] as const;

export const tiebaForumNameSchema = z
  .string()
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "贴吧名称不能包含换行或控制字符",
  )
  .transform((value) => value.normalize("NFKC").trim().replace(/\s+/gu, " "))
  .pipe(
    z
      .string()
      .min(1, "请填写贴吧名称")
      .max(100, "贴吧名称最多100字")
      .refine(
        (value) =>
          !/^(?:[a-z][a-z\d+.-]*:|www\.)|https?:\/\/|[\/\\]/iu.test(value),
        "请填写贴吧名称，不要填写网址或路径",
      ),
  );

export function normalizeTiebaForumName(value: string) {
  return tiebaForumNameSchema.parse(value);
}

/** Only build links to the official forum page, with the name as a parameter. */
export function tiebaForumHomeUrl(name: string): string | null {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  )
    return null;
  return `https://tieba.baidu.com/f?kw=${encodeURIComponent(trimmed)}&ie=utf-8`;
}

/** Decode official /f keyword bytes; legacy personal lists still emit GBK. */
export function decodeTiebaForumUrlName(
  value: string,
  options: { allowRelative?: boolean } = {},
): string | null {
  if (value.length > 2000) return null;
  let url: URL;
  try {
    url = options.allowRelative
      ? new URL(value, "https://tieba.baidu.com")
      : new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== "https://tieba.baidu.com" ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/f\/?$/u.test(url.pathname) ||
    url.searchParams.getAll("kw").length !== 1
  )
    return null;
  const pair = url.search
    .slice(1)
    .split("&")
    .find((part) => {
      try {
        return (
          decodeURIComponent(part.split("=", 1)[0].replace(/\+/gu, " ")) ===
          "kw"
        );
      } catch {
        return false;
      }
    });
  if (pair === undefined) return null;
  if (pair.indexOf("=") < 0) return null;
  const raw = pair.slice(pair.indexOf("=") + 1).replace(/\+/gu, " ");
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    if (
      url.searchParams
        .getAll("ie")
        .some((encoding) => /^utf-?8$/iu.test(encoding.trim()))
    )
      return null;
    const bytes: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "%") {
        const hex = raw.slice(i + 1, i + 3);
        if (!/^[a-f\d]{2}$/iu.test(hex)) return null;
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        const code = raw.charCodeAt(i);
        if (code > 127) return null;
        bytes.push(code);
      }
    }
    try {
      name = new TextDecoder("gbk", { fatal: true }).decode(
        Uint8Array.from(bytes),
      );
    } catch {
      return null;
    }
  }
  name = name.trim();
  return name &&
    name.length <= 100 &&
    !/[\u0000-\u001f\u007f\ufffd]/u.test(name)
    ? name
    : null;
}

/** Optional UI convenience; only an exact official forum home link becomes a name. */
export function tiebaForumInputName(value: string) {
  const input = value.trim();
  if (!/^https?:\/\//iu.test(input)) return normalizeTiebaForumName(input);
  if (input.length > 2000) throw new Error("贴吧首页链接过长");
  const name = decodeTiebaForumUrlName(input);
  if (name === null) throw new Error("只支持贴吧官方HTTPS吧首页链接");
  return normalizeTiebaForumName(name);
}
