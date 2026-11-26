import type { ResourceDriveLink } from "../shared/resource-drive-links";
import type { Resource, ResourceCopy } from "../shared/types";
import type { Database } from "./database";
import type { SecretStore } from "./secrets";
import { AppError } from "./errors";

export const driveLinkCodeKey = (id: string) => `resource-drive-link:${id}`;

export function readResourceDriveLinks(db: Database, resourceId: string) {
  return db
    .all<ResourceDriveLink>(
      `SELECT l.id, l.provider, l.url, l.needs_code AS needsCode,
        EXISTS(SELECT 1 FROM secrets s WHERE s.key=? || l.id) AS codeAvailable,
        c.id AS copyId,c.status,CASE WHEN c.status='ready' THEN c.share_url END AS shareUrl,
        (SELECT j.id FROM jobs j WHERE j.copy_id=c.id AND j.kind='transfer' ORDER BY j.created_at DESC LIMIT 1) jobId
      FROM resource_drive_links l LEFT JOIN copies c ON c.source_link_id=l.id
      WHERE l.resource_id=? ORDER BY l.provider`,
      driveLinkCodeKey(""),
      resourceId,
    )
    .map((link) => ({
      ...link,
      needsCode: !!link.needsCode,
      codeAvailable: !!link.codeAvailable,
    }));
}

export function copySource(copy: ResourceCopy, resource: Resource) {
  return copy.source
    ? {
        ...copy.source,
        kind: "share" as const,
        codeKey: driveLinkCodeKey(copy.source.linkId),
      }
    : {
        url: resource.sourceUrl,
        provider: resource.provider,
        kind: resource.sourceKind,
        codeKey: `source:${resource.id}`,
        needsCode: false,
      };
}

export async function readDriveSourceCode(
  secrets: SecretStore,
  source: { codeKey: string; needsCode: boolean },
) {
  const code = await secrets.get(source.codeKey);
  if (source.needsCode && !code)
    throw new AppError(
      "RESOURCE_DRIVE_LINK_CODE_MISSING",
      "补充来源缺少提取码，请在资源库补填后重试原任务。",
    );
  return code ?? "";
}

export function removeResourceDriveLinkCodes(db: Database, resourceId: string) {
  db.run(
    "DELETE FROM secrets WHERE key IN (SELECT ? || id FROM resource_drive_links WHERE resource_id=?)",
    driveLinkCodeKey(""),
    resourceId,
  );
}
