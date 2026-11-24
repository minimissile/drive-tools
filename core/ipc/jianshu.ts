import { z } from "zod";
import {
  jianshuIdSchema,
  jianshuCreateSchema,
  jianshuSaveSchema,
  jianshuGenerateSchema,
  jianshuCollectSchema,
  jianshuVersionSchema,
  jianshuResultSchema,
  jianshuResolveSchema,
} from "../../shared/jianshu";
import type { JianshuArticles } from "../jianshu/service";
import type { HandlerMap } from "./types";

export function createJianshuHandlers({
  jianshu,
}: {
  jianshu: JianshuArticles;
}) {
  const complete = async (
    result:
      | import("../../shared/jianshu").JianshuDetail
      | null
      | Promise<import("../../shared/jianshu").JianshuDetail | null>,
  ) => {
    const detail = await result;
    return detail ? jianshu.deliveryDetail(detail.article.id) : null;
  };
  return {
    "jianshu.list": () => jianshu.list(),
    "jianshu.get": (raw) =>
      jianshu.deliveryDetail(z.object({ id: jianshuIdSchema }).parse(raw).id),
    "jianshu.sources": () => jianshu.sources(),
    "jianshu.collect": (raw) =>
      jianshu.collect(jianshuCollectSchema.parse(raw)),
    "jianshu.create": (raw) =>
      complete(jianshu.createWithCover(jianshuCreateSchema.parse(raw))),
    "jianshu.save": (raw) =>
      complete(jianshu.save(jianshuSaveSchema.parse(raw))),
    "jianshu.generate": (raw) =>
      complete(jianshu.generate(jianshuGenerateSchema.parse(raw))),
    "jianshu.importImages": (raw) =>
      complete(jianshu.importImages(jianshuVersionSchema.parse(raw))),
    "jianshu.prepare": (raw) =>
      complete(jianshu.prepare(jianshuVersionSchema.parse(raw))),
    "jianshu.checkResult": (raw) =>
      complete(jianshu.checkResult(jianshuResultSchema.parse(raw))),
    "jianshu.confirmImages": (raw) =>
      complete(
        jianshu.confirmImages(
          jianshuVersionSchema
            .extend({ confirmed: z.literal(true) })
            .parse(raw),
        ),
      ),
    "jianshu.resolve": (raw) =>
      complete(jianshu.resolve(jianshuResolveSchema.parse(raw))),
  } satisfies HandlerMap;
}
