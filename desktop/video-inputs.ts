import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { AppError } from "../core/errors";

export function createVideoInputs(owner: () => BrowserWindow) {
  return {
    async readVideoImages() {
      const result = await dialog.showOpenDialog(owner(), {
        title: "选择视频预览图片（最多12张）",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "预览图片", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      if (result.canceled) return [];
      if (result.filePaths.length > 12)
        throw new AppError("VIDEO_IMAGE_LIMIT", "一次最多选择12张图片。");
      const images = [];
      for (const path of result.filePaths) {
        const info = await stat(path);
        if (!info.isFile() || info.size <= 0 || info.size > 6 * 1024 * 1024)
          throw new AppError(
            "VIDEO_IMAGE_TOO_LARGE",
            "每张预览图片须为6MB以内的本地文件。",
          );
        images.push({ name: basename(path), bytes: await readFile(path) });
      }
      return images;
    },
    async readVideoAudio() {
      const result = await dialog.showOpenDialog(owner(), {
        title: "选择本地配乐",
        properties: ["openFile"],
        filters: [
          { name: "音频", extensions: ["mp3", "wav", "ogg", "m4a", "aac"] },
        ],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const path = result.filePaths[0],
        info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024)
        throw new AppError(
          "VIDEO_AUDIO_TOO_LARGE",
          "请选择20MB以内的本地音频文件。",
        );
      const mime = (
        {
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".ogg": "audio/ogg",
          ".m4a": "audio/mp4",
          ".aac": "audio/aac",
        } as Record<string, string>
      )[extname(path).toLowerCase()];
      if (!mime)
        throw new AppError(
          "VIDEO_AUDIO_INVALID",
          "请选择MP3、WAV、OGG、M4A或AAC音频。",
        );
      return { name: basename(path), mime, bytes: await readFile(path) };
    },
  };
}
