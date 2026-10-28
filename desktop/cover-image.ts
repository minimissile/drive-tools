import { BrowserWindow, nativeImage } from "electron";
import { AppError } from "../core/errors";
import { assertWebpCover, resourceCoverMaxBytes } from "../core/cover-assets";

// Runs only in an isolated local renderer; all inputs are passed explicitly.
async function encodeCover(
  dataUrl: string,
  format: "png" | "webp",
  maxBytes: number,
): Promise<
  { base64: string } | { error: "INVALID_COVER" | "COVER_TOO_LARGE" }
> {
  const image = new Image();
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    return { error: "INVALID_COVER" };
  }
  if (!image.naturalWidth || !image.naturalHeight)
    return { error: "INVALID_COVER" };
  if (image.naturalWidth * image.naturalHeight > 60_000_000)
    return { error: "COVER_TOO_LARGE" };
  const scale = Math.min(
    1,
    1600 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  let width = Math.max(1, Math.round(image.naturalWidth * scale));
  let height = Math.max(1, Math.round(image.naturalHeight * scale));
  for (;;) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    // Prefer detail at the current size, then reduce dimensions if necessary.
    for (const quality of format === "webp" ? [0.86, 0.72, 0.58, 0.44] : [1]) {
      const blob = await canvas.convertToBlob({
        type: `image/${format}`,
        quality,
      });
      if (blob.type !== `image/${format}`)
        throw new Error("Image format unavailable");
      if (format === "webp" && blob.size > maxBytes) continue;
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve({ base64: String(reader.result).split(",")[1] });
        reader.onerror = () => reject(new Error("WebP read failed"));
        reader.readAsDataURL(blob);
      });
    }
    if (width === 1 && height === 1) throw new Error("WebP exceeds limit");
    width = Math.max(1, Math.floor(width * 0.75));
    height = Math.max(1, Math.floor(height * 0.75));
  }
}

export async function normalizeCover(
  bytes: Buffer,
  format: "png" | "webp" = "png",
) {
  const isWebp =
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  // Keep existing PNG workflows lightweight. WebP decoding uses Chromium because
  // NativeImage only guarantees PNG/JPEG support across desktop platforms.
  if (format === "png" && !isWebp) {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty())
      throw new AppError("INVALID_COVER", "图片内容无法解码。");
    const { width, height } = image.getSize();
    if (width * height > 60_000_000)
      throw new AppError(
        "COVER_TOO_LARGE",
        "图片分辨率过大，请使用封面尺寸的图片。",
      );
    return (
      Math.max(width, height) > 1600
        ? image.resize({
            width: width >= height ? 1600 : undefined,
            height: height > width ? 1600 : undefined,
          })
        : image
    ).toPNG();
  }
  const mime = isWebp
    ? "image/webp"
    : bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? "image/jpeg"
        : null;
  if (!mime) throw new AppError("INVALID_COVER", "图片内容无法解码。");

  // Chromium provides the WebP encoder, avoiding a platform-specific native dependency.
  const encoder = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      partition: "panxu-cover-encoder",
    },
  });
  encoder.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        await encoder.loadURL(
          "data:text/html,<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; script-src 'unsafe-eval'\">",
        );
        const encoded: Awaited<ReturnType<typeof encodeCover>> =
          await encoder.webContents.executeJavaScript(
            `(${encodeCover.toString()})(${JSON.stringify(`data:${mime};base64,${bytes.toString("base64")}`)}, ${JSON.stringify(format)}, ${resourceCoverMaxBytes})`,
          );
        if ("error" in encoded)
          throw new AppError(
            encoded.error,
            encoded.error === "COVER_TOO_LARGE"
              ? "图片分辨率过大，请使用封面尺寸的图片。"
              : "图片内容无法解码。",
          );
        const output = Buffer.from(encoded.base64, "base64");
        if (format === "webp") assertWebpCover(output);
        return output;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("WebP encoding timeout")),
          30_000,
        );
      }),
    ]);
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "COVER_PROCESSING_FAILED",
      format === "webp"
        ? "封面处理失败，未保存资源。请重新选择图片后重试。"
        : "图片格式转换失败，请重新选择图片后重试。",
    );
  } finally {
    clearTimeout(timeout);
    if (!encoder.isDestroyed()) encoder.destroy();
  }
}
