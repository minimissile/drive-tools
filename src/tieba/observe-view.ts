import { z } from "zod";
import {
  tiebaForumInputName,
  normalizeTiebaForumName,
} from "../../shared/tieba-forums";
import type {
  TiebaAutocareSnapshot,
  TiebaAutocareTarget,
} from "../../shared/tieba-autocare";

export interface TiebaObserveInputs {
  selectedNames: string[];
  customText: string;
}

export const tiebaForumKey = (name: string) =>
  normalizeTiebaForumName(name).toLocaleLowerCase();

export function tiebaObservePlan(
  input: TiebaObserveInputs,
  accountId: string,
  uid: string | null | undefined,
  targets: TiebaAutocareTarget[],
) {
  const names = new Map<string, string>();
  try {
    for (const raw of [
      ...input.selectedNames,
      ...input.customText.split(/\r?\n/u).filter((line) => line.trim()),
    ]) {
      const name = tiebaForumInputName(raw);
      names.set(tiebaForumKey(name), name);
    }
  } catch (cause) {
    return {
      forumNames: [],
      existingNames: [],
      issue:
        cause instanceof z.ZodError
          ? (cause.issues[0]?.message ?? "吧名或首页链接无效。")
          : cause instanceof Error
            ? cause.message
            : "吧名或首页链接无效。",
    };
  }
  if (names.size > 5)
    return {
      forumNames: [],
      existingNames: [],
      issue: "每次最多读取5个贴吧，请减少选择或输入。",
    };
  const existing = new Set(
    targets
      .filter(
        (target) =>
          target.accountId === accountId && !!uid && target.uid === uid,
      )
      .map((target) => tiebaForumKey(target.name)),
  );
  return {
    forumNames: [...names.values()],
    existingNames: [...names]
      .filter(([key]) => existing.has(key))
      .map(([, name]) => name),
    issue: "",
  };
}

/** Successful inputs leave the form; failed entries retain their original spelling or URL. */
export function tiebaObserveRemaining(
  input: TiebaObserveInputs,
  addedNames: string[],
): TiebaObserveInputs {
  const added = new Set(addedNames.map(tiebaForumKey));
  const keep = (raw: string) => {
    try {
      return !added.has(tiebaForumKey(tiebaForumInputName(raw)));
    } catch {
      return true;
    }
  };
  return {
    selectedNames: input.selectedNames.filter(keep),
    customText: input.customText.split(/\r?\n/u).filter(keep).join("\n"),
  };
}

export function tiebaObserveResult(
  names: string[],
  accountId: string,
  observation: TiebaAutocareSnapshot["observation"],
) {
  const result = observation?.accountId === accountId ? observation : undefined;
  const succeeded = new Set(result?.succeeded.map(tiebaForumKey));
  const failed = new Map(
    result?.failed.map((entry) => [tiebaForumKey(entry.name), entry.message]),
  );
  return {
    addedNames: names.filter((name) => succeeded.has(tiebaForumKey(name))),
    failed: names
      .filter((name) => !succeeded.has(tiebaForumKey(name)))
      .map((name) => ({
        name,
        message:
          failed.get(tiebaForumKey(name)) ??
          "本次未返回该吧读取结果，请查看日志与本地列表。",
      })),
  };
}
