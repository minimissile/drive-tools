import type { WebsiteAccount } from "../../shared/website-accounts";
import type { TiebaForumReading } from "../../shared/tieba-autocare";
import type {
  TiebaThreadCandidate,
  TiebaThreadContext,
  TiebaReplyReceipt,
} from "../../shared/tieba-participation";

/** Each operation runs while the caller holds the account's environment lease. */
export interface TiebaParticipationBrowser {
  listThreads(
    account: WebsiteAccount,
    expectedUid: string,
    forum: TiebaForumReading,
  ): Promise<TiebaThreadCandidate[]>;
  readThread(
    account: WebsiteAccount,
    expectedUid: string,
    candidate: TiebaThreadCandidate,
  ): Promise<TiebaThreadContext>;
  reply(
    account: WebsiteAccount,
    expectedUid: string,
    context: TiebaThreadContext,
    body: string,
    beforeSubmit: () => Promise<void>,
    options?: { aiGenerated: boolean },
  ): Promise<TiebaReplyReceipt>;
  reconcileReply(
    account: WebsiteAccount,
    expectedUid: string,
    context: TiebaThreadContext,
    body: string,
    submittedAt: string,
  ): Promise<TiebaReplyReceipt>;
}
