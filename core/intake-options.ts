import { z } from "zod";
import { Database } from "./database";
import { Repository } from "./repository";
import { AppError } from "./errors";
import { normalizedDirectory } from "./providers/provider";
import {
  defaultResourceCategories,
  type IntakeOptions,
} from "../shared/intake";
const categoryKey = "intake:categories";
const directoriesKey = (accountId: string) => `intake:directories:${accountId}`;
export function intakeOptions(
  db: Database,
  repo: Repository,
  accountId: string,
): IntakeOptions {
  const account = accountId ? repo.getAccount(accountId) : undefined;
  return {
    categories: [
      ...new Set([
        ...defaultResourceCategories,
        ...db.setting<string[]>(categoryKey, []),
        ...db
          .all<{ category: string }>(
            "SELECT DISTINCT category FROM resources ORDER BY category",
          )
          .map((r) => r.category),
      ]),
    ],
    directories: [
      ...new Set([
        account?.defaultDirectory || "/盘序资源",
        ...db.setting<string[]>(directoriesKey(accountId), []),
        ...db
          .all<{ directory: string }>(
            "SELECT DISTINCT directory FROM copies WHERE account_id=? ORDER BY updated_at DESC LIMIT 200",
            accountId,
          )
          .map(
            (r) => r.directory.slice(0, r.directory.lastIndexOf("/")) || "/",
          ),
      ]),
    ],
  };
}
export const intakeOptionInput = z.object({
  kind: z.enum(["category", "directory"]),
  value: z.string().trim().min(1).max(500),
  accountId: z.string().default(""),
});
export function addIntakeOption(db: Database, repo: Repository, raw: unknown) {
  const input = intakeOptionInput.parse(raw);
  let value = input.value,
    key = categoryKey;
  if (input.kind === "category")
    value = z
      .string()
      .max(60)
      .refine((v) => !/[\x00-\x1f\x7f]/.test(v), "分类不能包含控制字符")
      .parse(value);
  else {
    if (!input.accountId)
      throw new AppError("ACCOUNT_REQUIRED", "请先选择目标账号，再新增目录。");
    repo.getAccount(input.accountId);
    value = normalizedDirectory(value);
    key = directoriesKey(input.accountId);
  }
  const options = db.setting<string[]>(key, []);
  if (!options.includes(value)) {
    if (options.length >= 200)
      throw new AppError("OPTION_LIMIT", "自定义选项最多保存200项。");
    db.setSetting(key, [...options, value]);
  }
  return { value };
}
