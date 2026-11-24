/** Excel clipboard TSV, including quoted cells with embedded tabs/newlines. */
export function parseClipboardTable(text: string) {
  if (text.length > 500_000) throw new Error("粘贴内容过大，请分批录入。");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || !cell)) {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && /[\t\r\n]/.test(c)) {
      row.push(cell);
      cell = "";
      if (c !== "\t") {
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else cell += c;
  }
  if (quoted) throw new Error("粘贴内容有未闭合的引号，请重新复制完整单元格。");
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
