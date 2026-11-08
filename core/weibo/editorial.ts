import type { Database } from "../database";
import {
  weiboResourceStyle,
  type WeiboEditorialStyle,
} from "../../shared/weibo-workspace";
import { z } from "zod";
const style = z.object({
  instructions: z.string().min(10).max(5000),
  linkFirst: z.boolean(),
});
export function readWeiboStyle(
  db: Database,
  accountId: string,
): WeiboEditorialStyle {
  const saved = db.setting<unknown>(`weiboStyle:v1:${accountId}`, null);
  return saved === null
    ? { instructions: weiboResourceStyle, linkFirst: true, custom: false }
    : { ...style.parse(saved), custom: true };
}
