import type { BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../../shared/website-accounts";
import type { TiebaForumDiscoveryResult } from "../../shared/tieba-forum-discovery";
import type {
  TiebaForumReading,
  TiebaForumFollowReceipt,
} from "../../shared/tieba-autocare";

/** The caller holds the account's environment lease for the whole operation. */
export type TiebaBrowserProfile = <T>(
  account: WebsiteAccount,
  action: (context: BrowserContext) => Promise<T>,
) => Promise<T>;

export interface TiebaAutocareBrowser {
  /** Bounded, explicit, read-only discovery; does not add or follow candidates. */
  findForums?(
    account: WebsiteAccount,
    expectedUid: string,
    keyword: string,
  ): Promise<TiebaForumDiscoveryResult>;
  /** Resolve an explicitly supplied forum name without following or signing in it. */
  resolveForum?(
    account: WebsiteAccount,
    expectedUid: string,
    name: string,
  ): Promise<TiebaForumReading>;
  listForums(
    account: WebsiteAccount,
    expectedUid: string,
  ): Promise<TiebaForumReading[]>;
  readForum(
    account: WebsiteAccount,
    expectedUid: string,
    forum: TiebaForumReading,
  ): Promise<TiebaForumReading>;
  checkIn(
    account: WebsiteAccount,
    expectedUid: string,
    forum: TiebaForumReading,
    beforeSubmit: () => Promise<void>,
  ): Promise<TiebaForumReading>;
  /** Explicit follow action only; an uncertain checkpoint is reconciled via readForum. */
  followForum?(
    account: WebsiteAccount,
    expectedUid: string,
    forum: TiebaForumReading,
    beforeFollow: () => Promise<void>,
  ): Promise<TiebaForumFollowReceipt>;
}
