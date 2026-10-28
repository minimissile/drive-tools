import type {
  InsertionMaterialInput,
  InsertionMaterial,
  InsertionCandidate,
  InsertionTarget,
  InsertionRun,
  InsertionHistory,
} from "./insertion";
import type { z } from "zod";
import type { SettingsSecretKind, SettingsSecretPreview } from "./settings";
import type {
  Account,
  Provider,
  AiConnection,
  ApiPlan,
  BrowserBinding,
  BackupPreview,
  Draft,
  Platform,
  Pool,
  Keyword,
  ResourceInput,
  ImportPreview,
  ShareInput,
  ShareInspection,
  ShareCheck,
  TrafficQuery,
  TrafficResult,
} from "./types";
import type { ContentFormat, LinkPosition } from "./channels";
import type { AiModel, AiModelSelection } from "./ai-models";
import type { IdeaInput, IdeaContext, IdeaRun } from "./ideas";
import type {
  ExportInput,
  ExportRun,
  ExportColumn,
  ExportArticle,
} from "./resource-export";
import type { SearchTopic, effectInput } from "./search";
import type {
  ShareStatsFilter,
  ShareStatsRefreshResult,
} from "./share-statistics";
import type {
  CreativePackage,
  CreativeTemplate,
  MediaModel,
  StudioJob,
  creativeTemplateInput,
  studioCreateInput,
  mediaSubmitInput,
} from "./studio";
import type { KnowledgeFilter, KnowledgeDetail } from "./traffic-knowledge";
import type { PublicationDeliveryCheck } from "./publication-checks";
import type { TransferBatch, SplitRun } from "./types";

type Contract<Args, Value = unknown> = { args: Args; value: Value };
type Id = { id: string };
type CopyId = { copyId: string };
type TextFile = { name: string; text: string } | null;
type TargetItems = Id & { itemIds: string[]; includeCodes?: boolean };
type StartItems = Id & { itemIds: string[]; rightsConfirmed: true };
type PublicationInput = {
  draftId: string;
  bindingId: string | null;
  includeLink: boolean;
  linkPosition: LinkPosition;
};
export type ExportFormat = "xlsx" | "csv" | "md" | "json" | "txt";
export interface ImportReport {
  created: number;
  skipped: number;
  failed: number;
  errors: { row: number; message: string }[];
  copyIds: string[];
}
export interface PublicationPackage {
  text: string;
  body: string;
  title: string;
  coverId: string | null;
  platform: Platform;
  contentFormat: ContentFormat;
  includesOwnLink: boolean;
  delivery: {
    position: LinkPosition;
    label: string;
    url: string;
    code: string;
    instruction: string;
  } | null;
}

/** Business command contracts shared by renderer adapters, never component-local casts. */
export interface IpcCommands {
  "resource.intakeOptions": Contract<
    { accountId?: string },
    import("./intake").IntakeOptions
  >;
  "resource.addIntakeOption": Contract<
    { kind: "category" | "directory"; value: string; accountId?: string },
    { value: string }
  >;
  "insertion.materialDetail": Contract<
    { id: string },
    InsertionMaterial & { text?: string; dataUrl?: string }
  >;
  "insertion.materials": Contract<undefined, InsertionMaterial[]>;
  "insertion.addMaterial": Contract<InsertionMaterialInput, InsertionMaterial>;
  "insertion.removeMaterial": Contract<{ id: string }, boolean>;
  "insertion.candidates": Contract<{ query?: string }, InsertionCandidate[]>;
  "insertion.list": Contract<undefined, InsertionHistory[]>;
  "insertion.get": Contract<{ id: string }, InsertionRun>;
  "insertion.preview": Contract<
    { targets: InsertionTarget[]; materialIds: string[] },
    InsertionRun
  >;
  "insertion.start": Contract<{ id: string; confirmed: true }, InsertionRun>;
  "insertion.cancel": Contract<{ id: string }, boolean>;
  "insertion.recheck": Contract<{ id: string }, InsertionRun>;
  "insertion.export": Contract<{ id: string }, string | null>;

