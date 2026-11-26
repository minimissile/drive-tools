import { id, type Database } from "./database";
import type {
  Provider,
  RemoteFile,
  ResourceInput,
  ShareInput,
} from "../shared/types";
import {
  isIndexedOwnSource,
  ownedFileSource,
} from "../shared/owned-file-source";
import { AppError } from "./errors";
import {
  assertResourceUnique,
  duplicateResourceError,
  normalizedResourceTitle,
  sameProviderTitledResources,
} from "./resource-duplicates";

export const driveSyncAutoRegisterKey = (accountId: string) =>
  `drive-sync:auto-register:${accountId}`;

type Owner = { id: string; uid: string; provider: Provider };
type IndexedFile = RemoteFile & { path: string };

export function registeredDriveResource(
  db: Database,
  owner: Owner,
  fileId: string,
) {
  return db.get<{ resource_id: string }>(
    "SELECT c.resource_id FROM drive_resource_entries l JOIN copies c ON c.id=l.copy_id WHERE l.account_id=? AND l.owner_uid=? AND l.file_id=? LIMIT 1",
    owner.id,
    owner.uid,
    fileId,
  )?.resource_id;
}

/** Write an already verified object within the caller's transaction. */
export function writeIndexedDriveResource(
  db: Database,
  owner: Owner,
  input: { title: string; directory: string; file: IndexedFile; time: string },
  titles?: Set<string>,
) {
  const { title, directory, file, time } = input;
  const resourceId = id("resource");
  const sourceUrl = ownedFileSource(
    owner.provider,
    owner.id,
    owner.uid,
    file.id,
  );
  const normalized = titles ? normalizedResourceTitle(title) : "";
  if (normalized && titles?.has(normalized))
    throw duplicateResourceError(title, owner.provider);
  assertResourceUnique(db, {
    resourceId,
    sourceUrl,
    title,
    provider: owner.provider,
    accountId: owner.id,
    provisionalTitle: !!titles,
  });
  db.run(
    "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,source_kind,created_at,updated_at) VALUES(?,?,?,?,?,'未分类','[]','','owned',?,?)",
    resourceId,
    title,
    sourceUrl,
    file.id,
    owner.provider,
    time,
    time,
  );
  // Keep the exact file and parent path. No other files in its directory are claimed.
  db.run(
    "INSERT INTO copies(id,resource_id,account_id,directory,files,status,owner_uid,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,'recorded',?,?,?,?)",
    id("copy"),
    resourceId,
    owner.id,
    directory,
    JSON.stringify([file]),
    owner.uid,
    time,
    time,
    time,
  );
  if (normalized) titles?.add(normalized);
  return resourceId;
}

export function registerScannedDriveFiles(
  db: Database,
  owner: Owner,
  directory: string,
  files: IndexedFile[],
  time: string,
) {
  let titles: Set<string> | undefined;
  let added = 0;
  for (const file of files) {
    const title = file.name.trim();
    if (
      !title ||
      title.length > 200 ||
      registeredDriveResource(db, owner, file.id)
    )
      continue;
    titles ??= new Set(
      sameProviderTitledResources(db, owner.provider).map((item) =>
        normalizedResourceTitle(item.title),
      ),
    );
    try {
      writeIndexedDriveResource(
        db,
        owner,
        { title, directory, file, time },
        titles,
      );
      added++;
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== "RESOURCE_PROVIDER_EXISTS"
      )
        throw error;
    }
  }
  return { added, skipped: files.length - added };
}

/** Only existing, exact local provenance may bypass share parsing during metadata edits. */
export function indexedOwnSource(
  db: Database,
  input: ResourceInput,
): ShareInput | null {
  if (!input.id) return null;
  const resource = db.get<{
    source_url: string;
    source_key: string;
    source_kind: string;
    provider: Provider;
  }>(
    "SELECT source_url,source_key,source_kind,provider FROM resources WHERE id=?",
    input.id,
  );
  if (
    !resource ||
    resource.source_kind !== "owned" ||
    !isIndexedOwnSource(resource.source_url)
  )
    return null;
  if (
    !input.isOwnResource ||
    input.enqueue ||
    input.sourceText.trim() !== resource.source_url ||
    !input.copyId ||
    !db.get(
      "SELECT 1 FROM copies c JOIN accounts a ON a.id=c.account_id WHERE c.id=? AND c.resource_id=? AND c.account_id=? AND c.owner_uid=a.uid AND c.verified_at IS NOT NULL",
      input.copyId,
      input.id,
      input.accountId,
    )
  )
    throw new AppError(
      "INDEXED_SOURCE_IMMUTABLE",
      "此记录来自本人网盘目录，请保留原账号与来源编辑；分享需在资源中单独创建。",
    );
  return {
    provider: resource.provider,
    shareKey: resource.source_key,
    url: resource.source_url,
    code: "",
  };
}
