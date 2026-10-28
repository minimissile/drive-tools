import {
  channelInstruction,
  defaultContentFormat,
  supportsContentFormat,
} from "../shared/channels";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { Repository } from "./repository";
import { SecretStore } from "./secrets";
import { AiService } from "./ai";
import { id, now } from "./database";
import { AppError, safeMessage, ServiceHttpError } from "./errors";
import { readLimited } from "./http";
import { budgetDayStart } from "./traffic";
import { localTemplate } from "./templates";
import { platformSpecs } from "../shared/platforms";
import { builtinCreativeTemplates } from "../shared/studio-options";
import {
  creativePackage,
  creativeTemplateInput,
  studioCreateInput,
  mediaSubmitInput,
  studioWorkingCopy,
  editorValueForDraft,
  type CreativePackage,
  type CreativeTemplate,
  type StudioJob,
  type MediaModel,
} from "../shared/studio";
import type { Draft, Platform } from "../shared/types";
import { redactPromptText } from "./text-safety";
import { readResourceCover } from "./cover-assets";
import { loadMediaModelCatalog } from "./media-model-catalog";

const base = "https://openrouter.ai/api/v1";
const clean = redactPromptText;
const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex");
export const studioAssetPattern = /^[a-f0-9]{64}\.(png|mp4)$/;
const cost = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000)
    : null;
