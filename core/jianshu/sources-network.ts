import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import { AppError } from "../errors";
import { parseJianshuSourceReference } from "../../shared/jianshu-sources";

export type SourceLookup = (hostname: string) => Promise<LookupAddress[]>;
export type SourceResponse = {
  status: number;
  body: string;
  contentType?: string;
  location?: string;
};
export type SourceTransport = (
  url: URL,
  options: {
    signal: AbortSignal;
    addresses: LookupAddress[];
    method: "GET" | "POST";
    body?: string;
  },
) => Promise<SourceResponse>;
const maxBytes = 3_000_000;
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Reject special-use networks; the selected public address is pinned into HTTPS lookup. */
export function isPublicSourceAddress(raw: string): boolean {
  let address = raw.toLowerCase();
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && [0, 2].includes(c)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && [18, 19].includes(b)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Accept global unicast only. IPv4-mapped, unique/link local, multicast,
  // documentation, 6to4 and Teredo ranges are not public source targets.
  if (isIP(address) !== 6) return false;
  address = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  if (!/^[23][0-9a-f]{3}:/.test(address)) return false;
  const [first, second] = address
    .split(":")
    .map((part) => parseInt(part || "0", 16));
  return (
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
    ![0x2002, 0x3ffe, 0x3fff].includes(first)
  );
}

export function sourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      "JIANSHU_SOURCE_URL",
      "请填写完整的公开 HTTPS 来源网址。",
    );
  }
  if (url.protocol !== "https:" || !parseJianshuSourceReference(url.href))
    throw new AppError(
      "JIANSHU_SOURCE_URL",
      "来源必须是公开 HTTPS 网站，不能包含凭据、内网地址或自定义端口。",
    );
  url.hash = "";
  return url;
}

const nativeTransport: SourceTransport = async (url, options) => {
  return new Promise((resolve, reject) => {
    const address = options.addresses[0];
    const req = request(
      url,
      {
        method: options.method,
        signal: options.signal,
        // Resolve once; a second DNS lookup must not rebind an approved host to a LAN address.
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: {
          "User-Agent": "panxu/PanxuStudio/0.0.5 (https://panxu.site)",
          Accept:
            "application/rss+xml, application/atom+xml, application/json, text/html, application/xml;q=0.9, */*;q=0.2",
          "Accept-Encoding": "identity",
          ...(options.body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(options.body),
              }
            : {}),
        },
      },
      (res) => {
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
          res.destroy();
          reject(
            new AppError(
              "JIANSHU_SOURCE_SIZE",
              "来源内容超过 3 MB，请改用单篇详情或较小的订阅源。",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            res.destroy(
              new AppError(
                "JIANSHU_SOURCE_SIZE",
                "来源内容超过 3 MB，已停止读取。",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: res.headers["content-type"],
            location: res.headers.location,
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
};

export class JianshuSourceNetwork {
  constructor(
    private deps: {
      lookup?: SourceLookup;
      transport?: SourceTransport;
      timeoutMs?: number;
    } = {},
  ) {}
  async read(
    raw: string,
    requestOptions: { method?: "GET" | "POST"; body?: string } = {},
  ) {
    try {
      return await this.readPublic(raw, requestOptions);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "JIANSHU_SOURCE_UNAVAILABLE",
        "来源暂时无法读取，请检查网络或稍后重试；已采集的素材会保留。",
      );
    }
  }
  private async readPublic(
    raw: string,
    requestOptions: { method?: "GET" | "POST"; body?: string },
  ) {
    let url = sourceUrl(raw);
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? 20000);
    const resolve =
      this.deps.lookup ?? ((host: string) => lookup(host, { all: true }));
    let method = requestOptions.method ?? "GET",
      body = requestOptions.body;
    for (let redirect = 0; redirect <= 3; redirect++) {
      signal.throwIfAborted();
      const addresses = await abortable(resolve(url.hostname), signal);
      if (
        !addresses.length ||
        addresses.some((address) => !isPublicSourceAddress(address.address))
      )
        throw new AppError(
          "JIANSHU_SOURCE_NETWORK",
          "来源解析到内网或特殊地址，已停止访问。",
        );
      const response = await abortable(
        (this.deps.transport ?? nativeTransport)(url, {
          signal,
          addresses,
          method,
          body,
        }),
        signal,
      );
      signal.throwIfAborted();
      if (Buffer.byteLength(response.body) > maxBytes)
        throw new AppError(
          "JIANSHU_SOURCE_SIZE",
          "来源内容超过 3 MB，已停止读取。",
        );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirect === 3)
          throw new AppError(
            "JIANSHU_SOURCE_REDIRECT",
            "来源重定向过多或缺少目标地址，请粘贴最终公开页面网址。",
          );
        url = sourceUrl(new URL(response.location, url).href);
        if (
          response.status === 303 ||
          ([301, 302].includes(response.status) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new AppError(
          "JIANSHU_SOURCE_HTTP",
          `来源读取失败（HTTP ${response.status}），原采集结果会保留。`,
        );
      if (!response.body.trim())
        throw new AppError(
          "JIANSHU_SOURCE_EMPTY",
          "来源返回空白内容，请检查网址或稍后重试。",
        );
      const type = response.contentType?.split(";")[0].trim().toLowerCase();
      if (
        type &&
        !/^(?:text\/(?:html|plain|xml)|application\/(?:[^/]+\+)?(?:xml|json)|application\/atom\+xml|application\/rss\+xml)$/.test(
          type,
        )
      )
        throw new AppError(
          "JIANSHU_SOURCE_TYPE",
          "此地址返回附件或不支持的格式，请使用资料介绍页或 RSS/Atom 网址。",
        );
      return { ...response, url: url.href };
    }
    throw new AppError("JIANSHU_SOURCE_REDIRECT", "来源重定向未完成。");
  }
}
