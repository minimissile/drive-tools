/**
 * Manual visual fixture, served by the existing Vite source service.
 * This file never calls the backend, network, Electron, clipboard or filesystem.
 * It renders the real App and business components with an in-memory IPC model.
 * It is not a backend test or evidence of remote publishing.
 */
import type { AppSnapshot, ApiUsage } from "../shared/types";
import type {
  CatalogDetail,
  CatalogItem,
  CatalogPreparation,
  CatalogProvider,
  CatalogPublication,
  CatalogSaveInput,
  CatalogSnapshot,
  CatalogSummary,
} from "../shared/resource-catalog";
import { catalogSaveSchema } from "../shared/resource-catalog";
import {
  documentPlatformSpecs,
  documentPlatformUrl,
  isDocumentProvider,
} from "../shared/document-platforms";
import type { WebsiteAccountView } from "../shared/website-accounts";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "normal";
const workspace = "memory:resource-catalog-manual-preview";
const date = "2026-10-29T02:30:00.000Z";
let sequence = 20;
let failure = scenario.endsWith("-error") ? scenario : "";
const changed = new Set<() => void>();
const eventLog: string[] = [];

// The real application's panxu-ui-v1 key must never touch this origin's saved UI.
// Replace only this document's Storage getter; other tabs retain native storage.
const values = new Map<string, string>([
  ["panxu-ui-v1", JSON.stringify({ page: "resource-catalog" })],
]);
const memoryStorage: Storage = {
  get length() {
    return values.size;
  },
  key: (index) => [...values.keys()][index] ?? null,
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => {
    values.set(key, String(value));
  },
  removeItem: (key) => {
    values.delete(key);
  },
  clear: () => {
    values.clear();
  },
};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: memoryStorage,
});

const clone = <T>(value: T): T => structuredClone(value);
const log = (event: string) => {
  eventLog.unshift(event);
  document.getElementById("catalog-qa-output")!.textContent = eventLog
    .slice(0, 5)
    .join("；");
};
const usage = (currency: "CNY" | "USD"): ApiUsage => ({
  currency,
  requestCount: 0,
  cacheHits: 0,
  estimatedMicros: 0,
  estimateUnknownCount: 0,
  confirmedMicros: 0,
  confirmedUnknownCount: 0,
  pendingMicros: 0,
  pendingUnknownCount: 0,
  pendingCount: 0,
});
const snapshot: AppSnapshot = {
  accounts: [],
  resources: [],
  shareChecks: [],
  jobs: [],
  pools: [],
  drafts: [],
  bindings: [],
  publications: [],
  plans: [],
  apiCalls: [],
  asyncQueries: [],
  suggestionQueries: [],
  apiUsage: { cny: usage("CNY"), usd: usage("USD") },
  resourceTotals: {
    resources: 68,
    readyCopies: 58,
    attentionJobs: 0,
    categories: ["英语学习", "效率办公", "编程开发", "设计素材", "电子书"],
  },
  settings: {
    vaultPath: null,
    exportCodes: false,
    model: "",
    aiModels: { copy: "", analysis: "", vision: "", image: "", video: "" },
    openrouterConfigured: false,
    bitUrl: "",
    bitConfigured: false,
    dailyAiBudgetMicros: null,
    previousWorkspace: false,
  },
  appVersion: "0.0.3 · 模拟",
  dataPath: workspace,
};
let accounts: WebsiteAccountView[] =
  scenario === "no-accounts"
    ? []
    : [
        {
          id: "web_preview_feishu",
          provider: "feishu",
          alias: "学习资料 · 飞书主账号",
          status: "connected" as const,
        },
        {
          id: "web_preview_tencent",
          provider: "tencent-docs",
          alias: "资源目录 · 腾讯文档",
          status: "connected" as const,
        },
        {
          id: "web_preview_shimo",
          provider: "shimo",
          alias: "石墨整理账号（待重新登录）",
          status: "expired" as const,
        },
      ].map((account) => ({
        ...account,
        provider: account.provider as CatalogProvider,
        uid: null,
        nickname: null,
        sessionOnly: true,
        checkedAt: date,
        createdAt: date,
        updatedAt: date,
        windowOpen: false,
        message: "模拟本机工作台会话；没有验证远端身份或权限。",
      }));

