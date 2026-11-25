import { AppError } from "../errors";
import { fetchJson } from "../http";
import { parseShare, shareUrlWithCode } from "../links";
import type { OwnShare } from "./provider";

export type QuarkNativeSign = (value: string) => Promise<string>;
export interface QuarkPassphraseGenerator {
  create(share: OwnShare, title: string, planId: string): Promise<string>;
}

/** Official desktop UToken protocol. No account cookies or third-party converters. */
export function createQuarkPassphrases(dependencies: {
  withSigner<T>(action: (sign: QuarkNativeSign) => Promise<T>): Promise<T>;
  request(url: string, init: RequestInit): Promise<Response>;
}): QuarkPassphraseGenerator {
  return {
    async create(share, title, planId) {
      const source = parseShare(share.url, share.code);
      if (source.provider !== "quark" || !/^[A-Za-z0-9_-]{1,80}$/.test(planId))
        throw new AppError(
          "INVALID_PASSPHRASE_SHARE",
          "口令生成方案或分享链接不正确。",
        );
      return dependencies.withSigner(async (nativeSign) => {
        const call = async (
          path: "create" | "parse",
          values: Record<string, string>,
        ) => {
          const timestamp = String(Date.now());
          const signature = await nativeSign(
            Object.keys(values)
              .sort()
              .map((key) => values[key])
              .join("") + timestamp,
          );
          if (!signature)
            throw new AppError(
              "QUARK_SIGN_UNAVAILABLE",
              "夸克官方组件未能签名，分享链接已保留。",
            );
          const result = await fetchJson(
            `https://utoken2.uc.cn/utoken/v2/${path}`,
            {
              method: "POST",
              credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...values, timestamp, sign: signature }),
            },
            15_000,
            undefined,
            dependencies.request,
          );
          if (result.success !== true || result.code !== "OK")
            throw new AppError(
              "QUARK_PASSPHRASE_FAILED",
              "夸克未返回可用的中文口令，分享链接已保留。",
            );
          return result.data;
        };
        const target = new URL(shareUrlWithCode(source.url, source.code));
        target.searchParams.set("way", "u_token");
        const created = await call("create", {
          app: "QUARK",
          shareCode: planId,
          businessCode: "quark_cloud_disk",
          androidUrl: target.href,
          iOSUrl: target.href,
          buttonThemeColor: "",
          buttonTitle: "立即查看",
          dialogContent: "来自剪切板",
          dialogTitle: title.slice(0, 400),
          shareContent: "",
          imageUrl: "",
          expiredTimestamp: "",
          nickname: "",
          avatar: "",
        });
        const word = created?.value;
        if (typeof word !== "string" || !/^[\p{Script=Han}]{4,40}$/u.test(word))
          throw new AppError(
            "QUARK_CHINESE_PASSPHRASE_UNAVAILABLE",
            "此分享方案未返回中文口令，分享链接已保留。",
          );
        const parsed = await call("parse", {
          app: "QUARK",
          shareSecret: "xxxxxxxx",
          identifier: "!",
          clipboard: word,
        });
        const urls = [
          parsed?.androidUrl,
          parsed?.iosUrl,
          parsed?.iOSUrl,
        ].filter((value) => typeof value === "string" && value);
        if (
          !urls.length ||
          urls.some((raw) => {
            try {
              const resolved = parseShare(raw);
              return (
                resolved.provider !== "quark" ||
                resolved.url !== source.url ||
                resolved.code !== source.code
              );
            } catch {
              return true;
            }
          })
        )
          throw new AppError(
            "PASSPHRASE_SHARE_MISMATCH",
            "官方口令回读的链接或提取码不一致，未保存该口令。",
          );
        return word;
      });
    },
  };
}
