import { AppError } from "../errors";
export function ownPage(cursor = "", zeroBased = false) {
  if (cursor && !/^\d{1,6}$/.test(cursor))
    throw new AppError(
      "INVALID_CURSOR",
      "目录分页标记已失效，请重新读取此目录。",
    );
  const page = cursor ? Number(cursor) : zeroBased ? 0 : 1;
  if (page < (zeroBased ? 0 : 1) || page > 100000)
    throw new AppError(
      "INCOMPLETE_LIST",
      "目录超过读取保护上限，未记为同步完成。",
    );
  return page;
}
