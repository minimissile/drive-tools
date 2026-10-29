import { randomBytes } from "node:crypto";
import type { Provider } from "../../shared/types";
import {
  shareCreationOptionsError,
  type ShareCreationOptions,
} from "../../shared/share-options";
import { AppError, ProviderHttpError, safeMessage } from "../errors";

export function validateShareOptions(
  provider: Provider,
  options: ShareCreationOptions,
) {
  const error = shareCreationOptionsError(provider, options);
  if (error) throw new AppError("INVALID_SHARE_OPTIONS", error);
  return {
    expiresInDays: options.expiresInDays,
    extractionCode: options.extractionCode?.trim() ?? "",
  };
}
export function privateShareOptions(
  provider: Provider,
  options: ShareCreationOptions,
) {
  const validated = validateShareOptions(provider, options);
  return {
    ...validated,
    extractionCode:
      validated.extractionCode || randomBytes(3).toString("hex").slice(0, 4),
  };
}

/** Parse only a returned timestamp, without deriving expiry from request time. */
export function actualShareExpiry(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const numeric =
    typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value));
  if (!numeric && !/^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/.test(String(value)))
    return undefined;
  const number = numeric ? Number(value) : NaN;
  const time = numeric
    ? number >= 1e12
      ? number
      : number * 1000
    : Date.parse(String(value));
  if (!Number.isFinite(time) || time <= 0) return undefined;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** A rejected request may be corrected; a lost write response must never be replayed. */
export async function newShareRequest<T>(submit: () => Promise<T>): Promise<T> {
  try {
    return await submit();
  } catch (error) {
    const rejected =
      error instanceof ProviderHttpError
        ? error.status >= 400 && error.status < 500 && !error.uncertain
        : error instanceof AppError &&
          !error.uncertain &&
          [
            "AUTH_EXPIRED",
            "QUOTA_EXCEEDED",
            "USER_ACTION_REQUIRED",
            "BAD_CODE",
            "REMOTE_ERROR",
            "INVALID_SHARE_OPTIONS",
            "ACCOUNT_UID_MISMATCH",
          ].includes(error.code);
    if (rejected) throw error;
    throw new AppError(
      error instanceof AppError ? error.code : "UNCERTAIN_SHARE_RESULT",
      safeMessage(error),
      true,
    );
  }
}
