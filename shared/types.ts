import type { AccountCapacity } from "./drive-capacity";
export type Provider =
  "quark" | "baidu" | "uc" | "xunlei" | "guangya" | "pikpak";
export type { Platform } from "./channels";
import type { Platform, ContentFormat, ChannelCapabilities } from "./channels";
export type Endpoint = "longtail" | "suggest" | "metrics" | "radar";
export type AccountStatus =
  "disconnected" | "connected" | "expired" | "disabled";
export type JobStage =
  | "queued"
  | "preflight"
  | "transferring"
  | "verifying"
  | "sharing"
  | "archiving"
  | "completed"
  | "waiting_login"
  | "needs_review"
  | "failed"
  | "cancelled";
export interface Account {
  id: string;
  provider: Provider;
  alias: string;
  uid: string | null;
  status: AccountStatus;
  enabled: boolean;
  isDefault: boolean;
  defaultDirectory: string;
  lastVerifiedAt: string | null;
  error: string | null;
  capacity?: AccountCapacity | null;
  resourceCopies?: number;
}
export interface RemoteFile {
  id: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  parentId: string;
  path?: string;
}
export interface ShareInput {
  provider: Provider;
  shareKey: string;
  url: string;
  code: string;
}
export interface ShareInspection {
  shareKey: string;
  title: string;
  files: RemoteFile[];
  hasMore: boolean;
  page: number;
  parentId: string;
  nextCursor?: string;
}
export interface Resource {
  sourceKind?: "share" | "owned";
  id: string;
  title: string;
  sourceUrl: string;
  provider: Provider;
  category: string;
  tags: string[];
  summary: string;
  coverId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  copies: ResourceCopy[];
}
export interface ResourcePage {
  items: Resource[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SimilarResource {
  id: string;
  title: string;
  provider: Provider;
  similarity: number;
}
export interface ResourceTotals {
  resources: number;
  readyCopies: number;
  attentionJobs: number;
  categories: string[];
}
export interface ShareCheck {
  copyId: string;
  status: "valid" | "invalid" | "unavailable";
  checkedAt: string;
  message: string;
}
export interface BackupPreview {
  token: string;
  folder: string;
  createdAt: string;
  resources: number;
  accounts: number;
  drafts: number;
  covers: number;
}
export interface ImportRow {
  row: number;
  title: string;
  provider: Provider | null;
  account: string;
  status: "new" | "copy" | "skip" | "invalid";
  message: string;
}
export interface ImportPreview {
  token: string;
  rows: ImportRow[];
}
export interface ResourceCopy {
  id: string;
  resourceId: string;
  accountId: string;
  directory: string;
  folderId: string | null;
  files: RemoteFile[];
  status: string;
  ownerUid: string | null;
  verifiedAt: string | null;
  shareId: string | null;
  shareUrl: string | null;
  shareOwnerUid: string | null;
  shareVersion: number;
  shareVerifiedAt: string | null;
  noteStatus: string;
  error: string | null;
}
export interface Job {
  kind: "transfer" | "batch_inspect" | "split_preview" | "split_share";
  targetId: string | null;
  batchId: string | null;
  id: string;
  copyId: string;
  resourceId: string;
  title: string;
  accountId: string;
  stage: JobStage;
  checkpoint: string;
  attempts: number;
  error: string | null;
  logs: { at: string; message: string }[];
  createdAt: string;
  updatedAt: string;
}
export interface TransferBatchItem {
  id: string;
  copyId: string;
  title: string;
  accountId: string;
  state: string;
  error: string | null;
  files: RemoteFile[];
  selectedIds: string[];
  inspectJobId: string;
  transferJobId: string | null;
  stage: JobStage;
}
export interface TransferBatch {
  id: string;
  createdAt: string;
  items: TransferBatchItem[];
}
export interface SplitItem {
  id: string;
  copyId: string;
  file: RemoteFile;
  ancestors: RemoteFile[];
  path: string;
  depth: number;
  status: string;
  shareId: string | null;
  shareUrl: string | null;
  ownerUid: string | null;
  verifiedAt: string | null;
  error: string | null;
  jobId: string | null;
  shareVersion: number;
  stage: JobStage | null;
}
export interface SplitRun {
  id: string;
  copyId: string;
  depth: number;
  mode: "level" | "all";
  status: string;
  error: string | null;
  createdAt: string;
  items: SplitItem[];
  jobId: string;
}
export interface Keyword {
  id: string;
  word: string;
  source: string;
  platform: string | null;
  metrics: Record<string, number | string | null>;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  intent?: string;
  idea?: import("./ideas").IdeaProvenance;
}
export interface Hotspot {
  id: string;
  title: string;
  type: string;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  events: unknown[];
  metrics: Record<string, unknown>;
}
export interface Pool {
  id: string;
  name: string;
  resourceId: string | null;
  keywords: Keyword[];
  createdAt: string;
}
export interface ApiPlan {
  endpoint: Endpoint;
  configured: boolean;
  unitPriceMicros: number | null;
  dailyUnits: number;
  dailyBudgetMicros: number | null;
  enabled: boolean;
}
export interface ApiCall {
  id: string;
  endpoint: string;
  phase: string;
  units: number;
  requestCount: number;
  estimatedMicros: number | null;
  reservedMicros: number | null;
  confirmedMicros: number | null;
  status: "reserved" | "success" | "uncertain" | "failed" | "cache";
  message: string;
  createdAt: string;
}
export interface Draft {
  contentFormat: ContentFormat;
  creative: import("./studio").CreativePackage | null;
  topicId: string | null;
  splitItemId: string | null;
  splitShareVersion: number | null;
  id: string;
  resourceId: string;
  copyId: string;
  platform: Platform;
  poolId: string | null;
  title: string;
  body: string;
  tags: string[];
  coverText: string;
  version: number;
  resourceRevision: number;
  shareVersion: number;
  model: string;
  reviewed: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface BrowserBinding {
  websiteAccountId?: string | null;
  capabilities: ChannelCapabilities;
  id: string;
  platform: Platform;
  alias: string;
  windowId: string;
  editorUrl: string;
  linkPermission: "none" | "allowed";
  ruleNote: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastOpenedAt: string | null;
  openError: string | null;
}
export interface SuggestionQuery {
  id: string;
  seed: string;
  platform: string;
  status: "pending" | "uncertain" | "completed";
  message: string;
  createdAt: string;
  lastRequestedAt: string;
  resultCount: number;
  canRequest: boolean;
}
export interface ApiUsage {
  currency: "CNY" | "USD";
  requestCount: number;
  cacheHits: number;
  estimatedMicros: number;
  estimateUnknownCount: number;
  confirmedMicros: number;
  confirmedUnknownCount: number;
  pendingMicros: number;
  pendingUnknownCount: number;
  pendingCount: number;
}
export interface Publication {
  id: string;
  draftId: string;
  draftVersion: number;
  bindingId: string;
  status: "opened" | "submitted" | "published";
  url: string | null;
  createdAt: string;
}
export interface AppSettings {
  vaultPath: string | null;
  exportCodes: boolean;
  model: string;
  aiModels: import("./ai-models").AiModelSelection;
  openrouterConfigured: boolean;
  bitUrl: string;
  bitConfigured: boolean;
  dailyAiBudgetMicros: number | null;
  previousWorkspace: boolean;
}
export interface AppSnapshot {
  accounts: Account[];
  resources: Resource[];
  resourceTotals: ResourceTotals;
  shareChecks: ShareCheck[];
  jobs: Job[];
  pools: Pool[];
  drafts: Draft[];
  bindings: BrowserBinding[];
  publications: Publication[];
  plans: ApiPlan[];
  apiCalls: ApiCall[];
  asyncQueries: AsyncQuery[];
  suggestionQueries: SuggestionQuery[];
  apiUsage: { cny: ApiUsage; usd: ApiUsage };
  settings: AppSettings;
  appVersion: string;
  dataPath: string;
}
export interface AiConnection {
  checkedAt: string;
  usageMicros: number | null;
  usageDailyMicros: number | null;
  limitMicros: number | null;
  remainingMicros: number | null;
  limitReset: string | null;
  freeTier: boolean | null;
  managementKey: boolean;
}
export interface ResourceInput {
  id?: string;
  copyId?: string;
  title: string;
  sourceText: string;
  extractionCode?: string;
  category: string;
  tags: string[];
  summary: string;
  coverData?: string | null;
  accountId: string;
  directory: string;
  /** Legacy callers may still send this; resource intake no longer requires a checkbox. */
  rightsConfirmed?: boolean;
  selectedFiles?: RemoteFile[];
  enqueue: boolean;
  /** Records an existing own share locally without transferring or creating a share. */
  isOwnResource?: boolean;
}
export interface TrafficQuery {
  endpoint: Endpoint;
  seeds: string[];
  pages: number;
  platform?: string;
  type?: string;
  startTime?: string;
  endTime?: string;
  useCache: boolean;
  taskId?: string;
}
export interface TrafficResult {
  keywords: Keyword[];
  hotspots: Hotspot[];
  taskId?: string;
  pending?: boolean;
  pendingSuggestions?: string[];
  fromCache: boolean;
}
export interface AsyncQuery {
  taskId: string;
  seeds: string[];
  status: string;
  createdAt: string;
  lastPolledAt: string | null;
}
export interface Result<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}
export interface AppApi {
  /** Stable identity for UI drafts; all windows still share one workspace/profile. */
  readonly windowId?: string;
  readonly initialPage?: string;
  onDevSessionsChanged?(callback: () => void): () => void;
  invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
  onChanged(callback: () => void): () => void;
  onUpdateChanged(
    callback: (state: import("./updates").UpdateState) => void,
  ): () => void;
}
declare global {
  interface Window {
    panxu: AppApi;
  }
}
