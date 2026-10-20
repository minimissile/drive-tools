import { z } from "zod";
import { linkPositionIds } from "./channels";
import type { LinkPosition } from "./channels";

export const deliveryStatuses = {
  verified: "已验证可获取",
  failed: "获取失败",
  not_provided: "未提供入口",
} as const;
export const deliveryCheckInput = z
  .object({
    publicationId: z.string().min(1).max(100),
    status: z.enum(["verified", "failed", "not_provided"]),
    position: z.enum(linkPositionIds).nullable(),
    note: z.string().trim().min(10).max(2000),
    confirmed: z.literal(true),
  })
  .refine(
    (i) =>
      i.status === "not_provided" ? i.position === null : i.position !== null,
    "请选择实际资料入口位置；未提供入口时不填写位置。",
  );
export interface PublicationDeliveryCheck {
  id: string;
  publicationId: string;
  status: keyof typeof deliveryStatuses;
  position: LinkPosition | null;
  note: string;
  source: "manual";
  checkedAt: string;
  draftVersion: number;
  copyId: string;
  splitItemId: string | null;
  shareVersion: number;
  shareUrl: string | null;
  ownerUid: string | null;
}
export function deliveryCheckIsStale(
  check: PublicationDeliveryCheck,
  shareUrl: string | null | undefined,
  shareVersion: number | null | undefined,
  context?: { ready: boolean; ownerUid: string | null },
) {
  return (
    check.status !== "not_provided" &&
    (check.shareUrl !== shareUrl ||
      check.shareVersion !== shareVersion ||
      (!!context && (!context.ready || context.ownerUid !== check.ownerUid)))
  );
}
