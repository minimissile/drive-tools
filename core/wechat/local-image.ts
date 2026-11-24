import { createHash } from "node:crypto";
import {
  wechatCoverFilePattern,
  wechatImageFilePattern,
} from "../../shared/wechat-markup";
import { readContentImage } from "../content-assets";
import { readResourceCover } from "../cover-assets";
import { AppError } from "../errors";

export async function readWechatLocalImage(dataPath: string, file: string) {
  const coverId = wechatCoverFilePattern.exec(file)?.[1];
  if (coverId) {
    const { bytes, mime } = await readResourceCover(dataPath, coverId);
    if (createHash("sha256").update(bytes).digest("hex") !== coverId)
      throw new AppError(
        "COVER_CHANGED",
        "封面文件已变化，请重新上传或恢复备份。",
      );
    return { bytes, mime };
  }
  if (!wechatImageFilePattern.test(file))
    throw new AppError("WECHAT_IMAGE", "图片地址不正确。");
  const bytes = await readContentImage(dataPath, {
    file,
    sha256: file.split(".")[0],
    name: file,
    storage: "content-assets",
  });
  return {
    bytes,
    mime: file.endsWith(".png")
      ? "image/png"
      : file.endsWith(".gif")
        ? "image/gif"
        : "image/jpeg",
  };
}
