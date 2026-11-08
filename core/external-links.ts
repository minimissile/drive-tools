import { z } from "zod";
import { AppError } from "./errors";

/** Browser navigation is independent of account, publishing and source policies. */
export const externalLinkInput = z.object({
  url: z
    .url()
    .max(4000)
    .transform((url) => {
      const target = new URL(url);
      if (
        !["http:", "https:"].includes(target.protocol) ||
        !target.hostname ||
        target.username ||
        target.password
      )
        throw new AppError(
          "EXTERNAL_URL_BLOCKED",
          "只能打开 HTTP 或 HTTPS 网页链接，且地址不能包含用户名或密码。",
        );
      return target.href;
    }),
});
