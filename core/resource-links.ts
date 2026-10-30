import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { now } from "./database";
import { AppError } from "./errors";
import { readLimited } from "./http";
import { parseShare } from "./links";
import { hasVerifiedShare } from "../shared/share-status";
import { shareCreationCapabilities } from "../shared/share-options";
import type {
  ResourceLink,
  ResourceLinkContext,
  ResourceLinkSettings,
  ResourceLinkWrite,
  RemoteResourceLink,
} from "../shared/resource-links";
import type { Account, Resource, ResourceCopy } from "../shared/types";
import type { DriveProvider } from "./providers/provider";
import type { Repository } from "./repository";
import type { SecretStore } from "./secrets";

interface Dependencies {
  repo: Repository;
  secrets: SecretStore;
  fetch?(url: string, init: RequestInit): Promise<Response>;
  changed(): void;
  assertMutable(resourceId: string): void;
  assertIdle(accountId: string): void;
  authenticated<T>(
    accountId: string,
    action: (account: Account, provider: DriveProvider) => Promise<T>,
  ): Promise<T>;
}
interface LinkRecord extends Omit<
  ResourceLink,
  "code" | "url" | "hasPendingOperation"
> {
  baseUrl: string;
  hasCode: boolean;
  operationId: string | null;
  targetCopyId: string | null;
  targetShareVersion: number | null;
  targetOwnerUid: string | null;
}
const configKey = "resource-links:settings";
const tokenKey = "resource-links:token";
const codeKey = (id: string) => `resource-links:code:${id}`;
const operationKey = (id: string) => `resource-links:operation:${id}`;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const writeSchema = z.object({
  operationId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  slug: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !controlCharacters.test(value)),
  provider: z.enum(["quark", "baidu", "uc", "xunlei", "guangya", "pikpak"]),
  targetUrl: z.string().max(2048).nullable(),
  code: z
    .string()
    .max(128)
    .refine((value) => !controlCharacters.test(value)),
  enabled: z.boolean(),
});

/** Drive filenames can exceed the intake form limit; only the public display name is shortened. */
function publicTitle(value: string) {
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let title = "";
  for (const character of text) {
    if (title.length + character.length > 200) break;
    title += character;
  }
  return title;
}

function checkedWrite(
  value: ResourceLinkWrite,
  baseUrl: string,
): ResourceLinkWrite {
  const result = writeSchema.safeParse(value);
  if (!result.success)
    throw new AppError(
      "RESOURCE_LINK_INVALID_INPUT",
      "入口名称、短码、版本或提取码不符合服务要求，未提交同步请求。",
    );
  if (result.data.targetUrl !== null) {
    try {
      const target = new URL(result.data.targetUrl);
      const parsed = parseShare(result.data.targetUrl, result.data.code);
      if (
        target.protocol !== "https:" ||
        target.origin === baseUrl ||
        target.search ||
        target.hash ||
        target.username ||
        target.password ||
        target.port ||
        parsed.provider !== result.data.provider ||
        parsed.url !== result.data.targetUrl ||
        !/^\/s\/[A-Za-z0-9_-]{1,256}$/.test(target.pathname)
      )
        throw new Error("Invalid canonical target");
    } catch {
      throw new AppError(
        "RESOURCE_LINK_INVALID_INPUT",
        "入口目标必须是此资源对应的官方 HTTPS 分享链接，未提交同步请求。",
      );
    }
  }
  return result.data;
}

const remoteSchema = z.object({
  id: z.string(),
  slug: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  url: z.string().url(),
  title: z.string().max(200),
  provider: z.enum(["quark", "baidu", "uc", "xunlei", "guangya", "pikpak"]),
  targetUrl: z.string().url().nullable(),
  code: z.string().max(128),
  enabled: z.boolean(),
  revision: z.number().int().min(1),
  lastOperationId: z.string().uuid(),
  updatedAt: z.string(),
});

function serviceUrl(text: string) {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new AppError("INVALID_URL", "请填写完整的固定入口服务 HTTPS 地址。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    isIP(url.hostname.replace(/[\[\]]/g, "")) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new AppError(
      "INVALID_URL",
      "服务地址必须是公开的 HTTPS 域名，不能包含路径、端口或登录信息。",
    );
  return url.origin;
}

