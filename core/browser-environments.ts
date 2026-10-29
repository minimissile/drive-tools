import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { Database, id, now } from "./database";
import { AppError } from "./errors";
import type { SecretStore } from "./secrets";
import type { AppPorts } from "./ports";
import type {
  BrowserEnvironment,
  BrowserEnvironmentView,
  BrowserEnvironmentRuntime,
  EnvironmentAccountLink,
  EnvironmentAccountRef,
  EnvironmentSaveInput,
  EnvironmentStamp,
} from "../shared/browser-environments";

type LinkRow = {
  kind: EnvironmentAccountRef["kind"];
  account_id: string;
  environment_id: string;
  identity_id: string;
  realm: string;
  platform: string;
  uid: string | null;
  verified_revision: number;
};
export class BrowserEnvironments {
  private leases = new Map<string, symbol>();
  private leaseScope = new AsyncLocalStorage<Map<string, symbol>>();
  private guards: ((refs: EnvironmentAccountRef[]) => void)[] = [];
  private externalConfiguration?: (
    profileId: string,
  ) => Promise<{
    signature: string;
    proxy: "direct" | "configured";
    stopWhileNetError: boolean;
  }>;
  private externalNetwork?: (profileId: string) => Promise<string>;
  private externalIdle?: (profileId: string) => Promise<void>;
  private releaseListeners = new Set<() => void>();
  private queuedBusy: (environmentId: string) => boolean = () => false;
  constructor(
    private db: Database,
    private secrets: SecretStore,
    private ports: AppPorts,
    private workspace: string,
    private changed: () => void,
  ) {
    this.migrateLegacy();
  }
  get isBusy() {
    return this.leases.size > 0;
  }
  onRelease(listener: () => void) {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }
  setQueuedBusy(reader: (environmentId: string) => boolean) {
    this.queuedBusy = reader;
  }
  available(environmentIds: string[]) {
    return environmentIds.every((id) => !this.leases.has(id));
  }
  private released() {
    for (const listener of this.releaseListeners) listener();
  }
  addGuard(guard: (refs: EnvironmentAccountRef[]) => void) {
    this.guards.push(guard);
  }
  setExternalConfigurationReader(
    reader: NonNullable<BrowserEnvironments["externalConfiguration"]>,
  ) {
    this.externalConfiguration = reader;
  }
  setExternalNetworkChecker(
    reader: NonNullable<BrowserEnvironments["externalNetwork"]>,
  ) {
    this.externalNetwork = reader;
  }
  setExternalIdleGuard(
    reader: NonNullable<BrowserEnvironments["externalIdle"]>,
  ) {
    this.externalIdle = reader;
  }
  private async refreshExternal(environmentId: string) {
    const env = this.get(environmentId);
    if (env.engine !== "bitbrowser" || !this.externalConfiguration) return;
    const connectorKey = this.db.setting("bitUrl", "");
    if (env.connectorKey && env.connectorKey !== connectorKey)
      throw new AppError(
        "ENVIRONMENT_CONNECTOR_CHANGED",
        "比特服务地址已变化，请恢复原连接；不会将已有账号切到另一套浏览器配置。",
      );
    const config = await this.externalConfiguration(env.profileId);
    if (
      env.requireProxy &&
      (config.proxy !== "configured" || !config.stopWhileNetError)
    )
      throw new AppError(
        "ENVIRONMENT_PROXY_REQUIRED",
        "请在比特客户端配置代理，并开启网络异常停止打开；此环境已要求独立代理出口。",
      );
    const changed =
      !!env.externalSignature && env.externalSignature !== config.signature;
    this.persist({
      ...env,
      connectorKey,
      externalSignature: config.signature,
      externalProxy: config.proxy,
      revision: env.revision + (changed ? 1 : 0),
    });
    if (changed)
      this.db.run(
        "UPDATE browser_environment_identities SET revision=revision+1 WHERE environment_id=?",
        env.id,
      );
  }
  assertAccountIdle(ref: EnvironmentAccountRef) {
    const link = this.linkRow(ref);
    if (!link) return;
    if (
      this.leases.has(link.environment_id) ||
      this.queuedBusy(link.environment_id)
    )
      throw new AppError(
        "ENVIRONMENT_BUSY",
        "此账号所在环境正在操作或排队，请完成后再修改。",
      );
    for (const guard of this.guards) guard([ref]);
  }
  get(environmentId: string): BrowserEnvironment {
    const row = this.db.get<{ data: string }>(
      "SELECT data FROM browser_environments WHERE id=?",
      environmentId,
    );
    if (!row)
      throw new AppError(
        "ENVIRONMENT_NOT_FOUND",
        "浏览器环境不存在，请刷新后重新选择。",
      );
    return {
      ...JSON.parse(row.data),
      hasProxyCredentials: this.secrets.has(
        `environment:${environmentId}:proxy`,
      ),
    };
  }
  private persist(value: BrowserEnvironment) {
    const { hasProxyCredentials: _credentials, ...stored } = value;
    this.db.run(
      "INSERT INTO browser_environments(id,engine,profile_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      value.id,
      value.engine,
      value.profileId,
      JSON.stringify(stored),
    );
    return this.get(value.id);
  }
  private linkRow(ref: EnvironmentAccountRef) {
    return this.db.get<LinkRow>(
      "SELECT * FROM browser_environment_accounts WHERE kind=? AND account_id=?",
      ref.kind,
      ref.id,
    );
  }
  link(ref: EnvironmentAccountRef): EnvironmentAccountLink {
    const row = this.linkRow(ref);
    if (!row)
      throw new AppError(
        "ENVIRONMENT_ACCOUNT_MISSING",
        "此账号尚未关联浏览器环境，请在账号管理中设置。",
      );
    return {
      ...ref,
      environmentId: row.environment_id,
      identityId: row.identity_id,
      realm: row.realm,
      platform: row.platform,
      uid: row.uid,
      verifiedRevision: row.verified_revision,
      alias: this.accountInfo(ref).alias,
    };
  }
  forAccount(ref: EnvironmentAccountRef) {
    return this.get(this.link(ref).environmentId);
  }
  list(): BrowserEnvironmentView[] {
    return this.db
      .all<{ id: string }>("SELECT id FROM browser_environments ORDER BY rowid")
      .map(({ id: environmentId }) => ({
        ...this.get(environmentId),
        accounts: this.refs(environmentId).map((ref) => this.link(ref)),
        busy: this.leases.has(environmentId) || this.queuedBusy(environmentId),
      }));
  }
  private refs(environmentId: string): EnvironmentAccountRef[] {
    return this.db
      .all<{ kind: EnvironmentAccountRef["kind"]; account_id: string }>(
        "SELECT kind,account_id FROM browser_environment_accounts WHERE environment_id=?",
        environmentId,
      )
      .map((r) => ({ kind: r.kind, id: r.account_id }));
  }
  private accountInfo(ref: EnvironmentAccountRef): {
    alias: string;
    platform: string;
    realm: string;
    uid: string | null;
  } {
    if (ref.kind === "website") {
      const row = this.db.get<{
        alias: string;
        provider: string;
        uid: string | null;
      }>("SELECT alias,provider,uid FROM website_accounts WHERE id=?", ref.id);
      if (row)
        return {
          alias: row.alias,
          platform: row.provider,
          realm: row.provider === "baidu-marketing" ? "baidu" : row.provider,
          uid: row.uid,
        };
    } else if (ref.kind === "zhidao") {
      const row = this.db.get<{ data: string }>(
        "SELECT data FROM zhidao_accounts WHERE id=?",
        ref.id,
      );
      if (row) {
        const data = JSON.parse(row.data);
        return {
          alias: String(data.alias),
          platform: "baidu-zhidao",
          realm: "baidu",
          uid: data.uid || null,
        };
      }
    } else {
      const row = this.db.get<{
        alias: string;
        platform: string;
        website_account_id: string | null;
      }>(
        "SELECT alias,platform,website_account_id FROM browser_bindings WHERE id=?",
        ref.id,
      );
      if (row?.website_account_id)
        return this.accountInfo({
          kind: "website",
          id: row.website_account_id,
        });
      if (row)
        return {
          alias: row.alias,
          platform: row.platform,
          realm: row.platform,
          uid: null,
        };
    }
    throw new AppError(
      "ENVIRONMENT_ACCOUNT_NOT_FOUND",
      "关联的平台账号不存在或已移除。",
    );
  }
  private register(
    name: string,
    engine: BrowserEnvironment["engine"],
    profileId: string,
  ) {
    const prior = this.db.get<{ id: string }>(
      "SELECT id FROM browser_environments WHERE engine=? AND profile_id=?",
      engine,
      profileId,
    );
    if (prior) return this.get(prior.id);
    const time = now();
    return this.persist({
      id: id("env"),
      name,
      engine,
      profileId,
      revision: 1,
      proxy: engine === "electron" ? { mode: "direct" } : null,
      fingerprint: engine === "electron" ? "native" : "external",
      ...(engine === "bitbrowser" ? { connectorKey: this.db.setting("bitUrl", "") } : {}),
      hasProxyCredentials: false,
      createdAt: time,
      updatedAt: time,
    });
  }
  private attach(
    ref: EnvironmentAccountRef,
    environmentId: string,
    verified = false,
  ) {
    const info = this.accountInfo(ref);
    if (["feishu", "tencent-docs", "shimo"].includes(info.platform) && this.get(environmentId).engine !== "electron")
      throw new AppError("DOCUMENT_NATIVE_SESSION", "文档平台当前使用内置浏览器保存会话，请选择内置环境。");
    if(info.platform === "smzdm" && this.get(environmentId).engine !== "electron")
      throw new AppError("SMZDM_NATIVE_SESSION","什么值得买单账号目前使用内置浏览器环境，请选择内置环境。");
    if (
      ref.kind !== "binding" &&
      this.db.get(
        "SELECT account_id FROM browser_environment_accounts WHERE environment_id=? AND platform=? AND kind=? AND account_id<>?",
        environmentId,
        info.platform,
        ref.kind,
        ref.id,
      )
    )
      throw new AppError(
        "ENVIRONMENT_IDENTITY_OCCUPIED",
        "此环境已关联该平台账号；同平台的其他身份请选择另一个环境。",
      );
    let identity = this.db.get<{ id: string; revision: number }>(
      "SELECT id,revision FROM browser_environment_identities WHERE environment_id=? AND realm=?",
      environmentId,
      info.realm,
    );
    if (!identity) {
      identity = { id: id("identity"), revision: 1 };
      this.db.run(
        "INSERT INTO browser_environment_identities(id,environment_id,realm) VALUES(?,?,?)",
        identity.id,
        environmentId,
        info.realm,
      );
    }
    this.db.run(
      "INSERT INTO browser_environment_accounts(kind,account_id,environment_id,identity_id,realm,platform,uid,verified_revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,account_id) DO UPDATE SET environment_id=excluded.environment_id,identity_id=excluded.identity_id,realm=excluded.realm,platform=excluded.platform,uid=excluded.uid,verified_revision=excluded.verified_revision",
      ref.kind,
      ref.id,
      environmentId,
      identity.id,
      info.realm,
      info.platform,
      info.uid,
      verified ? identity.revision : 0,
    );
  }
  private migrateLegacy() {
    this.db.transaction(() => {
      for (const row of this.db.all<{
        id: string;
        provider: string;
        alias: string;
      }>("SELECT id,provider,alias FROM website_accounts")) {
        const ref = { kind: "website" as const, id: row.id };
        if (this.linkRow(ref)) continue;
        const hash = createHash("sha256")
          .update(`${this.workspace}\0${row.provider}\0${row.id}`)
          .digest("hex")
          .slice(0, 24);
        this.attach(
          ref,
          this.register(
            `${row.alias} · 原环境`,
            "electron",
            `persist:panxu-${row.provider === "weibo" ? "weibo" : "website"}-${hash}`,
          ).id,
          true,
        );
      }
      for (const row of this.db.all<{ id: string; data: string }>(
        "SELECT id,data FROM zhidao_accounts",
      )) {
        const ref = { kind: "zhidao" as const, id: row.id };
        if (!this.linkRow(ref))
          this.attach(
            ref,
            this.register(
              `${JSON.parse(row.data).alias} · 原环境`,
              "electron",
              `persist:panxu-zhidao-${row.id}`,
            ).id,
            true,
          );
      }
      for (const row of this.db.all<{
        id: string;
        alias: string;
        window_id: string;
        website_account_id: string | null;
      }>(
        "SELECT id,alias,window_id,website_account_id FROM browser_bindings",
      )) {
        if (row.website_account_id || !row.window_id) continue;
        const ref = { kind: "binding" as const, id: row.id };
        if (!this.linkRow(ref))
          this.attach(
            ref,
            this.register(
              `${row.alias} · 指纹环境`,
              "bitbrowser",
              row.window_id,
            ).id,
            true,
          );
      }
    });
  }
  registerAccount(ref: EnvironmentAccountRef, environmentId?: string) {
    if (
      environmentId &&
      (this.leases.has(environmentId) || this.queuedBusy(environmentId))
    )
      throw new AppError(
        "ENVIRONMENT_BUSY",
        "此环境正在执行操作，请完成后再添加账号。",
      );
    const environment = environmentId
      ? this.get(environmentId)
      : this.register(
          `${this.accountInfo(ref).alias} · 环境`,
          "electron",
          `persist:panxu-environment-${id("profile")}`,
        );
    this.attach(ref, environment.id);
    return environment;
  }
  syncBinding(bindingId: string) {
    const row = this.db.get<{
      alias: string;
      window_id: string;
      website_account_id: string | null;
    }>(
      "SELECT alias,window_id,website_account_id FROM browser_bindings WHERE id=?",
      bindingId,
    );
    if (!row || row.website_account_id || !row.window_id) return;
    const ref = { kind: "binding" as const, id: bindingId },
      env = this.register(
        `${row.alias} · 指纹环境`,
        "bitbrowser",
        row.window_id,
      );
    if (this.linkRow(ref)?.environment_id !== env.id) this.attach(ref, env.id);
  }
  stamp(ref: EnvironmentAccountRef): EnvironmentStamp {
    const link = this.link(ref),
      env = this.get(link.environmentId);
    const identity = this.db.get<{ revision: number }>(
      "SELECT revision FROM browser_environment_identities WHERE id=?",
      link.identityId,
    )!;
    return {
      environmentId: env.id,
      revision: env.revision,
      identityId: link.identityId,
      identityRevision: identity.revision,
    };
  }
  assertStamp(ref: EnvironmentAccountRef, expected?: EnvironmentStamp) {
    if (
      !expected ||
      JSON.stringify(this.stamp(ref)) !== JSON.stringify(expected)
    )
      throw new AppError(
        "ENVIRONMENT_CHANGED",
        "账号环境或登录身份已变化，请重新准备内容后再提交。",
      );
  }
  identityCurrent(ref: EnvironmentAccountRef) {
    return this.link(ref).verifiedRevision === this.stamp(ref).identityRevision;
  }
  confirm(ref: EnvironmentAccountRef, uid: string) {
    const link = this.link(ref);
    if (link.uid && link.uid !== uid)
      throw new AppError(
        "ENVIRONMENT_UID_MISMATCH",
        "当前环境登录了其他身份，请登录原账号后重新检查。",
      );
    this.db.run(
      "UPDATE browser_environment_accounts SET uid=?,verified_revision=? WHERE kind=? AND account_id=?",
      uid,
      this.stamp(ref).identityRevision,
      ref.kind,
      ref.id,
    );
  }
  /** Confirm a local document workspace session without manufacturing an external UID. */
  confirmSession(ref: EnvironmentAccountRef) {
    if (ref.kind !== "website" || !["feishu", "tencent-docs", "shimo"].includes(this.accountInfo(ref).platform))
      throw new AppError("ENVIRONMENT_SESSION_PLATFORM", "此平台需要核实真实账号身份。");
    this.db.run(
      "UPDATE browser_environment_accounts SET verified_revision=? WHERE kind=? AND account_id=?",
      this.stamp(ref).identityRevision, ref.kind, ref.id,
    );
  }
  invalidateIdentity(ref: EnvironmentAccountRef) {
    this.db.run(
      "UPDATE browser_environment_identities SET revision=revision+1 WHERE id=?",
      this.link(ref).identityId,
    );
    this.changed();
  }
  async runtime(environmentId: string): Promise<BrowserEnvironmentRuntime> {
    const env = this.get(environmentId),
      raw = await this.secrets.get(`environment:${environmentId}:proxy`);
    return { ...env, ...(raw ? { credentials: JSON.parse(raw) } : {}) };
  }
  run<T>(ref: EnvironmentAccountRef, action: () => Promise<T>): Promise<T> {
    return this.runEnvironment(
      this.forAccount(ref).id,
      `${ref.kind}:${ref.id}`,
      action,
    );
  }
  async runEnvironment<T>(
    environmentId: string,
    owner: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const held = this.leases.get(environmentId);
    if (held && this.leaseScope.getStore()?.get(environmentId) === held)
      return action();
    if (this.leases.has(environmentId))
      throw new AppError(
        "ENVIRONMENT_BUSY",
        "该浏览器环境正在执行其他平台操作，请等待完成后重试。",
      );
    const token = Symbol(owner),
      scope = new Map(this.leaseScope.getStore());
    scope.set(environmentId, token);
    this.leases.set(environmentId, token);
    try {
      return await this.leaseScope.run(scope, async () => {
        await this.refreshExternal(environmentId);
        await this.ports.browserEnvironments?.prepare(
          await this.runtime(environmentId),
        );
        if (this.get(environmentId).requireProxy)
          await this.probeNetwork(environmentId);
        return action();
      });
    } finally {
      this.leases.delete(environmentId);
      this.changed();
      this.released();
    }
  }
  async runMany<T>(
    refs: EnvironmentAccountRef[],
    action: () => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(refs.map((ref) => this.forAccount(ref).id))].sort();
    if (!this.available(ids))
      throw new AppError(
        "ENVIRONMENT_BUSY",
        "关联浏览器环境正在执行其他操作。",
      );
    const scope = new Map(this.leaseScope.getStore());
    for (const id of ids) {
      const token = Symbol("scheduled");
      scope.set(id, token);
      this.leases.set(id, token);
    }
    try {
      return await this.leaseScope.run(scope, async () => {
        for (const id of ids) {
          await this.refreshExternal(id);
          await this.ports.browserEnvironments?.prepare(await this.runtime(id));
          if (this.get(id).requireProxy) await this.probeNetwork(id);
        }
        return action();
      });
    } finally {
      for (const id of ids) this.leases.delete(id);
      this.changed();
      this.released();
    }
  }
  private async assertIdle(environmentId: string) {
    for (const guard of this.guards) guard(this.refs(environmentId));
    await this.ports.browserEnvironments?.assertIdle(this.get(environmentId));
    const environment = this.get(environmentId);
    if (environment.engine === "bitbrowser")
      await this.externalIdle?.(environment.profileId);
  }
  /** Window controls must also work when proxy/configuration checks are failing. */
  async controlWindow<T>(environmentId: string, action: () => Promise<T>, expectedRevision?: number) {
    if (this.leases.has(environmentId) || this.queuedBusy(environmentId))
      throw new AppError("ENVIRONMENT_BUSY", "此环境正在操作或排队，请在对应业务处理后再关闭窗口。");
    for (const guard of this.guards) guard(this.refs(environmentId));
    const env = this.get(environmentId);
    if (expectedRevision !== undefined && env.revision !== expectedRevision)
      throw new AppError("ENVIRONMENT_CHANGED", "环境在确认期间发生变化，请重新检查后关闭。");
    this.leases.set(environmentId, Symbol("window-control"));
    try {
      return await action();
    } finally {
      // Even an uncertain close result must revoke prepared browser operations.
      try {
        const current = this.get(environmentId);
        this.persist({ ...current, revision: current.revision + 1, updatedAt: now() });
      } finally {
        this.leases.delete(environmentId);
        this.changed();
        this.released();
      }
    }
  }
  private async mutate<T>(ids: string[], action: () => Promise<T>) {
    const unique = [...new Set(ids)].sort();
    if (unique.some((id) => this.leases.has(id) || this.queuedBusy(id)))
      throw new AppError(
        "ENVIRONMENT_BUSY",
        "此环境正在操作或排队，请完成后再修改配置或账号关联。",
      );
    for (const id of unique) this.leases.set(id, Symbol("configuration"));
    try {
      for (const id of unique) await this.assertIdle(id);
      return await action();
    } finally {
      for (const id of unique) this.leases.delete(id);
      this.changed();
      this.released();
    }
  }
  async save(input: EnvironmentSaveInput) {
    return this.mutate(input.id ? [input.id] : [], () =>
      this.saveWithinLease(input),
    );
  }
  private async saveWithinLease(input: EnvironmentSaveInput) {
    if (input.engine === "bitbrowser" && input.expectedConnectorKey !== undefined &&
      input.expectedConnectorKey !== this.db.setting("bitUrl", ""))
      throw new AppError("BIT_CONNECTION_CHANGED", "比特连接地址已变化，请重新读取窗口列表后接入。");
    const old = input.id ? this.get(input.id) : null;
    if (
      old &&
      input.expectedRevision !== undefined &&
      input.expectedRevision !== old.revision
    )
      throw new AppError(
        "ENVIRONMENT_EDIT_STALE",
        "环境配置已更新，请重新打开编辑，避免覆盖新配置。",
      );
    if (
      old &&
      (old.engine !== input.engine ||
        (input.profileId && old.profileId !== input.profileId))
    )
      throw new AppError(
        "ENVIRONMENT_ENGINE_FIXED",
        "已有环境的引擎与持久配置不能替换，请新建环境后关联账号。",
      );
    if (input.engine === "bitbrowser" && !input.profileId)
      throw new AppError(
        "ENVIRONMENT_PROFILE_REQUIRED",
        "请选择要接入的比特浏览器配置。",
      );
    if (
      input.engine === "bitbrowser" &&
      (input.proxy || input.proxyPassword || input.proxyUsername)
    )
      throw new AppError(
        "ENVIRONMENT_PROXY_EXTERNAL",
        "指纹环境的代理与指纹请在比特客户端统一配置。",
      );
    if (
      input.proxy?.mode === "socks5" &&
      (input.proxyUsername || input.proxyPassword)
    )
      throw new AppError(
        "ENVIRONMENT_PROXY_AUTH_UNSUPPORTED",
        "内置浏览器暂不支持带密码的 SOCKS5，请使用 HTTP 代理或指纹环境。",
      );
    if (
      input.engine === "electron" &&
      input.requireProxy &&
      (input.proxy?.mode ?? old?.proxy?.mode ?? "direct") === "direct"
    )
      throw new AppError(
        "ENVIRONMENT_PROXY_REQUIRED",
        "要求独立代理时，请先配置 HTTP 或 SOCKS5 代理。",
      );
    if (
      (input.proxyUsername !== undefined ||
        input.proxyPassword !== undefined) &&
      (!input.proxyUsername || !input.proxyPassword)
    )
      throw new AppError(
        "ENVIRONMENT_PROXY_CREDENTIALS",
        "代理用户名与密码需要同时填写。",
      );
    const duplicate =
      input.profileId &&
      this.db.get<{ id: string }>(
        "SELECT id FROM browser_environments WHERE engine=? AND profile_id=?",
        input.engine,
        input.profileId,
      );
    if (duplicate && duplicate.id !== old?.id)
      throw new AppError(
        "ENVIRONMENT_PROFILE_DUPLICATE",
        "此持久配置已登记，请使用已有环境。",
      );
    const time = now();
    const env: BrowserEnvironment = old ?? {
      id: id("env"),
      name: input.name,
      engine: input.engine,
      profileId:
        input.engine === "electron"
          ? `persist:panxu-environment-${id("profile")}`
          : input.profileId!,
      revision: 1,
      proxy: input.engine === "electron" ? { mode: "direct" } : null,
      fingerprint: input.engine === "electron" ? "native" : "external",
      ...(input.engine === "bitbrowser" ? { connectorKey: this.db.setting("bitUrl", "") } : {}),
      hasProxyCredentials: false,
      createdAt: time,
      updatedAt: time,
    };
    const scopeChanged =
      !!old &&
      (JSON.stringify(input.proxy ?? old.proxy) !== JSON.stringify(old.proxy) ||
        input.proxyUsername !== undefined ||
        input.proxyPassword !== undefined ||
        input.clearProxyCredentials ||
        (input.requireProxy ?? old.requireProxy) !== old.requireProxy);
    if (input.proxyUsername !== undefined)
      await this.secrets.set(
        `environment:${env.id}:proxy`,
        JSON.stringify({
          username: input.proxyUsername,
          password: input.proxyPassword,
        }),
      );
    else if (input.clearProxyCredentials || input.proxy?.mode === "direct" || input.proxy?.mode === "socks5")
      this.secrets.remove(`environment:${env.id}:proxy`);
    this.persist({
      ...env,
      name: input.name,
      proxy: input.engine === "electron" ? (input.proxy ?? env.proxy) : null,
      requireProxy: input.requireProxy ?? old?.requireProxy ?? false,
      revision: env.revision + (scopeChanged ? 1 : 0),
      updatedAt: now(),
    });
    if (scopeChanged)
      this.db.run(
        "UPDATE browser_environment_identities SET revision=revision+1 WHERE environment_id=?",
        env.id,
      );
    this.changed();
    return this.get(env.id);
  }
  async bind(ref: EnvironmentAccountRef, environmentId?: string) {
    const old = this.link(ref);
    if (old.environmentId === environmentId) return this.get(environmentId);
    return this.mutate([old.environmentId, ...(environmentId ? [environmentId] : [])], async () => {
      const related = this.db
        .all<{ kind: EnvironmentAccountRef["kind"]; account_id: string }>(
          "SELECT kind,account_id FROM browser_environment_accounts WHERE identity_id=?",
          old.identityId,
        )
        .map((row) => ({ kind: row.kind, id: row.account_id }));
      const target = this.db.transaction(() => {
        // Create and attach together: a failed migration must not leave an empty environment.
        const environment = environmentId
          ? this.get(environmentId)
          : this.register(
              `${this.accountInfo(ref).alias} · 内置环境`,
              "electron",
              `persist:panxu-environment-${id("profile")}`,
            );
        for (const account of related) {
          this.attach(account, environment.id);
          if (account.kind === "binding") {
            const env = environment;
            const binding = this.db.get<{ platform: string; website_account_id: string | null }>(
              "SELECT platform,website_account_id FROM browser_bindings WHERE id=?", account.id,
            );
            if (env.engine !== "bitbrowser" && !(binding?.platform === "weibo" && binding.website_account_id))
              throw new AppError(
                "ENVIRONMENT_ENGINE_UNSUPPORTED",
                "此发布映射目前需要指纹环境。",
              );
            this.db.run(
              "UPDATE browser_bindings SET window_id=?,verified_at=NULL,last_checked_at=NULL WHERE id=?",
              env.engine === "bitbrowser" ? env.profileId : "",
              account.id,
            );
          }
        }
        return environment;
      });
      this.changed();
      return this.get(target.id);
    });
  }
  detach(ref: EnvironmentAccountRef) {
    this.db.run(
      "DELETE FROM browser_environment_accounts WHERE kind=? AND account_id=?",
      ref.kind,
      ref.id,
    );
  }
  private async probeNetwork(environmentId: string) {
    const env = await this.runtime(environmentId);
    const ip =
      env.engine === "bitbrowser"
        ? await this.externalNetwork?.(env.profileId)
        : await this.ports.browserEnvironments?.checkNetwork?.(env);
    if (!ip || !isIP(ip))
      throw new AppError(
        "ENVIRONMENT_NETWORK_UNKNOWN",
        "未能确认环境实际出口 IP，已阻止任务继续；请检查网络后重试。",
      );
    const duplicate =
      env.requireProxy &&
      this.list().find(
        (other) =>
          other.id !== env.id &&
          other.requireProxy &&
          other.network?.revision === other.revision &&
          other.network.ip === ip,
      );
    if (duplicate)
      throw new AppError(
        "ENVIRONMENT_IP_DUPLICATE",
        `此环境与“${duplicate.name}”使用相同出口 IP，请调整代理后重试。`,
      );
    const changed = !!env.network && env.network.ip !== ip;
    const revision = env.revision + (changed ? 1 : 0);
    this.persist({
      ...this.get(environmentId),
      revision,
      network: { ip, checkedAt: now(), revision },
    });
    if (changed)
      this.db.run(
        "UPDATE browser_environment_identities SET revision=revision+1 WHERE environment_id=?",
        env.id,
      );
    return this.get(environmentId);
  }
  checkNetwork(environmentId: string) {
    return this.runEnvironment(environmentId, "network-check", () =>
      this.get(environmentId).requireProxy
        ? Promise.resolve(this.get(environmentId))
        : this.probeNetwork(environmentId),
    );
  }
  async remove(environmentId: string) {
    return this.mutate([environmentId], async () => {
      if (this.refs(environmentId).length)
        throw new AppError(
          "ENVIRONMENT_HAS_ACCOUNTS",
          "此环境仍有关联账号，请先移除或迁移账号；登录数据不会自动清理。",
        );
      this.db.transaction(() => {
        this.db.run(
          "DELETE FROM browser_environment_identities WHERE environment_id=?",
          environmentId,
        );
        this.db.run(
          "DELETE FROM browser_environments WHERE id=?",
          environmentId,
        );
      });
      this.secrets.remove(`environment:${environmentId}:proxy`);
      this.changed();
      return true;
    });
  }
}
