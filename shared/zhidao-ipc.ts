import type {
  OperationKind,
  OperationRun,
  OperationDetail,
  OperationItem,
  OperationsSummary,
  ZhidaoAccount,
  RunStartInput,
  ZhidaoSettings,
  DriveShareResult,
} from "./zhidao";
import type { RemoteFile } from "./types";
type Contract<A, V> = { args: A; value: V };
export interface ZhidaoContract {
  "zhidao.summary": Contract<undefined, OperationsSummary>;
  "zhidao.accounts": Contract<undefined, ZhidaoAccount[]>;
  "zhidao.account.add": Contract<
    { alias: string; cookie?: string },
    ZhidaoAccount
  >;
  "zhidao.account.update": Contract<
    { id: string; alias: string },
    ZhidaoAccount
  >;
  "zhidao.account.login": Contract<{ id: string }, boolean>;
  "zhidao.account.check": Contract<{ id: string }, ZhidaoAccount>;
  "zhidao.account.remove": Contract<{ id: string; confirmed: true }, boolean>;
  "zhidao.settings": Contract<undefined, ZhidaoSettings>;
  "zhidao.settings.save": Contract<ZhidaoSettings, ZhidaoSettings>;
  "zhidao.runs": Contract<
    { kind?: OperationKind; page?: number },
    { items: OperationRun[]; total: number }
  >;
  "zhidao.run": Contract<{ id: string; page?: number }, OperationDetail>;
  "zhidao.start": Contract<RunStartInput, OperationRun>;
  "zhidao.pause": Contract<{ id: string }, OperationRun>;
  "zhidao.resume": Contract<{ id: string; authorized: true }, OperationRun>;
  "zhidao.item.save": Contract<
    {
      id: string;
      name: string;
      question: string;
      answer: string;
      reviewed: boolean;
    },
    OperationItem
  >;
  "zhidao.item.remove": Contract<{ ids: string[] }, boolean>;
  "zhidao.export": Contract<
    { id: string; format: "txt" | "csv" | "xlsx" },
    string | null
  >;
  "zhidao.import": Contract<
    { kind: "keywords" | "resources" },
    { name: string; rows: string[][] } | null
  >;
  "zhidao.import.resources": Contract<
    { rows: string[][]; authorized: true },
    OperationRun
  >;
  "zhidao.resolve": Contract<
    {
      id: string;
      outcome: "submitted" | "retry";
      remoteId?: string;
      confirmed: true;
    },
    OperationItem
  >;
  "zhidao.mine.pool": Contract<
    { id: string; itemIds: string[]; name: string },
    string
  >;
  "zhidao.mine.words": Contract<{ id: string; itemIds: string[] }, string[]>;
  "zhidao.collect.transfer": Contract<
    {
      itemIds: string[];
      accountId: string;
      directory: string;
      rightsConfirmed: true;
    },
    { copyIds: string[]; batchId: string }
  >;
  "zhidao.targets": Contract<
    { query?: string; page?: number },
    {
      items: { copyId: string; title: string; url: string; provider: string }[];
      total: number;
    }
  >;
  "zhidao.templates": Contract<
    { page?: number },
    { items: OperationItem[]; total: number }
  >;
  "zhidao.open": Contract<{ url: string }, boolean>;
  "drive.files": Contract<{ accountId: string; path: string }, RemoteFile[]>;
  "drive.manage": Contract<
    {
      accountId: string;
      action: "mkdir" | "rename" | "delete";
      path: string;
      name?: string;
      fileId?: string;
      confirmed: true;
    },
    boolean
  >;
  "drive.files.share": Contract<
    {
      accountId: string;
      path: string;
      fileIds: string[];
      rightsConfirmed: true;
    },
    DriveShareResult
  >;
  "drive.share.reset": Contract<
    { accountId: string; fileIds: string[]; confirmed: true },
    boolean
  >;
}
