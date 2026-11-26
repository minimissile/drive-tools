export const tiebaCareActions = ["checkin", "like"] as const;
export type TiebaCareAction = (typeof tiebaCareActions)[number];
export const tiebaCareActionLabels: Record<TiebaCareAction, string> = {
  checkin: "签到",
  like: "点赞",
};
export function selectedTiebaActions(config: {
  actions?: TiebaCareAction[];
}): TiebaCareAction[] {
  return config.actions ?? ["checkin"];
}
export interface TiebaLikeReading {
  uid: string;
  forumId: string;
  threadId: string;
  authorUid: string;
  title: string;
  url: string;
  liked: boolean;
  checkedAt: string;
}
