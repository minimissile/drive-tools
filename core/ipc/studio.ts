import {
  defaultContentFormat,
  supportsContentFormat,
} from "../../shared/channels";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { id, now } from "../database";
import { creativePackage } from "../../shared/studio";
import { localTemplate } from "../templates";
import { AppError } from "../errors";
import { contentFormatSchema, platformSchema } from "../../shared/schemas";

import type { HandlerServices, HandlerMap } from "./types";

export function createStudioHandlers(
  services: Pick<
    HandlerServices,
    "ai" | "changed" | "db" | "ports" | "repo" | "search" | "studio"
  >,
) {
  return {
    "draft.get": async (object) => {
      return services.repo.draft(z.object({ id: z.string() }).parse(object).id);
    },
    "studio.templates": async () => {
      return services.studio.templates();
    },
    "studio.workingCopy": async (object) => {
      return services.studio.workingCopy(
        z.object({ draftId: z.string().min(1).max(100) }).parse(object).draftId,
      );
    },
    "studio.workingSave": async (object) => {
      return services.studio.saveWorkingCopy(object);
    },
    "studio.workingClear": async (object) => {
      return services.studio.clearWorkingCopy(
        z.object({ draftId: z.string().min(1).max(100) }).parse(object).draftId,
      );
    },
    "studio.templateSave": async (object) => {
      return services.studio.saveTemplate(object);
    },
    "studio.templateDelete": async (object) => {
      return services.studio.deleteTemplate(
        z.object({ id: z.string().max(100) }).parse(object).id,
      );
    },
    "studio.models": async () => {
      return services.studio.models();
    },
    "studio.modelCatalog": async () => {
      return services.db.setting("studio:modelCatalog", []);
    },
    "studio.create": async (object) => {
      return services.studio.create(object);
    },
    "studio.jobs": async (object) => {
      return services.studio.jobs(
        z.object({ draftId: z.string().max(100) }).parse(object).draftId,
      );
    },
    "studio.submit": async (object) => {
      return services.studio.submit(object);
    },
    "studio.poll": async (object) => {
      return services.studio.poll(
        z.object({ id: z.string().max(100) }).parse(object).id,
      );
    },
    "studio.assetExport": async (object) => {
      const { name } = z.object({ name: z.string().max(100) }).parse(object),
        path = await services.studio.assetPath(name);
      return services.ports.saveFile(
        `营销素材.${name.split(".")[1]}`,
        await readFile(path),
      );
    },
    "draft.generate": async (object) => {
      const { copyId, platform, poolId, contentFormat } = z
        .object({
          copyId: z.string(),
          platform: platformSchema,
          poolId: z.string().nullable(),
          contentFormat: contentFormatSchema.optional(),
        })
        .parse(object);
      return services.ai.draft(
        copyId,
        platform,
        poolId,
        undefined,
        contentFormat,
      );
    },
    "draft.manual": async (object) => {
      const {
        copyId,
        platform,
        template,
        contentFormat: requestedFormat,
      } = z
        .object({
          copyId: z.string(),
          platform: platformSchema,
          template: z.boolean().default(false),
          contentFormat: contentFormatSchema.optional(),
        })
        .parse(object);
      const copy = services.repo.getCopy(copyId),
        resource = services.repo.getResource(copy.resourceId),
        draftId = id("draft"),
        time = now();
      const contentFormat = requestedFormat ?? defaultContentFormat(platform);
      if (!supportsContentFormat(platform, contentFormat))
        throw new AppError(
          "CHANNEL_FORMAT_UNSUPPORTED",
          "此平台不支持所选内容形式。",
        );
      const content = template
        ? localTemplate(resource, platform, contentFormat)
        : { title: resource.title, body: "", tags: [], coverText: "" };
      services.db.run(
        "INSERT INTO drafts(id,resource_id,copy_id,platform,title,body,tags,resource_revision,share_version,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        draftId,
        resource.id,
        copyId,
        platform,
        content.title,
        content.body,
        JSON.stringify(content.tags),
        resource.revision,
        copy.shareVersion,
        template ? "local-template" : "manual",
        time,
        time,
      );
      services.db.run(
        "UPDATE drafts SET content_format=? WHERE id=?",
        contentFormat,
        draftId,
      );
      services.changed();
      return services.repo.draft(draftId);
    },
    "draft.save": async (object) => {
      const input = z
        .object({
          id: z.string(),
          title: z.string().trim().min(1).max(200),
          body: z.string().max(30000),
          tags: z.array(z.string().max(60)).max(30),
          coverText: z.string().max(300),
          creative: creativePackage.optional(),
        })
        .parse(object);
      const draft = services.repo.draft(input.id),
        draftId = id("draft"),
        time = now();
      services.db.transaction(() => {
        services.db.run(
          "INSERT INTO drafts(id,resource_id,copy_id,platform,pool_id,title,body,tags,cover_text,version,resource_revision,share_version,model,reviewed,created_at,updated_at,topic_id,split_item_id,split_share_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          draftId,
          draft.resourceId,
          draft.copyId,
          draft.platform,
          draft.poolId,
          input.title,
          input.body,
          JSON.stringify(input.tags),
          input.coverText,
          draft.version + 1,
          draft.resourceRevision,
          draft.shareVersion,
          draft.model,
          0,
          time,
          time,
          draft.topicId,
          draft.splitItemId,
          draft.splitShareVersion,
        );
        services.db.run(
          "UPDATE drafts SET content_format=? WHERE id=?",
          draft.contentFormat,
          draftId,
        );
        services.studio.inherit(draft, draftId, input.creative);
      });
      services.changed();
      return services.repo.draft(draftId);
    },
    "draft.review": async (object) => {
      const { id: draftId, reviewed } = z
        .object({ id: z.string(), reviewed: z.boolean() })
        .parse(object);
      const draft = services.repo.draft(draftId),
        resource = services.repo.getResource(draft.resourceId),
        copy = services.repo.getCopy(draft.copyId);
      const split =
        reviewed && draft.splitItemId
          ? services.search.assertTarget(copy.id, draft.splitItemId).split
          : null;
      if (
        reviewed &&
        !draft.body.trim() &&
        (!draft.creative || draft.creative.format === "text")
      )
        throw new AppError("EMPTY_DRAFT", "请先填写内容正文。");
      if (reviewed) {
        services.studio.assertWorkingCopySaved(draftId);
        await services.studio.assertReady(draftId);
      }
      services.db.run(
        "UPDATE drafts SET reviewed=?,resource_revision=?,share_version=?,split_share_version=?,updated_at=? WHERE id=?",
        Number(reviewed),
        resource.revision,
        copy.shareVersion,
        split?.shareVersion ?? null,
        now(),
        draftId,
      );
      services.changed();
      return services.repo.draft(draftId);
    },
  } satisfies HandlerMap;
}
