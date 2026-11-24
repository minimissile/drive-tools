import { AppError } from "../errors";
import { readTiebaThreadSource } from "../tieba/analysis";
import {
  jianshuCollectSchema,
  jianshuSourcePresets,
  type JianshuCollectInput,
  type JianshuSourceCollection,
  type JianshuSourceMaterial,
} from "../../shared/jianshu-sources";
import {
  JianshuSourceNetwork,
  sourceUrl,
  type SourceLookup,
  type SourceTransport,
} from "./sources-network";
import {
  parseSourceFeed,
  parseSourceTelegram,
  parseSourceWeb,
  sourceMaterial,
  sourcePlainText,
} from "./sources-parser";
import { collectTiebaSource } from "./source-tieba";

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value : []);
function remoteJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError(
      "JIANSHU_SOURCE_JSON",
      "来源没有返回可识别的 JSON，请稍后重试。原素材会保留。",
    );
  }
}
function trustedImage(raw: unknown) {
  const value = text(raw);
  try {
    return sourceUrl(value).href;
  } catch {
    return null;
  }
}
function tvmazeItems(raw: string, at: string, limit: number) {
  const payload = remoteJson(raw);
  if (!Array.isArray(payload))
    throw new AppError(
      "JIANSHU_TVMAZE_FORMAT",
      "TVmaze 返回格式已变化，未将其当作空列表。",
    );
  const items: JianshuSourceMaterial[] = [];
  for (const result of payload.slice(0, limit)) {
    const show = record(record(result).show),
      name = text(show.name),
      url = text(show.url);
    if (
      !name ||
      !/^https:\/\/www\.tvmaze\.com\/shows\/\d+(?:\/[^?#]*)?$/.test(url)
    )
      continue;
    const network = record(show.network),
      country = record(network.country),
      image = record(show.image);
    const facts = [
      text(show.language) && `语言：${text(show.language)}`,
      text(show.premiered) && `首播日期：${text(show.premiered)}`,
      list(show.genres).filter((v) => typeof v === "string").length &&
        `分类：${list(show.genres).join("、")}`,
      text(network.name) && `播出方：${text(network.name)}`,
      text(country.name) && `地区：${text(country.name)}`,
      sourcePlainText(text(show.summary)),
    ]
      .filter(Boolean)
      .join("\n\n");
    const imageUrl = trustedImage(image.original || image.medium);
    items.push(
      sourceMaterial({
        provider: "tvmaze",
        title: name,
        html: facts || "该条目未提供详细介绍，请到原页核对后补充。",
        url,
        sourceName: "TVmaze",
        collectedAt: at,
        publishedAt: text(show.premiered),
        images: imageUrl ? [{ url: imageUrl, alt: name }] : [],
        warnings: [
          "作品元数据来自 TVmaze，适用 CC BY-SA，需署名并遵循相同方式共享要求。图片仅保留原页引用，不自动下载或取得转载权。此来源不提供网盘文件。",
        ],
      }),
    );
  }
  if (payload.length && !items.length)
    throw new AppError(
      "JIANSHU_TVMAZE_FORMAT",
      "TVmaze 条目缺少作品名或官方地址，无法导入。",
    );
  return {
    items,
    sourceName: "TVmaze",
    truncated: payload.length > limit,
    warnings: [] as string[],
  };
}
function bangumiItems(raw: string, at: string, limit: number) {
  const payload = record(remoteJson(raw));
  if (!Array.isArray(payload.data))
    throw new AppError(
      "JIANSHU_BANGUMI_FORMAT",
      "Bangumi 返回格式已变化，未将其当作空列表。",
    );
  const items: JianshuSourceMaterial[] = [];
  for (const value of payload.data.slice(0, limit)) {
    const subject = record(value),
      name = text(subject.name_cn) || text(subject.name);
    if (!Number.isSafeInteger(subject.id) || Number(subject.id) <= 0 || !name)
      continue;
    const image = record(subject.images),
      imageUrl = trustedImage(image.large || image.common || image.medium);
    const info = list(subject.infobox)
      .map(record)
      .flatMap((field) => {
        const name = text(field.key),
          value = text(field.value);
        return name && value ? `${name}：${value}` : [];
      })
      .slice(0, 20);
    const facts = [
      text(subject.name) && text(subject.name) !== name
        ? `原名：${text(subject.name)}`
        : "",
      text(subject.date) && `首发日期：${text(subject.date)}`,
      ...info,
      text(subject.summary),
    ]
      .filter(Boolean)
      .join("\n\n");
    items.push(
      sourceMaterial({
        provider: "bangumi",
        title: name,
        html: facts || "该条目未提供详细介绍，请到原页核对后补充。",
        url: `https://bgm.tv/subject/${subject.id}`,
        sourceName: "Bangumi",
        collectedAt: at,
        publishedAt: text(subject.date),
        images: imageUrl ? [{ url: imageUrl, alt: name }] : [],
        warnings: [
          "作品条目资料来自 Bangumi，按官方版权说明保留出处与适用 CC BY-SA 信息；不采集用户日志或评论，不默认取得封面转载许可。此来源不提供网盘文件。",
        ],
      }),
    );
  }
  if (payload.data.length && !items.length)
    throw new AppError(
      "JIANSHU_BANGUMI_FORMAT",
      "Bangumi 条目缺少作品名或有效 ID，无法导入。",
    );
  const total =
    typeof payload.total === "number" ? payload.total : payload.data.length;
  return {
    items,
    sourceName: "Bangumi",
    truncated: total > items.length,
    warnings: [] as string[],
  };
}

export class JianshuSourceCollector {
  private network: JianshuSourceNetwork;
  private readTiebaThread: typeof readTiebaThreadSource;
  constructor(
    deps: {
      lookup?: SourceLookup;
      transport?: SourceTransport;
      timeoutMs?: number;
      now?: () => string;
      readTiebaThread?: typeof readTiebaThreadSource;
    } = {},
  ) {
    this.network = new JianshuSourceNetwork(deps);
    this.now = deps.now ?? (() => new Date().toISOString());
    this.readTiebaThread = deps.readTiebaThread ?? readTiebaThreadSource;
  }
  private now: () => string;
  async collect(raw: JianshuCollectInput): Promise<JianshuSourceCollection> {
    const input = jianshuCollectSchema.parse(raw);
    const preset = input.presetId
      ? jianshuSourcePresets.find((item) => item.id === input.presetId)
      : undefined;
    if (input.presetId && !preset)
      throw new AppError(
        "JIANSHU_SOURCE_PRESET",
        "采集来源不存在，请重新选择。",
      );
    const provider = input.provider ?? preset?.provider ?? "web";
    if (preset && input.provider && input.provider !== preset.provider)
      throw new AppError(
        "JIANSHU_SOURCE_PROVIDER",
        "来源与采集方式不一致，请重新选择。",
      );
    let url = input.url?.trim() || preset?.url || "";
    if (provider === "tieba")
      return collectTiebaSource(url, this.readTiebaThread, this.now);
    const query = input.query?.trim() || "";
    let method: "GET" | "POST" = "GET",
      body: string | undefined;
    if (provider === "tvmaze") {
      if (!query)
        throw new AppError("JIANSHU_SOURCE_QUERY", "请输入要查找的剧集名称。");
      url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`;
    } else if (provider === "bangumi") {
      if (!query)
        throw new AppError(
          "JIANSHU_SOURCE_QUERY",
          "请输入要查找的动漫作品名称。",
        );
      url = `https://api.bgm.tv/v0/search/subjects?limit=${input.limit}&offset=0`;
      method = "POST";
      body = JSON.stringify({
        keyword: query,
        sort: "match",
        filter: { type: [2] },
      });
    } else if (provider === "telegram") {
      const target = sourceUrl(url);
      if (
        target.hostname !== "t.me" ||
        !/^\/s\/[a-zA-Z][\w]{3,31}\/?$/.test(target.pathname) ||
        target.search
      )
        throw new AppError(
          "JIANSHU_TELEGRAM_URL",
          "请填写 t.me/s/频道名 的公开频道地址。",
        );
      url = target.href;
    }
    if (!url)
      throw new AppError(
        "JIANSHU_SOURCE_URL",
        "请填写来源网址或选择一个采集来源。",
      );
    const response = await this.network.read(url, { method, body });
    const at = this.now();
    const parsed =
      provider === "rss"
        ? parseSourceFeed(response.body, response.url, at, input.limit)
        : provider === "telegram"
          ? parseSourceTelegram(response.body, response.url, at, input.limit)
          : provider === "tvmaze"
            ? tvmazeItems(response.body, at, input.limit)
            : provider === "bangumi"
              ? bangumiItems(response.body, at, input.limit)
              : parseSourceWeb(response.body, response.url, at);
    // Redirects do not turn one provider into an unrelated authenticated transport.
    if (provider === "telegram" && new URL(response.url).hostname !== "t.me")
      throw new AppError(
        "JIANSHU_SOURCE_REDIRECT",
        "公开频道跳转到了其他网站，请使用原始频道地址。",
      );
    return { ...parsed, url: response.url, collectedAt: at };
  }
}
