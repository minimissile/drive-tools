import type { PhotoPostContract } from "./photo-posts";
import type { SystemLogContract } from "./system-logs";
import type { VideoContract } from "./video-jobs";
import type { MusicContract } from "./music";
import type { BilibiliContract } from "./bilibili";
import type { ResourceCatalogContract } from "./resource-catalog";
import type { BaiduDiscoveryContract } from "./baidu-discovery";
import type { DevSessionContract } from "./dev-sessions";
import type { DevUpdateContract } from "./dev-updates";
import type { ResourceAnswerContract } from "./resource-answers";
import type { ResourceDeletionContract } from "./resource-deletion";
import type { ShareCreationContract } from "./share-creation";
import type { ResourceLinksContract } from "./resource-links";
import type { ResourceLandingContract } from "./resource-landing";
import type { AccountDeletionContract } from "./account-deletion";
import type { SmzdmContract } from "./smzdm";
import type { WechatContract } from "./wechat";
import type { DistributionContract } from "./distribution";
import type { PipixContract } from "./pipix";
import type { PipixAcquisitionContract } from "./pipix-acquisition";
import type { ContentSupplyContract } from "./content-supply";
import type { AutocareContract } from "./zhihu-autocare";
import type { TiebaAutocareContract } from "./tieba-autocare";
import type { TiebaForumDiscoveryContract } from "./tieba-forum-discovery";
import type { TiebaParticipationContract } from "./tieba-participation";
import type { TiebaAutomationContract } from "./tieba-automation";
import type { TiebaTopicsContract } from "./tieba-topics";
import type { TiebaInsightsContract } from "./tieba-insights";
import type { TiebaPublishingContract } from "./tieba-publishing";
import type { TiebaPostStatsContract } from "./tieba-post-stats";
import type { TiebaAnalysisContract } from "./tieba-analysis";
import type { TiebaResourceDiscoveryContract } from "./tieba-resource-discovery";
import type { ZhihuContract } from "./zhihu";
import type { ZhihuParticipationContract } from "./zhihu-participation";
import type { IntelligentOperationsContract } from "./intelligent-operations";
import type { BrowserEnvironmentContract } from "./browser-environments";
import type { BitBrowserContract } from "./bitbrowser";
import type { IpcCommands } from "./ipc-commands";
import type { DriveFilesContract } from "./drive-files";
import type { DriveBrowserContract } from "./drive-browser";
import type { ZhidaoContract } from "./zhidao-ipc";
import type { PageDiscoveryContract } from "./zhidao-page-discovery";
import type { BaiduKeywordContract } from "./baidu-keywords";
import type { BaiduResearchContract } from "./baidu-research";
import type { WebsiteAccountContract } from "./website-accounts";
import type { CsdnWorkflowContract } from "./csdn-workflow";
import type { WeiboMarketingContract } from "./weibo-marketing";
import type { WeiboPostsContract } from "./weibo-posts";
import type { WeiboStatisticsContract } from "./weibo-statistics";
import type { WeiboWorkspaceContract } from "./weibo-workspace";
import type {
  AppSnapshot,
  BrowserBinding,
  Resource,
  ResourcePage,
  SimilarResource,
  SplitRun,
  SplitItem,
  TransferBatch,
  RemoteFile,
  Draft,
} from "./types";
import type { AiCatalog } from "./ai-models";
import type { IdeaRun } from "./ideas";
import type { ExportRun, ExportPlan } from "./resource-export";
import type {
  SearchPage,
  SearchDetail,
  SearchTargets,
  TopicStage,
} from "./search";
import type { ShareStatsFilter, ShareStatsResult } from "./share-statistics";
import type {
  CreativeTemplate,
  MediaModel,
  StudioJob,
  StudioWorkingCopy,
} from "./studio";
import type {
  KnowledgeFilter,
  KnowledgePage,
  KnowledgeContract,
} from "./traffic-knowledge";
import type { PublicationDeliveryCheck } from "./publication-checks";
import type { UpdateState } from "./updates";

type Contract<Args, Value> = { args: Args; value: Value };
export interface CandidatePage {
  total: number;
  page: number;
  pageSize: number;
  items: {
    copyId: string;
    accountId: string;
    title: string;
    provider: string;
    category: string;
  }[];
}
export type BatchSummary = { id: string; createdAt: string; count: number };
export type SplitSummary = {
  id: string;
  depth: number;
  mode: string;
  status: string;
  createdAt: string;
};