const resourceTitles = [
  "英语学习路线：从基础词汇、自然拼读到真实场景口语练习的系统资料合集（含完整课件、练习册与长期复习计划）",
  "日常口语 100 个场景 · 音频与学习手册",
  "英语语法图解：常用句型与易错表达",
  "阅读进阶书单：分级故事与每日练习",
  "写作表达素材 · 邮件、报告与生活记录",
  "听力训练：对话、访谈与逐句练习",
  "零基础词汇复习卡片与记忆表",
  "旅行英语：出行前的实用表达",
];
const baseItems: CatalogItem[] = Array.from({ length: 26 }, (_, i) => ({
  resourceId: `resource_preview_${i + 1}`,
  title: `${resourceTitles[i % resourceTitles.length]}${i >= 8 ? ` · 第 ${Math.floor(i / 8) + 1} 辑` : ""}`,
  category: "英语学习",
  summary:
    i === 0
      ? "这是一条专门用于检视长内容排版的模拟资源说明。资料按学习阶段整理，包含课件、练习和复习建议；可根据自己的基础逐步安排，公开内容不含账号身份与本地目录。建议先完成基础词汇复习，再按真实场景进行口语练习。每周可回顾学习进度，记录不熟悉的表达，并在下一次复习时重点巩固。清单中的资料可根据自己的基础安排使用顺序，示例文字仅用于手动检查完整公开说明的展开与收起。"
      : "本地界面示例，包含学习资料与练习说明。所有链接均为占位，不代表实际资源。",
  tags:
    i % 3 === 0
      ? ["学习路线", "适合初学者", "课件与练习", "持续整理"]
      : ["英语", "学习资料"],
  links: [
    {
      provider: "夸克",
      url: `https://pan.quark.cn/s/preview${String(i + 1).padStart(5, "0")}`,
      code: i % 2 ? "" : "abcd",
    },
    ...(i % 5 === 0
      ? [
          {
            provider: "百度网盘",
            url: `https://pan.baidu.com/s/1preview${i}`,
            code: "1234",
          },
        ]
      : []),
  ],
}));
const details = new Map<string, CatalogDetail>();
const frozenSnapshots = new Map<string, CatalogSnapshot>();
const makeSnapshot = (catalog: CatalogDetail["catalog"]): CatalogSnapshot => {
  const items =
    scenario === "no-resources"
      ? []
      : baseItems
          .filter(
            (_, i) =>
              catalog.category === "英语学习" ||
              catalog.category === "all" ||
              i < 6,
          )
          .map((item) => ({
            ...clone(item),
            category: catalog.category,
            summary: catalog.includeSummary ? item.summary : "",
            tags: catalog.includeTags ? item.tags : [],
          }));
  if (catalog.sort === "title")
    items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return {
    id: `snapshot_${catalog.id}_${catalog.revision}`,
    hash: JSON.stringify([
      catalog.title,
      catalog.introduction,
      catalog.includeTags,
      catalog.includeSummary,
      catalog.sort,
      items,
    ]),
    title: catalog.title,
    category: catalog.category,
    introduction: catalog.introduction,
    createdAt: date,
    items,
    excluded: [
      {
        resourceId: "resource_preview_missing",
        title: "历史学习资料（分享已失效，模拟数据）",
        reason: "本人分享已失效，请先在资源库处理。",
      },
      {
        resourceId: "resource_preview_unverified",
        title: "尚未核验归属的课件",
        reason: "尚未核实本人分享，不纳入公开清单。",
      },
    ],
  };
};
const seed = (
  id: string,
  title: string,
  category: string,
  archived = false,
) => {
  const catalog = {
    id,
    title,
    category,
    introduction:
      "按学习阶段整理的资料目录。选择适合自己的内容，点击资源链接查看；清单会持续维护。（本地模拟示例）",
    includeSummary: true,
    includeTags: true,
    sort: "title" as const,
    revision: 2,
    archived,
    createdAt: date,
    updatedAt: date,
  };
  const current = makeSnapshot(catalog);
  details.set(id, {
    catalog,
    current,
    publications: [],
    preparations: [],
    history: [],
  });
};
if (scenario !== "empty") {
  seed(
    "catalog_preview_english",
    "英语学习资源清单：基础入门到日常应用",
    "英语学习",
  );
  seed("catalog_preview_office", "效率办公工具与模板", "效率办公");
  seed("catalog_preview_design", "设计素材与灵感参考", "设计素材");
  seed("catalog_preview_archived", "2025 年电子书整理归档", "电子书", true);
  const detail = details.get("catalog_preview_english")!;
  const initialProviders: CatalogProvider[] = ["feishu", "tencent-docs"];
  detail.publications = initialProviders.map(
    (provider, i): CatalogPublication => ({
      id: `publication_preview_${i}`,
      provider,
      accountId: i ? "web_preview_tencent" : "web_preview_feishu",
      accountAlias: i ? "资源目录 · 腾讯文档" : "学习资料 · 飞书主账号",
      url: i
        ? "https://docs.qq.com/doc/DPreviewCatalog"
        : "https://example.feishu.cn/docx/PreviewCatalog",
      snapshotId: "snapshot_old",
      hash: `previous_${i}`,
      version: i + 1,
      confirmedAt: "2026-10-26T05:00:00.000Z",
      preparationId: `preparation_old_${i}`,
      needsUpdate: true,
      diff: {
        added: clone(detail.current.items.slice(0, 3)),
        changed: clone(detail.current.items.slice(3, 5)),
        removed: [
          {
            ...clone(baseItems[0]),
            resourceId: "resource_retired",
            title: "旧版英语练习册（已移出分类）",
          },
        ],
        metadataChanged: false,
      },
    }),
  );
  detail.history = detail.publications.map(
    ({ needsUpdate: _needsUpdate, diff: _diff, ...receipt }) => receipt,
  );
}

