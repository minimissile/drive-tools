/** Test-only iframe IPC. No real backend, account, external fetch, upload or publishing. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useAppData, useAppNavigation } from "../src/state";
import { ToastMessage } from "../src/state/feedback";
import JianshuWorkflow from "../src/jianshu/Workflow";
import { windowStorage } from "../src/storage/window-storage";
import {
  jianshuDelivery,
  jianshuIssues,
  jianshuInitialBody,
} from "../core/jianshu/content";
import {
  jianshuCreateSchema,
  jianshuSaveSchema,
  jianshuGenerateSchema,
  type JianshuArticle,
  type JianshuDetail,
} from "../shared/jianshu";
import type { JianshuSourceMaterial } from "../shared/jianshu-sources";
import type { WebsiteAccountView } from "../shared/website-accounts";
import type { AppSnapshot } from "../shared/types";
import "../src/styles.css";

const params = new URLSearchParams(location.search),
  run = params.get("run") || "manual";
if (params.get("frame") !== "1") {
  const frame = document.createElement("iframe");
  frame.title = "简书内容内存模拟页面";
  frame.src = `${location.pathname}?frame=1&run=${encodeURIComponent(run)}`;
  frame.style.cssText = "border:0;width:100%;height:100vh;display:block";
  document.body.style.margin = "0";
  document.getElementById("root")!.replaceWith(frame);
} else {
  const scope = `memory:jianshu-ui:${run}`;
  const at = "2026-11-23T08:00:00.000Z";
  const account: WebsiteAccountView = {
    id: "web_jianshu_fixture",
    provider: "jianshu",
    alias: "简书测试账号",
    nickname: "内存模拟作者",
    uid: "30293973",
    status: "connected",
    createdAt: at,
    updatedAt: at,
    windowOpen: false,
    message: "仅模拟身份",
  };
  const resource = {
    resourceId: "resource_js_fixture",
    copyId: "copy_js_fixture",
    title: "英语自学资料与阅读练习",
    accountAlias: "资料账号",
    summary:
      "资料包含英语词汇整理和阅读练习目录，适合按自己的学习计划逐步阅读；具体练习范围以文件目录为准。",
    matchedTerms: ["英语"],
  };
  const resourceUrl = "https://pan.quark.cn/s/ownenglish1?pwd=ABCD";
  const source: JianshuSourceMaterial = {
    id: "jsource_fixture",
    provider: "rss",
    title: "英语学习工具与练习安排",
    body: "原作者介绍了词汇回顾与阅读练习的安排方式，先了解资料目录，再根据学习进度选择相应部分。这是本地模拟素材，未采集真实网站。",
    summary:
      "英语学习工具与练习安排：先了解资料目录，再根据学习进度选择相应部分。",
    url: "https://source.example.org/english",
    sourceName: "原作者订阅（模拟）",
    author: "原作者",
    publishedAt: at,
    collectedAt: at,
    images: [],
    externalShares: [],
    warnings: ["本地模拟素材，来源保留，不代表取得全文转载许可。"],
  };
  const tiebaSource: JianshuSourceMaterial = {
    id: "jsource_tieba_fixture",
    provider: "tieba",
    title: "一键共享打印机的使用方法",
    body: "楼主整理了局域网打印机的共享方法。\n\n先打开工具，再选择要共享的打印机。",
    summary: "楼主整理了局域网打印机的共享方法和使用步骤。",
    url: "https://tieba.baidu.com/p/9063569462",
    sourceName: "百度贴吧 · windows11吧",
    author: "工具分享者",
    publishedAt: "2024-06-23T09:00:45.000Z",
    collectedAt: "2026-11-24T04:00:00.000Z",
    images: [
      { url: "https://tiebapic.baidu.com/example/first.png", alt: "工具界面" },
      {
        url: "https://tiebapic.baidu.com/example/second.png",
        alt: "选择打印机",
      },
    ],
    externalShares: [{ url: "https://www.123pan.com/s/fixture", code: "" }],
    warnings: [],
  };
  const articles = new Map<string, JianshuArticle>(),
    sources = new Map<string, JianshuSourceMaterial>();
  const events: { method: string; args: unknown }[] = [];
  const listeners = new Set<() => void>();
  let accounts: WebsiteAccountView[] = [],
    failCollect = false,
    failGenerate = false,
    failSave = false,
    receiptVerified = false;
  let accountCheckMode = "success";
  let prepareMode = "success",
    draftCreations = 0,
    imageUploads = 0;
  let heldMethod = "",
    release: (() => void) | undefined,
    sequence = 0;
  const clipboard = { title: "", text: "" },
    exports: string[] = [];
  const imageFile = `${"a".repeat(64)}.png`;
  const imageUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ2kAAAAASUVORK5CYII=";
  const clone = <T,>(value: T) => structuredClone(value);
  const details = (article: JianshuArticle): JianshuDetail => {
    const selected = article.sourceIds.flatMap((id) =>
      sources.has(id) ? [sources.get(id)!] : [],
    );
    const delivery = jianshuDelivery(
      article,
      selected,
      article.copyId ? { title: resource.title, url: resourceUrl } : null,
    );
    return {
      article: clone(article),
      sources: clone(selected),
      issues: jianshuIssues(article, delivery.resourceUrl),
      delivery,
      busy: false,
    };
  };
  const saveVersion = (
    article: JianshuArticle,
    origin: "created" | "manual" | "ai",
    instruction = "",
  ) =>
    article.versions.push({
      revision: article.revision,
      title: article.title,
      body: article.body,
      images: clone(article.images),
      copyId: article.copyId,
      sourceIds: clone(article.sourceIds),
      template: article.template,
      instruction,
      origin,
      createdAt: at,
    });
  const articleFor = (args: any) => {
    const article = articles.get(args.id);
    if (!article) throw new Error("模拟文章不存在。");
    if (args.revision !== undefined && article.revision !== args.revision)
      throw new Error("稿件已在其他窗口更新，当前文字保留。");
    return article;
  };
  const invoke = async (method: string, args: any) => {
    events.push({ method, args: clone(args) });
    if (heldMethod === method) {
      heldMethod = "";
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      release = undefined;
    }
    if (method === "snapshot")
      return {
        dataPath: scope,
        resources: [],
        accounts: [],
        settings: {},
        appVersion: "fixture",
      } as unknown as AppSnapshot;
    if (method === "websiteAccounts.list") return clone(accounts);
    if (method === "websiteAccounts.check") {
      const current = accounts.find((item) => item.id === args.id);
      if (!current) throw new Error("测试仅核对内存简书账号。");
      if (accountCheckMode === "failure") {
        accountCheckMode = "success";
        throw new Error(
          "简书身份核验暂时无法连接，原账号与稿件已保留，请重试。",
        );
      }
      const mode = accountCheckMode;
      accountCheckMode = "success";
      const result: WebsiteAccountView = {
        ...current,
        checkedAt: "2026-11-24T01:02:03.000Z",
        status: mode === "mismatch" ? "disconnected" : "connected",
        unverified: mode === "unverified",
        checking: false,
        message:
          mode === "mismatch"
            ? "简书窗口当前登录了其他身份，请重新登录原账号。"
            : mode === "unverified"
              ? "暂未核实简书当前身份，请稍后重新检查登录。"
              : "已核实简书当前身份。",
      };
      accounts = accounts.map((item) =>
        item.id === result.id ? result : item,
      );
      return clone(result);
    }
    if (method === "jianshu.matches")
      return clone(
        [resource].filter(
          (r) => !args.keyword || r.title.includes(args.keyword),
        ),
      );
    if (method === "jianshu.list")
      return clone(
        [...articles.values()]
          .reverse()
          .map(
            ({
              id,
              title,
              stage,
              accountId,
              copyId,
              sourceIds,
              updatedAt,
              receiptUrl,
              imageReviewRequired,
              message,
            }) => ({
              id,
              title,
              stage,
              accountId,
              copyId,
              sourceIds,
              updatedAt,
              receiptUrl,
              imageReviewRequired,
              message,
            }),
          ),
      );
    if (method === "jianshu.sources")
      return clone(
        [...sources.values()].sort((a, b) =>
          b.collectedAt.localeCompare(a.collectedAt),
        ),
      );
    if (method === "jianshu.collect") {
      if (failCollect) {
        failCollect = false;
        throw new Error("来源暂时无法读取，原采集记录已保留，请重试。");
      }
      const selected = args?.provider === "tieba" ? tiebaSource : source;
      sources.set(selected.id, clone(selected));
      return [clone(selected)];
    }
    if (method === "jianshu.create") {
      const input = jianshuCreateSchema.parse(args),
        selected = input.sourceIds
          .map((id) => sources.get(id)!)
          .filter(Boolean);
      const title =
        input.title ||
        (input.copyId ? resource.title : selected[0]?.title || "");
      const summary = input.copyId
        ? resource.summary
        : selected.map((s) => s.body).join("\n\n");
      const article: JianshuArticle = {
        id: `jianshu_fixture_${++sequence}`,
        title,
        body: input.body || jianshuInitialBody(title, summary, input.template),
        template: input.template,
        copyId: input.copyId || null,
        sourceIds: input.sourceIds,
        images: [],
        accountId: input.accountId || null,
        revision: 1,
        versions: [],
        aiAssisted: false,
        stage: "editing",
        message: "本地草稿已建立。",
        editorUrl: null,
        receiptUrl: null,
        preparedRevision: null,
        preparedUid: null,
        preparedEnvironment: null,
        preparedText: null,
        createdAt: at,
        updatedAt: at,
      };
      saveVersion(article, "created");
      articles.set(article.id, article);
      return details(article);
    }
    if (method === "system.copyText") {
      clipboard.title = args.text;
      return true;
    }
    if (method === "system.external") return true;
    if (method === "websiteAccounts.openDocument")
      return { opened: true, url: args.url };
    const article = articleFor(args);
    if (method === "jianshu.get") return details(article);
    if (method === "jianshu.save") {
      const input = jianshuSaveSchema.parse(args);
      if (failSave) {
        failSave = false;
        throw new Error("稿件已在其他窗口更新，当前文字保留。");
      }
      Object.assign(article, input, { revision: article.revision + 1 });
      saveVersion(article, "manual");
      return details(article);
    }
    if (method === "jianshu.generate") {
      const input = jianshuGenerateSchema.parse(args);
      if (failGenerate) {
        failGenerate = false;
        throw new Error("模拟模型暂时不可用，当前稿件和旧版本已保留。");
      }
      article.revision++;
      article.title = "英语自学资料：先看目录再安排练习";
      article.body =
        "根据资料目录安排阅读，再分阶段完成词汇回顾与阅读练习。每天根据自己的学习时间选择一个小目标，完成后记录需要继续复习的部分。";
      article.aiAssisted = true;
      saveVersion(article, "ai", input.instruction);
      return details(article);
    }
    if (method === "jianshu.copy") {
      clipboard.text = details(article).delivery.text;
      return true;
    }
    if (method === "jianshu.export") {
      exports.push(article.id);
      return `/memory-only/${article.id}.md`;
    }
    if (method === "jianshu.prepare") {
      if (!article.accountId) throw new Error("请先选择简书账号。");
      if (article.preparedFill?.pendingImageSha256)
        throw new Error("上一张图片上传结果未确认，请先检查官网草稿。");
      article.preparedRevision = article.revision;
      article.preparedText = details(article).delivery.text;
      article.preparedUid = account.uid;
      article.preparedEnvironment = "fixture";
      const mode = prepareMode;
      prepareMode = "success";
      if (mode === "legacy") {
        article.stage = "prepared";
        article.editorUrl = "https://www.jianshu.com/writer#/notebooks/300";
        article.message =
          "官网窗口已打开，内容已复制；请在官网完成发布。尚未确认发布成功。";
        return details(article);
      }
      if (!article.preparedFill) {
        draftCreations++;
        article.preparedFill = {
          editorUrl: `https://www.jianshu.com/writer#/notebooks/300/notes/${900 + draftCreations}`,
          filled: false,
          uploadedImages: 0,
          totalImages: article.images.length,
        };
      }
      article.editorUrl = article.preparedFill.editorUrl;
      if (mode === "partial") {
        article.stage = "uncertain";
        article.message =
          "模拟配图上传中断，官网草稿已保留；可继续填写原草稿，不会新建文章。";
        return details(article);
      }
      if (!article.preparedFill.filled)
        imageUploads +=
          article.images.length - (article.preparedFill.uploadedImages || 0);
      article.preparedFill = {
        ...article.preparedFill,
        filled: true,
        uploadedImages: article.images.length,
        totalImages: article.images.length,
      };
      article.stage = "prepared";
      article.message =
        "标题、正文和配图已填写到简书草稿，请在官网检查排版并由你点击发布。尚未发布。";
      return details(article);
    }
    if (method === "jianshu.checkResult") {
      article.receiptUrl = args.url;
      article.stage = receiptVerified ? "published" : "uncertain";
      article.imageReviewRequired =
        receiptVerified && article.images.length > 0;
      article.message = receiptVerified
        ? "已核实本人文章、正文和资源入口。"
        : "读取结果尚未核实，请查看原页面；不会自动重发。";
      return details(article);
    }
    if (method === "jianshu.confirmImages") {
      article.imageReviewRequired = false;
      article.imageReviewedAt = at;
      article.message =
        "文章已核实，配图已由你在官网人工核对；保留人工核对时间。";
      return details(article);
    }
    if (method === "jianshu.resolve") {
      if (args.newDraft) {
        article.editorUrl = null;
        article.preparedFill = null;
        article.preparedUid = null;
        article.preparedRevision = null;
        article.stage = "editing";
        article.message = "已保留原官网草稿，下次填写将新建草稿。";
        return details(article);
      }
      if (args.imageNotUploaded) {
        if (!article.preparedFill?.pendingImageSha256)
          throw new Error("当前没有待确认的图片上传，未更改草稿状态。");
        article.preparedFill.pendingImageSha256 = null;
        article.preparedFill.filled = false;
      }
      article.stage = "editing";
      article.message = args.imageNotUploaded
        ? "已确认图片未上传，保留原简书草稿和已上传配图，可重新填写原草稿。"
        : "请继续修改当前稿件。";
      article.preparedRevision = null;
      article.receiptUrl = null;
      return details(article);
    }
    if (method === "jianshu.importImages") {
      article.images = [
        {
          file: imageFile,
          sha256: "a".repeat(64),
          storage: "content-assets",
          name: "英语资料封面（模拟）",
        },
      ];
      article.revision++;
      saveVersion(article, "manual");
      return details(article);
    }
    if (method === "jianshu.image") return imageUrl;
    throw new Error(`测试页面禁止请求：${method}`);
  };
  window.panxu = {
    windowId: `jianshu-qa:${run}`,
    initialPage: "jianshu-workflow",
    invoke: async <T,>(method: string, args?: unknown) =>
      (await invoke(method, args)) as T,
    onChanged: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    onDevSessionsChanged: () => () => {},
    onUpdateChanged: () => () => {},
  };
  let remount = () => {},
    leave = () => {},
    back = () => {};
  Object.assign(window, {
    __jianshuQa: {
      events: () => clone(events),
      latest: () => clone([...articles.values()].at(-1)),
      clipboard: () => clone(clipboard),
      exports: () => clone(exports),
      failCollect: () => {
        failCollect = true;
      },
      seedSourceHistory: () => {
        sources.set(source.id, clone(source));
        for (let i = 2; i <= 7; i++) {
          const item = {
            ...clone(source),
            id: `${source.id}_${i}`,
            title: `英语学习素材 ${i}`,
            url: `https://source.example.org/english/${i}`,
          };
          sources.set(item.id, item);
        }
        for (const callback of listeners) callback();
      },
      failGenerate: () => {
        failGenerate = true;
      },
      failSave: () => {
        failSave = true;
      },
      prepareMode: (mode: string) => {
        prepareMode = mode;
      },
      prepareStats: () => ({ draftCreations, imageUploads }),
      seedImageRecovery: async () => {
        accounts = [clone(account)];
        const created = (await invoke("jianshu.create", {
          requestId: crypto.randomUUID(),
          copyId: resource.copyId,
          sourceIds: [],
          accountId: account.id,
          template: "resource",
        })) as JianshuDetail;
        const article = articles.get(created.article.id)!;
        article.images = [
          {
            file: imageFile,
            sha256: "a".repeat(64),
            storage: "content-assets",
            name: "英语资料封面（模拟）",
          },
        ];
        article.stage = "uncertain";
        article.editorUrl =
          "https://www.jianshu.com/writer#/notebooks/300/notes/950";
        article.preparedRevision = article.revision;
        article.preparedUid = account.uid;
        article.preparedEnvironment = "fixture";
        article.preparedText = details(article).delivery.text;
        article.preparedFill = {
          editorUrl: article.editorUrl,
          filled: false,
          totalImages: 1,
          uploadedImages: 0,
          pendingImageSha256: "a".repeat(64),
        };
        article.message = "模拟图片上传结果未知，保留原官网草稿。";
        for (const callback of listeners) callback();
        return clone(article);
      },
      externalUpdate: () => {
        const article = [...articles.values()].at(-1)!;
        article.revision++;
        article.title = "其他窗口已保存的标题";
        article.body =
          "其他窗口已保存的稿件内容。当前窗口未保存的输入应当保留，直到用户显式读取新版本。";
        saveVersion(article, "manual");
        for (const callback of listeners) callback();
      },
      hold: (method: string) => {
        heldMethod = method;
      },
      release: () => release?.(),
      verifyReceipt: () => {
        receiptVerified = true;
      },
      enableAccount: () => {
        accounts = [clone(account)];
        for (const callback of listeners) callback();
      },
      accountStates: (items: Partial<WebsiteAccountView>[]) => {
        accounts = items.map((item, index) => ({
          ...clone(account),
          id: index ? `web_jianshu_fixture_${index + 1}` : account.id,
          nickname: index ? `另一位模拟作者${index + 1}` : account.nickname,
          ...item,
        }));
        for (const callback of listeners) callback();
      },
      accountCheckMode: (mode: string) => {
        accountCheckMode = mode;
      },
      accounts: () => clone(accounts),
      remount: () => remount(),
      leave: () => leave(),
      back: () => back(),
      cleanup: () => windowStorage.clear(),
    },
  });
  function Fixture() {
    const { data } = useAppData(),
      { page, navigate } = useAppNavigation();
    const [generation, setGeneration] = useState(0);
    remount = () => setGeneration((v) => v + 1);
    leave = () => navigate("library");
    back = () => navigate("jianshu-workflow");
    return (
      <main style={{ maxWidth: 1200, margin: "16px auto", padding: "0 24px" }}>
        <p className="muted">
          专用内存模拟 · 不读取真实账号、不调用模型、不上传或发布
        </p>
        {!data ? (
          <p>正在读取模拟工作空间…</p>
        ) : page === "jianshu-workflow" ? (
          <JianshuWorkflow key={generation} />
        ) : (
          <section className="panel">
            <h2>模拟切换到其他模块</h2>
            <button onClick={() => navigate("jianshu-workflow")}>
              返回简书测试工作区
            </button>
          </section>
        )}
        <ToastMessage />
      </main>
    );
  }
  createRoot(document.getElementById("root")!).render(
    <AppProvider>
      <Fixture />
    </AppProvider>,
  );
}