  "account.add": Contract<{ provider: Provider; alias: string }, Account>;
  "account.capacity": Contract<Id, Account>;
  "account.check": Contract<Id>;
  "account.clear": Contract<Id>;
  "account.default": Contract<Id>;
  "account.login": Contract<Id>;
  "account.update": Contract<
    Id & Pick<Account, "alias" | "defaultDirectory" | "enabled">
  >;
  "ai.connection": Contract<undefined, AiConnection>;
  "ai.ideas.generate": Contract<IdeaInput, IdeaRun>;
  "ai.ideas.preview": Contract<IdeaInput, IdeaContext>;
  "ai.ideas.save": Contract<{
    runId: string;
    selected: string[];
    name: string;
  }>;
  "ai.keywords": Contract<
    { resourceId: string },
    { keywords: { word: string; intent: string }[] }
  >;
  "ai.models": Contract<undefined, AiModel[]>;
  "api.export": Contract<undefined, string | null>;
  "api.plan": Contract<Omit<ApiPlan, "configured">>;
  "batch.cancel": Contract<Id>;
  "batch.preview": Contract<{ copyIds: string[] }, TransferBatch>;
  "batch.retry": Contract<Id>;
  "batch.selection": Contract<{ itemId: string; fileIds: string[] }>;
  "batch.start": Contract<
    StartItems,
    { created: number; reused: number; skipped: number }
  >;
  "binding.open": Contract<Id & { contentFormat: ContentFormat }>;
  "binding.save": Contract<
    {
      id?: string;
      platform: Platform;
      alias: string;
      windowId: string;
      editorUrl: string;
      linkPermission: "none" | "allowed";
      ruleNote: string;
      capabilities?: BrowserBinding["capabilities"];
      confirmCapabilities?: boolean;
    },
    BrowserBinding
  >;
  "bit.health": Contract<undefined>;
  "bit.windows": Contract<
    undefined,
    { id: string; name: string; seq: number | null }[]
  >;
  "copies.check": Contract<{ copyIds: string[] }, ShareCheck[]>;
  "copy.createShare": Contract<CopyId>;
  "copy.link": Contract<CopyId, { text: string }>;
  "copy.open": Contract<Id>;
  "copy.recoverShare": Contract<CopyId & { text: string; code?: string }>;
  "cover.export": Contract<Id>;
  "draft.review": Contract<Id & { reviewed: boolean }>;
  "draft.save": Contract<
    Id &
      Pick<Draft, "title" | "body" | "tags" | "coverText"> & {
        creative?: CreativePackage;
      },
    Draft
  >;
  "job.cancel": Contract<Id>;
  "job.retry": Contract<Id>;
  "notes.export": Contract<CopyId>;
  "notes.open": Contract<CopyId>;
  "pool.manual": Contract<
    { name: string; words: string; resourceId: string | null },
    Pool
  >;
  "pool.save": Contract<
    { name: string; resourceId: string | null; keywords: Keyword[] },
    Pool
  >;
  "publication.deliveryCheck": Contract<
    {
      publicationId: string;
      status: PublicationDeliveryCheck["status"];
      position: LinkPosition | null;
      note: string;
      confirmed: boolean;
    },
    PublicationDeliveryCheck
  >;
  "publication.export": Contract<PublicationInput, { folder: string } | null>;
  "publication.mark": Contract<{
    draftId: string;
    bindingId: string;
    url: string;
    status: "submitted" | "published";
  }>;
  "publication.open": Contract<{ draftId: string; bindingId: string }>;
  "publication.package": Contract<PublicationInput, PublicationPackage>;
  "resource.importCommit": Contract<
    { token: string; rows: number[] },
    ImportReport
  >;
  "resource.importFile": Contract<undefined, TextFile>;
  "resource.importPreview": Contract<
    { text: string; targets: Partial<Record<Provider, string>> },
    ImportPreview
  >;
  "resource.save": Contract<
    ResourceInput,
    { resourceId: string; copyId: string; jobId: string | null }
  >;
  "resource.summaryFile": Contract<undefined, TextFile>;
  "resourceExport.article": Contract<
    { runId: string; ids: string[] },
    ExportRun
  >;
  "resourceExport.articleFile": Contract<
    { runId: string; article: ExportArticle; format: "md" | "txt" },
    string | null
  >;
  "resourceExport.articleSave": Contract<
    { runId: string; article: ExportArticle },
    ExportRun
  >;
  "resourceExport.file": Contract<
    {
      runId: string;
      ids: string[];
      columns: ExportColumn[];
      format: ExportFormat;
    },
    string | null
  >;
  "resourceExport.plan": Contract<ExportInput, ExportRun>;
  "search.bind": Contract<
    Id & { copyId: string; splitItemId: string | null },
    SearchTopic
  >;
  "search.check": Contract<Id>;
  "search.create": Contract<
    {
      keyword: string;
      intent?: string;
      platform?: Platform;
      poolId?: string | null;
      keywordId?: string | null;
      copyId?: string | null;
      splitItemId?: string | null;
    },
    SearchTopic
  >;
  "search.effect": Contract<z.input<typeof effectInput>>;
  "search.effectsExport": Contract<Id, string | null>;
  "search.facts": Contract<
    Id & {
      intent: string;
      softwareVersion: string;
      operatingSystem: string;
      evidence: string;
    }
  >;
  "search.importPool": Contract<
    { poolId: string; keywordIds: string[]; platform: Platform },
    { created: number; skipped: number }
  >;
  "search.write": Contract<Id, Draft>;
  "secret.preview": Contract<
    { kind: SettingsSecretKind },
    SettingsSecretPreview
  >;
  "secret.save": Contract<{ kind: SettingsSecretKind; value: string }>;
  "settings.save": Contract<
    Partial<{
      model: string;
      aiModels: AiModelSelection;
      exportCodes: boolean;
      bitUrl: string;
      dailyAiBudgetMicros: number | null;
    }>
  >;
  "settings.vault": Contract<undefined>;
  "share.inspect": Contract<
    {
      accountId: string;
      sourceText: string;
      code?: string;
      resourceId?: string;
      parentId?: string;
      page?: number;
      cursor?: string;
    },
    ShareInspection
  >;
  "share.open": Contract<{
    accountId: string;
    sourceText: string;
    code?: string;
    resourceId?: string;
  }>;
  "share.parse": Contract<{ text: string; code?: string }, ShareInput>;
  "shareStats.export": Contract<ShareStatsFilter, string | null>;
  "shareStats.refresh": Contract<
    { accountIds: string[] },
    ShareStatsRefreshResult[]
  >;
  "split.cancel": Contract<Id>;
  "split.export": Contract<TargetItems, string | null>;
  "split.link": Contract<{ itemId: string }, { text: string }>;
  "split.package": Contract<TargetItems, { text: string }>;
  "split.preview": Contract<
    CopyId & { depth: number; mode: "all" | "level" },
    SplitRun
  >;
  "split.recover": Contract<{ itemId: string; text: string; code?: string }>;
  "split.start": Contract<StartItems, { created: number; reused: number }>;
  "studio.assetExport": Contract<{ name: string }>;
  "studio.create": Contract<z.input<typeof studioCreateInput>, Draft>;
  "studio.models": Contract<undefined, MediaModel[]>;
  "studio.submit": Contract<z.input<typeof mediaSubmitInput>, StudioJob>;
  "studio.templateDelete": Contract<Id>;
  "studio.templateSave": Contract<
    z.input<typeof creativeTemplateInput>,
    CreativeTemplate
  >;
  "system.backup": Contract<undefined, string | null>;
  "system.backupPreview": Contract<undefined, BackupPreview | null>;
  "system.copyText": Contract<{ text: string }>;
  "system.dataFolder": Contract<undefined>;
  "system.external": Contract<{ url: string }>;
  "system.previousWorkspace": Contract<undefined>;
  "system.restore": Contract<{ token: string; confirmed: true }>;
  "traffic.knowledge.detail": Contract<Id, KnowledgeDetail>;
  "traffic.knowledge.export": Contract<KnowledgeFilter, string | null>;
  "traffic.knowledge.exportQuery": Contract<Id, string | null>;
  "traffic.query": Contract<TrafficQuery, TrafficResult>;
  "traffic.releaseSubmission": Contract<{ taskId: string }>;
  "traffic.suggestionResult": Contract<Id, TrafficResult>;
  "traffic.resumeSuggestion": Contract<
    Id & { chargeAcknowledged: true },
    TrafficResult
  >;
  "updater.cancel": Contract<undefined>;
  "updater.check": Contract<undefined>;
  "updater.configure": Contract<{ autoCheck: boolean }>;
  "updater.download": Contract<undefined>;
  "updater.install": Contract<undefined>;
  "updater.openLogs": Contract<undefined>;
  "updater.openRelease": Contract<undefined>;
  "updater.skip": Contract<undefined>;
}
