import { createBrowserPlatformPorts } from "./browser-platform-ports";
import { SmzdmArticles } from "./smzdm/service";
import { PipixSources } from "./pipix/service";
import { ZhihuOperations } from "./zhihu/service";
import { BitBrowserManagement } from "./bitbrowser-management";
import { createEnvironmentStatus } from "./browser-environment-status";
import { BrowserEnvironments } from "./browser-environments";
import { BrowserEnvironmentQueue } from "./browser-environment-queue";
import { ResourceAnswers } from "./resource-answers";
import { Distribution } from "./distribution";
import { verifyRecordedOwnShare } from "./owned-resource-intake";
import { InsertionService } from "./insertion";
import { DriveFiles } from "./drive-files";
import { WebsiteAccounts } from "./website-accounts";
import { ZhidaoOperations } from "./zhidao/service";
import { createApplicationHandlers } from "./ipc";
import type { AppPorts } from "./ports";
export type { AppPorts } from "./ports";
import { PublicationChecks } from "./publication-checks";
import {
  bindingEditorUrl,
  hasVerifiedFormat,
  linkPositionLabels,
  type ContentFormat,
  type LinkPosition,
} from "../shared/channels";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { Database, id, now } from "./database";
import { Repository } from "./repository";
import { SecretStore, type SecretCodec } from "./secrets";
import { AccountMutex, TransferQueue } from "./queue";
import { NoteExporter } from "./notes";
import { AiService } from "./ai";
import { KeywordIdeas } from "./ideas";
import { ResourceExports } from "./resource-export";
import { StudioService, studioAssetPattern } from "./studio";
import { TrafficService } from "./traffic";
import { BitBrowser } from "./bitbrowser";
import { CsdnWorkflows } from "./csdn/workflow";
import { CsdnBrowserEditor } from "./csdn/editor";
import { WeiboMarketing } from "./weibo/marketing";
import { WeiboPosts } from "./weibo/posts";
import { WeiboStatistics } from "./weibo/statistics";
import {
  canUseLinkPosition,
  includesOwnShareLink,
} from "../shared/publication";
import { BulkImporter } from "./bulk";
import { Operations } from "./operations";
import { SearchOperations } from "./search";
import { ShareStatisticsService } from "./share-statistics";
import { AppError, safeMessage } from "./errors";
import { driveCapacitySchema } from "../shared/drive-capacity";
import { parseShare, validateOutgoingLinks } from "./links";
import { normalizedDirectory, type DriveProvider } from "./providers/provider";
import type {
  Account,
  BrowserBinding,
  Provider,
  ResourceInput,
  ResourceCopy,
  ShareCheck,
} from "../shared/types";

