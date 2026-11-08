import { crc32, inflateRawSync } from "node:zlib";
import mammoth from "mammoth";
import { AppError } from "./errors";

const invalid = () =>
  new AppError(
    "DOCUMENT_PARSE_FAILED",
    "Word文档无法读取，可能已加密或损坏。请使用可打开的DOCX原文件，或另存为PDF后导入。",
  );

/** Bound XML expansion before handing the DOCX container to the text reader. */
function checkDocx(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    throw invalid();
  const count = bytes.readUInt16LE(end + 10),
    central = bytes.readUInt32LE(end + 16);
  if (!count || count > 1024 || central + bytes.readUInt32LE(end + 12) !== end)
    throw invalid();
  const names = new Set<string>();
  let offset = central,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw invalid();
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28),
      extraLength = bytes.readUInt16LE(offset + 30),
      commentLength = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      local + 30 > central ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw invalid();
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    total += size;
    if (
      total > 64 * 1024 * 1024 ||
      size > 24 * 1024 * 1024 ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      names.has(name)
    )
      throw invalid();
    names.add(name);
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    if (start + compressed > central) throw invalid();
    if (/\.(xml|rels)$/i.test(name)) {
      if (size > 8 * 1024 * 1024) throw invalid();
      const payload = bytes.subarray(start, start + compressed);
      const expanded =
        method === 0
          ? payload
          : inflateRawSync(payload, { maxOutputLength: 8 * 1024 * 1024 });
      if (expanded.length !== size || crc32(expanded) !== checksum)
        throw invalid();
    }
    offset = next;
  }
  if (
    offset !== end ||
    !names.has("word/document.xml") ||
    !names.has("[Content_Types].xml")
  )
    throw invalid();
}

export async function extractDocxText(bytes: Uint8Array) {
  try {
    const buffer = Buffer.from(bytes);
    checkDocx(buffer);
    // Raw text preserves paragraphs/tables, with no HTML rendering, image
    // conversion or access to external files. Mammoth disables that by default.
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}
