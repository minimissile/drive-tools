import {
  driveCapacitySchema,
  type DriveCapacity,
} from "../../shared/drive-capacity";
import { AppError } from "../errors";

/** Capacity APIs return bytes as integers or decimal integer strings. Missing is not zero. */
export function normalizeCapacity(
  total: unknown,
  used: unknown,
): DriveCapacity {
  const number = (value: unknown) =>
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : value;
  const result = driveCapacitySchema.safeParse({
    totalBytes: number(total),
    usedBytes: number(used),
  });
  if (!result.success)
    throw new AppError(
      "CAPACITY_UNAVAILABLE",
      "网盘未返回完整有效的总容量和已用容量，请稍后刷新。暂不把未知容量显示为0。",
    );
  return result.data;
}
