import type {
  WebsiteAccount,
  WebsiteAccountView,
  WebsiteProvider,
} from "../shared/website-accounts";
import {
  websiteAccountIdSchema,
  websiteProviderSpecs,
} from "../shared/website-accounts";
import { Database, id, now } from "./database";
import type { AppPorts } from "./ports";
import { AppError } from "./errors";

type Row = {
  id: string;
  provider: WebsiteProvider;
  alias: string;
  uid: string | null;
  status: WebsiteAccount["status"];
  created_at: string;
  updated_at: string;
};
const view = (row: Row): WebsiteAccount => ({
  id: row.id,
  provider: row.provider,
  alias: row.alias,
  uid: row.uid,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export class WebsiteAccounts {
  private active = new Set<string>();
  constructor(
    private db: Database,
    private ports: AppPorts,
  ) {}
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
    return view(row);
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
  add(provider: WebsiteProvider, alias?: string) {
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
    this.db.run(
      "INSERT INTO website_accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES(?,?,?,NULL,'disconnected',?,?)",
      accountId,
      provider,
      alias?.trim() || `${websiteProviderSpecs[provider].name} ${ordinal}`,
      time,
      time,
    );
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
    return this.get(accountId);
  }
  async check(accountId: string): Promise<WebsiteAccountView> {
    const account = this.get(accountId);
    if (!this.ports.websiteSessions)
      return {
        ...account,
        windowOpen: false,
        message: "请在桌面开发窗口管理登录。",
      };
    const state = await this.sessions().status(account);
    const uid = state.uid ?? account.uid;
    const status =
      state.hasSession && uid
        ? "connected"
        : account.status === "expired"
          ? "expired"
          : "disconnected";
    if (uid !== account.uid || status !== account.status) {
      this.db.run(
        "UPDATE website_accounts SET uid=?,status=?,updated_at=? WHERE id=?",
        uid,
        status,
        now(),
        account.id,
      );
    }
    return {
      ...this.get(accountId),
      windowOpen: state.windowOpen,
      message:
        state.error ||
        (status === "connected"
          ? "已识别本机会话，使用时由平台核验。"
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
    await this.sessions().login(account);
  }
  async remove(accountId: string) {
    if (this.active.has(accountId))
      throw new AppError(
        "WEBSITE_ACCOUNT_BUSY",
        "此账号正在使用，请完成后再移除。",
      );
    const account = this.get(accountId);
    await this.sessions().clear(account);
    this.db.transaction(() => {
      this.db.run("DELETE FROM website_accounts WHERE id=?", accountId);
      this.db.run(
        "DELETE FROM api_cache WHERE key=?",
        `baidu-keywords:latest:${accountId}`,
      );
      this.db.run("DELETE FROM api_cache WHERE key GLOB ?",`baidu-research:*:${accountId}:*`);
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
  ) {
    if (this.active.has(accountId))
      throw new AppError(
        "WEBSITE_ACCOUNT_BUSY",
        "此账号已有操作进行中，请等待完成。",
      );
    this.active.add(accountId);
    try {
      const account = await this.check(accountId);
      if (account.provider !== provider)
        throw new AppError(
          "WEBSITE_PROVIDER_MISMATCH",
          "所选账号不支持此功能，请重新选择。",
        );
      if (account.status !== "connected")
        throw new AppError(
          "WEBSITE_LOGIN_REQUIRED",
          "请先在账号管理中完成此网站账号的登录。",
        );
      return await action(account);
    } finally {
      this.active.delete(accountId);
    }
  }
}
