import type { TiebaAutocareSnapshot } from "../../shared/tieba-autocare";
import type { TiebaForumDiscoveryItem } from "../../shared/tieba-forum-discovery";
import {
  tiebaForumKey,
  tiebaObservePlan,
  tiebaObserveRemaining,
} from "./observe-view";

export const tiebaAddPlan = tiebaObservePlan;
export const tiebaAddRemaining = tiebaObserveRemaining;
export function tiebaLowReplyCandidate(
  item: Pick<TiebaForumDiscoveryItem, "sampledThreads" | "zeroReplyThreads">,
) {
  return (
    item.sampledThreads >= 3 &&
    item.zeroReplyThreads <= item.sampledThreads &&
    item.zeroReplyThreads * 2 >= item.sampledThreads
  );
}
export function tiebaFilterForums(
  items: TiebaForumDiscoveryItem[],
  filters: { memberMax: string; postMax: string; lowReplies: boolean },
) {
  const limit = (value: string) =>
    !value.trim()
      ? null
      : /^\d+$/u.test(value.trim()) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : NaN;
  const members = limit(filters.memberMax),
    posts = limit(filters.postMax);
  if (Number.isNaN(members) || Number.isNaN(posts))
    return { items, issue: "人数和帖子数上限应为非负整数，留空表示不限。" };
  return {
    items: items.filter(
      (item) =>
        (members === null ||
          (item.memberCount !== null && item.memberCount <= members)) &&
        (posts === null ||
          (item.postCount !== null && item.postCount <= posts)) &&
        (!filters.lowReplies || tiebaLowReplyCandidate(item)),
    ),
    issue: "",
  };
}
export function tiebaAdditionResult(
  names: string[],
  accountId: string,
  addition: TiebaAutocareSnapshot["addition"],
) {
  const items = addition?.accountId === accountId ? addition.items : [];
  const followed: string[] = [],
    remaining: {
      name: string;
      status: "failed" | "uncertain";
      message: string;
    }[] = [];
  for (const name of names) {
    const matches = items.filter(
      (item) => tiebaForumKey(item.name) === tiebaForumKey(name),
    );
    if (matches.length && matches.every((item) => item.status === "followed"))
      followed.push(name);
    else {
      const item =
        matches.find((item) => item.status === "uncertain") ??
        matches.find((item) => item.status === "failed");
      remaining.push({
        name,
        status: item?.status === "uncertain" ? "uncertain" : "failed",
        message:
          item?.message ??
          "本次没有明确返回该吧结果，输入已保留，请先检查目标列表与日志。",
      });
    }
  }
  return { followed, remaining };
}
