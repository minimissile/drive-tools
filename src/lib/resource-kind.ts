export type ResourceKind = "archive" | "file" | "document";

const archiveExtension =
  /\.(?:zipx?|rar|7z|tar|t[bgx]z|gz|bz2|xz|lzma|zst|cab)(?:\.\d{3})?$/i;
const documentExtension =
  /\.(?:pdf|docx?|xlsx?|xlsm|pptx?|pptm|odt|ods|odp|rtf|txt|md|markdown|csv|tsv|epub|mobi|azw3?|djvu|xps|pages|numbers)$/i;
const archiveMarker =
  /[（(\[【]\s*(?:zipx?|rar|7z|tar|gz|bz2|xz|压缩包)(?:格式|版)?\s*[）)\]】]\s*$/i;
const documentMarker =
  /[（(\[【]\s*(?:pdf|docx?|word|xlsx?|excel|pptx?|powerpoint|txt|md|epub|文档)(?:格式|版)?\s*[）)\]】]\s*$/i;

function nameKind(name: string): ResourceKind {
  const value = name.trim();
  if (archiveExtension.test(value)) return "archive";
  if (documentExtension.test(value)) return "document";
  return "file";
}

/** A directory or a mixed collection stays a generic file resource. */
export function resourceKind(
  files: readonly { name: string; isDirectory: boolean }[],
  title = "",
): ResourceKind {
  if (files.length) {
    if (files.some((file) => file.isDirectory)) return "file";
    const kinds = files.map((file) => nameKind(file.name));
    return kinds.every((kind) => kind === kinds[0]) ? kinds[0] : "file";
  }
  const kind = nameKind(title);
  if (kind !== "file") return kind;
  if (archiveMarker.test(title)) return "archive";
  if (documentMarker.test(title)) return "document";
  return "file";
}
