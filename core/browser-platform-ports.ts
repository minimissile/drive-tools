import type { BrowserContext, Page } from "playwright-core";
import type { AppPorts } from "./ports";
import type { BrowserEnvironments } from "./browser-environments";
import type { BitBrowser } from "./bitbrowser";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import type { EnvironmentAccountRef } from "../shared/browser-environments";
import { AppError } from "./errors";
import type { WeiboPublisher } from "./weibo/browser-publisher";
import { verifyBitWeibo, useBitWeiboPublisher } from "./weibo/bit-session";
import {
  officialBrowserPage as official,
  findEnvironmentPage as pageFor,
} from "./browser-pages";
import { bitBaiduExchange } from "./baidu-bit-session";
import { weiboReceiptUrl } from "../shared/weibo-marketing";
import { zhidaoAccountPages } from "../shared/zhidao-rights";
import { browserPageRequest } from "./browser-page-request";
import { weiboStatisticsScript } from "./weibo/statistics-page";
import { weiboStatisticsReading } from "../shared/weibo-statistics";
import { baiduKeywordPath, buildBaiduKeywordRequest } from "./baidu-keywords";
import { buildBaiduResearchRequest } from "./baidu-research";
import { verifyZhihu, zhihuBrowser } from "./zhihu/browser";

const webRef = (a: WebsiteAccount): EnvironmentAccountRef => ({
  kind: "website",
  id: a.id,
});
const missing = (): never => {
  throw new AppError(
    "BROWSER_SESSION_UNAVAILABLE",
    "当前环境不支持此平台会话，请使用源码桌面窗口。",
  );
};

