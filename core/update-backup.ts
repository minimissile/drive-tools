import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "./database";

// A local snapshot preserves encrypted credentials on this machine. Portable
// exports continue to use AppService.backup(), which removes credentials.
export async function snapshotBeforeUpdate(
  db: Database,
  dataPath: string,
): Promise<string> {
  const folder = join(dataPath, "updates", "backups");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `before-update-${Date.now()}-${randomUUID()}.db`);
  const temp = `${file}.tmp`;
  try {
    db.run("VACUUM INTO ?", temp);
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const entries = await readdir(folder);
    const snapshots = await Promise.all(
      entries
        .filter((name) => /^before-update-\d+-[a-f0-9-]+\.db$/.test(name))
        .map(async (name) => ({
          path: join(folder, name),
          time: (await stat(join(folder, name))).mtimeMs,
        })),
    );
    // Retention errors never invalidate a successfully created snapshot.
    for (const entry of snapshots
      .filter((entry) => entry.path !== file)
      .sort((a, b) => b.time - a.time)
      .slice(2))
      await rm(entry.path);
  } catch {
    /* Keep the current snapshot even if old files cannot be pruned. */
  }
  return file;
}
