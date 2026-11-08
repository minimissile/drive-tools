import { type Page, type ElementHandle } from "playwright-core";
import { AppError } from "../errors";
import {
  tiebaTopicFileSelector,
  tiebaTopicImageButtonSelector,
  tiebaTopicLocalUploadSelector,
} from "./topic-page";
type FilePayload = { name: string; mimeType: string; buffer: Buffer };
export interface TiebaTopicLocalImageInput {
  setFile(file: FilePayload): Promise<void>;
}
/** Only an empty link, fragment placeholder, or literal no-op JavaScript. */
export function tiebaTopicInertUploadHref(value: string | null) {
  return (
    value === null ||
    /^(?:|#|javascript:\s*(?:void\s*\(\s*0\s*\)\s*;?|;)?)$/iu.test(value.trim())
  );
}
const official = (url: string) => {
  try {
    const u = new URL(url);
    return (
      u.origin === "https://tieba.baidu.com" &&
      !u.username &&
      !u.password &&
      !u.port
    );
  } catch {
    return false;
  }
};
async function capturedInput(
  page: Page,
  input: ElementHandle,
  setFile: (file: FilePayload) => Promise<void> = (file) =>
    input.setInputFiles(file),
): Promise<TiebaTopicLocalImageInput> {
  const frame = await input.ownerFrame();
  if (
    !frame ||
    frame.page() !== page ||
    !official(frame.url()) ||
    !(await input.evaluate(
      (el) =>
        (el as HTMLInputElement).tagName === "INPUT" &&
        (el as HTMLInputElement).type === "file",
    ))
  )
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_ORIGIN",
      "本地图片选择控件不属于当前官方页面，未读取或上传文件。",
    );
  return { setFile };
}
/** Only the observed official toolbar -> local-upload branch can request files. */
export async function prepareTiebaTopicLocalImageInput(
  page: Page,
  timeoutMs = 6000,
): Promise<TiebaTopicLocalImageInput> {
  if (!official(page.url()))
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_ORIGIN",
      "本地图片上传页面不是官方HTTPS地址。",
    );
  const direct = page.locator(tiebaTopicFileSelector);
  if ((await direct.count()) > 1)
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_CONTROL",
      "官网出现多个本地文件控件，未选择文件。",
    );
  if ((await direct.count()) === 1) {
    const element = await direct.elementHandle();
    if (element) return capturedInput(page, element);
  }
  const local = page
    .locator(tiebaTopicLocalUploadSelector)
    .filter({ visible: true });
  if ((await local.count()) === 0) {
    const button = page
      .locator(tiebaTopicImageButtonSelector)
      .filter({ visible: true });
    if ((await button.count()) !== 1)
      throw new AppError(
        "TIEBA_TOPIC_IMAGE_CONTROL",
        "官网没有唯一图片工具栏入口。",
      );
    await button.click({ timeout: 10000 });
  }
  try {
    await local.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_CONTROL",
      "官网本地上传入口不可用或不唯一，未选择文件。",
    );
  }
  if ((await local.count()) !== 1)
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_CONTROL",
      "官网本地上传分支不唯一，未选择网络图片或付费项目。",
    );
  const target = await local.getAttribute("href");
  if (!tiebaTopicInertUploadHref(target))
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_CONTROL",
      "本地上传入口含未识别导航，已停止。",
    );
  // Listening before the exact local UI click also prevents an unmanaged OS picker.
  const chooserPromise = page
    .waitForEvent("filechooser", { timeout: Math.max(timeoutMs, 15000) })
    .catch(() => null);
  await local.click({ timeout: 10000 });
  const upload = page
    .locator(
      "#tb_rich_poster_container .edui-dialog-container .edui-dropdown-menu.edui-popup .upload_container",
    )
    .filter({ visible: true });
  const watermark = upload
    .locator(".water_image_selecter_wrap")
    .filter({ visible: true });
  const stage = await Promise.race([
    chooserPromise.then((chooser) => ({ kind: "chooser" as const, chooser })),
    watermark.waitFor({ state: "visible", timeout: timeoutMs }).then(
      () => ({ kind: "watermark" as const }),
      () => ({ kind: "missing" as const }),
    ),
  ]);
  let nextChooser: Awaited<typeof chooserPromise> | undefined;
  if (stage.kind === "watermark") {
    const free = watermark
      .locator(".slide_item.no_water")
      .filter({ visible: true });
    if (
      (await upload.count()) !== 1 ||
      (await watermark.count()) !== 1 ||
      (await free.count()) !== 1
    )
      throw new AppError(
        "TIEBA_TOPIC_IMAGE_CONTROL",
        "官网免费无水印选项不唯一，未选择任何付费水印。",
      );
    await free.click({ timeout: 10000 });
    if (
      (await watermark
        .locator(".slide_item.no_water.slide_item_active")
        .count()) !== 1 ||
      (await watermark
        .locator(".slide_item.slide_item_active:not(.no_water)")
        .count()) > 0
    )
      throw new AppError(
        "TIEBA_TOPIC_IMAGE_CONTROL",
        "无法确认免费无水印已选中，未继续上传。",
      );
    const next = upload.locator(".next_step").filter({ visible: true });
    if (
      (await next.count()) !== 1 ||
      (await next.innerText()).replace(/\s+/gu, "") !== "下一步"
    )
      throw new AppError(
        "TIEBA_TOPIC_IMAGE_CONTROL",
        "官网本地图片下一步控件不唯一。",
      );
    const nextChooserPromise = page
      .waitForEvent("filechooser", { timeout: Math.max(timeoutMs, 15000) })
      .catch(() => null);
    await next.click({ timeout: 10000 });
    nextChooser = await nextChooserPromise;
  }
  const chooser =
    stage.kind === "chooser"
      ? stage.chooser
      : nextChooser !== undefined
        ? nextChooser
        : await chooserPromise;
  if (chooser)
    return capturedInput(page, chooser.element(), (file) =>
      chooser.setFiles(file),
    );
  const ready = page.locator(tiebaTopicFileSelector);
  if ((await ready.count()) === 1) {
    const element = await ready.elementHandle();
    if (element) return capturedInput(page, element);
  }
  throw new AppError(
    "TIEBA_TOPIC_IMAGE_CONTROL",
    "官网本地上传未提供可核实的原生文件控件，未上传文件。",
  );
}
