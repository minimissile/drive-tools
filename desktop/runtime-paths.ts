import { isAbsolute, join } from "node:path";
/** Both runtimes use the same workspace selector and single-instance directory. */
export function runtimeDataPath(appData: string, override?: string) {
  if (override) {
    if (!isAbsolute(override))
      throw new Error("PANXU_DATA_DIR必须是绝对路径，未打开其他工作空间。");
    return override;
  }
  return join(appData, "盘序");
}
