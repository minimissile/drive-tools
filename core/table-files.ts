import { inflateRawSync, crc32 } from "node:zlib";
import { posix } from "node:path";
import { parseCsv } from "./bulk";
import { AppError } from "./errors";
import { decodeHtml } from "./zhidao/parsers";

const invalid = () =>
  new AppError(
    "INVALID_TABLE",
    "表格无法读取，请使用单工作表的 XLSX、CSV 或 TXT；旧 XLS 请另存为 XLSX。",
  );
function readZip(bytes: Buffer) {
  if (bytes.length > 8_000_000)
    throw new AppError("FILE_TOO_LARGE", "导入文件不能超过8MB。");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw invalid();
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count > 300 || offset >= end) throw invalid();
  const entries = new Map<string, () => string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw invalid();
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      checksum = bytes.readUInt32LE(offset + 16),
      compressed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24),
      nameLength = bytes.readUInt16LE(offset + 28),
      extraLength = bytes.readUInt16LE(offset + 30),
      commentLength = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    total += size;
    if (
      total > 24_000_000 ||
      size > 12_000_000 ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      entries.has(name)
    )
      throw invalid();
    entries.set(name, () => {
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
        throw invalid();
      const start =
        local +
        30 +
        bytes.readUInt16LE(local + 26) +
        bytes.readUInt16LE(local + 28);
      if (start + compressed > bytes.length) throw invalid();
      const payload = bytes.subarray(start, start + compressed);
      const expanded =
        method === 0
          ? payload
          : inflateRawSync(payload, { maxOutputLength: 12_000_000 });
      if (expanded.length !== size || crc32(expanded) !== checksum)
        throw invalid();
      return expanded.toString("utf8");
    });
  }
  return (name: string) => {
    const read = entries.get(name);
    return read ? read() : "";
  };
}
export function readXlsx(bytes: Buffer, maxRows = 501) {
  const entry = readZip(bytes);
  const workbook = entry("xl/workbook.xml"),
    rels = entry("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw invalid();
  const first = workbook.match(/<sheet\b[^>]*\br:id=["']([^"']+)/)?.[1];
  let sheet = "";
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attrs = m[1];
    if (attrs.match(/\bId=["']([^"']+)/)?.[1] === first)
      sheet = decodeHtml(attrs.match(/\bTarget=["']([^"']+)/)?.[1] ?? "");
  }
  const path = sheet.startsWith("/")
    ? sheet.slice(1)
    : posix.normalize("xl/" + sheet);
  if (!path.startsWith("xl/worksheets/")) throw invalid();
  const xml = entry(path);
  if (!xml) throw invalid();
  const strings = [
    ...entry("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
  ].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => decodeHtml(t[1]))
      .join(""),
  );
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows)
      throw new AppError("ROW_LIMIT", `一次最多导入${maxRows === 501 ? 500 : maxRows}条记录。`);
    const cells: string[] = [];
    for (const cell of row[1].matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attrs = cell[1],
        body = cell[2] ?? "";
      const ref = attrs.match(/\br=["']([A-Z]+)\d+/)?.[1];
      let col = ref
        ? [...ref].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
        : cells.length;
      if (col > 29) throw new AppError("COLUMN_LIMIT", "导入表格最多30列。");
      const type = attrs.match(/\bt=["']([^"']+)/)?.[1];
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const value =
        type === "s"
          ? (strings[Number(raw)] ?? "")
          : type === "inlineStr"
            ? [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
                .map((m) => decodeHtml(m[1]))
                .join("")
            : decodeHtml(raw);
      if (value.length > 32767) throw invalid();
      cells[col] = value.trim();
    }
    if (cells.some(Boolean))
      rows.push(Array.from({ length: cells.length }, (_, i) => cells[i] ?? ""));
  }
  return rows;
}
export function readTableBytes(name: string, bytes: Buffer): string[][] {
  if (/\.xlsx$/i.test(name)) return readXlsx(bytes);
  if (!/\.(?:txt|csv)$/i.test(name)) throw invalid();
  if (bytes.length > 2_000_000)
    throw new AppError("FILE_TOO_LARGE", "文本表格不能超过2MB。");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
  }
  text = text.replace(/^\uFEFF/, "");
  return /\.csv$/i.test(name)
    ? parseCsv(text)
    : text
        .split(/\r?\n/)
        .map((s) => [s.trim()])
        .filter((r) => r[0]);
}
export function keywordRows(rows: string[][]) {
  const words: string[] = [];
  for (const row of rows) {
    const values = row.map((v) => v.trim()).filter(Boolean);
    if (!values.length) continue;
    if (values.length > 1)
      throw new AppError(
        "KEYWORD_COLUMNS",
        "关键词文件需要单列，每行一个名称。",
      );
    if (/https?:\/\/|网盘链接|提取码/.test(values[0]) || values[0].length > 100)
      throw new AppError(
        "INVALID_KEYWORDS",
        "请导入关键词名称列表，资源链接表请使用“导入资源表”。",
      );
    words.push(values[0]);
  }
  if (!words.length || words.length > 500)
    throw new AppError("KEYWORD_LIMIT", "请提供1–500个关键词。");
  return [...new Set(words)];
}
