import type {
  WebsiteAccount,
  WebsiteAccountView,
  WebsiteProvider,
} from "../shared/website-accounts";
import {
  websiteAccountIdSchema,
  websiteProviderSpecs,
  weiboPublishingSchema,
} from "../shared/website-accounts";
import { Database, id, now } from "./database";
import type { AppPorts } from "./ports";
import { AppError } from "./errors";
import type { WeiboEditorPayload } from "../shared/weibo-publishing";
import { weiboReceiptUrl } from "../shared/weibo-marketing";
import type { BrowserEnvironments } from "./browser-environments";
import {
  documentPlatformUrl,
  isDocumentProvider,
} from "../shared/document-platforms";

type Row = {
  id: string;
  provider: WebsiteProvider;
  alias: string;
  uid: string | null;
  status: WebsiteAccount["status"];
  created_at: string;
  updated_at: string;
  nickname: string | null;
  checked_at: string | null;
};
const view = (row: Row): WebsiteAccount => ({
  id: row.id,
  provider: row.provider,
  alias: row.alias,
  uid: row.uid,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  nickname: row.nickname,
  checkedAt: row.checked_at,
});
export class WebsiteAccounts {
  private active = new Set<string>();
  constructor(
    private db: Database,
    private ports: AppPorts,
    private changed: () => void = () => {},
    private environments?: BrowserEnvironments,
    private environmentQueue?: import("./browser-environment-queue").BrowserEnvironmentQueue,
  ) {}
  get isBusy() {
    return this.active.size > 0;
  }
  get(accountId: string) {
    websiteAccountIdSchema.parse(accountId);
    const row = this.db.get<Row>(
      "SELECT * FROM website_accounts WHERE id=?",
      accountId,
    );
    if (!row)
      throw new AppError(
        "WEBSITE_ACCOUNT_NOT_FOUND",
        "网站账号不存在或已移除，请重新选择。",
      );
    return {
      ...view(row),
      environmentId: this.environments?.forAccount({
        kind: "website",
        id: accountId,
      }).id,
    };
  }
  private sessions() {
    if (!this.ports.websiteSessions)
      throw new AppError(
        "WEBSITE_SESSION_UNAVAILABLE",
        "当前环境不支持网站登录，请使用桌面开发窗口。",
      );
    return this.ports.websiteSessions;
  }
  async list() {
    const ids = this.db.all<{ id: string }>(
      "SELECT id FROM website_accounts ORDER BY created_at,id",
    );
    return Promise.all(ids.map((row) => this.check(row.id)));
  }
  add(provider: WebsiteProvider, alias?: string, environmentId?: string) {
    if (
      isDocumentProvider(provider) &&
      environmentId &&
      this.environments?.get(environmentId).engine !== "electron"
    )
      throw new AppError(
        "DOCUMENT_NATIVE_SESSION",
        "文档平台目前使用内置浏览器保存会话，请选择内置环境。",
      );
    if (provider === "smzdm") {
      if (this.db.get("SELECT id FROM website_accounts WHERE provider='smzdm'"))
        throw new AppError(
          "SMZDM_SINGLE_ACCOUNT",
          "什么值得买仅连接一个账号，请使用已有账号或先移除旧连接。",
        );
      if (
        environmentId &&
        this.environments?.get(environmentId).engine !== "electron"
      )
        throw new AppError(
          "SMZDM_NATIVE_SESSION",
          "什么值得买文章发布目前使用内置浏览器，请关闭指纹浏览器选项。",
        );
    }
    const time = now(),
      accountId = id("web");
    const count = this.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM website_accounts",
    )!.n;
    if (count >= 50)
      throw new AppError(
        "WEBSITE_ACCOUNT_LIMIT",
        "网站账号最多50个，请先移除不再使用的账号。",
      );
    const ordinal =
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM website_accounts WHERE provider=?",
        provider,
      )!.n + 1;
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO website_accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES(?,?,?,NULL,'disconnected',?,?)",
        accountId,
        provider,
        alias?.trim() || `${websiteProviderSpecs[provider].name} ${ordinal}`,
        time,
        time,
      );
      this.environments?.registerAccount(
        { kind: "website", id: accountId },
        environmentId,
      );
    });
    this.changed();
    return this.get(accountId);
  }
  rename(accountId: string, alias: string) {
    this.get(accountId);
    this.db.run(
      "UPDATE website_accounts SET alias=?,updated_at=? WHERE id=?",
      alias,
      now(),
      accountId,
    );
    this.db.run(
      "UPDATE browser_bindings SET alias=? WHERE website_account_id=?",
      alias,
      accountId,
    );
    this.changed();
    return this.get(accountId);
  }
  async check(accountId: string, fresh = false): Promise<WebsiteAccountView> {
    const account = this.get(accountId);
    if (!this.ports.websiteSessions)
      return {
        ...account,
        windowOpen: false,
        message: "请在桌面开发窗口管理登录。",
      };
    const sessions = this.sessions();
    const state =
      fresh && sessions.verify
        ? await sessions.verify(account)
        : await sessions.status(account);
    const ref = { kind: "website" as const, id: accountId };
    if (
      !fresh &&
      this.environments &&
      !this.environments.identityCurrent(ref)
    ) {
      if (state.hasSession || !state.error)
        state.error = "此环境的登录或配置已变化，请检查当前平台身份后再使用。";
      state.hasSession = false;
    }
    const mismatch = !!account.uid && !!state.uid && account.uid !== state.uid;
    const duplicate =
      !account.uid &&
      state.uid &&
      this.db.get<{ id: string }>(
        "SELECT id FROM website_accounts WHERE provider=? AND uid=? AND id<>?",
        account.provider,
        state.uid,
        accountId,
      );
    if (fresh && state.hasSession && state.uid && !mismatch && !duplicate)
      this.environments?.confirm(ref, state.uid);
    if (
      fresh &&
      state.hasSession &&
      state.sessionOnly &&
      isDocumentProvider(account.provider)
    )
      this.environments?.confirmSession(ref);
    const uid =
      mismatch || duplicate || !state.hasSession
        ? account.uid
        : (state.uid ?? account.uid);
    const nickname =
      !mismatch && !duplicate && state.hasSession
        ? (state.nickname ?? account.nickname ?? null)
        : (account.nickname ?? null);
    const checkedAt = state.checkedAt ?? account.checkedAt ?? null;
    const status =
      state.hasSession &&
      (uid || (state.sessionOnly && isDocumentProvider(account.provider))) &&
      !mismatch &&
      !duplicate
        ? "connected"
        : state.expired || account.status === "expired"
          ? "expired"
          : "disconnected";
    if (
      uid !== account.uid ||
      status !== account.status ||
      nickname !== account.nickname ||
      checkedAt !== account.checkedAt
    ) {
      this.db.run(
        "UPDATE website_accounts SET uid=?,status=?,nickname=?,checked_at=?,updated_at=? WHERE id=?",
        uid,
        status,
        nickname,
        checkedAt,
        now(),
        account.id,
      );
      this.changed();
    }
    if (account.provider === "weibo" && status === "connected")
      this.ensureWeiboBinding(this.get(accountId));
    const publishing = this.db.get<{
      id: string;
      verified_at: string | null;
      link_permission: string;
      rule_note: string;
    }>(
      "SELECT id,verified_at,link_permission,rule_note FROM browser_bindings WHERE website_account_id=?",
      accountId,
    );
    return {
      ...this.get(accountId),
      sessionOnly: state.sessionOnly,
      windowOpen: state.windowOpen,
      checking: state.checking,
      publishing: publishing
        ? {
            bindingId: publishing.id,
            verifiedAt: publishing.verified_at,
            allowLink: publishing.link_permission === "allowed",
            ruleNote: publishing.rule_note,
          }
        : null,
      message:
        (mismatch
          ? `${websiteProviderSpecs[account.provider].name}窗口当前登录了其他身份。请重新登录原账号；新身份请单独添加，任务不会自动换号。`
          : duplicate
            ? "该平台身份已在其他账号中连接，请使用已有账号。"
            : state.error) ||
        (status === "connected"
          ? state.sessionOnly
            ? "已识别本机文档工作台会话。未核实平台身份或开放平台授权；公开访问权限请在官方文档中设置。"
            : account.provider === "weibo"
              ? "已核实微博身份，发布交接前会再次检查。"
              : "已识别本机会话，使用时由平台核验。"
          : status === "expired"
            ? `${websiteProviderSpecs[account.provider].name}登录已失效，请重新登录并检查身份。`
            : state.windowOpen
              ? "请在官方窗口完成登录，账号身份将自动识别。"
              : "打开官方登录窗口，扫码或使用账号登录。"),
    };
  }
  async login(accountId: string) {
    const account = this.get(accountId);
    if (this.active.has(accountId))
      throw new AppError(
        "WEBSITE_ACCOUNT_BUSY",
        "此账号正在执行查询，请完成后再登录。",
      );
    const ref = { kind: "website" as const, id: accountId };
    const action = async () => {
      this.active.add(accountId);
      try {
        this.environments?.invalidateIdentity(ref);
        await this.sessions().login(account);
      } finally {
        this.active.delete(accountId);
      }
    };
    if (!this.environments) await action();
    else if (this.environments.forAccount(ref).engine === "bitbrowser")
      await this.environments.controlWindow(
        this.environments.forAccount(ref).id,
        action,
      );
    else await this.environments.run(ref, action);
  }
  async verify(accountId: string) {
    this.get(accountId);
    if (this.active.has(accountId))
      throw new AppError(
        "WEBSITE_ACCOUNT_BUSY",
        "此账号正在使用，请等待当前操作完成后检查登录。",
      );
    this.active.add(accountId);
    try {
      const action = () => this.check(accountId, true);
      return this.environments
        ? await this.environments.run(
            { kind: "website", id: accountId },
            action,
          )
        : await action();
    } finally {
      this.active.delete(accountId);
    }
  }
  remove(accountId: string) {
    const action = () => this.removeWithinEnvironment(accountId);
    return this.environments
      ? this.environments.run({ kind: "website", id: accountId }, action)
      : action();
  }
  private async removeWithinEnvironment(accountId: string) {
    if (this.active.has(accountId))
      throw new AppError(
        "WEBSITE_ACCOUNT_BUSY",
        "此账号正在使用，请完成后再移除。",
      );
    const account = this.get(accountId);
    this.active.add(accountId);
    try {
      // Removing a local account never clears a shared browser environment.
      this.db.transaction(() => {
        this.environments?.detach({ kind: "website", id: accountId });
        this.db.run("DELETE FROM website_accounts WHERE id=?", accountId);
        this.db.run(
          "DELETE FROM api_cache WHERE key=?",
          `baidu-keywords:latest:${accountId}`,
        );
        this.db.run(
          "DELETE FROM api_cache WHERE key GLOB ?",
          `baidu-research:*:${accountId}:*`,
        );
        // Preserve publication/effect history, but disable the removed identity's connection.
        this.db.run(
          "UPDATE browser_bindings SET capabilities=?,verified_at=NULL,link_permission='none',open_error=? WHERE website_account_id=?",
          JSON.stringify({ formats: [], linkPositions: [] }),
          "账号已从其他账号移除，请重新连接。",
          accountId,
        );
      });
      this.changed();
    } finally {
      this.active.delete(accountId);
    }
  }
  private ensureWeiboBinding(account: WebsiteAccount) {
    if (
      this.db.get(
        "SELECT id FROM browser_bindings WHERE website_account_id=?",
        account.id,
      )
    )
      return;
    this.db.run(
      "INSERT INTO browser_bindings(id,platform,alias,window_id,editor_url,link_permission,rule_note,capabilities,website_account_id) VALUES(?,'weibo',?,'','https://weibo.com/','none','',?,?)",
      id("binding"),
      account.alias,
      JSON.stringify({ formats: [], linkPositions: [] }),
      account.id,
    );
    this.changed();
  }
  async weiboPublishing(raw: unknown) {
    const input = weiboPublishingSchema.parse(raw);
    return this.use(input.id, "weibo", async (account) => {
      this.ensureWeiboBinding(account);
      this.db.run(
        "UPDATE browser_bindings SET capabilities=?,link_permission=?,rule_note=?,verified_at=? WHERE website_account_id=?",
        JSON.stringify({
          formats: ["shortpost"],
          linkPositions: input.allowLink ? ["body"] : [],
        }),
        input.allowLink ? "allowed" : "none",
        input.ruleNote,
        now(),
        account.id,
      );
      this.changed();
      return this.check(account.id);
    });
  }
  async verifyWeibo(accountId: string, expectedUid: string) {
    return this.use(accountId, "weibo", async (account) => {
      if (account.uid !== expectedUid)
        throw new AppError(
          "WEIBO_ACCOUNT_MISMATCH",
          "微博身份与任务不一致，请重新选择已登录账号并准备图文包。",
        );
      return account;
    });
  }
  async fillWeibo(accountId: string, payload: WeiboEditorPayload) {
    return this.use(
      accountId,
      "weibo",
      async (account) => {
        if (account.uid !== payload.uid)
          throw new AppError(
            "WEIBO_ACCOUNT_MISMATCH",
            "微博身份与当前图文任务不一致。",
          );
        if (!this.ports.weiboPublisher)
          throw new AppError(
            "WEIBO_PUBLISH_UNAVAILABLE",
            "请使用当前源码桌面窗口发布微博。",
          );
        const state = await this.ports.weiboPublisher.prepare(account, payload);
        return {
          ...state,
          environment: this.environments?.stamp({
            kind: "website",
            id: accountId,
          }),
        };
      },
      "微博图文填写",
    );
  }
  async openWeiboPost(accountId: string, url: string) {
    return this.use(accountId, "weibo", async (account) => {
      const permalink = weiboReceiptUrl(url, account.uid!);
      if (!this.ports.websiteSessions?.openPost)
        throw new AppError(
          "WEIBO_PUBLISH_UNAVAILABLE",
          "当前窗口不支持微博回执，请使用源码桌面窗口。",
        );
      await this.ports.websiteSessions.openPost(account, permalink);
      return true;
    });
  }
  async openDocument(accountId: string, value: string) {
    const account = this.get(accountId);
    const url = documentPlatformUrl(account.provider, value);
    if (!url)
      throw new AppError(
        "DOCUMENT_URL_BLOCKED",
        "文档地址必须属于所选账号的 HTTPS 官方平台。",
      );
    return this.use(accountId, account.provider, async (current) => {
      const sessions = this.sessions();
      if (!sessions.openDocument)
        throw new AppError(
          "DOCUMENT_SESSION_UNAVAILABLE",
          "当前环境不支持文档会话，请使用源码桌面窗口。",
        );
      await sessions.openDocument(current, url);
      return { opened: true, url };
    });
  }
  async submitWeibo(
    accountId: string,
    payload: WeiboEditorPayload,
    before: () => Promise<void>,
  ) {
    return this.use(
      accountId,
      "weibo",
      async (account) => {
        if (account.uid !== payload.uid)
          throw new AppError(
            "WEIBO_ACCOUNT_MISMATCH",
            "微博身份与当前图文任务不一致。",
          );
        if (!this.ports.weiboPublisher)
          throw new AppError(
            "WEIBO_PUBLISH_UNAVAILABLE",
            "请使用当前源码桌面窗口发布微博。",
          );
        const assertEnvironment = () =>
          this.environments?.assertStamp(
            { kind: "website", id: accountId },
            payload.environment,
          );
        assertEnvironment();
        return this.ports.weiboPublisher.submit(account, payload, async () => {
          assertEnvironment();
          await before();
        });
      },
      "微博提交",
    );
  }
  async open(accountId: string, expectedUid?: string) {
    return this.use(accountId, "weibo", async (account) => {
      if (!account.uid || (expectedUid && account.uid !== expectedUid))
        throw new AppError(
          "WEIBO_ACCOUNT_MISMATCH",
          "微博账号与图文任务不一致，已阻止打开发布窗口。",
        );
      const sessions = this.sessions();
      if (!sessions.open)
        throw new AppError(
          "WEBSITE_SESSION_UNAVAILABLE",
          "当前环境不支持微博发布窗口。",
        );
      await sessions.open(account, expectedUid ?? account.uid);
      return { opened: true, url: "https://weibo.com/" };
    });
  }
  async expire(accountId: string) {
    const account = this.get(accountId);
    await this.sessions().invalidate(account);
    this.db.run(
      "UPDATE website_accounts SET status='expired',updated_at=? WHERE id=?",
      now(),
      accountId,
    );
  }
  async use<T>(
    accountId: string,
    provider: WebsiteProvider,
    action: (account: WebsiteAccount) => Promise<T>,
    operationLabel?: string,
  ) {
    if (this.active.has(accountId))
      throw new AppError(
        "WEBSITE_ACCOUNT_BUSY",
        "此账号已有操作进行中，请等待完成。",
      );
    this.active.add(accountId);
    try {
      const actionWithIdentity = async () => {
        const account = await this.check(
          accountId,
          provider !== "baidu-marketing",
        );
        if (account.provider !== provider)
          throw new AppError(
            "WEBSITE_PROVIDER_MISMATCH",
            "所选账号不支持此功能，请重新选择。",
          );
        if (account.status !== "connected")
          throw new AppError(
            "WEBSITE_LOGIN_REQUIRED",
            account.message || "请先在账号管理中完成此网站账号的登录。",
          );
        return await action(account);
      };
      const ref = { kind: "website" as const, id: accountId };
      return operationLabel && this.environmentQueue
        ? await this.environmentQueue.schedule(
            [ref],
            operationLabel,
            actionWithIdentity,
          )
        : this.environments
          ? await this.environments.run(ref, actionWithIdentity)
          : await actionWithIdentity();
    } finally {
      this.active.delete(accountId);
    }
  }
}
