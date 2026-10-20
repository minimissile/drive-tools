import {
  channelProfiles,
  defaultContentFormat,
  supportsContentFormat,
  type ContentFormat,
} from "../../shared/channels";
import { z } from "zod";
import { id, now } from "../database";
import { AppError } from "../errors";
import { validateEditorUrl } from "../links";
import { platformSpecs } from "../../shared/platforms";
import {
  contentFormatSchema,
  linkPositionSchema,
  platformSchema,
} from "../../shared/schemas";

import type { HandlerServices, HandlerMap } from "./types";

export function createBindingsHandlers(
  services: Pick<
    HandlerServices,
    "bit" | "changed" | "db" | "openBinding" | "repo"
  >,
) {
  return {
    "bit.health": async () => {
      return services.bit.health();
    },
    "bit.windows": async () => {
      return services.bit.windows();
    },
    "binding.open": async (object) => {
      const { id: bindingId, contentFormat } = z
        .object({
          id: z.string(),
          contentFormat: contentFormatSchema.optional(),
        })
        .parse(object);
      const binding = services.repo.bindings().find((b) => b.id === bindingId);
      if (!binding)
        throw new AppError("NOT_FOUND", "未找到对应的平台窗口映射。");
      if (
        contentFormat &&
        !supportsContentFormat(binding.platform, contentFormat)
      )
        throw new AppError(
          "CHANNEL_FORMAT_UNSUPPORTED",
          "此平台不支持所选内容形式。",
        );
      return services.openBinding(binding, contentFormat);
    },
    "binding.save": async (object) => {
      const input = z
        .object({
          id: z.string().optional(),
          platform: platformSchema,
          alias: z.string().trim().min(1).max(80),
          windowId: z.string().min(1).max(200),
          editorUrl: z.string().max(2000),
          linkPermission: z.enum(["none", "allowed"]),
          ruleNote: z.string().max(2000),
          confirmCapabilities: z.boolean().optional(),
          capabilities: z
            .object({
              formats: z.array(contentFormatSchema).max(7),
              linkPositions: z.array(linkPositionSchema).max(4),
              editorUrls: z
                .partialRecord(contentFormatSchema, z.string().trim().max(2000))
                .optional(),
            })
            .optional(),
        })
        .parse(object);
      const spec = platformSpecs.find((p) => p.id === input.platform)!;
      if (input.id) {
        const prior = services.repo.bindings().find((b) => b.id === input.id);
        if (!prior || prior.platform !== input.platform)
          throw new AppError(
            "BINDING_MISMATCH",
            "已有映射不能修改所属平台，请为新平台新建映射。",
          );
      }
      const prior = input.id
        ? services.repo.bindings().find((b) => b.id === input.id)
        : null;
      const capabilities = input.capabilities ??
        prior?.capabilities ?? {
          formats: [defaultContentFormat(input.platform)],
          linkPositions:
            input.linkPermission === "allowed" ? ["body" as const] : [],
        };
      capabilities.formats = [...new Set(capabilities.formats)];
      capabilities.linkPositions = [...new Set(capabilities.linkPositions)];
      if (
        capabilities.formats.some(
          (f) => !supportsContentFormat(input.platform, f),
        ) ||
        capabilities.linkPositions.some(
          (p) => !channelProfiles[input.platform].positions.includes(p),
        )
      )
        throw new AppError(
          "CHANNEL_CAPABILITY_INVALID",
          "账号能力包含此平台不适用的内容形式或链接位置。",
        );
      if (
        input.linkPermission === "allowed" &&
        (input.ruleNote.trim().length < 10 ||
          !capabilities.formats.length ||
          !capabilities.linkPositions.length ||
          (spec.linkMode === "blocked" &&
            capabilities.linkPositions.some((p) => p !== "component")))
      )
        throw new AppError(
          "CHANNEL_RULE_REQUIRED",
          "请记录至少10字的账号核实依据，并选择允许的内容形式和链接位置；此平台不允许普通正文网盘链接。",
        );
      if (input.linkPermission === "none") capabilities.linkPositions = [];
      const editorUrls: Partial<Record<ContentFormat, string>> = {};
      for (const [format, value] of Object.entries(
        capabilities.editorUrls ?? {},
      )) {
        if (!supportsContentFormat(input.platform, format as ContentFormat))
          throw new AppError(
            "CHANNEL_FORMAT_UNSUPPORTED",
            "发布入口包含此平台不支持的内容形式。",
          );
        if (value)
          editorUrls[format as ContentFormat] = validateEditorUrl(
            input.platform,
            value,
          );
      }
      if (Object.keys(editorUrls).length) capabilities.editorUrls = editorUrls;
      else delete capabilities.editorUrls;
      const editorUrl = validateEditorUrl(input.platform, input.editorUrl);
      const scope = (value: {
        windowId: string;
        editorUrl: string;
        linkPermission: string;
        ruleNote: string;
        capabilities: typeof capabilities;
      }) =>
        JSON.stringify({
          windowId: value.windowId,
          editorUrl: value.editorUrl,
          linkPermission: value.linkPermission,
          ruleNote: value.ruleNote.trim(),
          formats: [...value.capabilities.formats].sort(),
          positions: [...value.capabilities.linkPositions].sort(),
          editors: Object.entries(value.capabilities.editorUrls ?? {}).sort(
            ([a], [b]) => a.localeCompare(b),
          ),
        });
      const scopeChanged =
        !!prior &&
        scope(prior) !== scope({ ...input, editorUrl, capabilities });
      if (
        input.confirmCapabilities === true &&
        (!capabilities.formats.length || input.ruleNote.trim().length < 10)
      )
        throw new AppError(
          "CHANNEL_RULE_REQUIRED",
          "确认核实前，请选择账号实际具备的内容形式，并填写至少10字的核实依据。",
        );
      // Legacy new-account callers retain their original explicit declaration. Edits never silently renew permissions.
      const verifiedAt =
        input.confirmCapabilities === true ||
        (!prior && input.confirmCapabilities === undefined)
          ? now()
          : scopeChanged
            ? null
            : (prior?.verifiedAt ?? null);
      const bindingId = input.id ?? id("binding");
      services.db.transaction(() => {
        services.db.run(
          "INSERT INTO browser_bindings(id,platform,alias,window_id,editor_url,link_permission,rule_note,verified_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,window_id=excluded.window_id,editor_url=excluded.editor_url,link_permission=excluded.link_permission,rule_note=excluded.rule_note,verified_at=excluded.verified_at,last_checked_at=NULL,last_opened_at=NULL,open_error=NULL",
          bindingId,
          input.platform,
          input.alias,
          input.windowId,
          editorUrl,
          input.linkPermission,
          input.ruleNote.trim(),
          verifiedAt,
        );
        services.db.run(
          "UPDATE browser_bindings SET capabilities=? WHERE id=?",
          JSON.stringify(capabilities),
          bindingId,
        );
      });
      services.changed();
      return services.repo.bindings().find((b) => b.id === bindingId);
    },
  } satisfies HandlerMap;
}
