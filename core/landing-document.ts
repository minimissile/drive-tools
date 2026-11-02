import { createHash } from "node:crypto";
import { AppError } from "./errors";

export interface LandingReading {
  copyId: string;
  fileId: string;
  name: string;
  bytes: number;
  sha256: string;
  pageCount: number;
  pages: { page: number; text: string }[];
  sampled: boolean;
  readAt: string;
}
export const landingDocumentLimit = 20 * 1024 * 1024;
export function documentPages(count: number) {
  if (count <= 48) return Array.from({ length: count }, (_, i) => i + 1);
  // Front matter / contents, an evenly spaced body sample, and the ending.
  return [
    ...new Set([
      ...Array.from({ length: 12 }, (_, i) => i + 1),
      ...Array.from(
        { length: 34 },
        (_, i) => 13 + Math.round((i * (count - 14)) / 33),
      ),
      count - 1,
      count,
    ]),
  ].sort((a, b) => a - b);
}
export async function extractLandingDocument(
  name: string,
  bytes: Uint8Array,
): Promise<Omit<LandingReading, "copyId" | "fileId">> {
  if (!bytes.length || bytes.length > landingDocumentLimit)
    throw new AppError("DOCUMENT_TOO_LARGE", "正文文件必须小于20MB。");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let pageCount = 1,
    sampled = false;
  const pages: LandingReading["pages"] = [];
  if (/\.pdf$/i.test(name)) {
    if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-")))
      throw new AppError("DOCUMENT_INVALID", "文件内容不是有效的 PDF。");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: true,
    });
    try {
      const pdf = await task.promise;
      pageCount = pdf.numPages;
      if (pageCount > 5000)
        throw new AppError(
          "DOCUMENT_TOO_LONG",
          "PDF超过5000页，请拆分后导入。",
        );
      const selected = documentPages(pageCount);
      sampled = selected.length < pageCount;
      let remaining = 110000;
      for (const number of selected) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const raw = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("");
        const full = raw.replace(/[ \t]+/g, " ").trim();
        const text = full.slice(0, Math.min(4500, remaining));
        if (text.length < full.length) sampled = true;
        if (text) {
          pages.push({ page: number, text });
          remaining -= text.length;
        }
        page.cleanup();
        if (remaining <= 0) {
          sampled = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "DOCUMENT_PARSE_FAILED",
        "PDF无法提取文字，可能已加密或损坏。请导入可读取的版本。",
      );
    } finally {
      await task.destroy();
    }
  } else if (/\.(txt|md)$/i.test(name)) {
    const full = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes)
      .trim();
    if ((full.match(/\uFFFD/g)?.length ?? 0) > Math.max(5, full.length / 100))
      throw new AppError(
        "DOCUMENT_ENCODING",
        "文本编码无法识别，请另存为UTF-8后导入。",
      );
    sampled = full.length > 60000;
    pages.push({ page: 1, text: full.slice(0, 60000) });
  } else
    throw new AppError(
      "DOCUMENT_FORMAT",
      "正文读取暂支持 PDF、TXT 和 Markdown，其他格式可补充已核实的文本资料。",
    );
  if (pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0) < 120)
    throw new AppError(
      "DOCUMENT_NO_TEXT",
      "正文文字不足，可能是扫描件。尚未读取内容，不能据此生成高质量页面；请导入可提取文字的版本。",
    );
  return {
    name,
    bytes: bytes.length,
    sha256,
    pageCount,
    pages,
    sampled,
    readAt: new Date().toISOString(),
  };
}
