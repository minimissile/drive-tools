import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { Repository } from "./repository";
import { id, now } from "./database";
import { AppError, safeMessage } from "./errors";
import type { SecretStore } from "./secrets";

const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const yaml = (text: string) => JSON.stringify(text);
const start = "<!-- panxu:generated:start -->";
const end = "<!-- panxu:generated:end -->";
export class NoteExporter {
  private flushing: Promise<void> | null = null;
  constructor(
    private repo: Repository,
    private secrets: SecretStore,
    private dataPath: string,
  ) {}
  enqueue(copyId: string) {
    if (
      !this.repo.db.get(
        "SELECT id FROM outbox WHERE copy_id=? AND status=?",
        copyId,
        "pending",
      )
    )
      this.repo.db.run(
        "INSERT INTO outbox(id,copy_id,kind,created_at) VALUES(?,?,?,?)",
        id("out"),
        copyId,
        "note",
        now(),
      );
    this.repo.db.run(
      "UPDATE copies SET note_status=? WHERE id=?",
      this.repo.db.setting("vaultPath", null) ? "pending" : "not_configured",
      copyId,
    );
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  private async flushOnce() {
    while (true) {
      const pending = this.repo.db.all<{ id: string; copy_id: string }>(
        "SELECT id,copy_id FROM outbox WHERE status=? LIMIT 20",
        "pending",
      );
      if (!pending.length) break;
      for (const item of pending) {
        try {
          await this.export(item.copy_id);
          this.repo.db.run(
            "UPDATE outbox SET status=?,error=NULL WHERE id=?",
            "done",
            item.id,
          );
        } catch (error) {
          this.repo.db.run(
            "UPDATE outbox SET status=?,error=? WHERE id=?",
            "failed",
            safeMessage(error),
            item.id,
          );
          this.repo.db.run(
            "UPDATE copies SET note_status=?,error=? WHERE id=?",
            error instanceof AppError && error.code === "NOTE_CONFLICT"
              ? "conflict"
              : "failed",
            safeMessage(error),
            item.copy_id,
          );
        }
      }
    }
  }
  async export(copyId: string) {
    const vault = this.repo.db.setting<string | null>("vaultPath", null);
    if (!vault) {
      this.repo.db.run(
        "UPDATE copies SET note_status=? WHERE id=?",
        "not_configured",
        copyId,
      );
      return;
    }
    const copy = this.repo.getCopy(copyId),
      resource = this.repo.getResource(copy.resourceId),
      account = this.repo.getAccount(copy.accountId);
    const base = resolve(vault, "盘序");
    const file = join(base, "Resources", `${resource.id}--${copy.id}.md`);
    if (!relative(base, file) || relative(base, file).startsWith(".."))
      throw new AppError("INVALID_NOTE_PATH", "知识库输出路径不正确。");
    await mkdir(join(base, "Resources"), { recursive: true });
    let coverLink = "";
    if (resource.coverId) {
      await mkdir(join(base, "Attachments"), { recursive: true });
      await copyFile(
        join(this.dataPath, "covers", `${resource.coverId}.png`),
        join(base, "Attachments", `${resource.coverId}.png`),
      );
      coverLink = `![](../Attachments/${resource.coverId}.png)\n`;
    }
    const code = this.repo.db.setting("exportCodes", false)
      ? await this.secrets.get(`share:${copyId}`)
      : null;
    const splits = this.repo.db.all<{
      id: string;
      path: string;
      share_url: string;
    }>(
      "SELECT id,path,share_url FROM split_items WHERE copy_id=? AND status='ready' AND verified_at IS NOT NULL AND owner_uid=? ORDER BY path",
      copyId,
      account.uid ?? "",
    );
    const splitLines: string[] = [];
    for (const item of splits) {
      const splitCode = this.repo.db.setting("exportCodes", false)
        ? await this.secrets.get(`split:${item.id}`)
        : null;
      splitLines.push(
        `- ${item.path}：${item.share_url}${splitCode ? `（提取码：${splitCode}）` : ""}`,
      );
    }
    const frontmatter = [
      "---",
      `resource_id: ${yaml(resource.id)}`,
      `copy_id: ${yaml(copy.id)}`,
      `title: ${yaml(resource.title)}`,
      `category: ${yaml(resource.category)}`,
      `provider: ${yaml(resource.provider)}`,
      `account: ${yaml(account.alias)}`,
      `tags: ${JSON.stringify(resource.tags)}`,
      `share_url: ${yaml(copy.shareUrl ?? "")}`,
      `status: ${yaml(copy.status)}`,
      `updated: ${yaml(resource.updatedAt)}`,
      "---",
    ].join("\n");
    let managed = `# ${resource.title}\n\n${coverLink}\n${resource.summary}\n\n## 保存与分享\n- 保存账号：${account.alias}\n- 本人分享：${copy.shareUrl ?? "尚未生成"}\n- 目标目录：${copy.directory}\n- 提取码：${code ?? "未导出；在盘序中复制内容包获取"}\n\n## 内部追溯（禁止对外分发）\n来源链接：${resource.sourceUrl}\n\n## 文件清单\n${copy.files.map((f) => `- ${f.name}`).join("\n")}\n`;
    if (splitLines.length)
      managed += `\n## 本人拆分链接\n${splitLines.join("\n")}\n`;
    const managedHash = hash(frontmatter + "\n" + managed);
    let suffix = "\n\n## 我的笔记\n\n";
    const previous = this.repo.db.get<{ managed_hash: string }>(
      "SELECT managed_hash FROM note_exports WHERE copy_id=?",
      copyId,
    );
    try {
      const existing = await readFile(file, "utf8");
      const first = existing.indexOf(start),
        last = existing.indexOf(end);
      if (
        first < 0 ||
        last < first ||
        !previous ||
        hash(
          existing.slice(0, first).trimEnd() +
            "\n" +
            existing.slice(first + start.length, last).trim(),
        ) !== previous.managed_hash
      )
        throw new AppError(
          "NOTE_CONFLICT",
          "笔记的生成区域或属性已被外部修改，未覆盖。请先在Obsidian中保留修改或使用另存功能。",
        );
      suffix = existing.slice(last + end.length);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const text = `${frontmatter}\n${start}\n${managed.trim()}\n${end}${suffix}`;
    const actualHash = hash(frontmatter + "\n" + managed.trim());
    const temp = file + "." + id("tmp");
    await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
    this.repo.db.run(
      "INSERT INTO note_exports(copy_id,path,managed_hash,revision,exported_at) VALUES(?,?,?,?,?) ON CONFLICT(copy_id) DO UPDATE SET path=excluded.path,managed_hash=excluded.managed_hash,revision=excluded.revision,exported_at=excluded.exported_at",
      copyId,
      file,
      actualHash || managedHash,
      resource.revision,
      now(),
    );
    this.repo.db.run(
      "UPDATE copies SET note_status=?,error=NULL WHERE id=?",
      "synced",
      copyId,
    );
  }
}
