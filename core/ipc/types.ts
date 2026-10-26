import type {
  Account,
  AppSnapshot,
  BrowserBinding,
  ResourceCopy,
  ResourceInput,
  ShareCheck,
} from "../../shared/types";
import type { ContentFormat, LinkPosition } from "../../shared/channels";
import type { IpcMethod } from "../../shared/ipc";
import type { PublicationPackage } from "../../shared/ipc-commands";
import type { AppPorts } from "../ports";
import type { Database } from "../database";
import type { Repository } from "../repository";
import type { SecretStore } from "../secrets";
import type { TransferQueue } from "../queue";
import type { NoteExporter } from "../notes";
import type { AiService } from "../ai";
import type { KeywordIdeas } from "../ideas";
import type { ResourceExports } from "../resource-export";
import type { StudioService } from "../studio";
import type { TrafficService } from "../traffic";
import type { BitBrowser } from "../bitbrowser";
import type { BulkImporter } from "../bulk";
import type { Operations } from "../operations";
import type { SearchOperations } from "../search";
import type { ShareStatisticsService } from "../share-statistics";
import type { PublicationChecks } from "../publication-checks";
import type { DriveProvider } from "../providers/provider";

/** The transport boundary stays unknown until each handler validates its own input. */
export type IpcHandler = (
  input: unknown,
  method: string,
) => unknown | Promise<unknown>;
export type HandlerMap = Partial<Record<IpcMethod, IpcHandler>>;

/** Composition-root dependencies. Each domain requests only the members it uses. */
export interface HandlerServices {
  environments: import("../browser-environments").BrowserEnvironments;
  environmentQueue: import("../browser-environment-queue").BrowserEnvironmentQueue;
  resourceAnswers: import("../resource-answers").ResourceAnswers;
  weiboPosts: import("../weibo/posts").WeiboPosts;
  weibo: import("../weibo/marketing").WeiboMarketing;
  csdn: import("../csdn/workflow").CsdnWorkflows;
  websiteAccounts: import("../website-accounts").WebsiteAccounts;
  driveFiles: import("../drive-files").DriveFiles;
  zhidao: import("../zhidao/service").ZhidaoOperations;
  db: Database;
  repo: Repository;
  secrets: SecretStore;
  queue: TransferQueue;
  notes: NoteExporter;
  ai: AiService;
  ideas: KeywordIdeas;
  resourceExports: ResourceExports;
  studio: StudioService;
  traffic: TrafficService;
  bit: BitBrowser;
  importer: BulkImporter;
  operations: Operations;
  insertion: import("../insertion").InsertionService;
  search: SearchOperations;
  shareStatistics: ShareStatisticsService;
  publicationChecks: PublicationChecks;
  dataPath: string;
  ports: AppPorts;
  changed(): void;
  snapshot(resourceId?: string): AppSnapshot;
  account(id: string): Account;
  authenticated<T>(
    id: string,
    action: (account: Account, provider: DriveProvider) => Promise<T>,
  ): Promise<T>;
  assertNoActiveJobs(id: string): void;
  refreshCapacity(id: string): Promise<Account>;
  assertOwnCopy(copy: ResourceCopy): Account;
  checkShare(id: string): Promise<ShareCheck>;
  saveResource(
    input: ResourceInput,
  ): Promise<{ resourceId: string; copyId: string; jobId: string | null }>;
  openBinding(
    binding: BrowserBinding,
    format?: ContentFormat,
  ): Promise<{ opened: boolean; url: string }>;
  contentPackage(
    draft: string,
    binding: string | null,
    includeLink: boolean,
    position?: LinkPosition,
  ): Promise<PublicationPackage>;
  hasRunningJobs(): boolean;
  backup(): Promise<string | null>;
  setSwitchingWorkspace(switching: boolean): void;
  invoke(method: string, input?: unknown): Promise<unknown>;
}
