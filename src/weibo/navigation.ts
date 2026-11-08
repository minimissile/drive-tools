import { windowStorage } from "../storage/window-storage";
import { z } from "zod";
const schema = z.object({
  accountId: z.string(),
  tab: z.enum(["content", "statistics", "style"]).default("content"),
  create: z.boolean().default(false),
});
const key = (path: string) => `weibo-workspace-intent:${path}`;
export function prepareWeiboWorkspace(
  path: string,
  input: z.input<typeof schema>,
) {
  windowStorage.setItem(key(path), JSON.stringify(schema.parse(input)));
}
export function takeWeiboWorkspaceIntent(path: string) {
  try {
    const raw = windowStorage.getItem(key(path));
    windowStorage.removeItem(key(path));
    return raw ? schema.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
