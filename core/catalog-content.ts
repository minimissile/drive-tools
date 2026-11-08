import { redactPromptText } from "./text-safety";

export const catalogPublicText = (text: string) =>
  redactPromptText(text)
    .replace(
      /\b(?:access_token|refresh_token|authorization|bdstoken|stoken|pass_code_token|captcha_token)\s*[:：=]\s*["']?[^\s,，;；。！？"']+/gi,
      "[凭据已省略]",
    )
    .replace(
      /file:\/\/[^\s<>"'，。；）)]+|\b[A-Z]:[\\/][^\s<>"'，。；）)]+|\\\\[^\\\s]+\\[^\s<>"'，。；）)]+|\/(?:Users|home|private|Volumes|var|tmp|mnt|opt|etc)\/[^\s<>"'，。；）)]+/gi,
      "[本地路径已省略]",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
