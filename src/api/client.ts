import type { FeedbackMessage } from "../lib/feedback";
import { queryMethods } from "../../shared/ipc";
import type {
  IpcArgs,
  IpcArguments,
  IpcMethod,
  IpcValue,
} from "../../shared/ipc";

/** The only renderer module that calls the untyped desktop transport. */
export function ipc<M extends IpcMethod>(
  method: M,
  ...[args]: IpcArguments<M>
): Promise<IpcValue<M>> {
  return window.panxu.invoke<IpcValue<M>>(method, args);
}

export type CommandArguments<M extends IpcMethod> =
  undefined extends IpcArgs<M>
    ? [
        args?: IpcArgs<M>,
        success?: string | FeedbackMessage,
        throwErrors?: boolean,
      ]
    : [
        args: IpcArgs<M>,
        success?: string | FeedbackMessage,
        throwErrors?: boolean,
      ];
export type Command = <M extends IpcMethod>(
  method: M,
  ...options: CommandArguments<M>
) => Promise<IpcValue<M> | undefined>;

const reads = new Set<string>([
  ...queryMethods,
  "resource.search",
  "publication.package",
  "bit.health",
  "bit.windows",
  "share.parse",
  "system.copyText",
  "system.external",
  "system.dataFolder",
  "system.backupPreview",
]);
export const shouldRefreshSnapshot = (method: string) =>
  !reads.has(method) &&
  !method.startsWith("baiduKeywords.") &&
  !method.startsWith("baiduResearch.") &&
  !method.startsWith("websiteAccounts.") &&
  !method.startsWith("updater.") &&
  !method.startsWith("dev.") &&
  !/\.(?:export|.*Export|file|articleFile)$/.test(method);
