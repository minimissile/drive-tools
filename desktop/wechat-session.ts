import { nativeImage } from "electron";
import {
  nativeWechatContext,
  type NativeWechatContext,
  type WechatReader,
  type WechatReaderContext,
} from "./wechat-readers";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import type { WechatPort, WechatDraftVerification } from "../shared/wechat";
import { AppError } from "../core/errors";
import {
  initialWechatIdentity,
  staleWechatIdentity,
} from "./wechat-login-state";
import { readContentImage } from "../core/content-assets";
import { WechatImageUploads } from "./wechat-image-uploads";
import { decodeWechatDraftReceipt } from "./wechat-draft-receipt";
import {
  assertWechatImagePixels,
  wechatComparisonImageBytes,
} from "./wechat-image-content";
import {
  normalizeWechatRemoteImageUrl,
  isPublicWechatImageAddress,
  assertWechatPreviewBytes,
} from "./wechat-image-policy";
import {
  decodeWechatImageReceipt,
  describeWechatImageReceipt,
  wechatDraftCoverFields,
  WechatImageReceiptError,
} from "./wechat-upload-receipt";
import { isAbortedNavigation } from "./website-session-policy";
import {
  readWechatIdentity,
  wechatExchange,
  assertWechatSingleDraft,
  assertWechatDraftContent,
} from "./wechat-page";

type Context = WechatReaderContext;
type Identity = NonNullable<ReturnType<typeof readWechatIdentity>>;

async function imageTarget(value: string) {
  const url = normalizeWechatRemoteImageUrl(value);
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((a) => !isPublicWechatImageAddress(a.address))
  )
    throw new AppError(
      "WECHAT_IMAGE_URL",
      "图片地址不能指向本机或内网，请上传本地图片。",
    );
  return {
    url,
    address: addresses.find((address) => address.family === 4) ?? addresses[0],
  };
}

