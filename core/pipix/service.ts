import { id, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { AppPorts } from "../ports";
import {
  pipixExportInput,
  pipixDiscoverInput,
  pipixDiscoveryKeyInput,
  type PipixSource,
  type PipixItem,
  type PipixCapacityReport,
} from "../../shared/pipix";
import {
  sourceMaterialBody,
  type ContentChannel,
  type ContentSourceExport,
  type SourceMaterial,
} from "../../shared/content-sources";
import { readContentImage, saveContentImage } from "../content-assets";
import { PipixClient, pipixShareUrl } from "./client";
import { TikHubPipixDiscovery } from "./discovery";
import type { SecretStore } from "../secrets";
import { PipixKnowledge } from "./knowledge";
import { parsePipixData } from "./parser";

export class PipixSources {
  private active = false;
  private closed = false;
  private exporting = 0;
  private probing = false;
  private abort = new AbortController();
  private archive: PipixKnowledge;
  constructor(
    private d: {
      db: Database;
      dataPath: string;
      ports: AppPorts;
      secrets?: Pick<SecretStore, "has" | "get" | "set">;
      changed(): void;
      destinations: Record<
        ContentChannel,
        (
          material: SourceMaterial,
          accountId: string,
        ) => { id: string; accountLabel?: string }
      >;
    },
    private client = new PipixClient(),
    private discovery = new TikHubPipixDiscovery(),
  ) {
    this.archive = new PipixKnowledge(d.db);
  }
  get isBusy() {
    return this.active || this.probing || this.exporting > 0;
  }
  close() {
    this.closed = true;
    this.abort.abort();
  }
  discoveryConfig() {
    return {
      configured: this.d.secrets?.has("pipix:tikhub") ?? false,
      capacity: this.d.db.setting<PipixCapacityReport | null>(
        "pipix:capacity:v1",
        null,
      ),
    };
  }
  async saveDiscoveryKey(raw: unknown) {
    const { value } = pipixDiscoveryKeyInput.parse(raw);
    if (this.closed || this.active || this.probing)
      throw new AppError("PIPIX_BUSY", "当前操作尚未结束，请稍后再修改配置。");
    if (!this.d.secrets) throw new AppError("PIPIX_CONFIG", "凭据服务不可用。");
    this.active = true;
    try {
      await this.d.secrets.set("pipix:tikhub", value);
      this.d.changed();
      return this.discoveryConfig();
    } finally {
      this.active = false;
    }
  }
  async discover(raw: unknown) {
    if (this.probing)
      throw new AppError("PIPIX_BUSY", "单页容量测试正在进行，请等待完成。");
    return this.discoverPage(raw);
  }
  private async discoverPage(raw: unknown) {
    const input = pipixDiscoverInput.parse(raw);
    if (this.closed || this.active)
      throw new AppError("PIPIX_BUSY", "采集或列表查询正在进行，请稍后重试。");
    this.active = true;
    let responseId: string | undefined;
    try {
      if (!input.force) {
        const cached = this.archive.cached(input);
        if (cached) return this.archive.reuse(cached);
      }
      const key = await this.d.secrets?.get("pipix:tikhub");
      if (!key)
        throw new AppError(
          "PIPIX_CONFIG",
          "请先配置 TikHub API Key，再获取数据列表。",
        );
      if (this.closed)
        throw new AppError("PIPIX_CLOSED", "当前工作空间已关闭。");
      responseId = this.archive.begin(input);
      await this.discovery.discover(
        input,
        key,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(45000)]),
        (body, status) => {
          if (this.closed)
            throw new AppError("PIPIX_CLOSED", "当前工作空间已关闭。");
          this.archive.receive(responseId!, body, status, key);
        },
      );
      if (this.closed)
        throw new AppError("PIPIX_CLOSED", "当前工作空间已关闭。");
      const result = this.archive.index(responseId);
      this.d.changed();
      return { ...result, cached: false };
    } catch (e) {
      if (responseId && !this.closed) {
        this.archive.fail(responseId, e);
        this.d.changed();
        throw new AppError(
          "PIPIX_ARCHIVED",
          `${safeMessage(e)} 请求记录已保存，可先重建本地索引；不会自动重复请求。`,
        );
      }
      throw e;
    } finally {
      this.active = false;
    }
  }
  async probeCapacity(keyword: string) {
    if (this.closed || this.isBusy)
      throw new AppError("PIPIX_BUSY", "请等待当前采集操作完成。");
    const input = pipixDiscoverInput.parse({ mode: "search", keyword });
    this.probing = true;
    const baseline = this.archive.cached(input);
    const report: PipixCapacityReport = {
      keyword: input.keyword,
      checkedAt: new Date().toISOString(),
      maxObserved: baseline?.parsed
        ? JSON.parse(baseline.parsed).items.length
        : 0,
      results: [],
    };
    try {
      const probes = [
        { parameter: "count", value: 20 },
        { parameter: "count", value: 1000 },
        { parameter: "page_size", value: 1000 },
      ] as const;
      for (const probe of probes) {
        if (this.closed) break;
        try {
          const result = await this.discoverPage({ ...input, probe });
          report.maxObserved = Math.max(
            report.maxObserved,
            result.items.length,
          );
          report.results.push({
            parameter: probe.parameter,
            requested: probe.value,
            returned: result.items.length,
            reflected: this.archive.reflected(
              result.responseId!,
              probe.parameter,
              probe.value,
            ),
            cached: !!result.cached,
          });
        } catch (e) {
          report.results.push({
            parameter: probe.parameter,
            requested: probe.value,
            returned: null,
            reflected: false,
            cached: false,
            error: safeMessage(e),
          });
        }
      }
      if (!this.closed) {
        this.d.db.setSetting("pipix:capacity:v1", report);
        this.d.changed();
      }
      return report;
    } finally {
      this.probing = false;
    }
  }
  knowledge(raw: unknown) {
    return this.archive.read(raw);
  }
  reindex() {
    if (this.closed || this.active || this.probing)
      throw new AppError("PIPIX_BUSY", "请等待当前操作完成后重建本地索引。");
    const result = this.archive.reindex();
    this.d.changed();
    return result;
  }
  list(): PipixSource[] {
    return this.d.db
      .all<{ data: string }>(
        "SELECT data FROM pipix_sources ORDER BY rowid DESC",
      )
      .map((r) => {
        const item: PipixItem = JSON.parse(r.data);
        return { ...item, exports: this.exports(item.id) };
      });
  }
  private get(id: string): PipixItem {
    const row = this.d.db.get<{ data: string }>(
      "SELECT data FROM pipix_sources WHERE id=?",
      id,
    );
    if (!row) throw new AppError("NOT_FOUND", "采集记录不存在，请刷新重试。");
    return JSON.parse(row.data);
  }
  private exports(sourceId: string): ContentSourceExport[] {
    return this.d.db
      .all<{ data: string }>(
        "SELECT data FROM content_source_exports WHERE provider='pipix' AND source_id=? ORDER BY rowid DESC",
        sourceId,
      )
      .map((r) => JSON.parse(r.data));
  }
  private save(source: PipixItem) {
    this.d.db.run(
      "INSERT INTO pipix_sources(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      source.id,
      JSON.stringify(source),
    );
  }
  async collect(text: string) {
    if (this.closed || this.active || this.probing)
      throw new AppError("PIPIX_BUSY", "采集正在进行，请等待当前采集完成。");
    this.active = true;
    try {
      const signal = () =>
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(25000)]);
      const sourceId = pipixShareUrl(text).pathname.match(/\/item\/(\d+)/)?.[1];
      const cached = sourceId ? this.archive.source(sourceId) : null;
      const previous = sourceId
        ? this.d.db.get<{ data: string }>(
            "SELECT data FROM pipix_sources WHERE id=?",
            sourceId,
          )
        : null;
      const cacheFailed =
        previous &&
        JSON.parse(previous.data).images.some(
          (image: { error?: string }) => image.error,
        );
      const local =
        cached && !cacheFailed && Array.isArray(cached.note?.multi_image)
          ? parsePipixData({ ppxItemDetail: { item: cached } }, sourceId, true)
          : null;
      const source =
        local &&
        local.images.every((image) => image.url) &&
        !(local.commentCount && !local.comments.length)
          ? local
          : await this.client.collect(text, signal());
      for (const image of source.images) {
        try {
          const raw = await this.client.image(image.url, signal());
          const bytes = await this.d.ports.normalizeCover(raw);
          image.asset = await saveContentImage(
            this.d.dataPath,
            bytes,
            `皮皮虾-${source.id}-${image.id}.png`,
          );
        } catch (e) {
          if (this.closed) throw e;
          image.error = safeMessage(e);
        }
      }
      if (this.closed) throw new AppError("PIPIX_CLOSED", "采集已停止。");
      if (source.images.some((v) => !v.asset))
        source.warnings.push(
          "部分图片读取失败；可重新采集，或取消选择失败图片后导入。",
        );
      this.save(source);
      this.d.changed();
      return { ...source, exports: this.exports(source.id) };
    } finally {
      this.active = false;
    }
  }
  async image(sourceId: string, imageId: string) {
    const image = this.get(sourceId).images.find(
      (v) => v.id === imageId,
    )?.asset;
    if (!image)
      throw new AppError("PIPIX_IMAGE", "此图片尚未成功采集，请重新采集原帖。");
    const bytes = await readContentImage(this.d.dataPath, image);
    return `data:image/${image.file.endsWith(".png") ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
  }
  async export(raw: unknown) {
    if (this.closed) throw new AppError("PIPIX_CLOSED", "当前工作空间已关闭。");
    this.exporting++;
    try {
      const input = pipixExportInput.parse(raw),
        source = this.get(input.id);
      const accountId =
        input.channel === "weibo" ? (input.accountId ?? "") : "";
      const existing = () =>
        this.exports(source.id).find(
          (v) => v.channel === input.channel && v.accountId === accountId,
        );
      const previous = existing();
      if (previous) return { delivery: previous, existing: true };
      const imageIds = [...new Set(input.imageIds)],
        commentIds = [...new Set(input.commentIds)];
      const images = imageIds.map((imageId) => {
        const image = source.images.find((v) => v.id === imageId);
        if (!image?.asset)
          throw new AppError(
            "PIPIX_IMAGE",
            "选中的图片尚未采集成功，请重新采集或取消选择。",
          );
        return image.asset;
      });
      const comments = commentIds.map((commentId) => {
        const comment = source.comments.find((v) => v.id === commentId);
        if (!comment)
          throw new AppError(
            "PIPIX_COMMENT",
            "选中的评论已变化，请刷新后重新选择。",
          );
        return comment;
      });
      if (!source.text && !comments.length && !images.length)
        throw new AppError(
          "PIPIX_EMPTY",
          "当前选择没有可导入的文案、图片或评论。",
        );
      const body = sourceMaterialBody(source.text, source.author, comments);
      const material: SourceMaterial = {
        title: input.title,
        body,
        images,
        source: {
          provider: "pipix",
          itemId: source.id,
          url: source.url,
          author: source.author,
          collectedAt: source.collectedAt,
          comments: comments.map(({ id, author }) => ({ id, author })),
        },
      };
      // Verify immutable local assets before committing a draft. No partial draft on failure.
      for (const image of images)
        await readContentImage(this.d.dataPath, image);
      if (this.closed)
        throw new AppError("PIPIX_CLOSED", "当前工作空间已关闭。");
      return this.d.db.transaction(() => {
        const current = this.get(source.id),
          previous = existing();
        if (previous) return { delivery: previous, existing: true };
        if (JSON.stringify(current) !== JSON.stringify(source))
          throw new AppError(
            "PIPIX_CHANGED",
            "原帖已重新采集，请刷新后再导出。",
          );
        const target = this.d.destinations[input.channel](material, accountId);
        const delivery: ContentSourceExport = {
          id: id("sourceexport"),
          provider: "pipix",
          sourceId: source.id,
          channel: input.channel,
          accountId,
          accountLabel: target.accountLabel,
          targetId: target.id,
          title: input.title,
          createdAt: new Date().toISOString(),
        };
        this.d.db.run(
          "INSERT INTO content_source_exports(id,provider,source_id,channel,account_id,data) VALUES(?,?,?,?,?,?)",
          delivery.id,
          delivery.provider,
          delivery.sourceId,
          delivery.channel,
          accountId,
          JSON.stringify(delivery),
        );
        this.d.changed();
        return { delivery, existing: false };
      });
    } finally {
      this.exporting--;
    }
  }
}
