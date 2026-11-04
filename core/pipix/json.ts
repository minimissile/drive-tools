import { AppError } from "../errors";

/** Preserve integer identities exactly. Modern V8 supplies the original primitive token. */
export function parsePipixJson(raw: string): any {
  return JSON.parse(
    raw,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value)
      ) {
        if (!context?.source || !/^-?\d+$/.test(context.source))
          throw new AppError(
            "PIPIX_INTEGER",
            "响应含无法精确读取的整数，请使用当前源码运行环境重新解析归档；未使用取整后的ID。",
          );
        return context.source;
      }
      return value;
    },
  );
}