/** Renderer query contracts. Add new requests here instead of asserting a return type in JSX. */
export interface IpcContract
  extends
    PhotoPostContract,
    SystemLogContract,
    VideoContract,
    MusicContract,
    BilibiliContract,
    BaiduDiscoveryContract,
    DevSessionContract,
    DevUpdateContract,
    ResourceCatalogContract,
    SmzdmContract,
    WechatContract,
    DriveFilesContract,
    DriveBrowserContract,
    DistributionContract,
    ZhihuContract,
    AutocareContract,
    TiebaAutocareContract,
    TiebaForumDiscoveryContract,
    TiebaParticipationContract,
    TiebaAutomationContract,
    TiebaTopicsContract,
    TiebaInsightsContract,
    TiebaPublishingContract,
    TiebaPostStatsContract,
    TiebaAnalysisContract,
    TiebaResourceDiscoveryContract,
    ZhihuParticipationContract,
    IntelligentOperationsContract,
    PipixContract,
    PipixAcquisitionContract,
    ContentSupplyContract,
    BrowserEnvironmentContract,
    BitBrowserContract,
    ResourceAnswerContract,
    ResourceDeletionContract,
    ShareCreationContract,
    ResourceLinksContract,
    ResourceLandingContract,
    AccountDeletionContract,
    IpcCommands,
    ZhidaoContract,
    PageDiscoveryContract,
    BaiduKeywordContract,
    BaiduResearchContract,
    WebsiteAccountContract,
    CsdnWorkflowContract,
    WeiboMarketingContract,
    WeiboPostsContract,
    WeiboStatisticsContract,
    WeiboWorkspaceContract {
  "binding.list": Contract<undefined, BrowserBinding[]>;
  snapshot: Contract<{ resourceId?: string } | undefined, AppSnapshot>;
  "resource.get": Contract<{ id: string }, Resource>;
  "resource.search": Contract<{ query: string }, Resource[]>;
  "resource.similar": Contract<
    { title: string; excludeId?: string },
    SimilarResource[]
  >;
  "directory.list": Contract<
    { accountId: string; parentId: string },
    RemoteFile[]
  >;
  "draft.get": Contract<{ id: string }, Draft>;
  "draft.generate": Contract<
    {
      copyId: string;
      platform: Draft["platform"];
      poolId: string | null;
      contentFormat?: Draft["contentFormat"];
    },
    Draft
  >;
  "draft.manual": Contract<
    {
      copyId: string;
      platform: Draft["platform"];
      template?: boolean;
      contentFormat?: Draft["contentFormat"];
    },
    Draft
  >;
  "search.generate": Contract<{ id: string }, Draft>;
  "resource.page": Contract<
    {
      query?: string;
      category?: string;
      accountId?: string;
      page?: number;
      pageSize?: number;
    },
    ResourcePage
  >;
  "cover.get": Contract<{ id: string }, string | null>;
  "batch.candidates": Contract<
    { query?: string; accountId?: string; page?: number },
    CandidatePage
  >;
  "batch.list": Contract<undefined, BatchSummary[]>;
  "batch.get": Contract<{ id: string }, TransferBatch>;
  "split.list": Contract<{ copyId: string }, SplitSummary[]>;
  "split.get": Contract<{ id: string }, SplitRun>;
  "split.item": Contract<{ id: string }, SplitItem>;
  "ai.modelCatalog": Contract<undefined, AiCatalog>;
  "ai.ideas.history": Contract<undefined, IdeaRun[]>;
  "resourceExport.history": Contract<undefined, ExportRun[]>;
  "resourceExport.get": Contract<{ runId: string }, ExportRun>;
  "resourceExport.updatePlan": Contract<
    { runId: string; plan: ExportPlan },
    ExportRun
  >;
  "resourceExport.step": Contract<{ runId: string }, ExportRun>;
  "search.list": Contract<
    {
      query?: string;
      page?: number;
      pageSize?: number;
      stage?: TopicStage | "all";
    },
    SearchPage
  >;
  "search.get": Contract<{ id: string }, SearchDetail>;
  "search.targets": Contract<{ copyId: string; page?: number }, SearchTargets>;
  "shareStats.list": Contract<ShareStatsFilter, ShareStatsResult>;
  "studio.templates": Contract<undefined, CreativeTemplate[]>;
  "studio.modelCatalog": Contract<undefined, MediaModel[]>;
  "studio.poll": Contract<{ id: string }, StudioJob>;
  "studio.jobs": Contract<{ draftId: string }, StudioJob[]>;
  "studio.workingCopy": Contract<{ draftId: string }, StudioWorkingCopy | null>;
  "studio.workingSave": Contract<StudioWorkingCopy, StudioWorkingCopy>;
  "studio.workingClear": Contract<{ draftId: string }, boolean>;
  "publication.deliveryChecks": Contract<
    { publicationId: string },
    PublicationDeliveryCheck[]
  >;
  "traffic.knowledge.list": Contract<KnowledgeFilter, KnowledgePage>;
  "pool.get": Contract<{ id: string }, import("./types").Pool>;
  "pool.list": Contract<undefined, import("./types").PoolSummary[]>;
  "traffic.knowledge.history": KnowledgeContract["traffic.knowledge.history"];
  "traffic.knowledge.overview": KnowledgeContract["traffic.knowledge.overview"];
  "traffic.knowledge.resolve": KnowledgeContract["traffic.knowledge.resolve"];
  "updater.state": Contract<undefined, UpdateState>;
  "dev.tools": Contract<undefined, boolean>;
}
export type IpcMethod = keyof IpcContract;
export type IpcArgs<M extends IpcMethod> = IpcContract[M]["args"];
export type IpcValue<M extends IpcMethod> = IpcContract[M]["value"];
export type IpcArguments<M extends IpcMethod> =
  undefined extends IpcArgs<M> ? [args?: IpcArgs<M>] : [args: IpcArgs<M>];

