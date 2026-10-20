import { Database, id, now } from "./database";
import { Repository } from "./repository";
import { AppError, safeMessage } from "./errors";
import {
  insertionMaterialInput,
  insertionTargetInput,
  type InsertionMaterial,
  type InsertionMaterialInput,
  type InsertionTarget,
  type InsertionRun,
  type InsertionHistory,
  type InsertionCandidate,
  type InsertionItem,
} from "../shared/insertion";
import type { Account, RemoteFile } from "../shared/types";
import type { DriveProvider } from "./providers/provider";
import { normalizedDirectory } from "./providers/provider";
import { createHash } from "node:crypto";
type Authenticate = <T>(
  id: string,
  fn: (a: Account, p: DriveProvider) => Promise<T>,
) => Promise<T>;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class InsertionService {
  private active = new Map<string, Set<string>>();
  private preparing = new Set<string>();
  private cancelled = new Set<string>();
  get isBusy() {
    return this.active.size > 0 || this.preparing.size > 0;
  }
  busyAccount(id: string) {
    return (
      this.preparing.has(id) ||
      [...this.active.values()].some((ids) => ids.has(id))
    );
  }
  constructor(
    private db: Database,
    private repo: Repository,
    private authenticated: Authenticate,
    private changed: () => void,
    private assertIdle: (id: string) => void,
  ) {
    // A process restart is a local interruption, never authorization to repeat writes.
    for (const row of db.all<{ data: string }>(
      "SELECT data FROM insertion_runs WHERE json_extract(data,'$.state')='running'",
    )) {
      const run = JSON.parse(row.data) as InsertionRun;
      if (run.state !== "running") continue;
      run.state = "interrupted";
      for (const item of run.items) {
        if (item.state === "writing") {
          item.state = "uncertain";
          item.message = "应用中断，写入结果待核对；不会自动重复。";
        } else if (item.state === "pending") {
          item.state = "cancelled";
          item.message = "应用中断，未继续执行。";
        }
      }
      this.save(run);
    }
  }
  materials() {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM insertion_materials ORDER BY rowid DESC LIMIT 200",
      )
      .map((r) => JSON.parse(r.data) as InsertionMaterial);
  }
  addMaterial(raw: InsertionMaterialInput) {
    const input = insertionMaterialInput.parse(raw);
    let bytes = Buffer.alloc(0),
      mime = "inode/directory";
    if (input.kind === "txt") {
      bytes = Buffer.from(input.text, "utf8");
      mime = "text/plain;charset=utf-8";
      if (bytes.length > 512 * 1024)
        throw new AppError("FILE_TOO_LARGE", "TXT 最多 512 KiB。");
    }
    if (input.kind === "image") {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64))
        throw new AppError("INVALID_IMAGE", "图片编码无效。");
      bytes = Buffer.from(input.base64, "base64");
      mime = input.mime;
      const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp =
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
      if (
        !{ "image/png": png, "image/jpeg": jpeg, "image/webp": webp }[mime] ||
        !{
          "image/png": /\.png$/i,
          "image/jpeg": /\.jpe?g$/i,
          "image/webp": /\.webp$/i,
        }[mime as "image/png"].test(input.name)
      )
        throw new AppError("INVALID_IMAGE", "图片格式、文件名与内容不一致。");
      if (!bytes.length || bytes.length > 4 * 1024 * 1024)
        throw new AppError("FILE_TOO_LARGE", "每张图片最多 4 MiB。");
    }
    const key =
      "insert_" +
      createHash("sha256")
        .update(JSON.stringify([input.kind, input.name, mime]))
        .update(bytes)
        .digest("hex");
    const material: InsertionMaterial = {
      id: key,
      name: input.name,
      kind: input.kind,
      mime,
      size: bytes.length,
    };
    const count = this.db.get<{ count: number }>(
      "SELECT count(*) count FROM insertion_materials",
    )!.count;
    if (
      count >= 200 &&
      !this.db.get("SELECT id FROM insertion_materials WHERE id=?", key)
    )
      throw new AppError(
        "MATERIAL_LIMIT",
        "本地最多保存 200 项插入素材，请先移除不再使用的素材。",
      );
    const total = this.db.get<{ total: number }>(
      "SELECT coalesce(sum(length(content)),0) total FROM insertion_materials",
    )!.total;
    if (
      !this.db.get("SELECT id FROM insertion_materials WHERE id=?", key) &&
      total + Math.ceil((bytes.length * 4) / 3) > 128 * 1024 * 1024
    )
      throw new AppError(
        "MATERIAL_LIMIT",
        "本地插入素材累计超过 96 MiB，请移除不再使用的素材。",
      );
    this.db.run(
      "INSERT OR IGNORE INTO insertion_materials(id,data,content) VALUES(?,?,?)",
      key,
      JSON.stringify(material),
      bytes.toString("base64"),
    );
    return material;
  }
  materialDetail(id: string) {
    const { metadata, bytes } = this.material(id);
    return {
      ...metadata,
      text: metadata.kind === "txt" ? bytes.toString("utf8") : undefined,
      dataUrl:
        metadata.kind === "image"
          ? `data:${metadata.mime};base64,${bytes.toString("base64")}`
          : undefined,
    };
  }
  removeMaterial(id: string) {
    if (this.isBusy)
      throw new AppError("ACTIVE_JOBS", "处理过程中不能移除素材。");
    for (const row of this.db.all<{ data: string }>(
      "SELECT data FROM insertion_runs",
    )) {
      const run = JSON.parse(row.data) as InsertionRun;
      if (
        run.state === "preview" &&
        run.items.some((i) => i.material.id === id)
      )
        throw new AppError(
          "MATERIAL_IN_USE",
          "该素材属于待执行预览，请先取消预览。",
        );
    }
    this.db.run("DELETE FROM insertion_materials WHERE id=?", id);
    return true;
  }
  candidates(query = ""): InsertionCandidate[] {
    return this.db
      .all<{ id: string; title: string }>(
        "SELECT c.id,r.title FROM copies c JOIN resources r ON r.id=c.resource_id WHERE c.folder_id IS NOT NULL AND c.verified_at IS NOT NULL AND c.owner_uid IS NOT NULL AND r.title LIKE ? ORDER BY r.updated_at DESC LIMIT 200",
        `%${query}%`,
      )
      .flatMap((row) => {
        const copy = this.repo.getCopy(row.id),
          account = this.repo.accounts().find((a) => a.id === copy.accountId);
        if (!account || account.uid !== copy.ownerUid || !account.enabled)
          return [];
        return [
          {
            accountId: copy.accountId,
            folderId: copy.folderId!,
            path: copy.directory,
            copyId: copy.id,
            title: row.title,
            account: account.alias,
          },
        ];
      });
  }
  list(): InsertionHistory[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM insertion_runs ORDER BY created_at DESC LIMIT 100",
      )
      .map((r) => {
        const run = JSON.parse(r.data) as InsertionRun;
        return {
          id: run.id,
          createdAt: run.createdAt,
          state: run.state,
          count: run.items.length,
        };
      });
  }
  get(id: string): InsertionRun {
    const row = this.db.get<{ data: string }>(
      "SELECT data FROM insertion_runs WHERE id=?",
      id,
    );
    if (!row) throw new AppError("NOT_FOUND", "插入记录不存在。");
    return JSON.parse(row.data);
  }
  private save(run: InsertionRun) {
    run.updatedAt = now();
    this.db.run(
      "INSERT INTO insertion_runs(id,data,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      run.id,
      JSON.stringify(run),
      run.createdAt,
    );
    this.changed();
  }
  private material(id: string) {
    const row = this.db.get<{ data: string; content: string }>(
      "SELECT data,content FROM insertion_materials WHERE id=?",
      id,
    );
    if (!row) throw new AppError("NOT_FOUND", "插入素材已移除，请重新选择。");
    return {
      metadata: JSON.parse(row.data) as InsertionMaterial,
      bytes: Buffer.from(row.content, "base64"),
    };
  }
  private async resolve(a: Account, p: DriveProvider, target: InsertionTarget) {
    const path = normalizedDirectory(target.path);
    if (path !== target.path || path === "/")
      throw new AppError(
        "INVALID_DIRECTORY",
        "请选择具体资料目录，不支持向网盘根目录批量插入。",
      );
    let parent = a.provider === "baidu" ? "/" : "0";
    for (const name of path.split("/").filter(Boolean)) {
      const matches = (await p.list(a, parent)).filter(
        (f) => f.isDirectory && f.name === name,
      );
      if (matches.length !== 1)
        throw new AppError(
          "TARGET_CHANGED",
          "目标目录不存在或存在同名歧义，请重新选择。",
        );
      parent =
        a.provider === "baidu"
          ? (matches[0].path ?? parent.replace(/\/$/, "") + "/" + name)
          : matches[0].id;
    }
    if (parent !== target.folderId)
      throw new AppError("TARGET_CHANGED", "目录路径与 ID 不一致，已停止。");
    return p.list(a, parent);
  }
  async preview(targets: InsertionTarget[], materialIds: string[]) {
    if (
      !targets.length ||
      targets.length > 100 ||
      !materialIds.length ||
      materialIds.length > 10
    )
      throw new AppError("INSERT_LIMIT", "请选择 1–100 个目录和 1–10 个素材。");
    const materials = [...new Set(materialIds)].map(
      (id) => this.material(id).metadata,
    );
    if (new Set(materials.map((m) => m.name)).size !== materials.length)
      throw new AppError("DUPLICATE_NAME", "所选素材名称不能重复。");
    const unique = new Map(
      targets.map((raw) => {
        const t = insertionTargetInput.parse(raw);
        return [JSON.stringify([t.accountId, t.folderId]), t];
      }),
    );
    const run: InsertionRun = {
      id: id("insertion"),
      createdAt: now(),
      updatedAt: now(),
      state: "preview",
      items: [],
    };
    for (const target of unique.values()) {
      this.assertIdle(target.accountId);
      if (this.busyAccount(target.accountId))
        throw new AppError("ACTIVE_JOBS", "目标账号正在处理其他插入任务。");
      this.preparing.add(target.accountId);
      try {
        await this.authenticated(target.accountId, async (a, p) => {
          const children = await this.resolve(a, p, target);
          for (const material of materials) {
            normalizedDirectory(target.path + "/" + material.name);
            if (material.kind !== "folder" && !p.upload)
              throw new AppError(
                "UPLOAD_UNSUPPORTED",
                "该网盘尚未提供文件上传能力。",
              );
            const exists = children.some((f) => f.name === material.name);
            run.items.push({
              id: id("insert_item"),
              target,
              account: a.alias,
              ownerUid: a.uid!,
              material,
              state: exists ? "skipped" : "pending",
              message: exists ? "同名项已存在，将跳过。" : "待确认插入",
              baseline: children
                .filter((f) => f.name === material.name)
                .map((f) => f.id),
            });
          }
        });
      } finally {
        this.preparing.delete(target.accountId);
      }
    }
    this.save(run);
    return run;
  }
  start(id: string) {
    const run = this.get(id);
    if (run.state !== "preview")
      throw new AppError(
        "ALREADY_STARTED",
        "该预览已经处理过，请查看结果；不会重复提交。",
      );
    if (Date.now() - Date.parse(run.createdAt) > 30 * 60 * 1000)
      throw new AppError("PREVIEW_EXPIRED", "预览超过 30 分钟，请重新预检。");
    const accounts = new Set(run.items.map((i) => i.target.accountId));
    for (const accountId of accounts) {
      this.assertIdle(accountId);
      if (this.busyAccount(accountId))
        throw new AppError("ACTIVE_JOBS", "账号正在处理其他插入任务。");
    }
    for (const item of run.items) this.material(item.material.id);
    run.state = "running";
    this.active.set(run.id, accounts);
    this.save(run);
    void this.execute(run)
      .catch(() => {
        run.state = "interrupted";
        for (const item of run.items) {
          if (item.state === "writing") {
            item.state = "uncertain";
            item.message = "处理异常中断，结果待核对。";
          }
          if (item.state === "pending") {
            item.state = "cancelled";
            item.message = "处理中断，未执行。";
          }
        }
        this.save(run);
      })
      .finally(() => {
        this.active.delete(run.id);
        this.cancelled.delete(run.id);
        this.changed();
      });
    return run;
  }
  cancel(id: string) {
    const run = this.get(id);
    if (run.state === "running") this.cancelled.add(id);
    else if (run.state === "preview") {
      run.state = "cancelled";
      run.items.forEach((i) => {
        if (i.state === "pending") {
          i.state = "cancelled";
          i.message = "未执行";
        }
      });
      this.save(run);
    }
    return true;
  }
  private matches(item: InsertionItem, files: RemoteFile[]) {
    return files.filter(
      (f) =>
        !item.baseline.includes(f.id) &&
        f.name === item.material.name &&
        f.isDirectory === (item.material.kind === "folder") &&
        (f.isDirectory || f.size === item.material.size),
    );
  }
  private async execute(run: InsertionRun) {
    for (const item of run.items) {
      if (item.state !== "pending") continue;
      if (this.cancelled.has(run.id)) {
        item.state = "cancelled";
        item.message = "尚未提交，已取消。";
        this.save(run);
        continue;
      }
      try {
        await this.authenticated(item.target.accountId, async (a, p) => {
          if (a.uid !== item.ownerUid)
            throw new AppError("UID_MISMATCH", "账号身份已变化，请重新预检。");
          const before = await this.resolve(a, p, item.target);
          if (before.some((f) => f.name === item.material.name)) {
            item.state = "skipped";
            item.message = "执行前发现同名内容，已跳过。";
            return;
          }
          if (this.cancelled.has(run.id)) {
            item.state = "cancelled";
            item.message = "尚未提交，已取消。";
            return;
          }
          item.baseline = before
            .filter((f) => f.name === item.material.name)
            .map((f) => f.id);
          item.state = "writing";
          item.message = "已提交写入检查点，正在处理。";
          this.save(run);
          this.invalidateCopies(item, undefined, true);
          const asset = this.material(item.material.id);
          if (item.material.kind === "folder")
            await p.ensureFolder(
              a,
              item.target.path + "/" + item.material.name,
            );
          else
            await p.upload!(a, item.target.folderId, {
              name: item.material.name,
              mime: item.material.mime,
              bytes: asset.bytes,
            });
          item.acknowledged = true;
          this.save(run);
          let files: RemoteFile[] = [],
            matched: RemoteFile[] = [];
          for (let n = 0; n < 4; n++) {
            if (n) await wait(700 * n);
            files = await p.list(a, item.target.folderId);
            matched = this.matches(item, files);
            if (matched.length === 1) break;
          }
          if (matched.length !== 1)
            throw new AppError(
              "UNCERTAIN_REMOTE_RESULT",
              "提交后未唯一核对到名称、类型和大小一致的新项。",
              true,
            );
          item.remoteId = matched[0].id;
          item.state = "success";
          item.message = "已插入并核对目录结果。";
          this.invalidateCopies(item, files);
        });
      } catch (e) {
        const written =
          (item.state as string) === "writing" ||
          item.acknowledged === true ||
          !!item.remoteId;
        item.state = written ? "uncertain" : "failed";
        item.message = written
          ? `写入结果待核对：${safeMessage(e)} 不会自动重试。`
          : safeMessage(e);
      }
      this.save(run);
    }
    run.state = this.cancelled.has(run.id) ? "cancelled" : "completed";
    this.save(run);
  }
  private invalidateCopies(
    item: InsertionItem,
    files?: RemoteFile[],
    bump = false,
  ) {
    this.db.transaction(() => {
      for (const row of this.db.all<{ id: string; directory: string }>(
        "SELECT id,directory FROM copies WHERE account_id=? AND verified_at IS NOT NULL",
        item.target.accountId,
      )) {
        if (
          item.target.path !== row.directory &&
          !item.target.path.startsWith(row.directory + "/")
        )
          continue;
        if (bump)
          this.db.run(
            "UPDATE copies SET share_verified_at=NULL,share_version=share_version+1,note_status='pending' WHERE id=?",
            row.id,
          );
        if (files && item.target.path === row.directory)
          this.db.run(
            "UPDATE copies SET files=? WHERE id=?",
            JSON.stringify(files),
            row.id,
          );
      }
    });
  }
  async recheck(id: string) {
    const run = this.get(id);
    if (run.state === "running")
      throw new AppError("ACTIVE_JOBS", "请等待当前任务结束再核对。");
    const accounts = new Set(
      run.items
        .filter((i) => i.state === "uncertain")
        .map((i) => i.target.accountId),
    );
    for (const accountId of accounts) this.assertIdle(accountId);
    for (const accountId of accounts) this.preparing.add(accountId);
    try {
      for (const item of run.items.filter((i) => i.state === "uncertain")) {
        await this.authenticated(item.target.accountId, async (a, p) => {
          if (a.uid !== item.ownerUid)
            throw new AppError("UID_MISMATCH", "账号身份已变化，不能核对。");
          const files = await this.resolve(a, p, item.target),
            matches = this.matches(item, files);
          // Existence alone cannot prove the bytes belong to this interrupted file upload.
          if (
            matches.length === 1 &&
            (item.material.kind === "folder" || item.acknowledged)
          ) {
            item.state = "success";
            item.remoteId = matches[0].id;
            item.message = "已通过目录读取核对新建内容。";
            this.invalidateCopies(item, files);
          } else
            item.message =
              matches.length === 1
                ? "目录存在名称及大小一致的新文件，请在官网核对内容；未自动重复上传。"
                : "未唯一找到对应新项，请在官网核对；未重复写入。";
        });
        this.save(run);
      }
      return run;
    } finally {
      for (const accountId of accounts) this.preparing.delete(accountId);
      this.changed();
    }
  }
}