const get = (id: string) => {
  const detail = details.get(id);
  if (!detail) throw Error("模拟清单不存在，请返回清单列表。");
  return detail;
};
const refreshCurrent = (detail: CatalogDetail) => {
  detail.current = makeSnapshot(detail.catalog);
  for (const publication of detail.publications)
    publication.needsUpdate = publication.hash !== detail.current.hash;
};
const revision = (detail: CatalogDetail, expected: number | undefined) => {
  if (expected !== detail.catalog.revision)
    throw Error("清单已变更，请刷新后重试。（模拟冲突检查）");
};
const summaries = (): CatalogSummary[] =>
  [...details.values()].map((detail) => {
    refreshCurrent(detail);
    return {
      ...detail.catalog,
      resourceCount: detail.current.items.length,
      excludedCount: detail.current.excluded.length,
      publicationCount: detail.publications.length,
      pendingCount: detail.publications.filter((item) => item.needsUpdate)
        .length,
    };
  });
const preparation = (id: string, preparationId: string) => {
  const detail = get(id);
  const prepared = detail.preparations.find(
    (item) => item.id === preparationId,
  );
  if (!prepared) throw Error("模拟交接记录不存在。");
  return { detail, prepared };
};

async function invoke(method: string, raw: unknown): Promise<unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (method === "snapshot") return snapshot;
  if (method === "updater.state") return null;
  if (
    ["zhidao.activeRuns", "environments.list", "zhidao.accounts"].includes(
      method,
    )
  )
    return [];
  if (method === "resourceCatalog.list") {
    if (failure === "list-error")
      throw Error("模拟：清单列表读取失败。恢复读取后点击重试。");
    return summaries();
  }
  if (method === "resourceCatalog.get") {
    if (failure === "detail-error")
      throw Error("模拟：清单详情读取失败。恢复读取后点击重试。");
    const detail = get(String(input.id));
    refreshCurrent(detail);
    return detail;
  }
  if (method === "resourceCatalog.save") {
    const parsed: CatalogSaveInput = catalogSaveSchema.parse(input);
    let detail: CatalogDetail;
    if (parsed.id) {
      detail = get(parsed.id);
      revision(detail, parsed.expectedRevision);
      detail.catalog = {
        ...detail.catalog,
        ...parsed,
        id: parsed.id,
        revision: detail.catalog.revision + 1,
        updatedAt: date,
      };
    } else {
      const id = `catalog_preview_new_${++sequence}`;
      seed(id, parsed.title, parsed.category);
      detail = get(id);
      detail.catalog = { ...detail.catalog, ...parsed, id, revision: 1 };
    }
    refreshCurrent(detail);
    log(`已在内存保存「${detail.catalog.title}」`);
    return detail;
  }
  if (method === "resourceCatalog.archive") {
    const detail = get(String(input.id));
    revision(detail, Number(input.expectedRevision));
    detail.catalog.archived = input.archived === true;
    detail.catalog.revision += 1;
    refreshCurrent(detail);
    log(`内存清单${input.archived ? "归档" : "恢复"}`);
    return detail;
  }
  if (method === "resourceCatalog.remove") {
    const detail = get(String(input.id));
    revision(detail, Number(input.expectedRevision));
    details.delete(detail.catalog.id);
    log("已删除内存清单，不影响真实工作空间");
    return true;
  }
  if (method === "resourceCatalog.prepare") {
    const detail = get(String(input.id));
    revision(detail, Number(input.expectedRevision));
    if (detail.catalog.archived) throw Error("请先恢复维护。");
    const provider = String(input.provider);
    if (!isDocumentProvider(provider)) throw Error("请选择文档平台。");
    const account = accounts.find(
      (item) => item.id === input.accountId && item.provider === provider,
    );
    if (!account) throw Error("模拟账号不存在或平台不匹配。");
    refreshCurrent(detail);
    const frozen = clone(detail.current);
    frozen.id = `snapshot_frozen_${++sequence}`;
    const publication = detail.publications.find(
      (item) => item.id === input.publicationId,
    );
    const prepared: CatalogPreparation = {
      id: `preparation_preview_${++sequence}`,
      catalogId: detail.catalog.id,
      provider,
      accountId: account.id,
      accountAlias: account.alias,
      publicationId: publication?.id ?? null,
      snapshotId: frozen.id,
      hash: frozen.hash,
      version: publication ? publication.version + 1 : 1,
      createdAt: date,
      confirmedAt: null,
    };
    detail.preparations.unshift(prepared);
    frozenSnapshots.set(frozen.id, frozen);
    log(`内存冻结 V${prepared.version}，共 ${frozen.items.length} 项资源`);
    return { preparation: prepared, snapshot: frozen };
  }
  if (method === "resourceCatalog.copy" || method === "resourceCatalog.open") {
    const { detail, prepared } = preparation(
      String(input.id),
      String(input.preparationId),
    );
    if (method.endsWith("copy")) {
      log(`模拟复制 V${prepared.version}：未写入系统剪贴板`);
      return { copied: true, format: "rich" };
    }
    const url =
      detail.publications.find((item) => item.id === prepared.publicationId)
        ?.url ?? documentPlatformSpecs[prepared.provider].home;
    log(`模拟打开：${url}（未联网）`);
    return { opened: true, url };
  }
  if (method === "resourceCatalog.confirm") {
    const { detail, prepared } = preparation(
      String(input.id),
      String(input.preparationId),
    );
    const url = documentPlatformUrl(prepared.provider, String(input.url));
    if (
      !url ||
      !input.publicConfirmed ||
      !/\/(docx|doc|sheet|docs|sheets)\//.test(new URL(url).pathname)
    )
      throw Error("请填写所选平台的文档链接，并核对公开阅读权限。");
    const old = detail.publications.find(
      (item) => item.id === prepared.publicationId,
    );
    if (old && old.url !== url)
      throw Error("更新请沿用原文档链接；另一文档请准备新交接。");
    const publication: CatalogPublication = {
      id: old?.id ?? `publication_preview_${++sequence}`,
      provider: prepared.provider,
      accountId: prepared.accountId,
      accountAlias: prepared.accountAlias,
      url,
      snapshotId: prepared.snapshotId,
      hash: prepared.hash,
      version: prepared.version,
      confirmedAt: date,
      preparationId: prepared.id,
      needsUpdate: prepared.hash !== detail.current.hash,
      diff: { added: [], changed: [], removed: [], metadataChanged: false },
    };
    detail.publications = [
      publication,
      ...detail.publications.filter((item) => item.id !== publication.id),
    ];
    prepared.confirmedAt = date;
    const { needsUpdate: _needsUpdate, diff: _diff, ...receipt } = publication;
    detail.history.unshift(receipt);
    log("内存登记完成：未核验或修改远端文档");
    return detail;
  }
  if (method === "resourceCatalog.export") {
    get(String(input.id));
    log(`模拟导出 ${String(input.format)}：未写入文件`);
    return `/仅内存模拟/资源清单.${String(input.format)}`;
  }
  if (method === "websiteAccounts.list") {
    if (failure === "account-error")
      throw Error("模拟：文档账号读取失败。恢复读取后点击重试。");
    return accounts;
  }
  if (method === "websiteAccounts.add") {
    const provider = String(input.provider);
    if (!isDocumentProvider(provider))
      throw Error("本验收入口只模拟三类文档账号。");
    const account: WebsiteAccountView = {
      id: `web_preview_${++sequence}`,
      provider,
      alias: String(
        input.alias || `${documentPlatformSpecs[provider].name}模拟账号`,
      ),
      uid: null,
      status: "disconnected",
      sessionOnly: true,
      createdAt: date,
      updatedAt: date,
      windowOpen: false,
      message: "仅内存模拟，请点击登录后检查。",
    };
    accounts.push(account);
    log("已增加内存模拟账号");
    return account;
  }
  if (method.startsWith("websiteAccounts.")) {
    const account = accounts.find((item) => item.id === input.id);
    if (!account) throw Error("模拟账号不存在。");
    if (method === "websiteAccounts.login") {
      account.windowOpen = true;
      log("模拟登录窗口：未打开真实网页");
      return true;
    }
    if (method === "websiteAccounts.check") {
      account.status = "connected";
      account.checkedAt = date;
      return account;
    }
    if (method === "websiteAccounts.rename") {
      account.alias = String(input.alias);
      return account;
    }
    if (method === "websiteAccounts.remove") {
      accounts = accounts.filter((item) => item.id !== account.id);
      return true;
    }
    if (method === "websiteAccounts.openDocument") {
      log(`模拟文档窗口：${String(input.url)}（未联网）`);
      return true;
    }
  }
  if (method === "system.copyText") {
    log(`模拟复制文本：${String(input.text).slice(0, 90)}`);
    return true;
  }
  if (method === "system.external") {
    log(`模拟打开链接：${String(input.url)}（未联网）`);
    return true;
  }
  throw Error(`手动验收入口未模拟此操作：${method}；不会转发到真实服务。`);
}

window.panxu = {
  invoke: async <T>(method: string, args?: unknown) =>
    clone(await invoke(method, args)) as T,
  onChanged: (callback) => {
    changed.add(callback);
    return () => {
      changed.delete(callback);
    };
  },
  onUpdateChanged: () => () => {},
};
document
  .querySelectorAll<HTMLButtonElement>("[data-scenario]")
  .forEach((button) => {
    button.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set("scenario", button.dataset.scenario!);
      location.href = url.toString();
    };
  });
document.getElementById("catalog-qa-recover")!.onclick = () => {
  failure = "";
  log("已关闭模拟读取失败。请点击业务界面中的重试或刷新。");
};
document.getElementById("catalog-qa-hide")!.onclick = () => {
  document.getElementById("catalog-qa-controls")!.hidden = true;
};
if (params.get("controls") === "0")
  document.getElementById("catalog-qa-controls")!.hidden = true;
void import("../src/main");