async function mediaJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(120_000),
    redirect: "error",
  });
  const text = await readLimited(response, 64 * 1024 * 1024);
  let data: Record<string, any>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError(
      "MEDIA_RESPONSE_INVALID",
      `素材接口未返回JSON（HTTP ${response.status}），请核对服务商任务记录。`,
    );
  }
  if (!response.ok)
    throw new ServiceHttpError(
      response.status,
      `素材接口请求失败（HTTP ${response.status}）：${String(data.error?.message ?? data.error ?? "").slice(0, 200)}`,
      [400, 401, 402, 403, 404, 422, 429].includes(response.status)
        ? "MEDIA_REJECTED"
        : "MEDIA_UNCERTAIN",
    );
  return data;
}
export class StudioService {
  private active = new Map<string, Promise<StudioJob>>();
  constructor(
    private repo: Repository,
    private secrets: SecretStore,
    private ai: AiService,
    private dataPath: string,
    private normalize: (bytes: Buffer) => Promise<Buffer>,
    private changed: () => void,
    private request = mediaJson,
    private fetchBinary: typeof fetch = (...args) => fetch(...args),
  ) {}
  get isBusy() {
    return this.active.size > 0;
  }
  workingCopy(draftId: string) {
    this.repo.draft(draftId);
    const row = this.repo.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key=?",
      `studio:working:${draftId}`,
    );
    if (!row) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      raw = null;
    }
    const parsed = studioWorkingCopy.safeParse(raw);
    if (!parsed.success || parsed.data.draftId !== draftId)
      throw new AppError(
        "WORKING_COPY_INVALID",
        "这份草稿的暂存记录无法读取，请保留工作空间备份后排查。",
      );
    return parsed.data;
  }
  saveWorkingCopy(raw: unknown) {
    const input = studioWorkingCopy.parse(raw);
    const draft = this.repo.draft(input.draftId);
    if (input.value.creative?.format !== draft.creative?.format)
      throw new AppError("WORKING_COPY_MISMATCH", "暂存内容形式与草稿不一致。");
    const previous = this.workingCopy(input.draftId);
    if (previous && previous.editedAt > input.editedAt) return previous;
    this.repo.db.setSetting(`studio:working:${input.draftId}`, input);
    // No snapshot broadcast on each keystroke: editing must not refresh the form.
    return input;
  }
  clearWorkingCopy(draftId: string) {
    this.repo.draft(draftId);
    this.repo.db.run(
      "DELETE FROM settings WHERE key=?",
      `studio:working:${draftId}`,
    );
    return true;
  }
  assertWorkingCopySaved(draftId: string) {
    const working = this.workingCopy(draftId);
    if (
      working &&
      JSON.stringify(working.value) !==
        JSON.stringify(editorValueForDraft(this.repo.draft(draftId)))
    )
      throw new AppError(
        "UNSAVED_DRAFT",
        "这份草稿还有未保存的编辑，请回到内容工作室保存修改，或恢复已保存版本后再审阅、交付。",
      );
  }
  templates(): CreativeTemplate[] {
    return [
      ...builtinCreativeTemplates,
      ...this.repo.db
        .all<{ data: string }>("SELECT data FROM studio_templates ORDER BY id")
        .map((r) => JSON.parse(r.data) as CreativeTemplate),
    ];
  }
  saveTemplate(raw: unknown) {
    const input = creativeTemplateInput.parse(raw);
    if (
      input.id &&
      !this.repo.db.get("SELECT id FROM studio_templates WHERE id=?", input.id)
    )
      throw new AppError(
        "TEMPLATE_NOT_FOUND",
        "只能修改自己保存的模板，请另存为新模板。",
      );
    const template = {
      ...input,
      id: input.id || id("template"),
      builtin: false,
    };
    this.repo.db.run(
      "INSERT INTO studio_templates(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      template.id,
      JSON.stringify(template),
    );
    this.changed();
    return template;
  }
  deleteTemplate(templateId: string) {
    this.repo.db.run("DELETE FROM studio_templates WHERE id=?", templateId);
    this.changed();
    return true;
  }
  async models(): Promise<MediaModel[]> {
    const models = await loadMediaModelCatalog(
      this.request,
      this.repo.db.setting<MediaModel[]>("studio:modelCatalog", []),
      this.repo.db.setting<Record<string, string>>("ai:modelIssues", {}),
    );
    this.repo.db.setSetting("studio:modelCatalog", models);
    return models;
  }
  async create(raw: unknown): Promise<Draft> {
    const input = studioCreateInput.parse(raw),
      platform = platformSpecs.find((p) => p.id === input.platform);
    if (!platform) throw new AppError("UNKNOWN_PLATFORM", "内容平台不存在。");
    const contentFormat =
      input.contentFormat ?? defaultContentFormat(platform.id);
    if (!supportsContentFormat(platform.id, contentFormat))
      throw new AppError(
        "CHANNEL_FORMAT_UNSUPPORTED",
        "此平台不支持所选内容形式。",
      );
    const template = this.templates().find((t) => t.id === input.templateId);
    if (!template)
      throw new AppError("TEMPLATE_NOT_FOUND", "模板已不存在，请重新选择。");
    const copy = this.repo.getCopy(input.copyId),
      resource = this.repo.getResource(copy.resourceId),
      source = input.sourceDraftId
        ? this.repo.draft(input.sourceDraftId)
        : null;
    if (
      source &&
      (source.copyId !== copy.id || source.platform !== platform.id)
    )
      throw new AppError("DRAFT_MISMATCH", "原草稿与当前资源或平台不一致。");
    const pool = input.poolId
      ? this.repo.pools().find((p) => p.id === input.poolId)
      : null;
    if (
      input.poolId &&
      (!pool || (pool.resourceId && pool.resourceId !== resource.id))
    )
      throw new AppError("POOL_MISMATCH", "词池不属于当前资源。");
    const pageCount =
      input.format === "image"
        ? 1
        : input.format === "carousel"
          ? input.pageCount
          : 0;
    const local = localTemplate(
      resource,
      platform.id as Platform,
      contentFormat,
    );
    local.body = `创作模板：${template.name}\n结构要求：${clean(template.instruction)}\n\n${local.body}`;
    let result = {
      ...local,
      cards: Array.from({ length: pageCount }, (_, i) => ({
        heading: i === 0 ? clean(resource.title) : `要点 ${i + 1}`,
        copy: clean(resource.summary).slice(0, 600),
        imagePrompt: `${template.style}。围绕${clean(resource.title)}创作主题插图。${clean(resource.summary).slice(0, 800)}。这是概念画面，不能伪造资料内页或使用证明。`,
      })),
      videoPrompt:
        input.format === "video"
          ? `${template.style}。围绕${clean(resource.title)}设计动态概念画面，明确主体动作、场景变化与镜头推进。${clean(resource.summary).slice(0, 800)}`
          : "",
      voiceover: "",
    };
    if (input.mode === "ai") {
      const context = source?.topicId
        ? this.repo.db.get<{ keyword: string; evidence: string }>(
            "SELECT keyword,evidence FROM search_topics WHERE id=?",
            source.topicId,
          )
        : null;
      result = await this.ai.creativeDraft({
        format: input.format,
        contentFormat,
        pageCount,
        aspectRatio: input.aspectRatio,
        brief: clean(input.brief),
        template: {
          name: template.name,
          style: clean(template.style),
          instruction: clean(template.instruction),
        },
        platform: {
          id: platform.id,
          name: platform.name,
          rule: platform.rule,
          instruction: channelInstruction(platform.id, contentFormat),
        },
        resource: {
          title: clean(resource.title),
          summary: clean(resource.summary),
          category: clean(resource.category),
          tags: resource.tags.map(clean),
          filenames: copy.files.slice(0, 60).map((f) => clean(f.name)),
        },
        keywords: pool?.keywords.slice(0, 30).map((k) => clean(k.word)) ?? [],
        priorContent: source ? clean(source.body).slice(0, 5000) : "",
        searchTopic: context
          ? {
              keyword: clean(context.keyword),
              evidence: clean(context.evidence),
            }
          : null,
      });
      // Some models put the requested prose in card.copy even in text mode.
      // Keep that text before discarding unrequested image plans.
      if (input.format === "text") {
        const parts = [result.body];
        for (const card of result.cards) {
          const copy = card.copy.trim(),
            heading = card.heading.trim(),
            existing = parts.join("\n\n");
          if (copy && !existing.includes(copy))
            parts.push(
              `${heading && !existing.includes(heading) ? `${heading}\n` : ""}${copy}`,
            );
        }
        result.body = parts.join("\n\n");
        if (result.body.length > 30000)
          throw new AppError(
            "CREATIVE_PLAN_INVALID",
            "模型文字与分段合并后超过30000字，未保存；费用已记录，请缩短创作要求。",
          );
      }
      result.body = result.body.replace(/<br\s*\/?>/gi, "\n");
      // Extra media fields must not imply unrequested image/video generation.
      if (input.format === "text" || input.format === "video")
        result.cards = [];
      if (input.format !== "video") {
        result.videoPrompt = "";
        result.voiceover = "";
      }
      if (
        result.cards.length !== pageCount ||
        (input.format === "video" && !result.videoPrompt.trim())
      )
        throw new AppError(
          "CREATIVE_PLAN_INVALID",
          input.format === "video"
            ? "模型缺少视频动态画面要求，未保存；费用已记录。"
            : `模型应返回${pageCount}页图片方案，实际返回${result.cards.length}页，未保存；费用已记录。`,
        );
    } else if (input.mode === "blank") {
      result = {
        ...result,
        title: clean(resource.title),
        body: "",
        tags: [],
        coverText: "",
      };
    }
    const draftId = id("draft"),
      time = now(),
      creative: CreativePackage = {
        format: input.format,
        templateId: template.id,
        brief: input.brief,
        aspectRatio: input.aspectRatio,
        cards: result.cards,
        videoPrompt: result.videoPrompt,
        voiceover: result.voiceover,
      };
    this.repo.db.transaction(() => {
      this.repo.db.run(
        "INSERT INTO drafts(id,resource_id,copy_id,platform,pool_id,title,body,tags,cover_text,resource_revision,share_version,model,created_at,updated_at,topic_id,split_item_id,split_share_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        draftId,
        resource.id,
        copy.id,
        platform.id,
        input.poolId,
        result.title,
        result.body,
        JSON.stringify(result.tags),
        result.coverText,
        resource.revision,
        copy.shareVersion,
        input.mode === "ai"
          ? this.ai.modelFor("copy")
          : input.mode === "template"
            ? "local-template"
            : "manual",
        time,
        time,
        source?.topicId ?? null,
        source?.splitItemId ?? null,
        source?.splitShareVersion ?? null,
      );
      this.repo.db.run(
        "UPDATE drafts SET content_format=? WHERE id=?",
        contentFormat,
        draftId,
      );
      this.repo.db.run(
        "INSERT INTO studio_packages VALUES(?,?)",
        draftId,
        JSON.stringify(creative),
      );
    });
    this.changed();
    return this.repo.draft(draftId);
  }
  jobs(draftId: string): StudioJob[] {
    this.repo.draft(draftId);
    return this.repo.db
      .all<{ data: string }>(
        "SELECT data FROM studio_jobs WHERE draft_id=? ORDER BY created_at,id",
        draftId,
      )
      .map((r) => {
        const job = JSON.parse(r.data) as StudioJob;
        if (
          job.status === "submitting" &&
          !this.active.has(`${draftId}:${job.kind}:${job.slot}`)
        ) {
          job.status = "uncertain";
          job.error =
            "应用曾在提交过程中退出，远端结果待核；不能自动重复生成。";
          this.repo.db.run(
            "UPDATE api_calls SET status='uncertain',message=? WHERE id=? AND status='reserved'",
            job.error,
            job.callId,
          );
          this.save(job);
        }
        return job;
      });
  }
  private job(jobId: string): StudioJob {
    const row = this.repo.db.get<{ data: string }>(
      "SELECT data FROM studio_jobs WHERE id=?",
      jobId,
    );
    if (!row) throw new AppError("MEDIA_JOB_NOT_FOUND", "素材任务不存在。");
    return JSON.parse(row.data);
  }
  private save(job: StudioJob) {
    job.updatedAt = now();
    this.repo.db.run(
      "INSERT INTO studio_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      job.id,
      job.draftId,
      JSON.stringify(job),
      job.createdAt,
    );
    this.changed();
    return job;
  }
  private invalidate(draftId: string) {
    this.repo.db.run(
      "UPDATE drafts SET reviewed=0,updated_at=? WHERE id=?",
      now(),
      draftId,
    );
  }
  prompt(creative: CreativePackage, kind: "image" | "video", slot: number) {
    if (
      kind === "video"
        ? creative.format !== "video" || slot !== 0
        : !["image", "carousel"].includes(creative.format) ||
          !creative.cards[slot]
    )
      throw new AppError(
        "MEDIA_SLOT_INVALID",
        "此内容形式没有对应的素材位置。",
      );
    const card = creative.cards[slot];
    const prompt =
      kind === "video"
        ? creative.videoPrompt
        : `画面要求：${card.imagePrompt}\n标题文字：${card.heading}\n页面文字：${card.copy}`;
    if (!prompt.trim())
      throw new AppError("MEDIA_PROMPT_REQUIRED", "请先填写并保存画面要求。");
    return (
      clean(prompt) +
      "\n基于已提供的资源信息制作营销概念素材。不要伪造亲测结果、资源内页、用户评价、认证或效果证明。不得出现网盘链接、提取码、二维码、联系方式或领取口令。"
    );
  }
  submit(raw: unknown): Promise<StudioJob> {
    const input = mediaSubmitInput.parse(raw),
      lock = `${input.draftId}:${input.kind}:${input.slot}`;
    const pending = this.active.get(lock);
    if (pending) return pending;
    const task = this.performSubmit(input);
    this.active.set(lock, task);
    void task.finally(() => this.active.delete(lock)).catch(() => {});
    return task;
  }
  private async performSubmit(
    input: ReturnType<typeof mediaSubmitInput.parse>,
  ) {
    const draft = this.repo.draft(input.draftId),
      creative = draft.creative;
    if (!creative)
      throw new AppError("CREATIVE_REQUIRED", "请先创建含画面方案的内容版本。");
    const prompt = this.prompt(creative, input.kind, input.slot),
      model = this.repo.db
        .setting<MediaModel[]>("studio:modelCatalog", [])
        .find(
          (m) =>
            m.id === (input.model || this.ai.modelFor(input.kind)) &&
            m.kind === input.kind,
        );
    if (!model)
      throw new AppError(
        "MEDIA_MODEL_REQUIRED",
        "请刷新素材模型列表并选择对应的模型。",
      );
    if (
      (model.ratios.length && !model.ratios.includes(creative.aspectRatio)) ||
      (input.kind === "video" &&
        ((model.durations.length &&
          !model.durations.includes(input.duration)) ||
          (model.resolutions.length &&
            !model.resolutions.includes(input.resolution)) ||
          (input.audio && !model.audio))) ||
      (input.referenceCover && !model.reference)
    )
      throw new AppError(
        "MEDIA_CAPABILITY_MISMATCH",
        "所选模型不支持当前比例、时长、分辨率、音频或参考封面，请调整后再提交。",
      );
    const existing = this.jobs(draft.id).findLast(
      (j) =>
        j.kind === input.kind &&
        j.slot === input.slot &&
        j.prompt === prompt &&
        j.aspectRatio === creative.aspectRatio,
    );
    if (
      existing &&
      (!input.regenerate ||
        ["pending", "in_progress", "submitting"].includes(existing.status))
    )
      return existing;
    const key = await this.secrets.get("openrouter");
    if (!key)
      throw new AppError("API_KEY_REQUIRED", "请先配置OpenRouter Key。");
    let referenceData: string | null = null;
    if (input.referenceCover) {
      const resource = this.repo.getResource(draft.resourceId);
      if (!resource.coverId)
        throw new AppError(
          "MEDIA_REFERENCE_REQUIRED",
          "当前资源没有参考封面。",
        );
      if (!/^[a-f0-9]{64}$/.test(resource.coverId))
        throw new AppError(
          "MEDIA_REFERENCE_REQUIRED",
          "参考封面记录不正确，请重新上传资源封面。",
        );
      const cover = await readResourceCover(this.dataPath, resource.coverId);
      referenceData = `data:${cover.mime};base64,${cover.bytes.toString("base64")}`;
    }
    const job: StudioJob = {
      id: id("media"),
      draftId: draft.id,
      kind: input.kind,
      slot: input.slot,
      model: model.id,
      prompt,
      status: "submitting",
      remoteId: null,
      asset: null,
      extension: null,
      callId: id("ai"),
      keyFingerprint: fingerprint(key),
      error: null,
      createdAt: now(),
      updatedAt: now(),
      checkedAt: null,
      costMicros: null,
      reservedMicros: input.reserveMicros,
      aspectRatio: creative.aspectRatio,
      duration: input.kind === "video" ? input.duration : 0,
      resolution: input.kind === "video" ? input.resolution : "",
      audio: input.audio,
    };
    this.repo.db.transaction(() => {
      const used = this.repo.db.get<{ n: number }>(
          "SELECT coalesce(sum(coalesce(reserved_micros,estimated_micros,0)),0) n FROM api_calls WHERE endpoint='openrouter' AND created_at>=? AND status IN ('reserved','success','uncertain')",
          budgetDayStart(),
        )!.n,
        budget = this.repo.db.setting<number | null>(
          "dailyAiBudgetMicros",
          null,
        );
      if (budget != null && used + input.reserveMicros > budget)
        throw new AppError(
          "AI_BUDGET_EXCEEDED",
          "今日AI美元预算不足，尚未提交素材生成。",
        );
      this.repo.db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,estimated_micros,reserved_micros,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
        job.callId,
        "openrouter",
        `studio_${job.kind}`,
        1,
        input.reserveMicros,
        input.reserveMicros,
        "reserved",
        now(),
      );
      this.invalidate(draft.id);
      if (input.regenerate && existing?.status === "uncertain")
        this.save({ ...existing, superseded: true });
      this.save(job);
    });
    try {
      const payload: Record<string, unknown> = {
        model: model.id,
        prompt,
        aspect_ratio: creative.aspectRatio,
      };
      if (input.kind === "video") {
        payload.duration = input.duration;
        payload.resolution = input.resolution;
        payload.generate_audio = input.audio;
      } else {
        payload.n = 1;
        if (model.qualities?.includes("high")) payload.quality = "high";
      }
      if (referenceData) {
        if (input.kind === "image")
          payload.input_references = [
            { type: "image_url", image_url: { url: referenceData } },
          ];
        else
          payload.frame_images = [
            {
              type: "image_url",
              image_url: { url: referenceData },
              frame_type: "first_frame",
            },
          ];
      }
      const response = await this.request(
        `${base}/${input.kind === "image" ? "images" : "videos"}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      if (!response.error) {
        const issues = this.repo.db.setting<Record<string, string>>(
          "ai:modelIssues",
          {},
        );
        if (issues[model.id]) {
          delete issues[model.id];
          this.repo.db.setSetting("ai:modelIssues", issues);
          this.repo.db.setSetting(
            "studio:modelCatalog",
            this.repo.db
              .setting<MediaModel[]>("studio:modelCatalog", [])
              .map((m) =>
                m.id === model.id ? { ...m, lastError: undefined } : m,
              ),
          );
        }
      }
      this.billing(job, response);
      if (
        input.kind === "video" &&
        typeof response.id === "string" &&
        response.id &&
        response.id.length <= 300
      ) {
        job.remoteId = response.id;
        this.save(job);
      }
      if (
        response.error &&
        !(
          input.kind === "video" &&
          response.status === "failed" &&
          job.remoteId
        )
      )
        throw new AppError(
          "MEDIA_REMOTE_ERROR",
          String(response.error?.message ?? response.error).slice(0, 300),
        );
      if (input.kind === "image") {
        const raw = response.data?.[0]?.b64_json;
        if (
          typeof raw !== "string" ||
          !raw ||
          raw.length > 48_000_000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)
        )
          throw new AppError(
            "MEDIA_OUTPUT_INVALID",
            "模型没有返回有效图片，费用事实已保留。",
          );
        let bytes: Buffer;
        try {
          bytes = await this.normalize(Buffer.from(raw, "base64"));
        } catch {
          throw new AppError(
            "MEDIA_OUTPUT_INVALID",
            "模型返回的图片无法解码，费用事实已保留。",
          );
        }
        if (
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new AppError(
            "MEDIA_OUTPUT_INVALID",
            "图片无法解码，未保存为成功素材。",
          );
        await this.storeAsset(job, bytes, "png");
      } else {
        if (
          typeof response.id !== "string" ||
          !response.id ||
          response.id.length > 300
        )
          throw new AppError(
            "MEDIA_JOB_ID_MISSING",
            "服务未返回可追溯任务ID，结果待核；请检查服务商记录，避免重复生成。",
          );
        job.remoteId = response.id;
        job.status = ["pending", "in_progress"].includes(response.status)
          ? response.status
          : "pending";
        this.save(job);
        if (response.status === "completed") await this.download(job, key);
        if (response.status === "failed") {
          job.status = "failed";
          job.error = "视频生成失败，请核对服务商任务与费用。";
        }
      }
    } catch (error) {
      job.error = safeMessage(error).replaceAll(key, "[凭据省略]");
      if (
        error instanceof ServiceHttpError &&
        [403, 404].includes(error.status)
      ) {
        this.repo.db.setSetting("ai:modelIssues", {
          ...this.repo.db.setting<Record<string, string>>("ai:modelIssues", {}),
          [model.id]: job.error,
        });
        this.repo.db.setSetting(
          "studio:modelCatalog",
          this.repo.db
            .setting<MediaModel[]>("studio:modelCatalog", [])
            .map((m) =>
              m.id === model.id ? { ...m, lastError: job.error! } : m,
            ),
        );
      }
      if (job.asset) job.status = "completed";
      else if (job.remoteId) job.status = "download_failed";
      else
        job.status =
          error instanceof AppError &&
          [
            "MEDIA_REJECTED",
            "MEDIA_OUTPUT_INVALID",
            "MEDIA_REFERENCE_REQUIRED",
          ].includes(error.code)
            ? "failed"
            : "uncertain";
      const call = this.repo.db.get<{ status: string }>(
        "SELECT status FROM api_calls WHERE id=?",
        job.callId,
      );
      if (call?.status === "reserved")
        this.repo.db.run(
          "UPDATE api_calls SET status=?,message=? WHERE id=?",
          job.status === "failed" &&
            error instanceof AppError &&
            error.code === "MEDIA_REJECTED"
            ? "failed"
            : "uncertain",
          job.error,
          job.callId,
        );
    }
    this.invalidate(draft.id);
    return this.save(job);
  }
  private billing(job: StudioJob, response: Record<string, any>) {
    const value = cost(response.usage?.cost);
    if (value != null) job.costMicros = value;
    if (
      value != null ||
      response.status === "completed" ||
      Array.isArray(response.data)
    )
      this.repo.db.run(
        "UPDATE api_calls SET status='success',confirmed_micros=coalesce(?,confirmed_micros),reserved_micros=coalesce(?,reserved_micros),message=? WHERE id=?",
        value,
        value,
        value == null
          ? "素材接口未返回实际费用，保留美元预留。"
          : "素材接口返回usage.cost，美元实费已记录。",
        job.callId,
      );
  }
  async poll(jobId: string): Promise<StudioJob> {
    const job = this.job(jobId);
    if (
      job.kind !== "video" ||
      !job.remoteId ||
      job.status === "completed" ||
      job.status === "failed"
    )
      return job;
    const lock = `poll:${job.id}`,
      pending = this.active.get(lock);
    if (pending) return pending;
    const task = this.performPoll(job);
    this.active.set(lock, task);
    void task.finally(() => this.active.delete(lock)).catch(() => {});
    return task;
  }
  private async performPoll(job: StudioJob) {
    const key = await this.secrets.get("openrouter");
    if (!key || fingerprint(key) !== job.keyFingerprint)
      throw new AppError(
        "MEDIA_KEY_CHANGED",
        "请使用提交此任务时的OpenRouter Key查询，避免混用账户。",
      );
    if (job.checkedAt && Date.now() - Date.parse(job.checkedAt) < 10_000)
      return job;
    job.checkedAt = now();
    this.save(job);
    try {
      const response = await this.request(
        `${base}/videos/${encodeURIComponent(job.remoteId!)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      this.billing(job, response);
      if (response.status === "completed") await this.download(job, key);
      else if (["failed", "cancelled", "expired"].includes(response.status)) {
        job.status = "failed";
        job.error = clean(
          String(
            response.error?.message ??
              response.error ??
              "远端任务失败或已过期，请核对费用。",
          ),
        );
        this.repo.db.run(
          "UPDATE api_calls SET status=CASE WHEN status='reserved' THEN 'uncertain' ELSE status END,message=? WHERE id=?",
          job.error,
          job.callId,
        );
      } else if (["pending", "in_progress"].includes(response.status)) {
        job.status = response.status;
        job.error = null;
      } else
        throw new AppError(
          "MEDIA_STATUS_INVALID",
          "服务返回未知任务状态，已保留任务ID，可稍后继续查询。",
        );
    } catch (error) {
      job.error = safeMessage(error).replaceAll(key, "[凭据省略]");
    }
    if (job.status === "completed") this.invalidate(job.draftId);
    return this.save(job);
  }
  private async download(job: StudioJob, key: string) {
    job.status = "download_failed";
    this.save(job);
    const response = await this.fetchBinary(
      `${base}/videos/${encodeURIComponent(job.remoteId!)}/content?index=0`,
      {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok || !response.body)
      throw new AppError(
        "MEDIA_DOWNLOAD_FAILED",
        `视频下载失败（HTTP ${response.status}），可稍后重新查询下载，不重新生成。`,
      );
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024 * 1024)
          throw new AppError(
            "MEDIA_TOO_LARGE",
            "视频超过128MB的本地接收上限，已保留远端任务ID。",
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")
      throw new AppError(
        "MEDIA_OUTPUT_INVALID",
        "下载内容不是可识别的MP4文件，请重试下载或检查模型输出。",
      );
    await this.storeAsset(job, bytes, "mp4");
  }
  private async storeAsset(
    job: StudioJob,
    bytes: Buffer,
    extension: "png" | "mp4",
  ) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(this.dataPath, "media"), { recursive: true, mode: 0o700 });
    const path = join(this.dataPath, "media", `${hash}.${extension}`),
      temp = path + "." + id("tmp");
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
    job.asset = hash;
    job.extension = extension;
    job.status = "completed";
    job.error = null;
  }
  async assetPath(name: string) {
    if (
      !studioAssetPattern.test(name) ||
      !this.repo.db.get(
        "SELECT id FROM studio_jobs WHERE json_extract(data,'$.asset')=? AND json_extract(data,'$.extension')=? AND json_extract(data,'$.status')='completed' LIMIT 1",
        name.slice(0, 64),
        name.split(".")[1],
      )
    )
      throw new AppError("MEDIA_NOT_FOUND", "素材不存在或尚未完成。");
    const path = join(this.dataPath, "media", name),
      stat = await lstat(path).catch(() => {
        throw new AppError(
          "MEDIA_NOT_FOUND",
          "素材文件已丢失，请重新生成或从备份恢复。",
        );
      });
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new AppError("MEDIA_NOT_FOUND", "素材文件不可读取。");
    return path;
  }
  readyAssets(draftId: string) {
    const draft = this.repo.draft(draftId),
      creative = draft.creative;
    if (!creative || creative.format === "text") return [];
    const jobs = this.jobs(draftId),
      kind = creative.format === "video" ? "video" : "image",
      count = kind === "video" ? 1 : creative.cards.length;
    if (!count)
      throw new AppError(
        "MEDIA_INCOMPLETE",
        "请先补充画面方案并生成实际素材。",
      );
    const assets: StudioJob[] = [];
    for (let slot = 0; slot < count; slot++) {
      const prompt = this.prompt(creative, kind, slot),
        matching = jobs.filter(
          (j) =>
            j.kind === kind &&
            j.slot === slot &&
            j.prompt === prompt &&
            j.aspectRatio === creative.aspectRatio,
        );
      if (
        matching.some(
          (j) =>
            !j.superseded &&
            ["pending", "in_progress", "submitting", "uncertain"].includes(
              j.status,
            ),
        )
      )
        throw new AppError(
          "MEDIA_INCOMPLETE",
          "仍有素材生成中或结果待核，请处理后再审阅。",
        );
      const ready = matching.findLast(
        (j) => j.status === "completed" && j.asset && j.extension,
      );
      if (!ready)
        throw new AppError(
          "MEDIA_INCOMPLETE",
          `第${slot + 1}个素材尚未生成，不能把画面方案当作成品发布。`,
        );
      assets.push(ready);
    }
    return assets;
  }
  async assertReady(draftId: string) {
    const assets = this.readyAssets(draftId);
    for (const asset of assets)
      await this.assetPath(`${asset.asset}.${asset.extension}`);
    return assets;
  }
  inherit(from: Draft, toId: string, raw?: unknown) {
    const creative = raw ? creativePackage.parse(raw) : from.creative;
    if (!creative) return;
    this.repo.db.run(
      "INSERT INTO studio_packages VALUES(?,?)",
      toId,
      JSON.stringify(creative),
    );
    for (const old of this.jobs(from.id).filter(
      (j) =>
        j.status === "completed" ||
        (j.kind === "video" &&
          !!j.remoteId &&
          ["pending", "in_progress", "download_failed"].includes(j.status)),
    )) {
      try {
        if (
          old.prompt !== this.prompt(creative, old.kind, old.slot) ||
          old.aspectRatio !== creative.aspectRatio
        )
          continue;
      } catch {
        continue;
      }
      this.save({
        ...old,
        id: id("media"),
        draftId: toId,
        createdAt: now(),
        updatedAt: now(),
      });
    }
  }
  async exportAssets(draftId: string, folder: string) {
    const assets = this.readyAssets(draftId),
      draft = this.repo.draft(draftId);
    for (const asset of assets)
      await copyFile(
        await this.assetPath(`${asset.asset}.${asset.extension}`),
        join(
          folder,
          `${String(asset.slot + 1).padStart(2, "0")}-${asset.kind === "video" ? "动态视频" : "图片"}.${asset.extension}`,
        ),
      );
    if (draft.creative)
      await writeFile(
        join(folder, "创意方案.json"),
        JSON.stringify(draft.creative, null, 2),
        { mode: 0o600 },
      );
    if (
      draft.creative &&
      ["image", "carousel"].includes(draft.creative.format)
    ) {
      const markdown = draft.creative.cards
        .map(
          (card, i) =>
            `## ${card.heading}\n\n${card.copy}\n\n![第${i + 1}张图片](./${String(i + 1).padStart(2, "0")}-图片.png)`,
        )
        .join("\n\n");
      await writeFile(
        join(folder, "图文内容.md"),
        `# ${draft.title}\n\n${markdown}\n`,
        { mode: 0o600 },
      );
    }
    if (draft.creative?.format === "video" && draft.creative.voiceover)
      await writeFile(join(folder, "口播参考.txt"), draft.creative.voiceover, {
        mode: 0o600,
      });
    return assets.map((a) => ({
      kind: a.kind,
      slot: a.slot,
      model: a.model,
      file: `${String(a.slot + 1).padStart(2, "0")}-${a.kind === "video" ? "动态视频" : "图片"}.${a.extension}`,
    }));
  }
}
