import type { IpcCommands } from "./ipc-commands";
import type { ZhidaoContract } from "./zhidao-ipc";
import type { BaiduKeywordContract } from "./baidu-keywords";
import type { BaiduResearchContract } from "./baidu-research";
import type { WebsiteAccountContract } from "./website-accounts";
import type {
  AppSnapshot,
  Resource,
  ResourcePage,
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
import type { KnowledgeFilter, KnowledgePage } from "./traffic-knowledge";
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
export interface IpcContract extends IpcCommands, ZhidaoContract, BaiduKeywordContract, BaiduResearchContract, WebsiteAccountContract {
  snapshot: Contract<{ resourceId?: string } | undefined, AppSnapshot>;
  "resource.get": Contract<{ id: string }, Resource>;
  "resource.search": Contract<{ query: string }, Resource[]>;
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
  "websiteAccounts.list", "baiduKeywords.latest", "baiduResearch.latest",
  "zhidao.summary", "zhidao.accounts", "zhidao.settings", "zhidao.runs", "zhidao.run", "zhidao.targets", "zhidao.templates",
  "snapshot",
  "insertion.materials",
  "insertion.materialDetail",
  "insertion.candidates",
  "insertion.list",
  "insertion.get",
  "resource.get",
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
  "studio.templates",
  "studio.modelCatalog",
  "studio.jobs",
  "studio.workingCopy",
  "publication.deliveryChecks",
  "traffic.knowledge.list",
  "traffic.knowledge.detail",
  "updater.state",
] as const satisfies readonly IpcMethod[];
export type IpcQueryMethod = (typeof queryMethods)[number];