/** Pin the checked public IP for this request; DNS is not resolved again by Chromium. */
async function downloadImage(value: string): Promise<Buffer> {
  let next = value;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const { url, address } = await imageTarget(next);
    const result = await new Promise<{ location?: string; bytes?: Buffer }>(
      (resolve, reject) => {
        const request = httpsRequest(
          url,
          {
            method: "GET",
            family: address.family,
            lookup: (_hostname, _options, callback) =>
              callback(null, address.address, address.family),
            signal: AbortSignal.timeout(30000),
            headers: {
              Referer: "https://mp.weixin.qq.com/",
              "Accept-Encoding": "identity",
            },
          },
          (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              const location = response.headers.location;
              response.destroy();
              if (!location)
                reject(
                  new AppError(
                    "WECHAT_IMAGE_DOWNLOAD",
                    "图片重定向地址无效，请上传本地图片。",
                  ),
                );
              else resolve({ location });
              return;
            }
            if (response.statusCode !== 200) {
              response.destroy();
              reject(
                new AppError(
                  [404, 410].includes(response.statusCode ?? 0)
                    ? "WECHAT_IMAGE_MISSING"
                    : "WECHAT_IMAGE_DOWNLOAD",
                  `图片读取失败（HTTP ${response.statusCode ?? "未知"}），请上传本地图片后重试。`,
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > 10 * 1024 * 1024) {
                request.destroy(
                  new AppError(
                    "WECHAT_IMAGE_DOWNLOAD",
                    "图片超过 10MB，请压缩后上传。",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => resolve({ bytes: Buffer.concat(chunks) }));
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    if (result.bytes) return result.bytes;
    if (!result.location || redirects === 3) break;
    next = new URL(result.location, url).href;
  }
  throw new AppError(
    "WECHAT_IMAGE_DOWNLOAD",
    "图片重定向过多，请上传本地图片后重试。",
  );
}

export function createWechatSession(
  context: (account: WebsiteAccount) => NativeWechatContext,
  workspace: () => string,
  readArticle: WechatPort["readArticle"],
) {
  const contexts = new WeakMap<NativeWechatContext, WechatReaderContext>();
  return createWechatBrowserSession(
    (account) => {
      const original = context(account);
      let reader = contexts.get(original);
      if (!reader) {
        reader = nativeWechatContext(original);
        contexts.set(original, reader);
      }
      return reader;
    },
    workspace,
    readArticle,
  );
}

/** The same account, upload and receipt workflow runs in either browser adapter. */
export function createWechatBrowserSession(
  context: (account: WebsiteAccount) => WechatReaderContext,
  workspace: () => string,
  readArticle: WechatPort["readArticle"],
  readRemoteImage: (url: string) => Promise<Buffer> = downloadImage,
) {
  const states = new WeakMap<Context, WebsiteSessionState>();
  const pending = new WeakMap<Context, Promise<WebsiteSessionState>>();
  const observed = new WeakSet<Context>();
  const ensureObserved = (ctx: Context) => {
    if (observed.has(ctx)) return;
    observed.add(ctx);
    ctx.observe(() => states.set(ctx, staleWechatIdentity(states.get(ctx))));
  };
  const status = (account: WebsiteAccount): WebsiteSessionState => {
    const ctx = context(account);
    ensureObserved(ctx);
    return {
      ...(states.get(ctx) ?? initialWechatIdentity(account)),
      windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
      checking: pending.has(ctx),
    };
  };
  const evaluate = async <T>(
    win: WechatReader,
    fn: Function,
    ...args: unknown[]
  ): Promise<T> => {
    const result = (await win.executeJavaScript(
      `(async()=>{try{return {ok:true,value:await (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})};}catch(error){return {ok:false,error:String(error?.message??"公众号处理失败").slice(0,500)};}})()`,
    )) as { ok: boolean; value: T; error?: string };
    if (!result.ok)
      throw new AppError(
        "WECHAT_PAGE",
        result.error || "公众号处理失败，请在官方后台核对。",
      );
    return result.value;
  };
  const reader = (ctx: Context, show = false) => ctx.reader(show);
  const waitForRead = async (
    win: WechatReader,
    fn: Function,
    ...args: unknown[]
  ) => {
    let failure: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await evaluate(win, fn, ...args);
      } catch (error) {
        failure = error;
      }
      if (win.isDestroyed()) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw failure;
  };
  const identify = async (
    win: WechatReader,
    ctx: Context,
  ): Promise<Identity> => {
    await win.loadURL("https://mp.weixin.qq.com/");
    const current = new URL(win.getURL());
    const token = current.searchParams.get("token");
    if (token && /^\d{1,24}$/.test(token))
      await win.loadURL(
        `https://mp.weixin.qq.com/cgi-bin/settingpage?t=setting/index&action=index&token=${token}&lang=zh_CN`,
      );
    const identity = await evaluate<Identity | null>(win, readWechatIdentity);
    if (!identity)
      throw new AppError(
        "WECHAT_LOGIN_REQUIRED",
        "未能核实公众号原始 ID，请在官方窗口扫码登录或完成安全验证后检查登录。",
      );
    states.set(ctx, {
      hasSession: true,
      uid: identity.uid,
      nickname: identity.nickname,
      checkedAt: new Date().toISOString(),
      windowOpen: false,
      error: null,
    });
    await ctx.flush().catch(() => {});
    return identity;
  };
  const verify = async (account: WebsiteAccount) => {
    const ctx = context(account);
    ensureObserved(ctx);
    if (pending.has(ctx)) return pending.get(ctx)!;
    const task = (async () => {
      const win = await reader(ctx),
        timeout = setTimeout(() => {
          if (!win.isDestroyed()) void win.destroy();
        }, 35000);
      let verified: WebsiteSessionState | undefined;
      try {
        const identity = await identify(win, ctx);
        verified = {
          hasSession: true,
          uid: identity.uid,
          nickname: identity.nickname,
          checkedAt: new Date().toISOString(),
          windowOpen: false,
          error: null,
        };
        states.set(ctx, verified);
      } catch (error) {
        states.set(ctx, {
          hasSession: false,
          uid: null,
          windowOpen: false,
          ...(error instanceof AppError &&
          error.code === "WECHAT_LOGIN_REQUIRED"
            ? { expired: !!account.uid }
            : { unverified: !!account.uid }),
          error:
            error instanceof AppError
              ? error.message
              : "公众号身份检查暂未完成，请检查网络后重试；已保存的登录会话会继续保留。",
        });
      } finally {
        clearTimeout(timeout);
        if (!win.isDestroyed()) await win.destroy();
      }
      // A normal cookie refresh can invalidate the cache while this reader
      // closes. Return the identity just read; writes still verify it again.
      return {
        ...(verified ?? status(account)),
        windowOpen: status(account).windowOpen,
        checking: false,
      };
    })();
    pending.set(ctx, task);
    try {
      return await task;
    } finally {
      pending.delete(ctx);
    }
  };
  const imageBytes = async (raw: string) => {
    const url = new URL(raw);
    if (url.protocol === "panxu-media:") {
      const file = url.pathname.slice(1);
      if (
        url.hostname !== "wechat" ||
        url.search ||
        url.hash ||
        !/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(file)
      )
        throw new AppError("WECHAT_IMAGE", "本地图片地址无效，请重新上传。");
      return readContentImage(workspace(), {
        file,
        sha256: file.split(".")[0],
        name: file,
        storage: "content-assets",
      });
    }
    return readRemoteImage(raw);
  };
  const samePixels = async (expected: string, actual: string) => {
    if (expected === actual) return;
    const first = nativeImage.createFromBuffer(
      wechatComparisonImageBytes(await imageBytes(expected)),
    );
    const second = nativeImage.createFromBuffer(
      wechatComparisonImageBytes(await imageBytes(actual)),
    );
    assertWechatImagePixels(first, second);
  };
  const imageUploads = new WechatImageUploads(
    workspace,
    async (bytes, saved) => {
      const actual = await imageBytes(saved.url);
      assertWechatImagePixels(
        nativeImage.createFromBuffer(wechatComparisonImageBytes(bytes)),
        nativeImage.createFromBuffer(wechatComparisonImageBytes(actual)),
      );
    },
  );
  const verifySavedContent = async (
    win: WechatReader,
    proof: WechatDraftVerification,
  ) => {
    const result = (await waitForRead(win, assertWechatDraftContent, {
      ...proof,
      allowImageMigration: true,
    })) as ReturnType<typeof assertWechatDraftContent>;
    for (const actual of result.coverUrls)
      await samePixels(proof.coverUrl, actual);
    for (const pair of result.images)
      await samePixels(pair.expected, pair.actual);
  };
  const port: WechatPort = {
    readArticle,
    async open(account, raw) {
      const ctx = context(account);
      const win =
        ctx.window && !ctx.window.isDestroyed()
          ? ctx.window
          : await reader(ctx, true);
      ctx.window = win;
      const identity = await identify(win, ctx);
      if (identity.uid !== account.uid)
        throw new AppError(
          "WECHAT_ACCOUNT_MISMATCH",
          "当前登录的公众号与所选账号不一致，请重新登录原账号。",
        );
      const target = new URL("https://mp.weixin.qq.com/cgi-bin/appmsg");
      target.search = new URLSearchParams({
        t: "media/appmsg_list",
        type: "77",
        action: "list_card",
        begin: "0",
        count: "10",
        token: identity.token,
        lang: "zh_CN",
      }).toString();
      if (raw) {
        const supplied = new URL(raw),
          draftId = supplied.searchParams.get("appmsgid");
        if (
          supplied.origin !== "https://mp.weixin.qq.com" ||
          supplied.pathname !== "/cgi-bin/appmsg" ||
          !draftId ||
          !/^\d{1,30}$/.test(draftId)
        )
          throw new AppError(
            "WECHAT_DRAFT_URL",
            "微信草稿地址无效，请先打开微信草稿箱核对。",
          );
        target.search = new URLSearchParams({
          t: "media/appmsg_edit",
          action: "edit",
          type: "77",
          appmsgid: draftId,
          token: identity.token,
          lang: "zh_CN",
        }).toString();
      }
      try {
        await win.loadURL(target.href);
      } catch (error) {
        if (!isAbortedNavigation(error)) throw error;
      }
      await win.show();
    },
    async verifyDraft(account, proof) {
      const ctx = context(account),
        win = await reader(ctx);
      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) void win.destroy();
      }, 180000);
      try {
        const identity = await identify(win, ctx);
        if (identity.uid !== account.uid)
          throw new AppError(
            "WECHAT_ACCOUNT_MISMATCH",
            "当前公众号与本次保存账号不一致。",
          );
        if (!/^\d{1,30}$/.test(proof.draftId))
          throw new AppError("WECHAT_DRAFT_ID", "微信草稿编号无效。");
        await win.loadURL(
          `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${proof.draftId}&token=${identity.token}&lang=zh_CN`,
        );
        // This is a read-only receipt check. Content is bound to the saved
        // draft ID; article-count protection belongs only before an update.
        await verifySavedContent(win, proof);
      } finally {
        clearTimeout(timeout);
        await ctx.flush().catch(() => {});
        if (!win.isDestroyed()) await win.destroy();
      }
    },
    async saveDraft(account, payload, beforeSubmit, onReceipt) {
      const ctx = context(account),
        win = await reader(ctx);
      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) void win.destroy();
      }, 5 * 60000);
      try {
        const identity = await identify(win, ctx);
        if (identity.uid !== payload.uid || identity.uid !== account.uid)
          throw new AppError(
            "WECHAT_ACCOUNT_MISMATCH",
            "公众号身份发生变化，未保存草稿，请重新检查原账号登录。",
          );
        if (payload.draftId) {
          if (!/^\d{1,30}$/.test(payload.draftId))
            throw new AppError("WECHAT_DRAFT_ID", "微信草稿编号无效。");
          await win.loadURL(
            `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${payload.draftId}&token=${identity.token}&lang=zh_CN`,
          );
          await waitForRead(win, assertWechatSingleDraft);
        }
        const uploaded = new Map<string, { url: string; id?: string }>();
        const upload = async (raw: string, asCover = false) => {
          if (!raw)
            throw new AppError(
              "WECHAT_COVER_REQUIRED",
              "请为文章选择一张封面后再发送到微信草稿箱。",
            );
          const cacheKey = `${asCover ? "cover:" : "body:"}${raw}`;
          const prior = uploaded.get(cacheKey);
          if (prior) return prior;
          let bytes = await imageBytes(raw);
          if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024)
            throw new AppError("WECHAT_IMAGE", "图片需要在 10MB 以内。");
          const gif =
            !asCover &&
            /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"));
          const picture = nativeImage.createFromBuffer(bytes),
            dimensions = picture.getSize();
          if (
            picture.isEmpty() ||
            dimensions.width * dimensions.height > 40_000_000
          )
            throw new AppError(
              "WECHAT_IMAGE",
              "无法读取图片或图片尺寸过大，请换一张图片。",
            );
          if (!gif) bytes = picture.toPNG();
          if (bytes.length > 10 * 1024 * 1024)
            throw new AppError(
              "WECHAT_IMAGE",
              "图片转换后超过 10MB，请压缩后上传。",
            );
          const saved = await imageUploads.use(
            identity.uid,
            bytes,
            async () => {
              const response = await evaluate<Record<string, unknown>>(
                win,
                wechatExchange,
                {
                  path: "/cgi-bin/filetransfer",
                  token: identity.token,
                  file: {
                    name: gif ? "article.gif" : "article.png",
                    type: gif ? "image/gif" : "image/png",
                    base64: bytes.toString("base64"),
                  },
                },
              );
              let saved: { url: string; id?: string };
              try {
                saved = decodeWechatImageReceipt(response);
              } catch (error) {
                if (error instanceof WechatImageReceiptError)
                  console.error(
                    "[wechat:image-upload] receipt rejected",
                    JSON.stringify(error.diagnostic),
                  );
                throw error;
              }
              if (!saved.id)
                console.info(
                  "[wechat:image-upload] URL receipt",
                  asCover ? "cover" : "body",
                  JSON.stringify(describeWechatImageReceipt(response)),
                );
              return saved;
            },
          );
          uploaded.set(cacheKey, saved);
          return saved;
        };
        const decode = (value: string) =>
          value.replace(
            /&(?:amp|lt|gt|quot|#39);/g,
            (entity) =>
              ({
                "&amp;": "&",
                "&lt;": "<",
                "&gt;": ">",
                "&quot;": '"',
                "&#39;": "'",
              })[entity]!,
          );
        const sources = [
          ...new Set(
            [...payload.html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) =>
              decode(m[1]),
            ),
          ),
        ];
        if (sources.length > 100)
          throw new AppError(
            "WECHAT_IMAGE_LIMIT",
            "单篇文章最多处理 100 张插图，请减少插图后重试。",
          );
        for (const raw of sources) await upload(raw);
        const html = payload.html.replace(
          /(<img\b[^>]*\bsrc=")([^"]+)(")/g,
          (_match, before, encoded, after) => {
            const saved = uploaded.get(`body:${decode(encoded)}`);
            if (!saved)
              throw new AppError(
                "WECHAT_IMAGE_UPLOAD",
                "存在未上传的插图，未保存文章，请检查后重试。",
              );
            return `${before}${saved.url.replace(/&/g, "&amp;")}${after}`;
          },
        );
        const cover = await upload(payload.coverUrl || sources[0] || "", true);
        const fields: Record<string, string> = {
          count: "1",
          data_seq: "0",
          operate_from: "Chrome",
          type: "77",
          title0: payload.title,
          author0: payload.author,
          digest0: payload.digest,
          content0: html,
          ...wechatDraftCoverFields(cover),
          show_cover_pic0: "0",
          need_open_comment0: "1",
          only_fans_can_comment0: "0",
          copyright_type0: "0",
          sourceurl0: payload.sourceUrl || "",
          article_type0: "0",
        };
        if (payload.draftId) fields.appmsgid = payload.draftId;
        // This is the sole draft mutation boundary. Only a missing or invalid
        // success receipt leaves the save uncertain; never submit again here.
        await beforeSubmit();
        const response = await evaluate<Record<string, unknown>>(
          win,
          wechatExchange,
          { path: "/cgi-bin/operate_appmsg", token: identity.token, fields },
        );
        const receipt = decodeWechatDraftReceipt(response, payload.draftId);
        const proof: WechatDraftVerification = {
          ...receipt,
          title: payload.title,
          html,
          coverUrl: cover.url,
          sourceUrl: payload.sourceUrl || "",
        };
        await onReceipt?.(proof);
        return receipt;
      } finally {
        clearTimeout(timeout);
        await ctx.flush().catch(() => {});
        if (!win.isDestroyed()) await win.destroy();
      }
    },
  };
  return {
    port,
    status,
    verify,
    async readPreviewImage(raw: string) {
      // This path has no account/session cookies and never reads local media.
      const bytes = await downloadImage(
        normalizeWechatRemoteImageUrl(raw).href,
      );
      assertWechatPreviewBytes(bytes);
      const picture = nativeImage.createFromBuffer(bytes),
        dimensions = picture.getSize();
      if (
        picture.isEmpty() ||
        dimensions.width <= 0 ||
        dimensions.height <= 0 ||
        dimensions.width * dimensions.height > 40_000_000
      )
        throw new AppError(
          "WECHAT_IMAGE_PREVIEW",
          "无法预览图片或图片尺寸过大，请更换图片。",
        );
      const png = picture.toPNG();
      if (!png.length || png.length > 10 * 1024 * 1024)
        throw new AppError(
          "WECHAT_IMAGE_PREVIEW",
          "图片预览超过 10MB，请压缩后上传。",
        );
      return { bytes: png, mime: "image/png" as const };
    },
    invalidate(account: WebsiteAccount) {
      states.set(context(account), {
        hasSession: false,
        uid: null,
        windowOpen: false,
        expired: true,
        error: "公众号会话需要重新扫码登录并检查。",
      });
    },
  };
}
