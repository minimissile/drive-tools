import { AppError } from "../core/errors";
interface DecodedImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
}
/** Compare stored pixels consistently when the CDN adds PNG display profiles. */
export function wechatComparisonImageBytes(bytes: Buffer) {
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return bytes;
  const chunks = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + length + 12;
    if (end > bytes.length) return bytes;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!["gAMA", "cHRM", "iCCP", "sRGB"].includes(type))
      chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND")
      return Buffer.concat([...chunks, bytes.subarray(offset)]);
  }
  return bytes;
}
/** URL migration is accepted only when decoded pixels match exactly. */
export function assertWechatImagePixels(
  first: DecodedImage,
  second: DecodedImage,
) {
  const a = first.getSize(),
    b = second.getSize();
  if (
    first.isEmpty() ||
    second.isEmpty() ||
    a.width <= 0 ||
    a.height <= 0 ||
    a.width * a.height > 40_000_000 ||
    a.width !== b.width ||
    a.height !== b.height ||
    !first.toBitmap().equals(second.toBitmap())
  )
    throw new AppError(
      "WECHAT_IMAGE_MISMATCH",
      "微信已保存的封面或插图与本地图片内容不一致。",
    );
}
