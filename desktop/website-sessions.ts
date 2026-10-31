import { BrowserWindow, session, type Session } from "electron";
import { createHash, randomUUID } from "node:crypto";
import type { AppPorts } from "../core/ports";
import type { WebsiteAccount } from "../shared/website-accounts";
import { websiteAccountIdSchema } from "../shared/website-accounts";
import { baiduKeywordInputSchema } from "../shared/baidu-keywords";
import { baiduResearchInputSchema } from "../shared/baidu-research";
import { buildBaiduResearchRequest } from "../core/baidu-research";
import { AppError } from "../core/errors";
import { readLimited, readLimitedBytes } from "../core/http";
import { createWeiboSessions } from "./weibo-session";
import { createZhihuIdentitySession } from "./zhihu-session";
import { createWebsiteIdentitySession } from "./website-identity-session";
import { tiebaIdentityScript } from "../core/tieba/identity";
import { createSmzdmSession } from "./smzdm-session";
import { createDocumentSessions } from "./document-session";
import { isDocumentProvider } from "../shared/document-platforms";
import { browserSessionFetch } from "./browser-session-fetch";
import {
  baiduKeywordPath,
  buildBaiduKeywordRequest,
} from "../core/baidu-keywords";
import {
  baiduIdentityFromUrl,
  isAbortedNavigation,
  websiteLoginSpecs,
  websiteNavigationAllowed,
  websitePostLoginUrl,
} from "./website-session-policy";

