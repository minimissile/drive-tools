import type { Account } from "../shared/types";

export interface AppPorts {
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
  };
  zhidaoSession?: {
    isOpen?(): boolean;
    login(id: string): Promise<void>;
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
  normalizeCover(bytes: Buffer): Promise<Buffer>;
  openPath(path: string): Promise<void>;
  openAccountPage(account: Account, url: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  saveFile(name: string, bytes: Buffer): Promise<string | null>;
}
