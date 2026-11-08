import type { WebsiteAccount } from "../../shared/website-accounts";
import type { TiebaPostStatsReading } from "../../shared/tieba-post-stats";
export interface TiebaPostStatsBrowser {
  listOwnThreads(
    account: WebsiteAccount,
    expectedUid: string,
    page: number,
  ): Promise<{ threadIds: string[]; nextPage: number | null }>;
  readThread(
    account: WebsiteAccount,
    expectedUid: string,
    threadId: string,
  ): Promise<TiebaPostStatsReading>;
}
