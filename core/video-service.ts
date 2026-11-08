import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Database, id, now } from "./database";
import { AppError, safeMessage } from "./errors";
import {
  renderLocalVideo,
  getLocalVideoRuntime,
  type RenderLocalVideoOptions,
} from "./video-renderer";
import {
  videoProjectSchema,
  type VideoProject,
  type VideoProjectInput,
} from "../shared/video";
import type { VideoJob } from "../shared/video-jobs";

const prefix = "local-video:job:";
const sourceIdSchema = z.string().trim().min(1).max(160);
const assetPattern = /^[a-f0-9]{64}\.(mp4|png)$/;
interface StoredJob extends VideoJob {
  videoAsset?: string;
  coverAsset?: string;
}
export interface VideoServiceOptions {
  bundlePath?: string;
  templateEntryPoint?: string;
  browserExecutable?: string;
  render?: typeof renderLocalVideo;
  runtime?: typeof getLocalVideoRuntime;
}

/** Shared local production queue. Business modules only supply content and a source ID. */
export class VideoService {
  private queue: { id: string; project: VideoProject }[] = [];
  private current: { id: string; controller: AbortController } | null = null;
  private disposed = false;
  private pendingChecks = 0;
  private idleWaiters: (() => void)[] = [];
  constructor(
    private db: Database,
    private dataPath: string,
    private changed: () => void,
    private options: VideoServiceOptions = {},
  ) {
    for (const job of this.storedJobs()) {
      if (job.status === "queued" || job.status === "rendering")
        this.store({
          ...job,
          status: "failed",
          error: "上次视频制作被中断，素材草稿已保留，请重新制作。",
          updatedAt: now(),
        });
    }
  }
  get isBusy() {
    return this.pendingChecks > 0 || !!this.current || this.queue.length > 0;
  }
  private resolveIdle() {
    if (!this.isBusy)
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
  runtime() {
    return (this.options.runtime ?? getLocalVideoRuntime)(this.options);
  }
  private storedJobs(): StoredJob[] {
    return this.db
      .all<{ value: string }>(
        "SELECT value FROM settings WHERE key LIKE ? ORDER BY key",
        `${prefix}%`,
      )
      .map((row) => JSON.parse(row.value) as StoredJob);
  }
  private store(job: StoredJob) {
    this.db.setSetting(`${prefix}${job.id}`, job);
  }
  private get(jobId: string) {
    z.string()
      .regex(/^video_[a-f0-9-]+$/)
      .parse(jobId);
    const job = this.db.setting<StoredJob | null>(`${prefix}${jobId}`, null);
    if (!job) throw new AppError("VIDEO_NOT_FOUND", "视频任务不存在。");
    return job;
  }
  private view(job: StoredJob): VideoJob {
    const { videoAsset, coverAsset, ...rest } = job;
    return {
      ...rest,
      ...(job.status === "completed" && videoAsset && coverAsset
        ? {
            videoUrl: `panxu-media://local-video/${videoAsset}`,
            coverUrl: `panxu-media://local-video/${coverAsset}`,
          }
        : {}),
    };
  }
  jobs(sourceId: string) {
    sourceIdSchema.parse(sourceId);
    return this.storedJobs()
      .filter((job) => job.sourceId === sourceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((job) => this.view(job));
  }
  async create(sourceId: string, input: VideoProjectInput) {
    if (this.disposed)
      throw new AppError("VIDEO_CLOSED", "视频制作服务已关闭。");
    sourceIdSchema.parse(sourceId);
    const project = videoProjectSchema.parse(input);
    if (
      this.storedJobs().some(
        (job) =>
          job.sourceId === sourceId &&
          ["queued", "rendering"].includes(job.status),
      )
    )
      throw new AppError(
        "VIDEO_ALREADY_RUNNING",
        "这份内容正在制作视频，请等待完成或先取消任务。",
      );
    this.pendingChecks++;
    let runtime: Awaited<ReturnType<VideoService["runtime"]>>;
    try {
      runtime = await this.runtime();
    } finally {
      this.pendingChecks--;
      this.resolveIdle();
    }
    if (this.disposed)
      throw new AppError("VIDEO_CLOSED", "视频制作服务已关闭。");
    if (!runtime.available)
      throw new AppError("VIDEO_RUNTIME_UNAVAILABLE", runtime.message);
    // The readiness read yields; another window may have submitted meanwhile.
    if (
      this.storedJobs().some(
        (job) =>
          job.sourceId === sourceId &&
          ["queued", "rendering"].includes(job.status),
      )
    )
      throw new AppError(
        "VIDEO_ALREADY_RUNNING",
        "这份内容正在制作视频，请等待完成或先取消任务。",
      );
    const { slides, audio, ...summary } = project;
    const time = now();
    const job: StoredJob = {
      id: id("video"),
      sourceId,
      project: { ...summary, slideCount: slides.length, hasAudio: !!audio },
      status: "queued",
      progress: 0,
      createdAt: time,
      updatedAt: time,
    };
    this.store(job);
    this.queue.push({ id: job.id, project });
    this.changed();
    void this.drain();
    return this.view(job);
  }
  cancel(jobId: string) {
    const job = this.get(jobId);
    if (!["queued", "rendering"].includes(job.status)) return this.view(job);
    this.queue = this.queue.filter((pending) => pending.id !== jobId);
    const cancelled: StoredJob = {
      ...job,
      status: "cancelled",
      error: undefined,
      updatedAt: now(),
    };
    this.store(cancelled);
    if (this.current?.id === jobId) this.current.controller.abort();
    this.changed();
    return this.view(cancelled);
  }
  private async saveAsset(path: string, extension: "mp4" | "png") {
    const bytes = await readFile(path);
    const asset = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
    await mkdir(join(this.dataPath, "media"), { recursive: true, mode: 0o700 });
    const destination = join(this.dataPath, "media", asset);
    try {
      await copyFile(path, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(destination);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        createHash("sha256")
          .update(await readFile(destination))
          .digest("hex") !== asset.slice(0, 64)
      )
        throw new AppError(
          "VIDEO_ASSET_INVALID",
          "已归档的同名素材不正确，请检查工作空间后重试。",
        );
    }
    return asset;
  }
  private async drain() {
    if (this.disposed || this.current || !this.queue.length) return;
    const pending = this.queue.shift()!;
    const controller = new AbortController();
    this.current = { id: pending.id, controller };
    const directory = join(this.dataPath, "video-work", pending.id);
    const update = (patch: Partial<StoredJob>) => {
      if (this.disposed) return;
      const job = this.get(pending.id);
      if (job.status === "cancelled") return;
      this.store({ ...job, ...patch, updatedAt: now() });
    };
    try {
      update({ status: "rendering", stage: "preparing" });
      this.changed();
      const result = await (this.options.render ?? renderLocalVideo)({
        project: pending.project,
        outputDirectory: directory,
        bundlePath: this.options.bundlePath,
        templateEntryPoint: this.options.templateEntryPoint,
        browserExecutable: this.options.browserExecutable,
        signal: controller.signal,
        onProgress: (progress) => update(progress),
      } satisfies RenderLocalVideoOptions);
      if (controller.signal.aborted) return;
      const videoAsset = await this.saveAsset(result.videoPath, "mp4");
      const coverAsset = await this.saveAsset(result.coverPath, "png");
      if (!controller.signal.aborted)
        update({
          status: "completed",
          stage: "completed",
          progress: 1,
          videoAsset,
          coverAsset,
        });
    } catch (error) {
      if (!controller.signal.aborted)
        update({ status: "failed", error: safeMessage(error) });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      this.current = null;
      this.resolveIdle();
      if (!this.disposed) {
        this.changed();
        void this.drain();
      }
    }
  }
  close() {
    if (this.disposed) return;
    for (const job of this.storedJobs()) {
      if (["queued", "rendering"].includes(job.status))
        this.store({
          ...job,
          status: "failed",
          error: "视频制作被关闭中断，请重新制作。",
          updatedAt: now(),
        });
    }
    this.disposed = true;
    this.queue = [];
    this.current?.controller.abort();
  }
  /** Desktop shutdown waits until our Chrome/encoder and temporary files are released. */
  async shutdown() {
    this.close();
    if (this.isBusy)
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
  async assetPath(name: string) {
    if (
      !assetPattern.test(name) ||
      !this.storedJobs().some(
        (job) =>
          job.status === "completed" &&
          [job.videoAsset, job.coverAsset].includes(name),
      )
    )
      throw new AppError("VIDEO_ASSET_NOT_FOUND", "视频素材不存在或尚未完成。");
    const path = join(this.dataPath, "media", name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink())
      throw new AppError(
        "VIDEO_ASSET_NOT_FOUND",
        "视频素材已丢失，请重新制作或从备份恢复。",
      );
    return path;
  }
  async output(jobId: string, kind: "video" | "cover") {
    const job = this.get(jobId);
    const asset = kind === "video" ? job.videoAsset : job.coverAsset;
    if (job.status !== "completed" || !asset)
      throw new AppError("VIDEO_NOT_READY", "视频尚未完成，暂时无法导出。");
    return { title: job.project.title, path: await this.assetPath(asset) };
  }
}
