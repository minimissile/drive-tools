import { isAbsolute, join } from "node:path";
/** Development and installed releases have independent cookies, credentials, DB and preferences. */
export function runtimeDataPath(
  appData: string,
  packaged: boolean,
  override?: string,
) {
  if (override) {
    if (!isAbsolute(override))
      throw new Error("PANXU_DATA_DIR必须是绝对路径，未打开其他工作空间。");
    return override;
  }
  return join(appData, packaged ? "盘序" : "盘序开发");
}
