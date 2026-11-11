import type { AppPorts } from "../core/ports";
import type { WechatPort } from "../shared/wechat";
import { bitWechatContext } from "./wechat-readers";
import { createWechatBrowserSession } from "./wechat-session";
import { readBitWechatImage } from "./wechat-bit-images";

export function createWechatBitSession(
  workspace: () => string,
  readArticle: WechatPort["readArticle"],
): NonNullable<AppPorts["wechatBrowserSession"]> {
  return (context, account) => {
    const reader = bitWechatContext(context, account.id);
    const session = createWechatBrowserSession(
      () => reader,
      workspace,
      readArticle,
      (url) => readBitWechatImage(context, url),
    );
    return { verify: () => session.verify(account), port: session.port };
  };
}
