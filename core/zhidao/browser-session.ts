import type { BrowserContext } from "playwright-core";
import type { AppPorts } from "../ports";
import type { BrowserEnvironments } from "../browser-environments";
import type { BitBrowser } from "../bitbrowser";
import { AppError } from "../errors";
import { findEnvironmentPage, officialBrowserPage } from "../browser-pages";
import { browserPageRequest } from "../browser-page-request";
import { zhidaoAccountPages } from "../../shared/zhidao-rights";
import { withEnvironmentBrowser } from "../environment-browser-runtime";

/** Every Zhidao operation follows its account environment; a failed fingerprint route never uses native transport. */
export function createZhidaoBrowserSession(
  native: AppPorts["zhidaoSession"],
  environments: BrowserEnvironments,
  bit: () => BitBrowser,
): NonNullable<AppPorts["zhidaoSession"]> {
  const session = () => {
    if (!native)
      throw new AppError(
        "SESSION_UNAVAILABLE",
        "当前环境不支持百度知道会话，请使用源码桌面窗口。",
      );
    return native;
  };
  const route = <T>(
    id: string,
    nativeAction: () => Promise<T>,
    action: (context: BrowserContext) => Promise<T>,
    visible = false,
  ): Promise<T> => {
    if (!/^zd_[\w-]+$/.test(id))
      throw new AppError("INVALID_ACCOUNT", "知道账号ID不正确。");
    return environments.run({ kind: "zhidao", id }, () => {
      const env = environments.forAccount({ kind: "zhidao", id });
      return env.engine === "electron"
        ? nativeAction()
        : withEnvironmentBrowser(
            environments,
            bit(),
            { kind: "zhidao", id },
            action,
            visible,
          );
    });
  };
  const open = async (context: BrowserContext, key: string, url: string) => {
    const page = await findEnvironmentPage(context, key, url);
    // A previously opened named tab may have navigated elsewhere in the same site.
    if (page.url() !== url)
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront();
  };
  return {
    isOpen: () => native?.isOpen?.() ?? false,
    login: (id, page) => {
      const target = zhidaoAccountPages[page ?? "home"];
      if (!target) throw new AppError("INVALID_URL", "知道页面不正确。");
      return route(
        id,
        () => session().login(id, page),
        (context) =>
          open(context, `panxu:zhidao:${id}:${page ?? "home"}`, target),
        true,
      );
    },
    close: (id) =>
      route(
        id,
        () => session().close(id),
        async () => {},
      ),
    clear: async () => {
      throw new AppError(
        "ENVIRONMENT_CLEAR_BLOCKED",
        "平台账号不能清空共享浏览器环境。",
      );
    },
    setCookie: (id, cookie) => {
      const cookies = cookie
        .split(";")
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const index = pair.indexOf("=");
          if (
            index < 1 ||
            !/^[\w-]+$/.test(pair.slice(0, index)) ||
            /[\r\n\0]/.test(pair)
          )
            throw new AppError("INVALID_COOKIE", "Cookie格式不正确。");
          return {
            name: pair.slice(0, index),
            value: pair.slice(index + 1),
            domain: ".baidu.com",
            path: "/",
            secure: true,
          };
        });
      if (!cookies.length)
        throw new AppError("INVALID_COOKIE", "请填写有效Cookie。");
      return route(
        id,
        () => session().setCookie(id, cookie),
        (context) => context.addCookies(cookies),
      );
    },
    openQuestion: (id, questionId) => {
      if (!/^[\w-]{1,100}$/.test(questionId))
        throw new AppError("INVALID_QUESTION", "知道问题ID不正确。");
      return route(
        id,
        () => {
          const current = session();
          if (!current.openQuestion)
            throw new AppError(
              "SESSION_UNAVAILABLE",
              "当前环境不支持打开知道问题页。",
            );
          return current.openQuestion(id, questionId);
        },
        (context) =>
          open(
            context,
            `panxu:question:${id}:${questionId}`,
            `https://zhidao.baidu.com/question/hx/${questionId}?activity=21th&qpi=21th_activity`,
          ),
        true,
      );
    },
    request: (id, url, init = {}) => {
      const target = new URL(url);
      if (
        target.origin !== "https://zhidao.baidu.com" ||
        target.username ||
        target.password ||
        target.port ||
        target.hash
      )
        throw new AppError(
          "ZHIDAO_URL_BLOCKED",
          "知道请求不属于允许的官方地址。",
        );
      init.signal?.throwIfAborted();
      return route(
        id,
        () => session().request(id, target.href, init),
        async (context) => {
          const page = await findEnvironmentPage(
            context,
            `panxu:zhidao-transport:${id}`,
            zhidaoAccountPages.home,
          );
          if (!officialBrowserPage(page, ["zhidao.baidu.com"]))
            throw new AppError(
              "ZHIDAO_LOGIN_REQUIRED",
              "请在关联的指纹环境中完成百度知道登录或安全验证。",
            );
          return browserPageRequest(page, target.href, init);
        },
      );
    },
  };
}