export function createBrowserPlatformPorts(
  native: AppPorts,
  environments: BrowserEnvironments,
  bit: () => BitBrowser,
): AppPorts {
  const cache = new Map<string, WebsiteSessionState>();
  const profile = <T>(
    ref: EnvironmentAccountRef,
    action: (context: BrowserContext) => Promise<T>,
  ) => bit().withProfile(environments.forAccount(ref).profileId, action);
  const isBit = (ref: EnvironmentAccountRef) =>
    environments.forAccount(ref).engine === "bitbrowser";
  const verify = async (a: WebsiteAccount) =>
    profile(webRef(a), async (context) => {
      if (a.provider === "smzdm") throw new AppError("SMZDM_NATIVE_SESSION", "什么值得买文章发布目前使用内置浏览器，请在账号管理关联内置环境。");
      let state: WebsiteSessionState;
      if (a.provider === "zhihu") state = await verifyZhihu(context);
      else if (a.provider === "weibo") state = await verifyBitWeibo(context);
      else {
        const cookies = await context.cookies("https://fengchao.baidu.com/");
        const token = cookies.find((c) =>
          ["CPTK_3", "__cas__st__3"].includes(c.name),
        )?.value;
        const uid =
          cookies.find((c) => ["CPID_3", "__cas__id__3"].includes(c.name))
            ?.value ?? null;
        state = {
          hasSession: !!token && !!uid && /^[1-9]\d{0,19}$/.test(uid),
          uid,
          windowOpen: true,
          error: null,
        };
      }
      cache.set(a.id, state);
      return state;
    });
  const withPublisher = <T>(
    a: WebsiteAccount,
    action: (publisher: WeiboPublisher) => Promise<T>,
  ) =>
    profile(webRef(a), (context) => useBitWeiboPublisher(context, a, action));
  const baiduExchange = (
    a: WebsiteAccount,
    spec: ReturnType<typeof buildBaiduResearchRequest>,
    file?: { name: string; bytes: Buffer },
  ) =>
    profile(webRef(a), (context) => bitBaiduExchange(context, a, spec, file));
  const withZhidao = <T>(
    id: string,
    action: (context: BrowserContext) => Promise<T>,
  ) =>
    environments.run({ kind: "zhidao", id }, () =>
      profile({ kind: "zhidao", id }, action),
    );
  return Object.assign(Object.create(native) as AppPorts, {
    zhihu: native.zhihu ?? zhihuBrowser((a, action) => {
      if (!isBit(webRef(a))) return missing();
      return profile(webRef(a), action);
    }),
    weiboStatistics: {
      read: (account, url) => {
        if (!isBit(webRef(account))) return native.weiboStatistics?.read(account, url) ?? missing();
        return profile(webRef(account), async (context) => {
          const page = await context.newPage();
          try {
            const response = await page.goto(weiboReceiptUrl(url, account.uid!), { waitUntil: "domcontentloaded", timeout: 20000 });
            if (!response?.ok()) throw new AppError("WEIBO_STATISTICS_LOAD", "微博详情暂时无法访问，请完成登录或安全验证后重试。");
            return weiboStatisticsReading.parse(await page.evaluate(weiboStatisticsScript(account.uid!, url)));
          } finally { await page.close().catch(() => {}); }
        });
      },
    },
    websiteSessions: {
      isOpen: () => native.websiteSessions?.isOpen() ?? false,
      login: async (a) => {
        if (!isBit(webRef(a)))
          return (native.websiteSessions ?? missing()).login(a);
        if (a.provider === "smzdm") throw new AppError("SMZDM_NATIVE_SESSION", "什么值得买账号请使用内置浏览器环境。");
        await profile(webRef(a), async (context) => {
          const page = await pageFor(
            context,
            `panxu:${a.provider}:${a.id}`,
            a.provider === "zhihu" ? "https://www.zhihu.com/" : a.provider === "weibo"
              ? "https://weibo.com/"
              : "https://qingge.baidu.com/login",
          );
          await page.bringToFront();
        });
        cache.delete(a.id);
      },
      status: async (a) =>
        !isBit(webRef(a))
          ? (native.websiteSessions ?? missing()).status(a)
          : (cache.get(a.id) ?? {
              hasSession: false,
              uid: null,
              windowOpen: false,
              error: "请点击检查登录，核实此指纹环境的平台身份。",
            }),
      verify: (a) =>
        isBit(webRef(a))
          ? verify(a)
          : (native.websiteSessions?.verify?.(a) ??
            native.websiteSessions?.status(a) ??
            missing()),
      clear: async () => {
        throw new AppError(
          "ENVIRONMENT_CLEAR_BLOCKED",
          "平台账号不能清空共享浏览器环境。",
        );
      },
      invalidate: async (a) => {
        cache.delete(a.id);
        if (!isBit(webRef(a))) await native.websiteSessions?.invalidate(a);
      },
      open: async (a, uid) => {
        if (!isBit(webRef(a)))
          return native.websiteSessions?.open?.(a, uid) ?? missing();
        const state = await verify(a);
        if (!state.hasSession || state.uid !== uid)
          throw new AppError(
            "WEIBO_ACCOUNT_MISMATCH",
            "指纹环境中的微博身份与任务不一致。",
          );
        await profile(webRef(a), async (context) => {
          await (
            await pageFor(context, `panxu:weibo:${a.id}`, "https://weibo.com/")
          ).bringToFront();
        });
      },
      openPost: async (a, raw) => {
        if (!isBit(webRef(a)))
          return native.websiteSessions?.openPost?.(a, raw) ?? missing();
        const url = weiboReceiptUrl(raw, a.uid!);
        await profile(webRef(a), async (context) => {
          await (
            await pageFor(context, `panxu:receipt:${url}`, url)
          ).bringToFront();
        });
      },
    },
    weiboPublisher: {
      prepare: (a, payload) =>
        isBit(webRef(a))
          ? withPublisher(a, (publisher) => publisher.prepare(payload))
          : (native.weiboPublisher?.prepare(a, payload) ?? missing()),
      submit: (a, payload, before) =>
        isBit(webRef(a))
          ? withPublisher(a, (publisher) => publisher.submit(payload, before))
          : (native.weiboPublisher?.submit(a, payload, before) ?? missing()),
    },
    zhidaoSession: {
      isOpen: () => native.zhidaoSession?.isOpen?.() ?? false,
      login: (id, page) =>
        environments.run({ kind: "zhidao", id }, async () => {
          if (!isBit({ kind: "zhidao", id }))
            return native.zhidaoSession?.login(id, page) ?? missing();
          await profile({ kind: "zhidao", id }, async (context) => {
            const target = zhidaoAccountPages[page ?? "home"];
            await (
              await pageFor(
                context,
                `panxu:zhidao:${id}:${page ?? "home"}`,
                target,
              )
            ).bringToFront();
          });
        }),
      close: async () => {},
      clear: async () => {
        throw new AppError(
          "ENVIRONMENT_CLEAR_BLOCKED",
          "平台账号不能清空共享浏览器环境。",
        );
      },
      setCookie: (id, cookie) =>
        environments.run({ kind: "zhidao", id }, async () => {
          if (!isBit({ kind: "zhidao", id }))
            return native.zhidaoSession?.setCookie(id, cookie) ?? missing();
          await profile({ kind: "zhidao", id }, async (context) => {
            const cookies = cookie.split(";").map((pair) => {
              const index = pair.indexOf("=");
              return {
                name: pair.slice(0, index).trim(),
                value: pair.slice(index + 1).trim(),
                domain: ".baidu.com",
                path: "/",
                secure: true,
              };
            });
            if (cookies.some((c) => !/^[\w-]+$/.test(c.name)))
              throw new AppError("INVALID_COOKIE", "Cookie格式不正确。");
            await context.addCookies(cookies);
          });
        }),
      openQuestion: (id, questionId) =>
        environments.run({ kind: "zhidao", id }, async () => {
          if (!isBit({ kind: "zhidao", id }))
            return (
              native.zhidaoSession?.openQuestion?.(id, questionId) ?? missing()
            );
          if (!/^[\w-]{1,100}$/.test(questionId))
            throw new AppError("INVALID_QUESTION", "知道问题ID不正确。");
          await profile({ kind: "zhidao", id }, async (context) => {
            await (
              await pageFor(
                context,
                `panxu:question:${id}:${questionId}`,
                `https://zhidao.baidu.com/question/hx/${questionId}?activity=21th&qpi=21th_activity`,
              )
            ).bringToFront();
          });
        }),
      request: (id, url, init) =>
        environments.run({ kind: "zhidao", id }, async () => {
          if (!isBit({ kind: "zhidao", id }))
            return native.zhidaoSession?.request(id, url, init) ?? missing();
          const target = new URL(url);
          if (
            target.origin !== "https://zhidao.baidu.com" ||
            target.username ||
            target.password
          )
            throw new AppError(
              "ZHIDAO_URL_BLOCKED",
              "知道请求不属于官方地址。",
            );
          return withZhidao(id, async (context) => {
            const page = await pageFor(
              context,
              `panxu:zhidao-transport:${id}`,
              "https://zhidao.baidu.com/",
            );
            if (!official(page, ["zhidao.baidu.com"]))
              throw new AppError(
                "ZHIDAO_LOGIN_REQUIRED",
                "请在指纹环境中完成百度登录。",
              );
            return browserPageRequest(page, url, init);
          });
        }),
    },
    baiduKeywords: {
      query: (a, input) =>
        isBit(webRef(a))
          ? baiduExchange(a, {
              host: "fengchao.baidu.com",
              path: baiduKeywordPath,
              params: buildBaiduKeywordRequest(input),
            })
          : (native.baiduKeywords?.query(a, input) ?? missing()),
      run: (a, input) =>
        isBit(webRef(a))
          ? baiduExchange(a, buildBaiduResearchRequest(input))
          : (native.baiduKeywords?.run?.(a, input) ?? missing()),
      upload: (a, name, bytes) =>
        isBit(webRef(a))
          ? baiduExchange(
              a,
              {
                host: "fengchao.baidu.com",
                path: "aigc-boost/GET/FileService/uploadBosFile",
                params: {},
              },
              { name, bytes },
            )
          : (native.baiduKeywords?.upload?.(a, name, bytes) ?? missing()),
      open: async (a, tool) => {
        if (!isBit(webRef(a)))
          return native.baiduKeywords?.open?.(a, tool) ?? missing();
        const target =
          tool === "industry"
            ? "https://cdp.baidu.com/static/#/main"
            : `https://fengchao.baidu.com/fc/toolscenter/orientation/kr/user/${a.uid}`;
        await profile(webRef(a), async (context) => {
          await (
            await pageFor(context, `panxu:baidu-tool:${a.id}:${tool}`, target)
          ).bringToFront();
        });
      },
      download: (a, url) =>
        !isBit(webRef(a))
          ? (native.baiduKeywords?.download?.(a, url) ?? missing())
          : profile(webRef(a), async (context) => {
              const target = new URL(url);
              if (
                target.protocol !== "https:" ||
                target.username ||
                target.password ||
                !/(?:^|\.)(?:bcebos\.com|bdstatic\.com|baidu\.com)$/.test(
                  target.hostname,
                )
              )
                throw new AppError(
                  "BAIDU_DOWNLOAD_HOST",
                  "下载地址不属于百度官方服务。",
                );
              const page = await pageFor(
                context,
                `panxu:baidu-download:${a.id}`,
                "https://fengchao.baidu.com/",
              );
              const bytes = await page.evaluate(async (url) => {
                const response = await fetch(url, {
                  credentials: "omit",
                  redirect: "error",
                  signal: AbortSignal.timeout(45000),
                });
                if (!response.ok) throw Error("下载失败，请重新读取任务状态。");
                const data = new Uint8Array(await response.arrayBuffer());
                if (data.length > 50_000_000) throw Error("下载文件过大。");
                let text = "";
                for (let i = 0; i < data.length; i += 16384)
                  text += String.fromCharCode(...data.subarray(i, i + 16384));
                return btoa(text);
              }, url);
              return Buffer.from(bytes, "base64");
            }),
    },
  } satisfies Partial<AppPorts>);
}
