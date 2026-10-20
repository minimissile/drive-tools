import { z } from "zod";

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const driveCapacitySchema = z.object({
  totalBytes: bytes,
  usedBytes: bytes,
});
export type DriveCapacity = z.infer<typeof driveCapacitySchema>;
export const accountCapacitySchema = z.object({
  ownerUid: z.string(),
  value: driveCapacitySchema.nullable(),
  updatedAt: z.string().nullable(),
  attemptedAt: z.string(),
  error: z.string().nullable(),
});
export type AccountCapacity = z.infer<typeof accountCapacitySchema>;

export function capacitySummary(value: DriveCapacity) {
  return {
    remainingBytes: Math.max(0, value.totalBytes - value.usedBytes),
    percent:
      value.totalBytes > 0
        ? Math.min(100, (value.usedBytes / value.totalBytes) * 100)
        : value.usedBytes > 0
          ? 100
          : 0,
    full: value.totalBytes === 0 || value.usedBytes >= value.totalBytes,
    overLimit: value.usedBytes > value.totalBytes,
  };
}
export function formatCapacity(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: unit ? 2 : 0 }).format(value)} ${units[unit]}`;
}
