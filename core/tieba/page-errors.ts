import { AppError } from "../errors";

/** A renderer crash is an environment failure, never evidence of a changed login. */
export function tiebaPageError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (
    error instanceof Error &&
    /Target crashed|Page crashed|renderer.*crash/i.test(error.message)
  )
    return new AppError(
      "TIEBA_BROWSER_CRASHED",
      "此比特环境的页面已崩溃。请在比特中关闭并重新打开该环境（保留登录状态），再点击“同步并启动”；当前账号与未完成记录已保留。",
    );
  return error;
}
