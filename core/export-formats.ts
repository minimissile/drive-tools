import { crc32 } from "node:zlib";
import { csv } from "./csv";
import { AppError } from "./errors";
import type { ExportColumn, ExportRecord } from "../shared/resource-export";

const xml = (s: string) =>
  s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const markdown = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
    .replace(/\r?\n/g, "<br>");

// A small, uncompressed OOXML archive. Every cell is an inline string, so
// resource text can never become an executable spreadsheet formula.
function zip(files: Record<string, string>): Buffer {
  const entries: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path),
      bytes = Buffer.from(content),
      checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    entries.push(header, name, bytes);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(bytes.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22),
    count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, directory, end]);
}
export function xlsx(rows: string[][], sheetName = "资源清单"): Buffer {
  if (rows.some((row) => row.some((v) => v.length > 32767)))
    throw new AppError(
      "EXPORT_CELL_TOO_LONG",
      "部分字段超过Excel单元格32767字符的限制，请选择CSV、JSON或文本格式，避免内容截断。",
    );
  const letter = (n: number) => {
    let s = "";
    for (n++; n; n = Math.floor((n - 1) / 26))
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const cells = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((v, c) => `<c r="${letter(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(v.slice(0, 32767))}</t></is></c>`).join("")}</row>`,
    )
    .join("");
  return zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="26"/><sheetData>${cells}</sheetData><autoFilter ref="A1:${letter(rows[0].length - 1)}${rows.length}"/></worksheet>`,
  });
}
export function formatResourceExport(
  format: "xlsx" | "csv" | "md" | "json" | "txt",
  columns: ExportColumn[],
  records: ExportRecord[],
): Buffer {
  const rows = [
    columns.map((c) => c.label),
    ...records.map((r) => columns.map((c) => r[c.field])),
  ];
  if (format === "xlsx") return xlsx(rows);
  if (format === "csv")
    return Buffer.from(
      csv(
        rows.map((row) =>
          row.map((v) => (/^\s+[=+\-@]/.test(v) ? "'" + v : v)),
        ),
      ),
    );
  if (format === "json")
    return Buffer.from(
      JSON.stringify({ columns, rows: rows.slice(1) }, null, 2),
    );
  if (format === "md")
    return Buffer.from(
      [
        rows[0].map(markdown).join(" | "),
        columns.map(() => "---").join(" | "),
        ...rows.slice(1).map((r) => r.map(markdown).join(" | ")),
      ]
        .map((r) => `| ${r} |`)
        .join("\n") + "\n",
    );
  return Buffer.from(
    records
      .map(
        (r, i) =>
          `${i + 1}. ${columns.map((c) => `${c.label}：${r[c.field]}`).join("\n")}`,
      )
      .join("\n\n") + "\n",
  );
}
