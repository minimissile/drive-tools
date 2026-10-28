import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Database, databaseSchemaVersion, id, now } from "./database";
import { AppError } from "./errors";
import { coverFilePattern } from "./cover-assets";
import { sourceWeiboPostBackup } from "../shared/weibo-posts";
import { studioWorkingCopy } from "../shared/studio";

export async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function regularFile(path: string, max: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max)
    throw new AppError(
      "INVALID_BACKUP",
      "备份包含异常文件或文件超过大小限制。",
    );
}
export async function inspectBackup(folder: string) {
  const root = await lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new AppError(
      "INVALID_BACKUP",
      "请选择真实备份目录，不能使用符号链接。",
    );
  for (const sidecar of ["panxu.db-wal", "panxu.db-shm", "panxu.db-journal"]) {
    try {
      await lstat(join(folder, sidecar));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new AppError(
      "INVALID_BACKUP",
      "备份包含数据库工作日志，请先关闭其他程序并重新导出一致性备份。",
    );
  }
  await regularFile(join(folder, "manifest.json"), 1_000_000);
  const manifest = z
    .object({
      product: z.literal("panxu-studio"),
      schemaVersion: z.number().int().min(1).max(databaseSchemaVersion),
      createdAt: z.string(),
      credentialsIncluded: z.literal(false),
      databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")));
  const file = join(folder, "panxu.db");
  await regularFile(file, 512 * 1024 * 1024);
  if ((await fileHash(file)) !== manifest.databaseSha256)
    throw new AppError("BACKUP_HASH_MISMATCH", "备份数据库校验失败，未恢复。");
  // Immutable reads never create SQLite sidecars in the source backup.
  const db = new DatabaseSync(pathToFileURL(file).href + "?immutable=1", {
    readOnly: true,
  });
  let resources: number,
    accounts: number,
    drafts: number,
    required: string[],
    requiredMedia: string[] = [],
    requiredZhihu: string[] = [],
    requiredContent: string[] = [];
  try {
    db.exec("PRAGMA trusted_schema=OFF;");
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      Number(db.prepare("PRAGMA user_version").get()?.user_version) !==
        manifest.schemaVersion
    )
      throw new AppError("INVALID_BACKUP", "备份数据库结构或完整性检查失败。");
    if (Number(db.prepare("SELECT COUNT(*) n FROM secrets").get()?.n) !== 0)
      throw new AppError(
        "BACKUP_CONTAINS_SECRETS",
        "此备份包含凭据记录，请使用盘序的导出备份功能重新生成。",
      );
    resources = Number(db.prepare("SELECT COUNT(*) n FROM resources").get()!.n);
    accounts = Number(db.prepare("SELECT COUNT(*) n FROM accounts").get()!.n);
    drafts = Number(db.prepare("SELECT COUNT(*) n FROM drafts").get()!.n);
    required = db
      .prepare(
        "SELECT DISTINCT cover_id FROM resources WHERE cover_id IS NOT NULL",
      )
      .all()
      .map((r) => String(r.cover_id));
    if (manifest.schemaVersion >= 9)
      requiredMedia = db
        .prepare(
          "SELECT DISTINCT json_extract(data,'$.asset')||'.'||json_extract(data,'$.extension') name FROM studio_jobs WHERE json_extract(data,'$.status')='completed' AND json_extract(data,'$.asset') IS NOT NULL",
        )
        .all()
        .map((r) => String(r.name));
    if (manifest.schemaVersion >= 19) {
      for (const row of db.prepare("SELECT json_extract(image.value,'$.file') name,json_extract(image.value,'$.storage') storage FROM zhihu_contents content, json_each(content.data,'$.images') image").all())
        (row.storage === "content-assets" ? requiredContent : requiredZhihu).push(String(row.name));
    }
    if (manifest.schemaVersion >= 20) {
      for (const row of db.prepare("SELECT json_extract(image.value,'$.asset.file') name,json_extract(image.value,'$.asset.storage') storage FROM pipix_sources source, json_each(source.data,'$.images') image WHERE json_extract(image.value,'$.asset.file') IS NOT NULL").all())
        (row.storage === "content-assets" ? requiredContent : requiredZhihu).push(String(row.name));
    }
    if (manifest.schemaVersion >= 21) {
      for (const row of db.prepare("SELECT json_extract(image.value,'$.asset.file') name,json_extract(image.value,'$.asset.storage') storage FROM settings post, json_each(post.value,'$.images') image WHERE post.key LIKE 'weiboPosts:v1:%' AND json_extract(image.value,'$.asset.file') IS NOT NULL").all())
        (row.storage === "zhihu-assets" ? requiredZhihu : requiredContent).push(String(row.name));
    }
  } finally {
    db.close();
  }
  const covers: string[] = [];
  let entries: string[] = [];
  try {
    const info = await lstat(join(folder, "covers"));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AppError("INVALID_BACKUP", "封面目录不正确。");
    entries = await readdir(join(folder, "covers"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entries.length > 10000)
    throw new AppError("INVALID_BACKUP", "一次恢复最多10000张封面。");
  for (const name of entries) {
    if (!coverFilePattern.test(name))
      throw new AppError("INVALID_BACKUP", "备份封面文件名不正确。");
    const path = join(folder, "covers", name);
    await regularFile(path, 16 * 1024 * 1024);
    if ((await fileHash(path)) !== name.slice(0, 64))
      throw new AppError("BACKUP_HASH_MISMATCH", "封面校验失败，未恢复。");
    covers.push(name);
  }
  if (
    required.some(
      (cover) =>
        !/^[a-f0-9]{64}$/.test(cover) ||
        !["webp", "png"].some((extension) =>
          covers.includes(`${cover}.${extension}`),
        ),
    )
  )
    throw new AppError("INVALID_BACKUP", "备份缺少资源引用的封面。");
  let media: string[] = [];
  try {
    const info = await lstat(join(folder, "media"));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AppError("INVALID_BACKUP", "营销素材目录不正确。");
    media = await readdir(join(folder, "media"));
    if (media.length > 20000)
      throw new AppError("INVALID_BACKUP", "一次恢复最多20000份营销素材。");
    for (const name of media) {
      if (!/^[a-f0-9]{64}\.(png|mp4)$/.test(name))
        throw new AppError("INVALID_BACKUP", "营销素材文件名不正确。");
      const path = join(folder, "media", name);
      await regularFile(path, 128 * 1024 * 1024);
      if ((await fileHash(path)) !== name.slice(0, 64))
        throw new AppError(
          "BACKUP_HASH_MISMATCH",
          "营销素材校验失败，未恢复。",
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (requiredMedia.some((name) => !media.includes(name)))
    throw new AppError("INVALID_BACKUP", "备份缺少已完成的营销素材。");
  const zhihuAssets = await inspectImageDirectory(folder, "zhihu-assets"),
    contentAssets = await inspectImageDirectory(folder, "content-assets");
  if (requiredZhihu.some(name => !zhihuAssets.includes(name))) throw new AppError("INVALID_BACKUP", "备份缺少知乎内容引用的配图。");
  if (requiredContent.some(name => !contentAssets.includes(name))) throw new AppError("INVALID_BACKUP", "备份缺少公共内容引用的配图。");
  return {
    createdAt: manifest.createdAt,
    databaseSha256: manifest.databaseSha256,
    resources,
    accounts,
    drafts,
    covers,
    media,
    zhihuAssets,
    contentAssets,
  };
}

export async function stageRestore(
  folder: string,
  dataPath: string,
  expectedHash: string,
) {
  const source = await inspectBackup(folder);
  if (source.databaseSha256 !== expectedHash)
    throw new AppError("BACKUP_CHANGED", "备份在预检后发生变化，请重新预检。");
  const destination = join(dataPath, "restored-workspaces", id("workspace"));
  await mkdir(join(destination, "covers"), { recursive: true, mode: 0o700 });
  try {
    const file = join(destination, "panxu.db");
    await copyFile(join(folder, "panxu.db"), file);
    if ((await fileHash(file)) !== expectedHash)
      throw new AppError(
        "BACKUP_CHANGED",
        "复制期间备份发生变化，未启用恢复副本。",
      );
    for (const cover of source.covers) {
      const target = join(destination, "covers", cover);
      await copyFile(join(folder, "covers", cover), target);
      if ((await fileHash(target)) !== cover.slice(0, 64))
        throw new AppError(
          "BACKUP_CHANGED",
          "复制期间封面发生变化，未启用恢复副本。",
        );
    }
    await mkdir(join(destination, "media"), { mode: 0o700 });
    for (const name of source.media) {
      await copyFile(
        join(folder, "media", name),
        join(destination, "media", name),
      );
      if (
        (await fileHash(join(destination, "media", name))) !== name.slice(0, 64)
      )
        throw new AppError(
          "BACKUP_CHANGED",
          "复制期间营销素材发生变化，请重新预检。",
        );
    }
    await mkdir(join(destination,"zhihu-assets"), {mode:0o700});
    for (const name of source.zhihuAssets) {
      await copyFile(join(folder,"zhihu-assets",name),join(destination,"zhihu-assets",name));
      if (await fileHash(join(destination,"zhihu-assets",name)) !== name.slice(0,64)) throw new AppError("BACKUP_CHANGED", "复制期间知乎配图发生变化。");
    }
    await mkdir(join(destination, "content-assets"), {mode: 0o700});
    for (const name of source.contentAssets) {
      await copyFile(join(folder, "content-assets", name), join(destination, "content-assets", name));
      if (await fileHash(join(destination, "content-assets", name)) !== name.slice(0, 64)) throw new AppError("BACKUP_CHANGED", "复制期间公共配图发生变化。");
    }
    const db = new Database(file);
    try {
      db.transaction(() => {
        // Working text is user content and travels with drafts. Connection
        // settings are still reset; only validated, associated edits survive.
        const workingCopies = db.all<{ key: string; value: string }>(
          "SELECT key,value FROM settings WHERE key LIKE 'studio:working:%'",
        );
        const sourcePosts = db.all<{data:string}>("SELECT data FROM content_source_exports WHERE channel='weibo'").map(row => {
          const delivery = JSON.parse(row.data);
          const parsed = sourceWeiboPostBackup.safeParse(db.setting(`weiboPosts:v1:${delivery.targetId}`, null));
          if (!parsed.success || parsed.data.accountId !== delivery.accountId || parsed.data.source.itemId !== delivery.sourceId)
            throw new AppError("INVALID_BACKUP", "公共素材关联的微博草稿缺失或不完整。");
          return parsed.data;
        });
        db.run("DELETE FROM settings");
        for (const post of sourcePosts) {
          db.setSetting(`weiboPosts:v1:${post.id}`, { ...post, stage:["editing","attention"].includes(post.stage) ? "attention" : "uncertain", message:"从备份恢复，请检查账号和原发布结果，未自动填写或发布。" });
        }
        if (sourcePosts.length) db.setSetting("weiboPosts:index:v1", [...new Set(sourcePosts.map(post=>post.id))]);
        for (const row of workingCopies) {
          let raw: unknown;
          try {
            raw = JSON.parse(row.value);
          } catch {
            raw = null;
          }
          const parsed = studioWorkingCopy.safeParse(raw);
          if (
            !parsed.success ||
            row.key !== `studio:working:${parsed.data.draftId}` ||
            !db.get("SELECT id FROM drafts WHERE id=?", parsed.data.draftId)
          )
            throw new AppError(
              "INVALID_BACKUP",
              "备份中的草稿暂存记录不完整，未启用恢复副本。",
            );
          db.setSetting(row.key, parsed.data);
        }
        db.run("DELETE FROM secrets");
        db.run("UPDATE browser_environment_identities SET revision=revision+1");
        db.run("UPDATE browser_environment_accounts SET verified_revision=0");
        db.run(
          "UPDATE browser_environments SET data=json_remove(json_set(data,'$.revision',json_extract(data,'$.revision')+1),'$.network')",
        );
        for (const row of db.all<{ data: string }>(
          "SELECT data FROM browser_environment_jobs WHERE status IN ('queued','running')",
        )) {
          const job = {
            ...JSON.parse(row.data),
            status: "attention",
            message:
              "从备份恢复，请先核对原平台结果，再手动继续；不会自动重发。",
            updatedAt: now(),
          };
          db.run(
            "UPDATE browser_environment_jobs SET status='attention',data=?,updated_at=? WHERE id=?",
            JSON.stringify(job),
            job.updatedAt,
            job.id,
          );
        }
        db.run("DELETE FROM note_exports");
        db.run("DELETE FROM outbox");
        db.run("DELETE FROM share_checks");
        db.run(
          "UPDATE share_statistics_syncs SET status='failed',error='从备份恢复的历史统计，请重新登录并同步。'",
        );
        db.run(
          "UPDATE accounts SET status='disconnected',verified_at=NULL,error=NULL",
        );
        db.run("UPDATE website_accounts SET status='disconnected'");
        db.run(
          "UPDATE copies SET share_verified_at=NULL,note_status='not_configured',error=NULL",
        );
        db.run(
          "UPDATE split_items SET status=CASE WHEN share_url IS NULL THEN 'draft' ELSE 'needs_review' END,verified_at=NULL,error='从备份恢复，请先登录并复核本人子链接。'",
        );
        db.run(
          "UPDATE split_runs SET status='failed',error='从备份恢复，请重新预览目录。' WHERE status IN ('pending','inspecting')",
        );
        db.run(
          "UPDATE transfer_batch_items SET state='failed',error='从备份恢复，请重新读取分享。' WHERE state IN ('pending','inspecting','ready')",
        );
        db.run("UPDATE drafts SET reviewed=0");
        db.run("UPDATE zhihu_contents SET data=json_set(data,'$.reviewed',json('false'))");
        db.run("UPDATE zhihu_plans SET data=json_remove(json_set(data,'$.active',json('false'),'$.progress',NULL,'$.message','备份恢复后请重新检查身份和等级'),'$.environment','$.uid')");
        db.run("UPDATE zhihu_tasks SET data=json_set(data,'$.status','attention','$.message','从备份恢复，请核对原账号发布结果后处理') WHERE json_extract(data,'$.status') IN ('queued','running','submitting')");
        db.run(
          "UPDATE zhidao_accounts SET data=json_set(data,'$.status','disconnected','$.bulkPermission',NULL,'$.publishingRights',NULL,'$.checkedAt',NULL,'$.message','从备份恢复，请重新登录并检查')",
        );
        db.run(
          "UPDATE operation_runs SET status='paused',message='从备份恢复，请核对账号、费用和远端结果后继续' WHERE status!='completed'",
        );
        db.run(
          "UPDATE operation_items SET data=json_set(data,'$.reviewed',json('false'))",
        );
        db.run(
          "UPDATE browser_bindings SET link_permission='none',verified_at=NULL,last_checked_at=NULL,last_opened_at=NULL,open_error=NULL",
        );
        db.run(
          "UPDATE jobs SET stage='needs_review',error='从备份恢复：请登录原账号并核对远端结果后手动恢复任务。' WHERE stage NOT IN ('completed','cancelled')",
        );
        db.run(
          "UPDATE jobs SET stage='cancelled' WHERE kind IN ('batch_inspect','split_preview') AND stage='needs_review'",
        );
        db.run(
          "UPDATE copies SET status='needs_review' WHERE status!='ready' AND id IN (SELECT copy_id FROM jobs WHERE stage='needs_review' AND kind='transfer')",
        );
        db.setSetting("dailyAiBudgetMicros", 0);
        db.setSetting("restorePreviousDataPath", dataPath);
      });
    } finally {
      db.close();
    }
    return {
      dataPath: destination,
      resources: source.resources,
      accounts: source.accounts,
      drafts: source.drafts,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function inspectImageDirectory(folder: string, name: string) {
  try {
    const directory = join(folder, name), info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError("INVALID_BACKUP", "内容图片目录不正确。");
    const entries = await readdir(directory);
    if (entries.length > 20000) throw new AppError("INVALID_BACKUP", "内容图片数量超过恢复上限。");
    for (const file of entries) {
      if (!/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(file)) throw new AppError("INVALID_BACKUP", "内容图片名称不正确。");
      await regularFile(join(directory, file), 20*1024*1024);
      if (await fileHash(join(directory, file)) !== file.slice(0,64)) throw new AppError("BACKUP_HASH_MISMATCH", "内容图片校验失败。");
    }
    return entries;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
