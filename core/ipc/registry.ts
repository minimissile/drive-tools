import { AppError } from "../errors";
import type { HandlerMap, IpcHandler } from "./types";

/** Domains cannot silently replace an existing command or expose prototype properties. */
export function createIpcRegistry(...domains: HandlerMap[]) {
  const handlers = new Map<string, IpcHandler>();
  for (const domain of domains) {
    for (const [method, handler] of Object.entries(domain)) {
      if (handlers.has(method))
        throw new AppError("DUPLICATE_IPC_METHOD", `操作被重复注册：${method}`);
      handlers.set(method, handler);
    }
  }
  return {
    async invoke(method: string, input: unknown): Promise<unknown> {
      const handler = handlers.get(method);
      if (!handler) throw new AppError("UNKNOWN_METHOD", "不支持此操作。");
      return handler(input, method);
    },
  };
}
