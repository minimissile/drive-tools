import { z } from "zod";

export const driveMembershipSchema = z.object({
  status: z.enum(["active", "none", "expired", "unknown"]),
  tier: z.string().max(80).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});
export type DriveMembership = z.infer<typeof driveMembershipSchema>;
export const baiduMembershipParserRevision = 2;

export const accountMembershipSchema = z.object({
  parserRevision: z.number().int().nonnegative().optional(),
  ownerUid: z.string(),
  value: driveMembershipSchema.nullable(),
  updatedAt: z.string().nullable(),
  attemptedAt: z.string(),
  error: z.string().nullable(),
});
export type AccountMembership = z.infer<typeof accountMembershipSchema>;
export function membershipStatus(value: DriveMembership, time = Date.now()) {
  return value.status === "active" &&
    value.expiresAt &&
    Date.parse(value.expiresAt) <= time
    ? "expired"
    : value.status;
}
