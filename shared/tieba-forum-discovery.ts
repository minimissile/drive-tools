import { z } from "zod";
import { websiteAccountIdSchema } from "./website-accounts";
export const tiebaForumKeywordSchema = z
  .string()
  .refine((v) => !/\p{Cc}/u.test(v), "查找词不能包含换行或控制字符")
  .transform((v) => v.normalize("NFKC").trim().replace(/\s+/gu, " "))
  .pipe(z.string().min(1, "请填写查找词").max(80, "查找词最多80字"));
export const tiebaFindForumsSchema = z.object({
  accountId: websiteAccountIdSchema,
  keyword: tiebaForumKeywordSchema,
});
export interface TiebaForumDiscoveryItem {
  name: string;
  forumId: string | null;
  url: string;
  description: string;
  memberCount: number | null;
  postCount: number | null;
  threadCount: number | null;
  sampledThreads: number;
  zeroReplyThreads: number;
  latestActiveLabel: string | null;
  checkedAt: string;
  message?: string | null;
}
export interface TiebaForumDiscoveryResult {
  accountId: string;
  keyword: string;
  items: TiebaForumDiscoveryItem[];
  checkedAt: string;
  truncated: boolean;
  message: string;
}
export interface TiebaForumDiscoveryContract {
  "tieba.autocare.findForums": {
    args: z.infer<typeof tiebaFindForumsSchema>;
    value: TiebaForumDiscoveryResult;
  };
}
