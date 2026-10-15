import { id } from "./database";
import { AppError, safeMessage } from "./errors";
import { parseShare } from "./links";
import { Repository } from "./repository";
import { resourceInputSchema } from "../shared/schemas";
import type {
  ImportPreview,
  ImportRow,
  Provider,
  ResourceInput,
} from "../shared/types";

export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text, "utf8") > 2_000_000)
    throw new AppError("IMPORT_TOO_LARGE", "CSV不能超过2MB。");
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    endedQuote = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        endedQuote = true;
      } else value += c;
    } else if (c === '"') {
      if (value || endedQuote)
        throw new AppError(
          "INVALID_CSV",
          "CSV引号位置不正确，请使用标准CSV格式。",
        );
      quoted = true;
    } else if (c === "," || c === "\r" || c === "\n") {
      row.push(value);
      value = "";
      endedQuote = false;
      if (c !== ",") {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (endedQuote && !/\s/.test(c))
        throw new AppError("INVALID_CSV", "CSV引号后的内容不正确。");
      if (!endedQuote) value += c;
    }
    if (rows.length > 501)
      throw new AppError("IMPORT_TOO_LARGE", "一次最多导入500份资源。");
  }
  if (quoted) throw new AppError("INVALID_CSV", "CSV存在未闭合引号。");
  row.push(value);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length > 501)
    throw new AppError("IMPORT_TOO_LARGE", "一次最多导入500份资源。");
  return rows;
}

export class BulkImporter {
  private previews = new Map<
    string,
    {
      expires: number;
      rows: { view: ImportRow; input: ResourceInput | null }[];
    }
  >();
  constructor(
    private repo: Repository,
    private save: (input: ResourceInput) => Promise<unknown>,
  ) {}
  preview(
    text: string,
    targets: Partial<Record<Provider, string>>,
  ): ImportPreview {
    const [header = [], ...rows] = parseCsv(text);
    const aliases: Record<string, string> = {
      title: "标题",
      link: "链接",
      url: "链接",
      category: "分类",
      tags: "标签",
      summary: "说明",
      account: "账号",
      code: "提取码",
      资源标题: "标题",
      网盘链接: "链接",
      资源说明: "说明",
      网盘账号: "账号",
    };
    const columns = header.map(
      (h) => aliases[h.trim().toLowerCase()] ?? h.trim(),
    );
    if (
      !["标题", "链接", "分类"].every((h) => columns.includes(h)) ||
      new Set(columns).size !== columns.length
    )
      throw new AppError(
        "CSV_HEADER_REQUIRED",
        "CSV首行须包含标题、链接、分类，列名不能重复。可选：标签、说明、账号、提取码。",
      );
    const seen = new Set<string>();
    const items = rows.map((values, index) => {
      const data = Object.fromEntries(
        columns.map((key, i) => [key, values[i] ?? ""]),
      );
      const view: ImportRow = {
        row: index + 2,
        title: data["标题"].trim(),
        provider: null,
        account: "",
        status: "invalid",
        message: "",
      };
      try {
        if (values.length > columns.length)
          throw new AppError(
            "INVALID_CSV",
            "数据列超过表头，请检查逗号和引号。",
          );
        const source = parseShare(data["链接"], data["提取码"] ?? "");
        view.provider = source.provider;
        const available = this.repo
          .accounts()
          .filter((a) => a.enabled && a.provider === source.provider);
        const requested = data["账号"]?.trim();
        const matches = requested
          ? available.filter((a) => a.alias === requested)
          : targets[source.provider]
            ? available.filter((a) => a.id === targets[source.provider])
            : available.filter((a) => a.isDefault);
        const account =
          matches.length === 1
            ? matches[0]
            : !requested && !targets[source.provider] && available.length === 1
              ? available[0]
              : null;
        if (!account)
          throw new AppError(
            "IMPORT_ACCOUNT_REQUIRED",
            "目标账号不明确，请选择对应网盘账号，或在CSV填写唯一账号别名。",
          );
        view.account = account.alias;
        const existing = this.repo.db.get<{ id: string }>(
          "SELECT id FROM resources WHERE source_url=?",
          source.url,
        );
        const sameCopy =
          existing &&
          this.repo.db.get(
            "SELECT id FROM copies WHERE resource_id=? AND account_id=?",
            existing.id,
            account.id,
          );
        const key = `${source.url}:${account.id}`;
        if (sameCopy || seen.has(key)) {
          view.status = "skip";
          view.message = sameCopy
            ? "该账号已录入此资源，跳过"
            : "CSV内重复，跳过";
          return { view, input: null };
        }
        const resource = existing ? this.repo.getResource(existing.id) : null;
        const input = resourceInputSchema.parse({
          title: resource?.title ?? data["标题"],
          sourceText: source.url,
          extractionCode: source.code,
          category: resource?.category ?? data["分类"],
          tags:
            resource?.tags ??
            (data["标签"] ?? "")
              .split(/[,，;；]/)
              .map((v) => v.trim())
              .filter(Boolean),
          summary: resource?.summary ?? data["说明"] ?? "",
          accountId: account.id,
          directory: account.defaultDirectory,
          rightsConfirmed: false,
          enqueue: false,
        });
        seen.add(key);
        view.status = existing ? "copy" : "new";
        view.message = existing
          ? "新增该账号的资料草稿，沿用已有资源信息"
          : "新增资料草稿，稍后单独选择文件并转存";
        return { view, input };
      } catch (error) {
        view.message =
          error instanceof AppError
            ? error.message
            : "资源字段不符合要求，请检查标题、分类、标签和长度。";
        return { view, input: null };
      }
    });
    for (const [key, value] of this.previews)
      if (value.expires < Date.now()) this.previews.delete(key);
    if (this.previews.size >= 5)
      this.previews.delete(this.previews.keys().next().value!);
    const token = id("import");
    this.previews.set(token, {
      expires: Date.now() + 30 * 60_000,
      rows: items,
    });
    return { token, rows: items.map((r) => r.view) };
  }
  async commit(token: string, selected: number[]) {
    const preview = this.previews.get(token);
    if (!preview || preview.expires < Date.now())
      throw new AppError("IMPORT_EXPIRED", "预检已过期，请重新预检CSV。");
    const rows = [...new Set(selected)].map((n) =>
      preview.rows.find((r) => r.view.row === n),
    );
    if (!rows.length || rows.some((r) => !r?.input))
      throw new AppError("IMPORT_SELECTION", "请选择预检通过的资源行。");
    this.previews.delete(token);
    let created = 0,
      skipped = 0;
    const copyIds: string[] = [];
    const errors: { row: number; message: string }[] = [];
    for (const row of rows) {
      const input = row!.input!;
      try {
        const source = parseShare(input.sourceText);
        if (
          this.repo.db.get(
            "SELECT c.id FROM copies c JOIN resources r ON r.id=c.resource_id WHERE r.source_url=? AND c.account_id=?",
            source.url,
            input.accountId,
          )
        ) {
          skipped++;
          continue;
        }
        const saved = (await this.save(input)) as { copyId: string };
        copyIds.push(saved.copyId);
        created++;
      } catch (error) {
        errors.push({ row: row!.view.row, message: safeMessage(error) });
      }
    }
    return { created, skipped, failed: errors.length, errors, copyIds };
  }
}