/** Durable, per-resource cloud writes. Original drive shares stay independent. */
export class ResourceLinks {
  private active = new Set<string>();
  private configuring = false;
  constructor(private d: Dependencies) {}
  private get db() {
    return this.d.repo.db;
  }
  get isBusy() {
    return this.configuring || this.active.size > 0;
  }
  private config() {
    return this.db.setting(configKey, { enabled: false, baseUrl: "" });
  }
  private record(resourceId: string) {
    const row = this.db.get<{ data: string }>(
      "SELECT data FROM resource_links WHERE resource_id=?",
      resourceId,
    );
    return row ? (JSON.parse(row.data) as LinkRecord) : null;
  }
  private store(record: LinkRecord) {
    this.db.run(
      "INSERT INTO resource_links(id,resource_id,slug,base_url,data) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET data=excluded.data",
      record.id,
      record.resourceId,
      record.slug,
      record.baseUrl,
      JSON.stringify(record),
    );
    this.d.changed();
  }
  async settings(): Promise<ResourceLinkSettings> {
    const config = this.config();
    const token = await this.d.secrets.get(tokenKey);
    return {
      ...config,
      configured: !!(config.baseUrl && token),
      maskedToken: token
        ? `${token.slice(0, 4)}********${token.slice(-4)}`
        : "",
    };
  }
  async configure(input: {
    enabled: boolean;
    baseUrl: string;
    token?: string;
  }) {
    if (this.isBusy)
      throw new AppError(
        "RESOURCE_LINK_BUSY",
        "固定入口正在同步，请完成后再修改连接。",
      );
    this.configuring = true;
    try {
      const baseUrl = input.baseUrl.trim() ? serviceUrl(input.baseUrl) : "";
      if (
        this.db.get(
          "SELECT id FROM resource_links WHERE base_url<>? LIMIT 1",
          baseUrl,
        )
      )
        throw new AppError(
          "RESOURCE_LINK_SERVICE_CHANGED",
          "已有固定入口绑定当前服务。请保留此服务地址，避免已经发布的入口失去维护连接。",
        );
      const token =
        input.token === undefined
          ? await this.d.secrets.get(tokenKey)
          : input.token.trim();
      if (token && (!/^[\x21-\x7e]{32,512}$/.test(token) || /\s/.test(token)))
        throw new AppError(
          "INVALID_TOKEN",
          "管理令牌需为32至512位非空白字符，请填写 Worker 的管理令牌。",
        );
      if (input.enabled && (!baseUrl || !token))
        throw new AppError(
          "RESOURCE_LINK_NOT_CONFIGURED",
          "请先填写服务地址和管理令牌，再启用自动创建。",
        );
      if (input.token !== undefined)
        await this.d.secrets.set(tokenKey, token || "");
      this.db.setSetting(configKey, { enabled: input.enabled, baseUrl });
      this.d.changed();
      return await this.settings();
    } finally {
      this.configuring = false;
    }
  }
  private async request(
    baseUrl: string,
    path: string,
    method = "GET",
    payload?: unknown,
  ) {
    if (this.config().baseUrl !== baseUrl)
      throw new AppError(
        "RESOURCE_LINK_SERVICE_CHANGED",
        "当前服务地址与此入口不一致，请恢复原服务配置。",
      );
    const token = await this.d.secrets.get(tokenKey);
    if (!token)
      throw new AppError(
        "RESOURCE_LINK_NOT_CONFIGURED",
        "请先在连接与设置中保存固定入口管理令牌。",
      );
    let response: Response;
    let text: string;
    try {
      response = await (this.d.fetch ?? fetch)(baseUrl + path, {
        method,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      text = await readLimited(response, 32_768);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const error = new AppError(
        "RESOURCE_LINK_NETWORK",
        method === "GET"
          ? "无法连接固定入口服务，请检查系统代理和网络后重试。"
          : "固定入口服务连接中断，暂时无法确认同步结果。请检查系统代理和网络后核对原操作。",
        method !== "GET",
      );
      Object.defineProperty(error, "cause", { value: cause });
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError(
        "RESOURCE_LINK_RESPONSE",
        "固定入口服务未返回有效数据，请检查部署地址。",
      );
    }
    if (
      response.status === 404 &&
      method === "GET" &&
      path.startsWith("/api/links/")
    )
      return null;
    if (!response.ok) {
      const failure = z
        .object({ error: z.object({ code: z.string() }) })
        .safeParse(value);
      const rejectedBeforeWrite =
        method === "PUT" &&
        failure.success &&
        ((response.status === 400 &&
          ["INVALID_INPUT", "INVALID_ID", "INVALID_JSON"].includes(
            failure.data.error.code,
          )) ||
          (response.status === 401 &&
            failure.data.error.code === "UNAUTHORIZED") ||
          (response.status === 403 &&
            failure.data.error.code === "ORIGIN_REJECTED") ||
          (response.status === 405 &&
            failure.data.error.code === "METHOD_NOT_ALLOWED") ||
          (response.status === 413 &&
            failure.data.error.code === "BODY_TOO_LARGE") ||
          (response.status === 415 &&
            failure.data.error.code === "JSON_REQUIRED"));
      const message =
        response.status === 401 || response.status === 403
          ? "管理令牌未通过验证，请检查 Worker 配置和本机保存的令牌。"
          : response.status === 409
            ? "云端入口已发生变化，未覆盖新版本。请先读取云端状态后再更新。"
            : response.status === 429
              ? "固定入口服务暂时达到使用限制，请稍后重试原操作。"
              : "固定入口服务请求未完成，请检查部署和用量后重试原操作。";
      throw new AppError(
        rejectedBeforeWrite
          ? "RESOURCE_LINK_REJECTED"
          : response.status === 409
            ? "RESOURCE_LINK_CONFLICT"
            : "RESOURCE_LINK_HTTP",
        message,
        method !== "GET" && !rejectedBeforeWrite,
      );
    }
    return value;
  }
  async checkConnection() {
    const config = this.config();
    if (!config.baseUrl)
      throw new AppError(
        "RESOURCE_LINK_NOT_CONFIGURED",
        "请先保存固定入口服务地址。",
      );
    const result = z
      .object({
        service: z.literal("panxu-resource-links"),
        version: z.literal(1),
      })
      .safeParse(await this.request(config.baseUrl, "/api/connection"));
    if (!result.success)
      throw new AppError(
        "RESOURCE_LINK_RESPONSE",
        "此地址不是兼容的盘序固定入口服务，请检查部署。",
      );
    return { message: "固定入口服务和管理令牌连接正常。" };
  }
  private currentCopy(resource: Resource) {
    return (
      resource.copies.find((copy) => {
        if (!hasVerifiedShare(copy, this.d.repo.getAccount(copy.accountId)))
          return false;
        const check = this.db.get<{ status: string; checked_at: string }>(
          "SELECT status,checked_at FROM share_checks WHERE copy_id=?",
          copy.id,
        );
        return (
          !check ||
          check.status === "valid" ||
          Date.parse(check.checked_at) < Date.parse(copy.shareVerifiedAt!)
        );
      }) ?? null
    );
  }
  async context(resourceId: string): Promise<ResourceLinkContext> {
    const resource = this.d.repo.getResource(resourceId);
    const current = this.currentCopy(resource);
    const record = this.record(resourceId);
    const currentCodeMissing = !!(
      current &&
      shareCreationCapabilities[resource.provider].extractionCode.mode !==
        "none" &&
      !this.d.secrets.has(`share:${current.id}`)
    );
    const code = record?.hasCode
      ? await this.d.secrets.get(codeKey(record.id))
      : "";
    return {
      settings: await this.settings(),
      link: record
        ? {
            id: record.id,
            resourceId,
            slug: record.slug,
            url: `${record.baseUrl}/r/${record.slug}`,
            state: record.state,
            enabled: record.enabled,
            targetUrl: record.targetUrl,
            code: code ?? "",
            revision: record.revision,
            updatedAt: record.updatedAt,
            syncedAt: record.syncedAt,
            error: record.error,
            hasPendingOperation: !!record.operationId,
            requestMissing:
              !!record.operationId &&
              !this.d.secrets.has(operationKey(record.id)),
          }
        : null,
      currentCopyId: current?.id ?? null,
      currentShareUrl: current?.shareUrl ?? null,
      currentTargetIssue: !current
        ? "本人分享尚未完成核验，可先创建待更新的固定入口。"
        : currentCodeMissing && !record?.targetUrl
          ? "本机未保存此分享的提取码，固定入口会先保持待更新。请使用“绑定当前本人分享”联网核验，或填写本人链接与提取码。"
          : null,
    };
  }
  private async exclusive<T>(resourceId: string, action: () => Promise<T>) {
    if (this.configuring || this.active.has(resourceId))
      throw new AppError(
        "RESOURCE_LINK_BUSY",
        "此固定入口正在处理，请稍后再试。",
      );
    this.d.assertMutable(resourceId);
    this.active.add(resourceId);
    try {
      return await action();
    } finally {
      this.active.delete(resourceId);
    }
  }
  private async newRecord(resourceId: string) {
    const settings = await this.settings();
    if (!settings.configured)
      throw new AppError(
        "RESOURCE_LINK_NOT_CONFIGURED",
        "请先连接固定入口服务。",
      );
    const record: LinkRecord = {
      id: randomUUID(),
      resourceId,
      slug: randomBytes(9).toString("base64url"),
      baseUrl: settings.baseUrl,
      state: "pending",
      enabled: true,
      targetUrl: null,
      revision: 0,
      updatedAt: now(),
      syncedAt: null,
      error: null,
      operationId: null,
      hasCode: false,
      targetCopyId: null,
      targetShareVersion: null,
      targetOwnerUid: null,
    };
    return record;
  }
  private assertSettled(record: LinkRecord) {
    if (record.operationId)
      throw new AppError(
        "RESOURCE_LINK_PENDING",
        "上次同步结果尚待核对，请重试原操作或读取云端状态后再修改。",
      );
  }
  private async queueWrite(
    record: LinkRecord,
    target: { url: string | null; code: string; copy: ResourceCopy | null },
    enabled: boolean,
  ) {
    this.assertSettled(record);
    const resource = this.d.repo.getResource(record.resourceId);
    const input = checkedWrite(
      {
        operationId: randomUUID(),
        expectedRevision: record.revision,
        slug: record.slug,
        title: publicTitle(resource.title),
        provider: resource.provider,
        targetUrl: target.url,
        code: target.code,
        enabled,
      },
      record.baseUrl,
    );
    // Persist the exact request before dispatch; extraction codes stay encrypted.
    await this.d.secrets.set(
      operationKey(record.id),
      JSON.stringify({
        input,
        copyId: target.copy?.id ?? record.targetCopyId,
        shareVersion: target.copy?.shareVersion ?? null,
        ownerUid: target.copy?.ownerUid ?? null,
      }),
    );
    record.operationId = input.operationId;
    record.state = "pending";
    record.error = null;
    record.updatedAt = now();
    this.store(record);
    await this.send(record, input, true);
    return this.context(record.resourceId);
  }
  private remote(record: LinkRecord, value: unknown) {
    const result = remoteSchema.safeParse(value);
    const resource = this.d.repo.getResource(record.resourceId);
    if (
      !result.success ||
      result.data.id !== record.id ||
      result.data.slug !== record.slug ||
      result.data.url !== `${record.baseUrl}/r/${record.slug}` ||
      result.data.provider !== resource.provider
    )
      throw new AppError(
        "RESOURCE_LINK_RESPONSE",
        "云端返回的入口身份或地址不匹配，未采用此结果。",
      );
    if (result.data.targetUrl) {
      const parsed = parseShare(result.data.targetUrl, result.data.code);
      if (parsed.provider !== resource.provider)
        throw new AppError(
          "RESOURCE_LINK_RESPONSE",
          "云端目标不是当前资源对应的官方网盘分享。",
        );
      result.data.targetUrl = parsed.url;
    }
    return result.data;
  }
  private sameWrite(remote: RemoteResourceLink, input: ResourceLinkWrite) {
    return (
      remote.slug === input.slug &&
      remote.title === input.title &&
      remote.provider === input.provider &&
      remote.targetUrl === input.targetUrl &&
      remote.code === input.code &&
      remote.enabled === input.enabled &&
      remote.lastOperationId === input.operationId &&
      remote.revision === input.expectedRevision + 1
    );
  }
  private async commit(
    record: LinkRecord,
    remote: RemoteResourceLink,
    preserveBinding: boolean,
  ) {
    const raw = await this.d.secrets.get(operationKey(record.id));
    const operation = raw
      ? (JSON.parse(raw) as {
          copyId: string | null;
          shareVersion: number | null;
          ownerUid: string | null;
        })
      : null;
    await this.d.secrets.set(codeKey(record.id), remote.code);
    this.store({
      ...record,
      targetUrl: remote.targetUrl,
      enabled: remote.enabled,
      revision: remote.revision,
      hasCode: !!remote.code,
      state: "synced",
      operationId: null,
      error: null,
      updatedAt: remote.updatedAt,
      syncedAt: now(),
      targetCopyId: preserveBinding
        ? (operation?.copyId ?? record.targetCopyId)
        : null,
      targetShareVersion: preserveBinding
        ? (operation?.shareVersion ?? record.targetShareVersion)
        : null,
      targetOwnerUid: preserveBinding
        ? (operation?.ownerUid ?? record.targetOwnerUid)
        : null,
    });
    this.d.secrets.remove(operationKey(record.id));
  }
  private async send(
    record: LinkRecord,
    input: ResourceLinkWrite,
    firstAttempt = false,
  ) {
    try {
      const result = this.remote(
        record,
        await this.request(
          record.baseUrl,
          `/api/links/${record.id}`,
          "PUT",
          input,
        ),
      );
      if (!this.sameWrite(result, input))
        throw new AppError(
          "RESOURCE_LINK_RESPONSE",
          "服务回执与原同步请求不一致，请读取云端状态。",
        );
      // Historical idempotent receipts must never be mistaken for the current target.
      const latest = this.remote(
        record,
        await this.request(record.baseUrl, `/api/links/${record.id}`),
      );
      if (!this.sameWrite(latest, input))
        throw new AppError(
          "RESOURCE_LINK_CONFLICT",
          "云端已有更新版本，请读取云端状态，未覆盖新目标。",
        );
      await this.commit(record, latest, true);
    } catch (error) {
      const rejected =
        error instanceof AppError && error.code === "RESOURCE_LINK_REJECTED";
      if (firstAttempt && rejected) {
        // Only a known rejection of the first dispatch proves this intent never committed.
        // Retried requests may have an earlier unknown submission and must retain the fence.
        this.db.transaction(() => {
          this.d.secrets.remove(operationKey(record.id));
          this.store({
            ...record,
            operationId: null,
            enabled: record.revision === 0 ? false : record.enabled,
            state: "error",
            error: `${error.message} 本次请求已明确拒绝；请修正配置或资料后重新同步。`,
          });
        });
        return;
      }
      record.state = "error";
      record.error =
        error instanceof AppError
          ? `${error.message}${rejected ? " 上次同步仍可能已提交，请读取云端状态核对。" : ""}`
          : "同步未完成或结果待核对。资源已保留，请重试原操作或读取云端状态。";
      this.store(record);
    }
  }
  private async savedTarget(resource: Resource) {
    const copy = this.currentCopy(resource);
    const code = copy ? await this.d.secrets.get(`share:${copy.id}`) : null;
    // Backups omit secrets. A missing entry proves an empty code only when the
    // provider explicitly has no extraction-code capability; other empty codes
    // need the user's explicit online verification, not an automatic assumption.
    if (
      copy &&
      code === null &&
      shareCreationCapabilities[resource.provider].extractionCode.mode !==
        "none"
    )
      return { url: null, code: "", copy: null };
    return { url: copy?.shareUrl ?? null, code: code ?? "", copy };
  }
  async ensure(resourceId: string) {
    return this.exclusive(resourceId, async () => {
      const resource = this.d.repo.getResource(resourceId);
      const record =
        this.record(resourceId) ?? (await this.newRecord(resourceId));
      if (record.revision > 0 || record.operationId)
        return this.context(resourceId);
      return this.queueWrite(record, await this.savedTarget(resource), true);
    });
  }
  async afterResourceSaved(resourceId: string) {
    try {
      if (
        !this.config().enabled ||
        !this.d.secrets.has(tokenKey) ||
        this.record(resourceId)
      )
        return;
      await this.ensure(resourceId);
    } catch {
      /* The committed resource is never reported as a failed intake. */
    }
  }
  async afterShareSaved(copyId: string) {
    try {
      if (!this.config().enabled || !this.d.secrets.has(tokenKey)) return;
      const copy = this.d.repo.getCopy(copyId);
      const record = this.record(copy.resourceId);
      if (!record) return;
      if (
        !record.enabled ||
        record.targetUrl ||
        record.operationId ||
        record.state !== "synced"
      )
        return;
      await this.exclusive(copy.resourceId, async () => {
        const target = await this.savedTarget(
          this.d.repo.getResource(copy.resourceId),
        );
        if (target.url) await this.queueWrite(record, target, true);
      });
    } catch {
      /* Share creation/archival remains successful if cloud sync fails. */
    }
  }
  private async verifiedTarget(resource: Resource, text: string, code = "") {
    const source = parseShare(text, code);
    if (
      source.provider !== resource.provider ||
      (resource.sourceKind !== "owned" && source.url === resource.sourceUrl)
    )
      throw new AppError(
        "FOREIGN_SHARE_BLOCKED",
        "请填写这份资源对应的本人分享，不能绑定采集来源或其他网盘类型。",
      );
    const copy = resource.copies.find(
      (item) =>
        item.verifiedAt &&
        item.files.length &&
        item.ownerUid &&
        item.ownerUid === this.d.repo.getAccount(item.accountId).uid,
    );
    if (!copy)
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "请先完成本人资源文件核验，再绑定分享。",
      );
    this.d.assertIdle(copy.accountId);
    return this.d.authenticated(copy.accountId, async (account, provider) => {
      if (!account.enabled || !account.uid || account.uid !== copy.ownerUid)
        throw new AppError(
          "ACCOUNT_UID_MISMATCH",
          "本人网盘账号归属已发生变化，请先重新核验。",
        );
      const share = await provider.recoverOwnShare(account, source, copy.files);
      const parsed = parseShare(share.url, share.code);
      if (
        share.ownerUid !== account.uid ||
        parsed.provider !== resource.provider ||
        parsed.url !== source.url ||
        !(await provider.verifyShare(
          account,
          share.id,
          copy.files,
          parsed.code,
        ))
      )
        throw new AppError(
          "OWNERSHIP_UNVERIFIED",
          "此分享未通过本人归属及资源文件核验，固定入口未更新。",
        );
      return { url: parsed.url, code: parsed.code, copy };
    });
  }
  async setTarget(resourceId: string, text: string, code = "") {
    return this.exclusive(resourceId, async () => {
      const record = this.record(resourceId);
      if (!record) throw new AppError("NOT_FOUND", "请先创建固定入口。");
      this.assertSettled(record);
      const resource = this.d.repo.getResource(resourceId);
      return this.queueWrite(
        record,
        await this.verifiedTarget(resource, text, code),
        record.enabled,
      );
    });
  }
  async useCurrent(resourceId: string) {
    const resource = this.d.repo.getResource(resourceId),
      copy = this.currentCopy(resource);
    if (!copy?.shareUrl)
      throw new AppError("SHARE_NOT_READY", "当前本人分享尚未完成核验。");
    return this.setTarget(
      resourceId,
      copy.shareUrl,
      (await this.d.secrets.get(`share:${copy.id}`)) ?? "",
    );
  }
  async setEnabled(resourceId: string, enabled: boolean) {
    return this.exclusive(resourceId, async () => {
      const record = this.record(resourceId);
      if (!record) throw new AppError("NOT_FOUND", "固定入口尚未创建。");
      const code = record.hasCode
        ? await this.d.secrets.get(codeKey(record.id))
        : "";
      if (record.hasCode && code === null)
        throw new AppError(
          "RESOURCE_LINK_CODE_MISSING",
          "本机缺少原提取码，请先读取云端状态恢复连接数据。",
        );
      return this.queueWrite(
        record,
        { url: record.targetUrl, code: code ?? "", copy: null },
        enabled,
      );
    });
  }
  async retry(resourceId: string) {
    if (!this.record(resourceId)?.operationId) return this.ensure(resourceId);
    return this.exclusive(resourceId, async () => {
      const record = this.record(resourceId)!;
      const raw = await this.d.secrets.get(operationKey(record.id));
      if (!raw)
        throw new AppError(
          "RESOURCE_LINK_REQUEST_MISSING",
          "本机缺少原同步参数，请读取云端状态后再维护，不会重新生成入口。",
        );
      const { input } = JSON.parse(raw) as { input: ResourceLinkWrite };
      if (input.operationId !== record.operationId)
        throw new AppError(
          "RESOURCE_LINK_REQUEST_MISSING",
          "同步记录不匹配，请读取云端状态。",
        );
      await this.send(record, input);
      return this.context(resourceId);
    });
  }
  async refresh(resourceId: string) {
    return this.exclusive(resourceId, async () => {
      const record = this.record(resourceId);
      if (!record) throw new AppError("NOT_FOUND", "固定入口尚未创建。");
      const value = await this.request(
        record.baseUrl,
        `/api/links/${record.id}`,
      );
      if (value === null) {
        throw new AppError(
          "RESOURCE_LINK_CLOUD_MISSING",
          record.operationId
            ? "云端暂未读到入口，上次请求仍可能在处理。请保留原操作并点击重试，不能据此重新创建。"
            : "原云端入口不存在，请核对原服务数据库。不会用新地址替换已发布入口。",
        );
      }
      const remote = this.remote(record, value);
      if (record.operationId) {
        const raw = await this.d.secrets.get(operationKey(record.id));
        if (raw) {
          const { input } = JSON.parse(raw) as { input: ResourceLinkWrite };
          if (this.sameWrite(remote, input))
            await this.commit(record, remote, true);
          else if (remote.revision > input.expectedRevision)
            await this.commit(record, remote, false);
          else
            throw new AppError(
              "RESOURCE_LINK_PENDING",
              "云端仍是上次同步前的版本，请重试原操作。不会清除尚待核对的请求。",
            );
        } else if (remote.revision > record.revision)
          await this.commit(record, remote, false);
        else
          throw new AppError(
            "RESOURCE_LINK_REQUEST_MISSING",
            "原同步参数未能读取，且云端版本尚未推进，请恢复原本机记录后再核对。",
          );
      } else await this.commit(record, remote, false);
      return this.context(resourceId);
    });
  }
  async copy(resourceId: string) {
    const { link } = await this.context(resourceId);
    if (!link || !link.enabled || link.revision < 1 || !link.syncedAt)
      throw new AppError(
        "RESOURCE_LINK_NOT_READY",
        "固定入口尚未同步或已停用，请先完成维护。",
      );
    return { text: link.url };
  }
  async recover(resourceId: string) {
    return this.exclusive(resourceId, async () => {
      const record = this.record(resourceId);
      if (!record?.operationId || this.d.secrets.has(operationKey(record.id)))
        throw new AppError(
          "RESOURCE_LINK_RECOVERY_UNNEEDED",
          "原同步参数仍可读取，请重试原操作或读取云端状态。",
        );
      const value = await this.request(
        record.baseUrl,
        `/api/links/${record.id}`,
      );
      const remote = value === null ? null : this.remote(record, value);
      // This explicit recovery fences any late original request with a newer CAS.
      // If another request wins the race, its version is never overwritten.
      return this.queueWrite(
        {
          ...record,
          operationId: null,
          revision: remote?.revision ?? 0,
          targetCopyId: null,
          targetOwnerUid: null,
          targetShareVersion: null,
        },
        {
          url: remote?.targetUrl ?? null,
          code: remote?.code ?? "",
          copy: null,
        },
        false,
      );
    });
  }
}