/** Local reads permitted in automatic query hooks; generation and polling stay explicit commands. */
export const queryMethods = [
  "systemLogs.list",
  "zhihu.participation.snapshot",
  "zhihu.participation.logs",
  "photoPosts.list",
  "photoPosts.get",
  "baiduDiscovery.list",
  "baiduDiscovery.get",
  "baiduDiscovery.questionImport",
  "account.deletePreview",
  "dev.session",
  "dev.sessions",
  "dev.updates",
  "resourceLinks.settings",
  "resourceLinks.get",
  "resourceLanding.get",
  "resourceLanding.traffic",
  "resourceCatalog.list",
  "resourceCatalog.get",
  "resourceCatalog.resources",
  "resourceCatalog.resourceDetails",
  "resourceCatalog.aiGet",
  "secret.preview",
  "smzdm.list",
  "smzdm.get",
  "wechat.list",
  "wechat.get",
  "wechat.discoveryConfig",
  "distribution.overview",
  "distribution.list",
  "distribution.history",
  "distribution.batches",
  "pipix.list",
  "pipix.comments",
  "pipix.requestPolicy",
  "contentSupply.acquisition",
  "contentSupply.snapshot",
  "contentSupply.image",
  "contentSupply.candidates",
  "contentSupply.logs",
  "pipix.discoveryConfig",
  "pipix.knowledge",
  "pipix.image",
  "zhihu.snapshot",
  "zhihu.autocare.snapshot",
  "tieba.autocare.snapshot",
  "tieba.participation.snapshot",
  "tieba.automation.snapshot",
  "tieba.topics.snapshot",
  "tieba.topics.image",
  "tieba.insights.snapshot",
  "tieba.publishing.snapshot",
  "tieba.publishing.words",
  "tieba.publishing.resources",
  "tieba.postStats.snapshot",
  "tieba.discovery.snapshot",
  "tieba.discovery.potential",
  "zhihu.autocare.logs",
  "zhihu.logs",
  "intelligentOps.snapshot",
  "intelligentOps.tasks",
  "intelligentOps.logs",
  "intelligentOps.brain.snapshot",
  "intelligentOps.quickView",
  "intelligentOps.brain.cycles",
  "bit.profiles",
  "bit.diagnose",
  "environments.list",
  "environments.jobs",
  "binding.list",
  "resourceAnswers.list",
  "weibo.words",
  "weibo.matches",
  "weibo.history",
  "weibo.get",
  "weiboPosts.list",
  "weiboStats.list",
  "weiboWorkspace.list",
  "weiboWorkspace.get",
  "weiboWorkspace.style",
  "weiboStats.get",
  "csdn.words",
  "csdn.matches",
  "csdn.history",
  "csdn.get",
  "websiteAccounts.list",
  "baiduKeywords.latest",
  "baiduResearch.latest",
  "zhidao.activeRuns",
  "zhidaoPages.latest",
  "zhidao.summary",
  "zhidao.accounts",
  "zhidao.settings",
  "zhidao.runs",
  "zhidao.run",
  "zhidao.answer.logs",
  "zhidao.answer.sessions",
  "zhidao.targets",
  "zhidao.templates",
  "zhidao.publish.preview",
  "zhidao.template.sources",
  "snapshot",
  "insertion.materials",
  "insertion.materialDetail",
  "insertion.candidates",
  "insertion.list",
  "insertion.get",
  "resource.get",
  "share.creationOptions",
  "share.creationResult",
  "resource.similar",
  "resource.deletePreview",
  "resource.intakeOptions",
  "resource.page",
  "cover.get",
  "batch.candidates",
  "batch.list",
  "batch.get",
  "split.list",
  "split.get",
  "split.item",
  "ai.modelCatalog",
  "ai.ideas.history",
  "ai.ideas.preview",
  "resourceExport.history",
  "resourceExport.get",
  "search.list",
  "search.get",
  "search.targets",
  "shareStats.list",
  "draft.get",
  "studio.templates",
  "studio.modelCatalog",
  "studio.jobs",
  "studio.workingCopy",
  "video.runtime",
  "video.source",
  "video.jobs",
  "music.library",
  "bilibili.list",
  "bilibili.get",
  "bilibili.preview",
  "publication.deliveryChecks",
  "traffic.knowledge.list",
  "traffic.knowledge.overview",
  "traffic.knowledge.resolve",
  "pool.get",
  "pool.list",
  "traffic.knowledge.history",
  "traffic.knowledge.detail",
  "updater.state",
] as const satisfies readonly IpcMethod[];
export type IpcQueryMethod = (typeof queryMethods)[number];
