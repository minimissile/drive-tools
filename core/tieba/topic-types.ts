import type { WebsiteAccount } from "../../shared/website-accounts";
import type { TiebaTopicReceipt } from "../../shared/tieba-topics";
export interface TiebaTopicPayload {
  forumId: string;
  forumName: string;
  title: string;
  body: string;
  aiGenerated?: boolean;
  images: {
    name: string;
    sha256: string;
    mime: "image/png" | "image/jpeg";
    bytes: Uint8Array;
  }[];
}
export interface TiebaTopicPublisher {
  publish(
    account: WebsiteAccount,
    expectedUid: string,
    payload: TiebaTopicPayload,
    beforeSubmit: () => Promise<void>,
    beforePublish: () => Promise<void>,
  ): Promise<TiebaTopicReceipt>;
  reconcile(
    account: WebsiteAccount,
    expectedUid: string,
    payload: TiebaTopicPayload,
    submittedAt: string,
    previousReceipt?: TiebaTopicReceipt | null,
  ): Promise<TiebaTopicReceipt>;
}
