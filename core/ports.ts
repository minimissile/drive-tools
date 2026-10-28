import type { Account } from "../shared/types";

export interface AppPorts {
  smzdm?: import("../shared/smzdm").SmzdmPort;
  collectionWebSession?: {
    search(source: import("../shared/resource-collection").CollectionWebSource, keyword: string, page: number, signal: AbortSignal): Promise<{ status: number; body: string }>;
    open(source: import("../shared/resource-collection").CollectionWebSource): Promise<void>;
    isOpen(): boolean;
  };
  distributionSessions?: {
    open(platformId: import("../shared/distribution").DistributionPlatformId, page: "submit" | "login"): Promise<void>;
    isOpen(): boolean;
    inspect(platformId: import("../shared/distribution").DistributionPlatformId): Promise<import("../shared/distribution").DistributionReadiness>;
    submit(platformId: import("../shared/distribution").DistributionPlatformId, text: string, beforeSubmit: () => Promise<void>, signal: AbortSignal): Promise<import("../shared/distribution").DistributionSubmitResult>;
  };
  zhihu?: import("../shared/zhihu").ZhihuBrowserPort;
  browserEnvironments?: {
    prepare(environment: import("../shared/browser-environments").BrowserEnvironmentRuntime): Promise<void>;
    assertIdle(environment: import("../shared/browser-environments").BrowserEnvironment): Promise<void>;
    checkNetwork?(environment: import("../shared/browser-environments").BrowserEnvironmentRuntime): Promise<string>;
  };
  weiboPublisher?: {
    prepare(account: import("../shared/website-accounts").WebsiteAccount, payload: import("../shared/weibo-publishing").WeiboEditorPayload): Promise<import("../shared/weibo-publishing").WeiboEditorState>;
    submit(account: import("../shared/website-accounts").WebsiteAccount, payload: import("../shared/weibo-publishing").WeiboEditorPayload, beforeSubmit: () => Promise<void>): Promise<import("../shared/weibo-publishing").WeiboSubmitReceipt>;
  };
  readWeiboImages?(platform?: "weibo" | "zhihu"): Promise<{ name: string; bytes: Buffer }[] | null>;
  weiboStatistics?: {
    read(account: import("../shared/website-accounts").WebsiteAccount, url: string): Promise<import("../shared/weibo-statistics").WeiboStatisticsReading>;
  };
  baiduKeywords?: {
    run?(account: import("../shared/website-accounts").WebsiteAccount, input: import("../shared/baidu-research").BaiduResearchInput): Promise<import("../shared/baidu-research").BaiduWireResponse>;
    open?(account: import("../shared/website-accounts").WebsiteAccount, tool: import("../shared/baidu-research").BaiduTool): Promise<void>;
    upload?(account: import("../shared/website-accounts").WebsiteAccount, name: string, bytes: Buffer): Promise<import("../shared/baidu-research").BaiduWireResponse>;
    download?(account: import("../shared/website-accounts").WebsiteAccount, url: string): Promise<Buffer>;
    query(account: import("../shared/website-accounts").WebsiteAccount, input: import("../shared/baidu-keywords").BaiduKeywordInput): Promise<{ status: number; body: string; userId: string }>;
  };
  websiteSessions?: {
    isOpen(): boolean;
    login(account: import("../shared/website-accounts").WebsiteAccount): Promise<void>;
    clear(account: import("../shared/website-accounts").WebsiteAccount): Promise<void>;
    invalidate(account: import("../shared/website-accounts").WebsiteAccount): Promise<void>;
    status(account: import("../shared/website-accounts").WebsiteAccount): Promise<import("../shared/website-accounts").WebsiteSessionState>;
    verify?(account: import("../shared/website-accounts").WebsiteAccount): Promise<import("../shared/website-accounts").WebsiteSessionState>;
    open?(account: import("../shared/website-accounts").WebsiteAccount, expectedUid: string): Promise<void>;
    openPost?(account: import("../shared/website-accounts").WebsiteAccount, url: string): Promise<void>;
  };
  zhidaoSession?: {
    isOpen?(): boolean;
    openQuestion?(id: string, questionId: string): Promise<void>;
    login(id: string, page?: import("../shared/zhidao-rights").ZhidaoAccountPage): Promise<void>;
    clear(id: string): Promise<void>;
    close(id: string): Promise<void>;
    setCookie(id: string, cookie: string): Promise<void>;
    request(id: string, url: string, init?: RequestInit): Promise<{ status: number; body: string }>;
  };
  readTable?(kind: "keywords" | "resources"): Promise<{ name: string; rows: string[][] } | null>;
  pansouBinary?: string;
  login(account: Account): Promise<void>;
  clearSession(accountId: string): Promise<void>;
  closeAccountWindow(accountId: string): Promise<void>;
  chooseDirectory(
    kind: "vault" | "backup" | "restore" | "content",
    defaultPath?: string,
  ): Promise<string | null>;
  readText(
    kind: "csv" | "summary",
  ): Promise<{ name: string; text: string } | null>;
  activateDataPath(path: string): Promise<void>;
  /** PNG by default for existing content workflows; resource intake requests bounded WebP. */
  normalizeCover(bytes: Buffer, format?: "png" | "webp"): Promise<Buffer>;
  openPath(path: string): Promise<void>;
  openAccountPage(account: Account, url: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  copyImage?(bytes: Buffer): Promise<void>;
  copyRichText?(html: string, text: string): Promise<void>;
  saveFile(name: string, bytes: Buffer): Promise<string | null>;
}
