import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContentSources } from "../content-sources";
import { readContentImage } from "../content-assets";
import { copyJianshuBody } from "../jianshu/handoff";
import { jianshuVersionSchema } from "../../shared/jianshu";
import { AppError } from "../errors";
import type { HandlerServices, HandlerMap } from "./types";
export function createJianshuDeliveryHandlers(
  s: Pick<
    HandlerServices,
    "jianshu" | "ports" | "dataPath" | "repo" | "search"
  >,
) {
  const sources = new ContentSources(s.repo, s.search);
  const current = async (raw: unknown) => {
    const v = jianshuVersionSchema.parse(raw),
      detail = await s.jianshu.deliveryDetail(v.id);
    if (detail.article.revision !== v.revision)
      throw new AppError(
        "JIANSHU_VERSION",
        "文章版本已变化，请先重新读取当前稿件。",
      );
    return detail;
  };
  return {
    "jianshu.matches": (raw) =>
      sources.matches(
        z.object({ keyword: z.string().trim().max(100) }).parse(raw),
      ),
    "jianshu.image": async (raw) => {
      const v = jianshuVersionSchema
          .extend({ file: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif)$/) })
          .parse(raw),
        detail = await current(v);
      const image = [
        ...detail.article.images,
        ...detail.article.versions.flatMap((version) => version.images),
      ].find((image) => image.file === v.file);
      if (!image)
        throw new AppError(
          "JIANSHU_IMAGE",
          "当前文章不包含此图片，请重新选择。",
        );
      const bytes = await readContentImage(s.dataPath, image);
      return `data:image/${image.file.endsWith("jpg") ? "jpeg" : image.file.split(".").pop()};base64,${bytes.toString("base64")}`;
    },
    "jianshu.copy": async (raw) => {
      const detail = await current(raw),
        text = detail.delivery.text;
      await copyJianshuBody(s.ports, text);
      return true;
    },
    "jianshu.export": async (raw) => {
      const detail = await current(raw),
        files = await Promise.all(
          detail.article.images.map(async (image) => ({
            image,
            bytes: await readContentImage(s.dataPath, image),
          })),
        );
      const folder = await s.ports.chooseDirectory("content");
      if (!folder) return null;
      const dir = join(
        folder,
        `简书文章-${detail.article.id}-${detail.article.revision}-${randomUUID().slice(0, 8)}`,
      );
      await mkdir(join(dir, "images"), { recursive: true });
      for (const { image, bytes } of files)
        await writeFile(join(dir, "images", image.file), bytes, {
          mode: 0o600,
        });
      const images = detail.article.images
        .map(
          (image) =>
            `![${image.name.replace(/[\[\]\r\n]/g, "")}](images/${image.file})`,
        )
        .join("\n\n");
      await writeFile(
        join(dir, "article.md"),
        `# ${detail.article.title}\n\n${detail.delivery.text}\n\n${images}\n`,
        { mode: 0o600 },
      );
      await writeFile(join(dir, "正文.txt"), detail.delivery.text, {
        mode: 0o600,
      });
      await writeFile(join(dir, "标题.txt"), detail.article.title, {
        mode: 0o600,
      });
      await writeFile(
        join(dir, "sources.json"),
        JSON.stringify(
          {
            id: detail.article.id,
            revision: detail.article.revision,
            sources: detail.sources.map(
              ({
                title,
                url,
                author,
                sourceName,
                provider,
                publishedAt,
                collectedAt,
                warnings,
              }) => ({
                title,
                url,
                author,
                sourceName,
                provider,
                publishedAt,
                collectedAt,
                warnings,
              }),
            ),
            resourceUrl: detail.delivery.resourceUrl,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return dir;
    },
  } satisfies HandlerMap;
}
