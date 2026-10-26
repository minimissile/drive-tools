import { contentFormats } from "../../shared/channels";
import { z } from "zod";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { id, now } from "../database";
import { csdnHandoff, csdnPublishingSteps } from "../../shared/csdn";
import { AppError } from "../errors";
import { validatePublicationUrl } from "../links";
import { platformSpecs } from "../../shared/platforms";
import { linkPositionSchema } from "../../shared/schemas";
import { recordEditorOpened } from "../publications";

import type { HandlerServices, HandlerMap } from "./types";

export function createPublicationHandlers(
  services: Pick<
    HandlerServices,
    | "changed"
    | "contentPackage"
    | "dataPath"
    | "db"
    | "openBinding"
    | "ports"
    | "publicationChecks"
    | "repo"
    | "studio"
  >,
) {
  return {
    "publication.package": async (object) => {
      const input = z
        .object({
          draftId: z.string(),
          bindingId: z.string().nullable(),
          includeLink: z.boolean(),
          linkPosition: linkPositionSchema.default("body"),
        })
        .parse(object);
      return services.contentPackage(
        input.draftId,
        input.bindingId,
        input.includeLink,
        input.linkPosition,
      );
    },
    "publication.open": async (object) => {
      const { draftId, bindingId } = z
        .object({ draftId: z.string(), bindingId: z.string() })
        .parse(object);
      await services.contentPackage(draftId, bindingId, false);
      const binding = services.repo.bindings().find((b) => b.id === bindingId)!;
      const draft = services.repo.draft(draftId);
      const result = await services.openBinding(binding, draft.contentFormat);
      recordEditorOpened(services.db, draft, bindingId);
      services.changed();
      return result;
    },
    "publication.export": async (object) => {
      const { draftId, bindingId, includeLink, linkPosition } = z
        .object({
          draftId: z.string(),
          bindingId: z.string().nullable(),
          includeLink: z.boolean(),
          linkPosition: linkPositionSchema.default("body"),
        })
        .parse(object);
      const result = await services.contentPackage(
        draftId,
        bindingId,
        includeLink,
        linkPosition,
      );
      const selected = await services.ports.chooseDirectory(
        "content",
        services.db.setting<string | undefined>(
          "lastContentExportDirectory",
          undefined,
        ),
      );
      if (!selected) return null;
      const folder = join(selected, `盘序内容包-${id("export")}`);
      await mkdir(folder, { mode: 0o700 });
      try {
        const media = await services.studio.exportAssets(draftId, folder),
          exportedDraft = services.repo.draft(draftId),
          creative = exportedDraft.creative;
        await writeFile(join(folder, "发布文案.txt"), result.text, {
          mode: 0o600,
        });
        const handoff = csdnHandoff({
          title: result.title,
          body: result.body,
          tags: exportedDraft.tags,
        });
        await writeFile(join(folder, "文章.md"), handoff.markdown, {
          mode: 0o600,
        });
        await writeFile(
          join(folder, "发布字段.json"),
          JSON.stringify(
            {
              platform: exportedDraft.platform,
              contentFormat: exportedDraft.contentFormat,
              contentFormatLabel:
                contentFormats[exportedDraft.contentFormat].name,
              title: result.title,
              summarySuggestion: handoff.summary,
              tags: exportedDraft.tags,
              delivery: result.delivery,
              deliveryMounted: false,
              rule: platformSpecs.find((p) => p.id === exportedDraft.platform)!
                .rule,
              ruleUrl: platformSpecs.find(
                (p) => p.id === exportedDraft.platform,
              )!.ruleUrl,
              accountAlias: bindingId
                ? services.repo.bindings().find((b) => b.id === bindingId)
                    ?.alias
                : null,
              aiModel: exportedDraft.model,
              aiLabelRequiresReview: true,
              published: false,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        if (exportedDraft.platform === "csdn") {
          await writeFile(
            join(folder, "CSDN发布字段.json"),
            JSON.stringify(
              {
                title: handoff.title,
                tags: handoff.tags,
                summarySuggestion: handoff.summary,
                titleTooLong: handoff.titleTooLong,
                includesOwnLink: result.includesOwnLink,
                model: exportedDraft.model,
                steps: csdnPublishingSteps,
                published: false,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        }
        await writeFile(
          join(folder, "内容信息.json"),
          JSON.stringify(
            {
              title: result.title,
              platform: result.platform,
              contentFormat: exportedDraft.contentFormat,
              linkPosition: result.delivery?.position ?? null,
              deliveryMounted: false,
              draftId: exportedDraft.id,
              draftVersion: exportedDraft.version,
              resourceId: exportedDraft.resourceId,
              copyId: exportedDraft.copyId,
              exportedAt: now(),
              published: false,
              includesOwnLink: result.includesOwnLink,
              format: creative?.format ?? "text",
              templateId: creative?.templateId ?? null,
              media,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        if (result.coverId)
          await copyFile(
            join(services.dataPath, "covers", `${result.coverId}.png`),
            join(folder, "封面.png"),
          );
        services.db.setSetting("lastContentExportDirectory", selected);
        return { folder };
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
    },
    "publication.deliveryChecks": async (object) => {
      return services.publicationChecks.list(
        z.object({ publicationId: z.string().min(1).max(100) }).parse(object)
          .publicationId,
      );
    },
    "publication.deliveryCheck": async (object) => {
      return services.publicationChecks.save(object);
    },
    "publication.mark": async (object) => {
      const { draftId, bindingId, url, status } = z
        .object({
          draftId: z.string(),
          bindingId: z.string(),
          url: z.url().max(2000),
          status: z.enum(["submitted", "published"]).default("published"),
        })
        .parse(object);
      const draft = services.repo.draft(draftId);
      validatePublicationUrl(draft.platform, url);
      if (
        !services.db.get(
          "SELECT id FROM publications WHERE draft_id=? AND draft_version=? AND binding_id=? AND status=?",
          draftId,
          draft.version,
          bindingId,
          "opened",
        )
      )
        throw new AppError(
          "EDITOR_NOT_OPENED",
          "当前草稿版本尚未打开指定编辑器。",
        );
      const existing = services.db.get<{ id: string; status: string }>(
        "SELECT id,status FROM publications WHERE draft_id=? AND draft_version=? AND binding_id=? AND url=? AND status IN ('submitted','published') ORDER BY created_at DESC,rowid DESC LIMIT 1",
        draftId,
        draft.version,
        bindingId,
        url,
      );
      if (existing) {
        if (existing.status === "published" && status === "submitted")
          throw new AppError(
            "PUBLICATION_ALREADY_PUBLISHED",
            "这篇文章已确认发布，无需重复记录为待审核。",
          );
        if (existing.status === status) return true;
        services.db.run(
          "UPDATE publications SET status=? WHERE id=?",
          status,
          existing.id,
        );
        services.publicationChecks.capture(existing.id, draft);
        services.changed();
        return true;
      }
      const publicationId = id("pub");
      services.db.transaction(() => {
        services.db.run(
          "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,url,created_at) VALUES(?,?,?,?,?,?,?)",
          publicationId,
          draftId,
          draft.version,
          bindingId,
          status,
          url,
          now(),
        );
        services.publicationChecks.capture(publicationId, draft);
      });
      services.changed();
      return true;
    },
  } satisfies HandlerMap;
}
