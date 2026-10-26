import type { Repository } from "../../repository";
import type { SecretStore } from "../../secrets";
import type { AiService } from "../../ai";
import type { Resource, ResourceCopy } from "../../../shared/types";
import type { OperationRun } from "../../../shared/zhidao";
import type { OperationsStore } from "../store";
import type { ZhidaoClient, SourceFetch } from "../client";
import type { Pansou } from "../pansou";
export interface WorkerContext {
  repo: Repository;
  secrets: SecretStore;
  ai: AiService;
  store: OperationsStore;
  client: ZhidaoClient;
  pansou: Pansou;
  fetcher: SourceFetch;
  pace: number;
  readonly closed: boolean;
  progress(run: OperationRun, message: string, done?: number): void;
  settings(): { pansouUrl: string };
  identity(
    accountId: string,
  ): Promise<{ uid: string; nickname: string; stoken: string }>;
  ownTarget(copyId: string): { copy: ResourceCopy; resource: Resource };
  verifyCopy?: (copyId: string) => Promise<void>;
  generateAnswer(
    question: string,
    style: string,
    evidence?: unknown,
  ): Promise<{ answer: string }>;
  validatePublication(ids: string[]): void;
  assertNoDuplicatePublication(ids: string[], accountId: string): void;
}
export const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
