import type { WebsiteAccount } from "../../shared/website-accounts";
import type {
  TiebaPublicationRef,
  TiebaVisibilityReading,
} from "../../shared/tieba-insights";

export interface TiebaInsightsBrowser {
  readVisibility(
    account: WebsiteAccount,
    expectedUid: string,
    publication: TiebaPublicationRef,
  ): Promise<TiebaVisibilityReading>;
}
