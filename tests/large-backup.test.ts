import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Database, databaseSchemaVersion } from "../core/database";
import {
  assertBackupDatabaseFile,
  backupDatabaseLimitBytes,
  fileHash,
  inspectBackup,
  stageRestore,
} from "../core/backups";

const snapshot = [
  {
    id: "manual_local",
    word: "国画笔墨练习",
    source: "手工录入",
    platform: null,
    metrics: {},
    sourceUpdatedAt: null,
    fetchedAt: "2026-11-07T00:00:00.000Z",
  },
];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panxu-large-backup-"));
  const folder = join(root, "backup");
  await mkdir(folder);
  const file = join(folder, "panxu.db");
  const db = new Database(file);
  try {
    db.run(
      "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES('preserved_pool','笔墨练习',NULL,?,'2026-11-07T00:00:00.000Z')",
      JSON.stringify(snapshot),
    );
    db.run(
      "INSERT INTO accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES('backup_account','quark','本地隔离账号','uid_local','connected','2026-11-07','2026-11-07')",
    );
    db.run("PRAGMA journal_mode=DELETE");
  } finally {
    db.close();
  }
  const updateManifest = async () => {
    const databaseSha256 = await fileHash(file);
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        product: "panxu-studio",
        schemaVersion: databaseSchemaVersion,
        createdAt: "2026-11-07T00:00:00.000Z",
        credentialsIncluded: false,
        databaseSha256,
      }),
    );
    return databaseSha256;
  };
  return {
    root,
    folder,
    file,
    updateManifest,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("backup preflight and restore accept a valid sparse SQLite file above 512MiB, retaining immutable pools", async () => {
  const f = await fixture();
  try {
    // SQLite permits trailing bytes beyond its logical page count. Extending the
    // file creates a valid, sparse fixture for the actual file-size boundary;
    // this is not a large-row performance benchmark and allocates no giant blob.
    const file = await open(f.file, "r+");
    try {
      await file.truncate(513 * 1024 ** 2);
    } finally {
      await file.close();
    }
    assert.ok((await stat(f.file)).size > 512 * 1024 ** 2);
    const hash = await f.updateManifest();
    const info = await inspectBackup(f.folder);
    assert.equal(info.databaseSha256, hash);
    assert.equal(info.accounts, 1);
    const staged = await stageRestore(f.folder, f.root, hash);
    const restored = new Database(join(staged.dataPath, "panxu.db"));
    try {
      const pool = restored.get<{ keywords: string }>(
        "SELECT keywords FROM pools WHERE id='preserved_pool'",
      );
      assert.deepEqual(JSON.parse(pool!.keywords), snapshot);
      assert.equal(
        restored.get<{ status: string }>(
          "SELECT status FROM accounts WHERE id='backup_account'",
        )?.status,
        "disconnected",
      );
      assert.equal(
        restored.get<{ n: number }>("SELECT count(*) n FROM secrets")?.n,
        0,
      );
    } finally {
      restored.close();
    }
    assert.equal(
      await fileHash(f.file),
      hash,
      "restoration must not modify the source backup",
    );
  } finally {
    await f.close();
  }
});

test("database export guard and restore share the 8GiB bound and reject larger files before hashing", async () => {
  const f = await fixture();
  try {
    await f.updateManifest();
    const file = await open(f.file, "r+");
    try {
      await file.truncate(backupDatabaseLimitBytes + 1);
    } finally {
      await file.close();
    }
    await assert.rejects(assertBackupDatabaseFile(f.file), {
      code: "INVALID_BACKUP",
    });
    await assert.rejects(inspectBackup(f.folder), { code: "INVALID_BACKUP" });
    await assert.rejects(stageRestore(f.folder, f.root, "0".repeat(64)), {
      code: "INVALID_BACKUP",
    });
  } finally {
    await f.close();
  }
});

test("larger-file support retains symlink, hash, sidecar and credential rejection", async () => {
  for (const mode of ["symlink", "hash", "sidecar", "credentials"] as const) {
    const f = await fixture();
    try {
      const hash = await f.updateManifest();
      if (mode === "symlink") {
        const target = join(f.root, "source.db");
        await rename(f.file, target);
        await symlink(target, f.file);
      } else if (mode === "hash") {
        const file = await open(f.file, "a");
        try {
          await file.write("changed");
        } finally {
          await file.close();
        }
      } else if (mode === "sidecar") await writeFile(`${f.file}-wal`, "");
      else {
        const db = new DatabaseSync(f.file);
        try {
          db.prepare("INSERT INTO secrets VALUES('protected','opaque')").run();
        } finally {
          db.close();
        }
        await f.updateManifest();
      }
      await assert.rejects(inspectBackup(f.folder), {
        code:
          mode === "hash"
            ? "BACKUP_HASH_MISMATCH"
            : mode === "credentials"
              ? "BACKUP_CONTAINS_SECRETS"
              : "INVALID_BACKUP",
      });
      await assert.rejects(stageRestore(f.folder, f.root, hash));
    } finally {
      await f.close();
    }
  }
});
