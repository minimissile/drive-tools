import { articleHtml } from "../../shared/article-markup";
import type { JianshuPort } from "../../shared/jianshu";
import type { AppPorts } from "../ports";

type Clipboard = Pick<AppPorts, "copyText" | "copyRichText">;
export async function copyJianshuBody(ports: Clipboard, text: string) {
  if (ports.copyRichText) await ports.copyRichText(articleHtml(text), text);
  else await ports.copyText(text);
}

/** Copy the exact frozen handoff payload immediately before opening its editor. */
export function jianshuHandoff(
  port: JianshuPort | undefined,
  ports: Clipboard,
): JianshuPort | undefined {
  if (!port) return undefined;
  return {
    openEditor: port.openEditor
      ? (account, url) => port.openEditor!(account, url)
      : undefined,
    async prepare(account, payload, onCheckpoint) {
      await copyJianshuBody(ports, payload.text);
      return port.prepare(account, payload, onCheckpoint);
    },
    checkResult: (account, url, payload) =>
      port.checkResult(account, url, payload),
  };
}
