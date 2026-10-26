export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public uncertain = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export class ProviderHttpError extends AppError {
  constructor(
    public status: number,
    public remoteCode: string,
    message: string,
    uncertain = false,
  ) {
    super(
      status === 401 ? "AUTH_EXPIRED" : "PROVIDER_HTTP_ERROR",
      message,
      uncertain,
    );
  }
}
export class ServiceHttpError extends AppError {
  constructor(
    public status: number,
    message: string,
    code = "HTTP_ERROR",
    public retryAfterMs: number | null = null,
  ) {
    super(code, message);
  }
}
export const ensure = (
  condition: unknown,
  code: string,
  message: string,
): asserts condition => {
  if (!condition) throw new AppError(code, message);
};
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "操作失败，请重试。";
  return message
    .replace(/\bBearer\s+[^\s,;"'}]+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-or-v1-[a-zA-Z0-9_-]{8,}\b/g, "[已隐藏Key]")
    .replace(
      /(authorization|cookie|access_token|refresh_token|captcha_token|pass_code_token|bdstoken|stoken|api_?key)["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi,
      "$1=[已隐藏]",
    )
    .slice(0, 600);
}