type Context = {
  profile: Session;
  window?: BrowserWindow;
  uid: string | null;
  owner?: string;
  headers: Record<string, string>;
  industryHeaders: Record<string, string>;
  error: string | null;
  invalidSignature?: string;
  productOpened: boolean;
};
export function createWebsiteSessions(
  workspace: () => string,
  environmentProfile?: (account: WebsiteAccount) => Session,
) {
  const contexts = new Map<string, Context>();
  const key = (account: WebsiteAccount) =>
    createHash("sha256")
      .update(
        `${workspace()}\0${account.provider}\0${websiteAccountIdSchema.parse(account.id)}${environmentProfile ? `\0${environmentProfile(account).getStoragePath()}` : ""}`,
      )
      .digest("hex")
      .slice(0, 24);
  const context = (account: WebsiteAccount) => {
    const id = key(account),
      old = contexts.get(id);
    if (old) return old;
    const profile =
      environmentProfile?.(account) ??
      session.fromPartition(`persist:panxu-website-${id}`);
    const value: Context = {
      profile,
      uid: account.uid,
      headers: {},
      industryHeaders: {},
      error: null,
      productOpened: false,
    };
    profile.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    profile.webRequest.onBeforeRequest(
      {
        urls: [
          "https://fengchao.baidu.com/hairuo/request.ajax*",
          "https://cdp.baidu.com/hairuo/request.ajax*",
        ],
      },
      (details, callback) => {
        // Only the account identifier is retained from Baidu's own form envelope.
        for (const upload of details.uploadData ?? []) {
          if (!upload.bytes || upload.bytes.length > 256_000) continue;
          const uid = new URLSearchParams(upload.bytes.toString("utf8")).get(
            "userid",
          );
          if (uid && /^[1-9]\d{0,19}$/.test(uid)) value.uid = uid;
        }
        callback({});
      },
    );
    profile.webRequest.onBeforeSendHeaders(
      {
        urls: [
          "https://fengchao.baidu.com/hairuo/request.ajax*",
          "https://cdp.baidu.com/hairuo/request.ajax*",
        ],
      },
      (details, callback) => {
        for (const [name, header] of Object.entries(details.requestHeaders)) {
          if (
            ["ds", "tk"].includes(name.toLowerCase()) &&
            /^[\x20-\x7e]{1,8192}$/.test(header)
          )
            (new URL(details.url).hostname === "cdp.baidu.com"
              ? value.industryHeaders
              : value.headers)[name.toLowerCase()] = header;
        }
        callback({ requestHeaders: details.requestHeaders });
      },
    );
    contexts.set(id, value);
    return value;
  };
  const credentials = async (account: WebsiteAccount) => {
    const ctx = context(account);
    const cookies = await ctx.profile.cookies.get({
      url: "https://fengchao.baidu.com/",
    });
    const token =
      cookies.find((c) => c.name === "CPTK_3")?.value ||
      cookies.find((c) => c.name === "__cas__st__3")?.value;
    const owner =
      cookies.find((c) => c.name === "CPID_3")?.value ||
      cookies.find((c) => c.name === "__cas__id__3")?.value;
    if (owner && /^[1-9]\d{0,19}$/.test(owner)) {
      if (ctx.owner && ctx.owner !== owner) ctx.uid = null;
      ctx.owner = owner;
      ctx.uid ??= owner;
    }
    const signature = createHash("sha256")
      .update(
        `${token ?? ""}\0${ctx.uid ?? ""}\0${JSON.stringify(ctx.headers)}`,
      )
      .digest("hex");
    return { token, uid: ctx.uid, signature };
  };
  const baiduSessions: NonNullable<AppPorts["websiteSessions"]> = {
    isOpen: () =>
      [...contexts.values()].some(
        (ctx) => ctx.window && !ctx.window.isDestroyed(),
      ),
    async login(account) {
      const ctx = context(account),
        spec = websiteLoginSpecs[account.provider];
      let win = ctx.window;
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        if (!ctx.error) return;
      } else {
        win = new BrowserWindow({
          width: 1280,
          height: 840,
          title: spec.title,
          webPreferences: {
            session: ctx.profile,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        ctx.window = win;
        const auth = win;
        auth.webContents.setWindowOpenHandler(({ url }) => {
          if (websiteNavigationAllowed(account.provider, url)) {
            ctx.error = null;
            void auth.loadURL(url).catch((error) => {
              if (!isAbortedNavigation(error))
                ctx.error = "官方登录页面加载失败，请重试登录。";
            });
          }
          return { action: "deny" };
        });
        auth.webContents.on("will-navigate", (details) => {
          if (!websiteNavigationAllowed(account.provider, details.url))
            details.preventDefault();
        });
        auth.webContents.on("will-redirect", (details) => {
          if (
            details.isMainFrame &&
            !websiteNavigationAllowed(account.provider, details.url)
          )
            details.preventDefault();
        });
        auth.webContents.on(
          "did-fail-load",
          (_event, code, description, _url, isMainFrame) => {
            if (!isMainFrame || code === -3) return;
            ctx.error = `官方登录页面加载失败（${description.replace(/[^A-Z_0-9-]/gi, "").slice(0, 60)}），请重试登录。`;
          },
        );
        auth.webContents.on(
          "did-frame-navigate",
          (_event, url, _code, _text, isMainFrame) => {
            const uid = baiduIdentityFromUrl(url);
            if (uid) ctx.uid = uid;
            const target =
              isMainFrame && websitePostLoginUrl(account.provider, url);
            if (target && !ctx.productOpened) {
              ctx.productOpened = true;
              void credentials(account)
                .then((identity) => {
                  if (auth.isDestroyed()) return;
                  const destination = new URL(target);
                  if (identity.uid)
                    destination.searchParams.set("userId", identity.uid);
                  return auth.loadURL(destination.toString());
                })
                .catch((error) => {
                  if (!isAbortedNavigation(error))
                    ctx.error = "登录后工具页面加载失败，请重试登录。";
                });
            }
          },
        );
        auth.on("closed", () => {
          if (ctx.window === auth) ctx.window = undefined;
        });
      }
      ctx.error = null;
      ctx.productOpened = false;
      try {
        await win.loadURL(spec.home);
      } catch (error) {
        // A page-initiated/SSO redirect cancels loadURL while the next page keeps loading.
        if (isAbortedNavigation(error)) return;
        ctx.error ??= "官方登录页面加载失败，请重试登录。";
        throw new AppError("WEBSITE_LOGIN_LOAD_FAILED", ctx.error);
      }
    },
    async clear(account) {
      const ctx = context(account);
      if (ctx.window && !ctx.window.isDestroyed()) ctx.window.close();
      await ctx.profile.clearStorageData();
      await ctx.profile.clearCache();
      ctx.uid = null;
      ctx.owner = undefined;
      ctx.headers = {};
      ctx.industryHeaders = {};
      ctx.invalidSignature = undefined;
      ctx.error = null;
    },
    async invalidate(account) {
      const ctx = context(account);
      ctx.invalidSignature = (await credentials(account)).signature;
    },
    async status(account) {
      const ctx = context(account),
        auth = await credentials(account);
      return {
        hasSession:
          !!auth.token && !!auth.uid && ctx.invalidSignature !== auth.signature,
        uid: auth.uid,
        windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
        error: ctx.error,
      };
    },
  };
  const exchange = async (
    account: WebsiteAccount,
    spec: { host: string; path: string; params: object },
    file?: { name: string; bytes: Buffer },
  ) => {
    const ctx = context(account),
      auth = await credentials(account);
    if (
      account.provider !== "baidu-marketing" ||
      !auth.token ||
      !auth.uid ||
      ctx.invalidSignature === auth.signature
    )
      throw new AppError(
        "BAIDU_LOGIN_REQUIRED",
        "请先在账号管理中登录百度营销账号，身份将自动识别。",
      );
    let token: string | undefined = auth.token;
    if (spec.host === "cdp.baidu.com") {
      token = (
        await ctx.profile.cookies.get({ url: "https://cdp.baidu.com/" })
      ).find((c) => c.name === "CPTK_590")?.value;
      if (!token || token === "NLI")
        throw new AppError(
          "BAIDU_INDUSTRY_LOGIN_REQUIRED",
          "请先打开行业流量洞察官方窗口，完成同一账号的登录验证。",
        );
    }
    const reqid = randomUUID(),
      url = new URL(`https://${spec.host}/hairuo/request.ajax`);
    url.search = new URLSearchParams({
      path: spec.path,
      reqid,
    }).toString();
    try {
      const fields = {
        reqid,
        userid: auth.uid,
        token,
        path: spec.path,
        params: JSON.stringify(spec.params),
      };
      let body: URLSearchParams | FormData = new URLSearchParams(fields);
      if (file) {
        body = new FormData();
        for (const [k, v] of Object.entries(fields)) body.append(k, v);
        body.append("filename", file.name);
        body.append(
          "signature",
          createHash("md5").update(file.bytes).digest("hex"),
        );
        body.append(
          "file",
          new Blob([new Uint8Array(file.bytes)], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          file.name,
        );
      }
      const response = await browserSessionFetch(ctx.profile, url.toString(), {
        method: "POST",
        redirect: "error",
        credentials: "include",
        signal: AbortSignal.timeout(45000),
        headers: {
          ...(file
            ? {}
            : {
                "Content-Type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
              }),
          Accept: "application/json",
          Referer:
            spec.host === "cdp.baidu.com"
              ? `https://cdp.baidu.com/static/?targetUserId=${auth.uid}`
              : `https://fengchao.baidu.com/fc/toolscenter/orientation/kr/user/${auth.uid}`,
          ...(spec.host === "cdp.baidu.com"
            ? ctx.industryHeaders
            : ctx.headers),
        },
        body,
      });
      return {
        status: response.status,
        body: await readLimited(response, 8_000_000),
        userId: auth.uid,
      };
    } catch {
      throw new AppError(
        "BAIDU_REQUEST_FAILED",
        "百度关键词请求未完成，请检查网络；若需安全验证，请在账号管理中打开官方窗口处理后手动重试。",
      );
    }
  };
  const baiduKeywords: NonNullable<AppPorts["baiduKeywords"]> = {
    async query(account, raw) {
      const input = baiduKeywordInputSchema.parse(raw),
        params = buildBaiduKeywordRequest(input);
      if (input.combinations) {
        delete (params as Partial<typeof params>).pageNo;
        delete (params as Partial<typeof params>).pageSize;
      }
      return exchange(account, {
        host: "fengchao.baidu.com",
        path: baiduKeywordPath,
        params,
      });
    },
    run: (account, raw) =>
      exchange(
        account,
        buildBaiduResearchRequest(baiduResearchInputSchema.parse(raw)),
      ),
    upload: (account, name, bytes) =>
      exchange(
        account,
        {
          host: "fengchao.baidu.com",
          path: "aigc-boost/GET/FileService/uploadBosFile",
          params: {},
        },
        { name, bytes },
      ),
    async download(_account, value) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !/(?:^|\.)(?:bcebos\.com|bdstatic\.com|baidu\.com)$/.test(url.hostname)
      )
        throw new AppError(
          "BAIDU_DOWNLOAD_HOST",
          "百度返回了未受信任的下载地址，请在官方窗口核对。",
        );
      const r = await browserSessionFetch(
        context(_account).profile,
        url.toString(),
        {
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(45000),
        },
      );
      if (!r.ok)
        throw new AppError(
          "BAIDU_DOWNLOAD_FAILED",
          `下载返回 HTTP ${r.status}，请读取最新任务状态后重试。`,
        );
      return readLimitedBytes(r, 50_000_000);
    },
    async open(account, tool) {
      await baiduSessions.login(account);
      const ctx = context(account),
        win = ctx.window;
      if (!win || win.isDestroyed()) return;
      ctx.productOpened = true;
      const uid = (await credentials(account)).uid;
      let target: URL;
      if (tool === "industry") {
        const product = new URL("https://cdp.baidu.com/hairuo/main.do");
        product.search = new URLSearchParams({
          lp: "flowInsight",
          source: "3",
          ...(uid ? { tUserid: uid } : {}),
          rurl: Buffer.from("https://cdp.baidu.com/static/#/main").toString(
            "base64",
          ),
        }).toString();
        target = new URL("https://cas.baidu.com/");
        target.search = new URLSearchParams({
          action: "check",
          appid: "590",
          rb: "1",
          u: product.toString(),
          ...(uid ? { userId: uid } : {}),
        }).toString();
      } else {
        if (!uid)
          throw new AppError("BAIDU_LOGIN_REQUIRED", "请先完成百度营销登录。");
        target = new URL(
          `https://fengchao.baidu.com/fc/toolscenter/orientation/kr/user/${uid}`,
        );
        target.searchParams.set(
          "kr_tab",
          {
            keyword: "new_kr_keyword",
            ranking: "keyword_rank",
            grouping: "keyword_group",
            flow: "new_kr_flow",
            mass: "new_kr_mass_keyword",
          }[tool],
        );
      }
      try {
        await win.loadURL(target.toString());
      } catch (e) {
        if (!isAbortedNavigation(e))
          throw new AppError(
            "BAIDU_TOOL_LOAD_FAILED",
            "官方工具页面加载失败，请重试打开。",
          );
      }
    },
  };
  const weiboSessions = createWeiboSessions(workspace, environmentProfile);
  const zhihuIdentity = createZhihuIdentitySession(context);
  const tiebaIdentity = createWebsiteIdentitySession(context, {
    provider: "tieba",
    label: "贴吧",
    home: websiteLoginSpecs.tieba.home,
    cookieNames: /^(?:BDUSS|BDUSS_BFESS|STOKEN|PTOKEN)$/,
    cookieDomain: /(^|\.)baidu\.com$/,
    script: tiebaIdentityScript(),
  });
  const smzdm = createSmzdmSession(context);
  const documents = createDocumentSessions(context, (account) =>
    baiduSessions.login(account),
  );
  const adapter = (account: WebsiteAccount) =>
    account.provider === "weibo" ? weiboSessions : baiduSessions;
  const sessions: NonNullable<AppPorts["websiteSessions"]> = {
    isOpen: () =>
      baiduSessions.isOpen() || weiboSessions.isOpen() || smzdm.isOpen(),
    login: (account) => adapter(account).login(account),
    status: (account) =>
      isDocumentProvider(account.provider)
        ? Promise.resolve(documents.status(account))
        : account.provider === "smzdm"
          ? Promise.resolve(smzdm.status(account))
          : account.provider === "tieba"
            ? Promise.resolve(tiebaIdentity.status(account))
            : account.provider === "zhihu"
              ? Promise.resolve(zhihuIdentity.status(account))
              : adapter(account).status(account),
    clear: (account) => adapter(account).clear(account),
    invalidate: async (account) =>
      isDocumentProvider(account.provider)
        ? documents.invalidate(account)
        : account.provider === "smzdm"
          ? smzdm.invalidate(account)
          : account.provider === "tieba"
            ? tiebaIdentity.invalidate(account)
            : account.provider === "zhihu"
              ? zhihuIdentity.invalidate(account)
              : adapter(account).invalidate(account),
    verify: (account) =>
      isDocumentProvider(account.provider)
        ? documents.verify(account)
        : account.provider === "smzdm"
          ? smzdm.verify(account)
          : account.provider === "tieba"
            ? tiebaIdentity.verify(account)
            : account.provider === "zhihu"
              ? zhihuIdentity.verify(account)
              : account.provider === "weibo"
                ? weiboSessions.verify(account)
                : baiduSessions.status(account),
    openDocument: (account, url) => documents.openDocument(account, url),
    open: async (account, expectedUid) => {
      if (account.provider !== "weibo")
        throw new AppError(
          "WEBSITE_PUBLISH_UNSUPPORTED",
          "此平台暂未接入网站发布窗口。",
        );
      await weiboSessions.open(account, expectedUid);
    },
    openPost: async (account, url) => {
      if (account.provider !== "weibo")
        throw new AppError(
          "WEBSITE_PUBLISH_UNSUPPORTED",
          "此账号不支持微博回执。",
        );
      await weiboSessions.openPost(account, url);
    },
  };
  return {
    sessions,
    baiduKeywords,
    weiboPublisher: weiboSessions.publisher,
    weiboStatistics: weiboSessions.statistics,
    smzdm: smzdm.port,
  };
}