export class AppService {
  readonly smzdm: SmzdmArticles;
  readonly distribution: Distribution;
  readonly zhihu: ZhihuOperations;
  readonly pipix: PipixSources;
  readonly weiboPosts: WeiboPosts;
  readonly weiboStatistics: WeiboStatistics;
  readonly weibo: WeiboMarketing;
  readonly csdn: CsdnWorkflows;
  readonly csdnEditor: CsdnBrowserEditor;
  readonly websiteAccounts: WebsiteAccounts;
  readonly environments: BrowserEnvironments;
  readonly environmentQueue: BrowserEnvironmentQueue;
  readonly driveFiles: DriveFiles;
  readonly zhidao: ZhidaoOperations;
  readonly db: Database;
  readonly repo: Repository;
  readonly secrets: SecretStore;
  readonly queue: TransferQueue;
  readonly notes: NoteExporter;
  readonly ai: AiService;
  readonly ideas: KeywordIdeas;
  readonly resourceExports: ResourceExports;
  readonly studio: StudioService;
  readonly resourceAnswers: ResourceAnswers;
  readonly traffic: TrafficService;
  readonly bit: BitBrowser;
  readonly bitManagement: BitBrowserManagement;
  readonly importer: BulkImporter;
  readonly operations: Operations;
  readonly insertion: InsertionService;
  readonly search: SearchOperations;
  readonly shareStatistics: ShareStatisticsService;
  readonly publicationChecks: PublicationChecks;
  private readonly handlers: ReturnType<typeof createApplicationHandlers>;
  private switchingWorkspace = false;
  private capacityRequests = new Map<string, Promise<Account>>();
  readonly mutex = new AccountMutex();
  constructor(
    readonly dataPath: string,
    codec: SecretCodec,
    private providers: Record<Provider, DriveProvider>,
    private ports: AppPorts,
    private changed: () => void,
    dbPath = join(dataPath, "panxu.db"),
  ) {
    this.db = new Database(dbPath);
    this.repo = new Repository(this.db);
    this.distribution = new Distribution(this.db, ports, async source => {
      const result = await this.invoke(source.splitItemId ? "split.link" : "copy.link", source.splitItemId ? { itemId: source.splitItemId } : { copyId: source.copyId }) as { text: string };
      return result.text;
    }, changed);
    this.secrets = new SecretStore(this.db, codec);
    this.environments = new BrowserEnvironments(this.db, this.secrets, ports, dataPath, changed);
    this.environmentQueue = new BrowserEnvironmentQueue(this.db, this.environments, changed);
    const browserPorts = createBrowserPlatformPorts(ports, this.environments, () => this.bit);
    this.ports = browserPorts;
    this.websiteAccounts = new WebsiteAccounts(this.db, browserPorts, changed, this.environments, this.environmentQueue);
    this.zhihu = new ZhihuOperations({db: this.db, accounts: this.websiteAccounts, environments: this.environments, queue: this.environmentQueue, ports: browserPorts, dataPath, changed});
    this.weiboPosts = new WeiboPosts({ db: this.db, accounts: this.websiteAccounts, dataPath: this.dataPath, ports: browserPorts, changed });
    this.pipix = new PipixSources({ db: this.db, dataPath, ports: browserPorts, secrets: this.secrets, changed, destinations: {
      zhihu: material => this.zhihu.saveSource(material),
      weibo: (material, accountId) => this.weiboPosts.saveSource(material, accountId),
    } });
    this.notes = new NoteExporter(this.repo, this.secrets, dataPath);
    this.queue = new TransferQueue(
      this.repo,
      providers,
      this.secrets,
      this.notes,
      this.mutex,
      changed,
    );
    this.ai = new AiService(this.repo, this.secrets, changed);
    this.smzdm = new SmzdmArticles({
      repo: this.repo,
      secrets: this.secrets,
      ai: this.ai,
      accounts: this.websiteAccounts,
      port: browserPorts.smzdm,
      saveResource: (input) => this.saveResource(input),
      assertOwnCopy: (copy) => this.assertOwnCopy(copy),
      checkShare: (copyId) => this.checkShare(copyId),
      environmentStamp: (accountId) => this.environments.stamp({kind: "website", id: accountId}),
      changed,
    });
    this.zhidao = new ZhidaoOperations(
      this.repo,
      this.secrets,
      this.ai,
      this.ports,
      dataPath,
      changed,
      {
        environments: this.environments,
        schedule: (refs, label, action, signal) => this.environmentQueue.schedule(refs, label, action, signal),
        verifyCopy: async (copyId) => {
          const check = await this.checkShare(copyId);
          if (check.status !== "valid")
            throw new AppError(
              "SHARE_INVALID",
              "本人分享未通过实时核验，请检查后再生成或发布。",
            );
        },
      },
    );
    this.ideas = new KeywordIdeas(this.repo, this.ai, changed);
    this.resourceExports = new ResourceExports(this.repo, this.ai, changed);
    this.studio = new StudioService(
      this.repo,
      this.secrets,
      this.ai,
      dataPath,
      (bytes) => ports.normalizeCover(bytes),
      changed,
    );
    this.resourceAnswers = new ResourceAnswers(this.repo,this.ai,this.studio,ports,changed);
    this.traffic = new TrafficService(this.db, this.secrets, changed);
    this.bit = new BitBrowser(async () => ({
      url: this.db.setting("bitUrl", ""),
      key: await this.secrets.get("bit"),
    }), undefined, (binding, action) => {
      this.environments.syncBinding(binding.id);
      return this.environments.run({ kind: "binding", id: binding.id }, action);
    });
    this.environments.setExternalConfigurationReader((profileId) => this.bit.environmentConfiguration(profileId));
    this.environments.setExternalNetworkChecker((profileId) => this.bit.environmentExitIp(profileId));
    this.environments.setExternalIdleGuard((profileId) => this.bit.assertProfileIdle(profileId));
    this.importer = new BulkImporter(this.repo, (input) =>
      this.saveResource(input),
    );
    this.operations = new Operations(
      this.repo,
      providers,
      this.secrets,
      this.notes,
      (id) => this.verifyAccount(id),
      changed,
    );
    this.insertion = new InsertionService(
      this.db,
      this.repo,
      (id, fn) => this.authenticated(id, fn),
      changed,
      (id) => this.assertNoActiveJobs(id),
    );
    this.search = new SearchOperations(this.repo, this.operations, changed);
    this.publicationChecks = new PublicationChecks(
      this.repo,
      this.search,
      changed,
    );
    this.csdnEditor = new CsdnBrowserEditor(this.bit);
    this.csdn = new CsdnWorkflows({
      environmentStamp: (bindingId) => this.environments.stamp({ kind: "binding", id: bindingId }),
      withEnvironment: (bindingId, action) => {
        this.environments.syncBinding(bindingId);
        return this.environmentQueue.schedule([{ kind: "binding", id: bindingId }], "CSDN 内容操作", action);
      },
      repo: this.repo,
      search: this.search,
      ai: this.ai,
      editor: this.csdnEditor,
      verifyTarget: async (topicId) => {
        const result = await this.invoke("search.check", { id: topicId }) as ShareCheck;
        if (result.status && result.status !== "valid") throw new AppError("SHARE_INVALID", result.message || "配套本人分享未通过实时核验，请先恢复分享。");
      },
      contentPackage: (draftId, bindingId, includeLink) => this.contentPackage(draftId, bindingId, includeLink),
      record: (input) => this.invoke("publication.mark", input),
      changed,
    });
    this.weibo = new WeiboMarketing({
      repo: this.repo,
      search: this.search,
      ai: this.ai,
      studio: this.studio,
      websiteAccounts: this.websiteAccounts,
      dataPath: this.dataPath,
      ports: this.ports,
      verifyTarget: async (topicId) => {
        const result = await this.invoke("search.check", { id: topicId }) as ShareCheck;
        if (result.status !== "valid") throw new AppError("SHARE_INVALID", result.message || "配套本人分享未通过实时核验。");
      },
      contentPackage: (draftId, bindingId, includeLink) => this.contentPackage(draftId, bindingId, includeLink),
      record: (input) => this.invoke("publication.mark", input),
      changed,
    });
    this.shareStatistics = new ShareStatisticsService(
      this.repo,
      (id, fn) => this.authenticated(id, fn),
      changed,
    );
    for (const kind of [
      "batch_inspect",
      "split_preview",
      "split_share",
    ] as const)
      this.queue.workers[kind] = (jobId) => this.operations.execute(jobId);
    this.queue.onAccountBlocked = (accountId, stage, message) =>
      this.operations.pauseAccount(accountId, stage, message);
    this.driveFiles = new DriveFiles({
      material: (id) => this.insertion.materialDetail(id),
      db: this.db,
      repo: this.repo,
      secrets: this.secrets,
      changed,
      authenticated: (id, action) => this.authenticated(id, action),
      assertNoActiveJobs: (id) => this.assertNoActiveJobs(id),
    });
    this.environments.addGuard((refs) => {
      for (const ref of refs) {
        if (ref.kind === "zhidao") this.zhidao.assertAccountIdle(ref.id);
        if (ref.kind === "website" && (this.websiteAccounts.isBusy || this.weiboPosts.isBusy || this.weibo.isBusy)) throw new AppError("ENVIRONMENT_BUSY", "此环境的平台任务正在执行，请完成后再修改。");
        if (ref.kind === "binding" && this.csdn.isBusy) throw new AppError("ENVIRONMENT_BUSY", "发布任务正在执行，请完成后再修改环境。");
      }
    });
    const environmentStatus = createEnvironmentStatus({
      db: this.db,
      environments: this.environments,
      posts: () => this.weiboPosts.list(),
      marketing: () => this.weibo.history(),
      csdn: () => this.csdn.history(),
    });
    this.bitManagement = new BitBrowserManagement({
      bit: this.bit,
      environments: this.environments,
      connector: () => this.db.setting("bitUrl", ""),
      accountState: (ref) => environmentStatus.account(ref),
      pendingOperations: (refs) => environmentStatus.pending(refs),
      openAccount: async (ref) => {
        if (ref.kind === "website") return this.websiteAccounts.login(ref.id);
        if (ref.kind === "zhidao") return this.zhidao.login(ref.id);
        const binding = this.repo.bindings().find((binding) => binding.id === ref.id);
        if (!binding) throw new AppError("NOT_FOUND", "发布账号映射不存在，请刷新后重试。");
        return this.openBinding(binding);
      },
    });
    this.weiboStatistics = new WeiboStatistics({ db: this.db, accounts: this.websiteAccounts, ports: this.ports, changed, posts: (accountId) => this.weiboPosts.list(accountId), marketing: () => this.weibo.history() });
    this.handlers = createApplicationHandlers({
      smzdm: this.smzdm,
      distribution: this.distribution,
      zhihu: this.zhihu,
      pipix: this.pipix,
      weiboStatistics: this.weiboStatistics,
      bitManagement: this.bitManagement,
      environments: this.environments,
      environmentQueue: this.environmentQueue,
      weibo: this.weibo,
      weiboPosts: this.weiboPosts,
      csdn: this.csdn,
      websiteAccounts: this.websiteAccounts,
      driveFiles: this.driveFiles,
      zhidao: this.zhidao,
      db: this.db,
      repo: this.repo,
      secrets: this.secrets,
      queue: this.queue,
      notes: this.notes,
      ai: this.ai,
      ideas: this.ideas,
      resourceExports: this.resourceExports,
      studio: this.studio,
      resourceAnswers: this.resourceAnswers,
      traffic: this.traffic,
      bit: this.bit,
      importer: this.importer,
      operations: this.operations,
      insertion: this.insertion,
      search: this.search,
      shareStatistics: this.shareStatistics,
      publicationChecks: this.publicationChecks,
      dataPath: this.dataPath,
      ports: this.ports,
      changed: () => this.changed(),
      snapshot: (resourceId) => this.snapshot(resourceId),
      account: (id) => this.account(id),
      authenticated: (id, fn) => this.authenticated(id, fn),
      assertNoActiveJobs: (id) => this.assertNoActiveJobs(id),
      refreshCapacity: (id) => this.refreshCapacity(id),
      assertOwnCopy: (copy) => this.assertOwnCopy(copy),
      checkShare: (id) => this.checkShare(id),
      saveResource: (input) => this.saveResource(input),
      openBinding: (binding, format) => this.openBinding(binding, format),
      contentPackage: (draft, binding, includeLink, position) =>
        this.contentPackage(draft, binding, includeLink, position),
      hasRunningJobs: () => this.hasRunningJobs(),
      backup: () => this.backup(),
      setSwitchingWorkspace: (switching) => {
        this.switchingWorkspace = switching;
      },
      invoke: (method, raw) => this.invoke(method, raw),
    });
  }
  snapshot(resourceId?: string) {
    return this.repo.snapshot(
      (key) => this.secrets.has(key),
      this.dataPath,
      resourceId,
    );
  }
  assertUpdateIdle(activeOperations = 0) {
    if (
      this.switchingWorkspace ||
      activeOperations ||
      this.queue.isBusy ||
      this.hasRunningJobs() ||
      this.ports.collectionWebSession?.isOpen()
    )
      throw new AppError(
        "UPDATE_TASKS_RUNNING",
        "仍有任务、网页采集窗口、工作空间切换或其他操作正在进行，请完成或关闭后再安装更新。",
      );
  }
  private account(id: string) {
    const a = this.repo.getAccount(id);
    if (!a.enabled)
      throw new AppError("ACCOUNT_DISABLED", "该账号已停用，请先启用。");
    return a;
  }
  private async verifyAccount(accountId: string) {
    try {
      const account = this.account(accountId),
        identity = await this.providers[account.provider].identity(account);
      if (account.uid && identity.uid !== account.uid)
        throw new AppError(
          "ACCOUNT_UID_MISMATCH",
          "此登录窗口的UID与原账号不同。请退出后登录原账号，或新建账号记录。",
        );
      const duplicate = this.repo
        .accounts()
        .find(
          (a) =>
            a.id !== account.id &&
            a.provider === account.provider &&
            a.uid === identity.uid,
        );
      if (duplicate)
        throw new AppError(
          "DUPLICATE_ACCOUNT",
          `此UID已绑定「${duplicate.alias}」，请使用该账号记录。`,
        );
      this.db.run(
        "UPDATE accounts SET uid=?,status=?,verified_at=?,error=NULL,updated_at=? WHERE id=?",
        identity.uid,
        "connected",
        now(),
        now(),
        account.id,
      );
      this.changed();
      return this.repo.getAccount(account.id);
    } catch (error) {
      this.db.run(
        "UPDATE accounts SET status=CASE WHEN ? THEN 'expired' ELSE status END,error=?,updated_at=? WHERE id=?",
        Number(
          error instanceof AppError &&
            [
              "AUTH_EXPIRED",
              "ACCOUNT_UID_MISMATCH",
              "DUPLICATE_ACCOUNT",
            ].includes(error.code),
        ),
        safeMessage(error),
        now(),
        accountId,
      );
      this.changed();
      throw error;
    }
  }
  private capacityError(accountId: string, error: unknown) {
    const account = this.repo.getAccount(accountId);
    if (!account.enabled || !account.uid) return;
    this.db.setSetting(`account:capacity:${accountId}`, {
      ownerUid: account.uid,
      value: account.capacity?.value ?? null,
      updatedAt: account.capacity?.updatedAt ?? null,
      attemptedAt: now(),
      error: safeMessage(error),
    });
    this.changed();
  }
  private async readCapacity(account: Account) {
    try {
      const provider = this.providers[account.provider];
      if (!provider.capacity)
        throw new AppError(
          "CAPACITY_UNSUPPORTED",
          "当前网盘连接尚不支持容量查询。",
        );
      const parsed = driveCapacitySchema.safeParse(
        await provider.capacity(account),
      );
      if (!parsed.success)
        throw new AppError(
          "CAPACITY_UNAVAILABLE",
          "网盘返回的容量数据不完整，请稍后刷新。",
        );
      const current = this.repo.getAccount(account.id);
      if (!current.enabled || current.uid !== account.uid) return current;
      const time = now();
      this.db.setSetting(`account:capacity:${account.id}`, {
        ownerUid: account.uid,
        value: parsed.data,
        updatedAt: time,
        attemptedAt: time,
        error: null,
      });
      this.changed();
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_EXPIRED") {
        this.db.run(
          "UPDATE accounts SET status='expired',error=?,updated_at=? WHERE id=?",
          safeMessage(error),
          now(),
          account.id,
        );
      }
      this.capacityError(account.id, error);
    }
    return this.repo.getAccount(account.id);
  }
  private refreshCapacity(accountId: string): Promise<Account> {
    const pending = this.capacityRequests.get(accountId);
    if (pending) return pending;
    const task = this.mutex.run(accountId, async () => {
      let account: Account;
      try {
        account = await this.verifyAccount(accountId);
      } catch (error) {
        this.capacityError(accountId, error);
        throw error;
      }
      return this.readCapacity(account);
    });
    this.capacityRequests.set(accountId, task);
    void task
      .finally(() => this.capacityRequests.delete(accountId))
      .catch(() => {});
    return task;
  }
  async authenticated<T>(
    accountId: string,
    fn: (account: Account, provider: DriveProvider) => Promise<T>,
  ) {
    return this.mutex.run(accountId, async () => {
      const a = await this.verifyAccount(accountId);
      return fn(a, this.providers[a.provider]);
    });
  }
  async invoke(method: string, raw: unknown = undefined): Promise<unknown> {
    if (this.switchingWorkspace && method !== "snapshot")
      throw new AppError(
        "WORKSPACE_SWITCHING",
        "工作空间正在切换，请等待应用重启。",
      );
    const object = raw ?? {};
    return this.handlers.invoke(method, object);
  }

  private assertNoActiveJobs(accountId: string) {
    if (this.driveFiles?.busyAccount(accountId))
      throw new AppError("ACTIVE_JOBS", "此账号正在管理网盘文件，请等待完成。");
    if (this.insertion?.busyAccount(accountId))
      throw new AppError(
        "ACTIVE_JOBS",
        "此账号正在执行批量插入，请先取消并等待结束。",
      );
    if (
      this.db.get(
        "SELECT j.id FROM jobs j JOIN copies c ON c.id=j.copy_id WHERE c.account_id=? AND j.stage IN ('queued','preflight','transferring','verifying','sharing','archiving') LIMIT 1",
        accountId,
      )
    )
      throw new AppError(
        "ACTIVE_JOBS",
        "此账号有正在执行的任务，请先停止等待并核对远端结果。",
      );
  }
  async saveResource(input: ResourceInput) {
    if (input.isOwnResource && input.enqueue)
      throw new AppError(
        "OWNED_TRANSFER_BLOCKED",
        "自有资源直接入库，不创建转存任务。",
      );
    const source = parseShare(input.sourceText, input.extractionCode),
      account = this.account(input.accountId);
    if (source.provider !== account.provider)
      throw new AppError(
        "CROSS_PROVIDER_UNSUPPORTED",
        "来源与目标账号网盘类型不同，首版仅支持同网盘转存。",
      );
    if (input.enqueue && !input.selectedFiles?.length)
      throw new AppError(
        "SELECTION_REQUIRED",
        "开始转存前，请读取并选择需要保存的文件。",
      );
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM resources WHERE source_url=?",
      source.url,
    );
    const resourceId = input.id ?? existing?.id ?? id("resource");
    if (input.id && this.repo.getResource(input.id).sourceUrl !== source.url)
      throw new AppError(
        "SOURCE_IMMUTABLE",
        "已有资源的来源链接不能直接更换，请新建资源。",
      );
    let coverId: string | null | undefined;
    if (input.coverData === null) coverId = null;
    else if (input.coverData) {
      const match = input.coverData.match(
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match)
        throw new AppError("INVALID_COVER", "仅支持PNG、JPEG、WebP封面。");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 8 * 1024 * 1024)
        throw new AppError("COVER_TOO_LARGE", "封面不能超过8MB。");
      const normalized = await this.ports.normalizeCover(bytes);
      coverId = createHash("sha256").update(normalized).digest("hex");
      await mkdir(join(this.dataPath, "covers"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(this.dataPath, "covers", `${coverId}.png`),
        normalized,
        { mode: 0o600 },
      );
    }
    if (source.code) await this.secrets.set(`source:${resourceId}`, source.code);
    const resourceExists = !!existing || !!input.id;
    let directory = input.isOwnResource
      ? normalizedDirectory(input.directory || "/")
      : normalizedDirectory(input.directory || account.defaultDirectory) +
        "/" +
        input.title
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
          .trim()
          .slice(0, 40) +
        "__" +
        resourceId.slice(-8);
    if (input.copyId) {
      const editedCopy = this.repo.getCopy(input.copyId);
      if (
        editedCopy.resourceId !== resourceId ||
        editedCopy.accountId !== account.id
      )
        throw new AppError(
          "COPY_MISMATCH",
          "编辑资料时不能改绑已有副本账号；请新建该账号的副本。",
        );
      directory = editedCopy.directory;
    }
    const priorCopy =
      input.isOwnResource && !input.copyId
        ? this.db.get<{ id: string; status: string }>(
            "SELECT id,status FROM copies WHERE resource_id=? AND account_id=? ORDER BY created_at LIMIT 1",
            resourceId,
            account.id,
          )
        : this.db.get<{ id: string; status: string }>(
            "SELECT id,status FROM copies WHERE resource_id=? AND account_id=? AND directory=?",
            resourceId,
            account.id,
            directory,
          );
    if (
      input.isOwnResource &&
      priorCopy &&
      !["draft", "recorded"].includes(priorCopy.status) &&
      this.repo.getResource(resourceId).sourceKind !== "owned"
    )
      throw new AppError(
        "COPY_EXISTS",
        "该资源已有转存副本，请保留其原有归档方式，勿改写正在执行或已完成的记录。",
      );
    if (
      input.isOwnResource &&
      priorCopy &&
      !["draft", "recorded", "ready"].includes(priorCopy.status)
    )
      throw new AppError(
        "COPY_EXISTS",
        "该资源仍有转存进度，请先到转存任务中核对。",
      );
    if (
      input.isOwnResource &&
      priorCopy?.status === "ready" &&
      this.repo.getCopy(priorCopy.id).shareUrl !== source.url
    )
      throw new AppError(
        "COPY_EXISTS",
        "此副本使用的是另一条本人分享，请按原有归档方式编辑，不改写已有链接。",
      );
    if (
      input.isOwnResource &&
      priorCopy?.status === "draft" &&
      this.db.get(
        "SELECT id FROM jobs WHERE copy_id=? AND kind='transfer' LIMIT 1",
        priorCopy.id,
      )
    )
      throw new AppError(
        "COPY_EXISTS",
        "该副本已有转存记录，请先核对原任务，不能改为自有资源入库。",
      );
    if (!input.isOwnResource && priorCopy?.status === "recorded")
      throw new AppError(
        "OWNED_TRANSFER_BLOCKED",
        "此记录为已入库的自有资源，请使用自有资源方式编辑。",
      );
    if (input.enqueue && priorCopy && priorCopy.status !== "draft")
      throw new AppError(
        "COPY_EXISTS",
        "该账号和目录已有此资源副本，请到转存任务中核对或恢复，避免重复转存。",
      );
    const copyId = priorCopy?.id ?? id("copy"),
      time = now();
    const ownedCodeChanged = !!(
      input.isOwnResource &&
      priorCopy?.status === "ready" &&
      source.code &&
      (await this.secrets.get(`share:${copyId}`)) !== source.code
    );
    if (input.isOwnResource && source.code)
      await this.secrets.set(`share:${copyId}`, source.code);
    let jobId: string | null = null;
    this.db.transaction(() => {
      if (!resourceExists)
        this.db.run(
          "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,cover_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          resourceId,
          input.title,
          source.url,
          source.shareKey,
          source.provider,
          input.category,
          JSON.stringify(input.tags),
          input.summary,
          coverId ?? null,
          time,
          time,
        );
      else if (input.id)
        this.db.run(
          "UPDATE resources SET title=?,category=?,tags=?,summary=?,cover_id=?,revision=revision+1,updated_at=? WHERE id=?",
          input.title,
          input.category,
          JSON.stringify(input.tags),
          input.summary,
          coverId === undefined
            ? this.repo.getResource(input.id).coverId
            : coverId,
          time,
          resourceId,
        );
      if (!priorCopy)
        this.db.run(
          "INSERT INTO copies(id,resource_id,account_id,directory,selected_files,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
          copyId,
          resourceId,
          account.id,
          directory,
          JSON.stringify(input.selectedFiles ?? []),
          input.isOwnResource ? "recorded" : "draft",
          time,
          time,
        );
      else if (!input.isOwnResource && input.selectedFiles?.length)
        this.db.run(
          "UPDATE copies SET selected_files=? WHERE id=?",
          JSON.stringify(input.selectedFiles),
          copyId,
        );
      if (input.isOwnResource) {
        this.db.run(
          "UPDATE resources SET source_kind='owned' WHERE id=?",
          resourceId,
        );
        if (!priorCopy || priorCopy.status !== "ready" || ownedCodeChanged)
          this.db.run(
            "UPDATE copies SET status='recorded',share_url=?,share_verified_at=NULL,selected_files='[]',error=NULL,updated_at=? WHERE id=?",
            source.url,
            time,
            copyId,
          );
      }
      if (input.enqueue) {
        jobId = id("job");
        this.db.run(
          "INSERT INTO jobs(id,copy_id,stage,created_at,updated_at) VALUES(?,?,?,?,?)",
          jobId,
          copyId,
          account.uid ? "queued" : "waiting_login",
          time,
          time,
        );
        this.db.run("UPDATE copies SET status=? WHERE id=?", "queued", copyId);
      }
      if (input.id) {
        for (const copy of this.repo.getResource(resourceId).copies) {
          if (copy.status === "ready") this.notes.enqueue(copy.id);
        }
      }
    });
    if (input.id) await this.notes.flush();
    this.changed();
    if (input.enqueue) {
      await this.ports.closeAccountWindow(account.id);
      void this.queue.pump();
    }
    return { resourceId, copyId, jobId };
  }

  private async openBinding(
    binding: BrowserBinding,
    contentFormat?: ContentFormat,
  ) {
    try {
      const result = binding.websiteAccountId ? await this.websiteAccounts.open(binding.websiteAccountId) : await this.bit.open({
        ...binding,
        editorUrl: bindingEditorUrl(binding, contentFormat),
      });
      this.db.run(
        "UPDATE browser_bindings SET last_checked_at=?,last_opened_at=?,open_error=NULL WHERE id=?",
        now(),
        now(),
        binding.id,
      );
      return result;
    } catch (error) {
      this.db.run(
        "UPDATE browser_bindings SET last_checked_at=?,open_error=? WHERE id=?",
        now(),
        safeMessage(error),
        binding.id,
      );
      throw error;
    } finally {
      this.changed();
    }
  }
  private hasRunningJobs() {
    return (
      this.smzdm.isBusy ||
      this.distribution.isBusy ||
      !!this.ports.distributionSessions?.isOpen() ||
      this.environmentQueue.isBusy ||
      this.bitManagement.isBusy ||
      this.environments.isBusy ||
      this.driveFiles.isBusy ||
      this.websiteAccounts.isBusy ||
      this.weibo.isBusy ||
      this.weiboPosts.isBusy ||
      this.zhihu.isBusy ||
      this.pipix.isBusy ||
      this.csdn.isBusy ||
      this.zhidao.isBusy ||
      this.insertion.isBusy ||
      this.studio.isBusy ||
      this.resourceAnswers.isBusy ||
      this.shareStatistics.isBusy ||
      !!this.db.get(
        "SELECT id FROM jobs WHERE stage IN ('queued','preflight','transferring','verifying','sharing','archiving') LIMIT 1",
      )
    );
  }
  private async checkShare(copyId: string): Promise<ShareCheck> {
    const copy = this.repo.getCopy(copyId);
    let status: ShareCheck["status"] = "unavailable",
      message = "";
    try {
      const resource = this.repo.getResource(copy.resourceId);
      const valid = await this.authenticated(
        copy.accountId,
        async (account, provider) => {
          if (copy.status === "recorded" && resource.sourceKind === "owned") {
            await verifyRecordedOwnShare(
              this.repo,
              this.secrets,
              account,
              provider,
              resource,
              copy,
            );
            this.notes.enqueue(copy.id);
            await this.notes.flush();
            return true;
          }
          if (
            copy.status !== "ready" ||
            !copy.shareId ||
            !copy.shareUrl ||
            (copy.shareUrl === resource.sourceUrl &&
              resource.sourceKind !== "owned") ||
            !copy.files.length ||
            !copy.verifiedAt ||
            copy.ownerUid !== account.uid ||
            copy.shareOwnerUid !== account.uid
          )
            throw new AppError(
              "OWNERSHIP_UNVERIFIED",
              "副本或本人分享归属尚未核验，请先完成转存或恢复分享。",
            );
          return provider.verifyShare(account, copy.shareId, copy.files);
        },
      );
      status = valid ? "valid" : "invalid";
      message = valid
        ? "本人分享记录与文件清单核验通过。"
        : "本人分享已失效或文件不匹配，请恢复本人分享。";
      this.db.run(
        "UPDATE copies SET share_verified_at=? WHERE id=?",
        valid ? now() : null,
        copyId,
      );
    } catch (error) {
      message = safeMessage(error);
    }
    const checkedAt = now();
    this.db.run(
      "INSERT INTO share_checks(copy_id,status,checked_at,message) VALUES(?,?,?,?) ON CONFLICT(copy_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,message=excluded.message",
      copyId,
      status,
      checkedAt,
      message,
    );
    this.changed();
    return { copyId, status, checkedAt, message };
  }

  private assertOwnCopy(copy: ResourceCopy) {
    const account = this.account(copy.accountId);
    if (
      copy.status !== "ready" ||
      !copy.verifiedAt ||
      !copy.shareVerifiedAt ||
      !copy.shareUrl ||
      !copy.shareId ||
      !account.uid ||
      copy.ownerUid !== account.uid ||
      copy.shareOwnerUid !== account.uid
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "资源副本与本人分享尚未通过同账号UID核验，禁止分发。",
      );
    if (copy.shareUrl === this.repo.getResource(copy.resourceId).sourceUrl && this.repo.getResource(copy.resourceId).sourceKind !== "owned")
      throw new AppError(
        "FOREIGN_SHARE_BLOCKED",
        "本人分享与来源链接相同，禁止分发。",
      );
    return account;
  }
  async contentPackage(
    draftId: string,
    bindingId: string | null,
    includeLink: boolean,
    linkPosition: LinkPosition = "body",
  ) {
    const draft = this.repo.draft(draftId),
      copy = this.repo.getCopy(draft.copyId),
      resource = this.repo.getResource(draft.resourceId),
      split = draft.splitItemId
        ? this.search.assertTarget(copy.id, draft.splitItemId).split
        : null,
      account = split
        ? this.repo.getAccount(copy.accountId)
        : this.assertOwnCopy(copy);
    if (!draft.reviewed)
      throw new AppError("REVIEW_REQUIRED", "请先保存并人工审阅当前内容版本。");
    this.studio.assertWorkingCopySaved(draftId);
    await this.studio.assertReady(draftId);
    if (
      draft.resourceRevision !== resource.revision ||
      (split
        ? draft.splitShareVersion !== split.shareVersion
        : draft.shareVersion !== copy.shareVersion)
    )
      throw new AppError(
        "STALE_DRAFT",
        "资源信息或分享链接已更新，请重新审阅草稿。",
      );
    const binding = bindingId
      ? this.repo.bindings().find((b) => b.id === bindingId)
      : null;
    if (bindingId && (!binding || binding.platform !== draft.platform))
      throw new AppError("BINDING_MISMATCH", "所选发布账号与草稿平台不匹配。");
    if (binding && !hasVerifiedFormat(binding, draft.contentFormat))
      throw new AppError(
        "CHANNEL_FORMAT_UNVERIFIED",
        "此发布账号尚未核实当前内容形式，请在连接与设置中补充账号能力。",
      );
    const allowLinks = canUseLinkPosition(
      draft.platform,
      binding,
      draft.contentFormat,
      linkPosition,
    );
    const allowBodyLinks = canUseLinkPosition(
      draft.platform,
      binding,
      draft.contentFormat,
      "body",
    );
    if (includeLink && !allowLinks)
      throw new AppError(
        "CHANNEL_LINK_BLOCKED",
        "此发布场景未核实允许网盘链接，或权限核实记录已超过30天。",
      );
    let body = draft.body;
    let text = `${draft.title}\n\n${body}\n\n${draft.tags.join(" ")}`;
    const ownUrl = split?.shareUrl ?? copy.shareUrl!;
    validateOutgoingLinks(text, ownUrl, allowBodyLinks);
    if (split) {
      await this.authenticated(account.id, () =>
        this.operations.splitLink(split.id, false),
      );
    } else
      await this.authenticated(account.id, async (a, p) => {
        if (!(await p.verifyShare(a, copy.shareId!, copy.files))) {
          this.db.run(
            "UPDATE copies SET share_verified_at=NULL,error=? WHERE id=?",
            "本人分享已失效或文件不匹配，请重新处理分享。",
            copy.id,
          );
          this.changed();
          throw new AppError(
            "SHARE_INVALID",
            "未能重新确认本人分享有效性，已阻止分发。",
          );
        }
      });
    if (!split)
      this.db.run(
        "UPDATE copies SET share_verified_at=? WHERE id=?",
        now(),
        copy.id,
      );
    let delivery: {
      position: LinkPosition;
      label: string;
      url: string;
      code: string;
      instruction: string;
    } | null = null;
    if (includeLink) {
      const code = await this.secrets.get(
        split ? `split:${split.id}` : `share:${copy.id}`,
      );
      const linkText = `\n\n资源链接：${ownUrl}${code ? `\n提取码：${code}` : ""}`;
      delivery = {
        position: linkPosition,
        label: linkPositionLabels[linkPosition],
        url: ownUrl,
        code: code ?? "",
        instruction:
          linkPosition === "body"
            ? "正文已附加；发布后点击核验。"
            : "仅供填写已获准的平台字段；尚未挂载，勿粘贴到正文，发布后点击核验。",
      };
      if (linkPosition === "body") {
        text += linkText;
        body += linkText;
      }
    }
    return {
      text,
      body,
      delivery,
      contentFormat: draft.contentFormat,
      includesOwnLink: includesOwnShareLink(body, ownUrl),
      coverId: resource.coverId,
      title: draft.title,
      platform: draft.platform,
    };
  }
  async backup() {
    const selected = await this.ports.chooseDirectory("backup");
    if (!selected) return null;
    const folder = join(selected, `盘序备份-${now().replace(/[:.]/g, "-")}`);
    await mkdir(folder, { mode: 0o700 });
    const file = join(folder, "panxu.db");
    this.db.run("VACUUM INTO ?", file);
    const copy = new Database(file);
    copy.run("PRAGMA secure_delete=ON");
    copy.run("DELETE FROM secrets");
    copy.run("UPDATE accounts SET status=?,verified_at=NULL", "disconnected");
    copy.run("UPDATE website_accounts SET status='disconnected'");
    copy.run(
      "UPDATE zhidao_accounts SET data=json_set(data,'$.status','disconnected','$.bulkPermission',NULL,'$.publishingRights',NULL,'$.checkedAt',NULL,'$.message','从备份恢复，请重新登录并检查')",
    );
    copy.run("VACUUM");
    copy.run("PRAGMA journal_mode=DELETE");
    copy.close();
    await chmod(file, 0o600);
    const covers = join(this.dataPath, "covers");
    await mkdir(join(folder, "covers"), { mode: 0o700 });
    try {
      for (const entry of await readdir(covers))
        if (/^[a-f0-9]{64}\.png$/.test(entry))
          await copyFile(join(covers, entry), join(folder, "covers", entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(join(folder, "media"), { mode: 0o700 });
    try {
      for (const entry of await readdir(join(this.dataPath, "media")))
        if (studioAssetPattern.test(entry))
          await copyFile(
            join(this.dataPath, "media", entry),
            join(folder, "media", entry),
          );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const directory of ["zhihu-assets", "content-assets"]) {
      await mkdir(join(folder, directory), {mode: 0o700});
      try {
        for (const entry of await readdir(join(this.dataPath, directory)))
          if (/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(entry))
            await copyFile(join(this.dataPath, directory, entry), join(folder, directory, entry));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify(
        {
          product: "panxu-studio",
          schemaVersion: Number(
            this.db.get<{ user_version: number }>("PRAGMA user_version")
              ?.user_version ?? 2,
          ),
          createdAt: now(),
          credentialsIncluded: false,
          databaseSha256: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return folder;
  }
  close() {
    this.smzdm.close();
    this.distribution.close();
    this.pipix.close();
    this.zhihu.close();
    this.weibo.close();
    this.csdn.close();
    this.zhidao.close();
    this.queue.stop();
    this.environmentQueue.close();
    this.db.close();
  }
}
