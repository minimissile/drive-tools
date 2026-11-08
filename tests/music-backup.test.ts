import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Database } from "../core/database";
import { fileHash, inspectBackup, stageRestore } from "../core/backups";
import { MusicService, musicStateKey } from "../core/music/service";
import { fixture } from "./helpers";

const musicId = "7136850194742315016";
const attemptedAt = "2026-11-07T00:00:00.000Z";
const bytes = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61)]);
const audioFile = `${createHash("sha256").update(bytes).digest("hex")}.mp3`;
const track = {
  id: musicId,
  title: "测试热门配乐",
  author: "测试作者",
  rank: 1,
  audioUrls: ["https://sf6-cdn-tos.douyinstatic.com/obj/music-tos/test.mp3"],
};
const audioMetadata = {
  track,
  asset: { file: audioFile, mime: "audio/mpeg" },
  lastAttemptAt: attemptedAt,
  error: null,
};
const chartRaw = {
  at: attemptedAt,
  status: 200,
  body: JSON.stringify({ code: 200, data: { music_list: [] } }),
};
const detailRaw = {
  at: attemptedAt,
  status: 200,
  body: JSON.stringify({ code: 200, data: { music_info: track } }),
};

async function setup() {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "music"), { mode: 0o700 });
    await writeFile(join(f.dir, "music", audioFile), bytes);
    f.app.db.setSetting(musicStateKey, {
      enabled: true,
      updatedAt: attemptedAt,
      lastAttemptAt: attemptedAt,
      error: null,
      tracks: [track],
    });
    f.app.db.setSetting(`music:audio:${musicId}:v1`, audioMetadata);
    f.app.db.setSetting("music:raw:chart:v1", chartRaw);
    f.app.db.setSetting(`music:raw:detail:${musicId}:v1`, detailRaw);
    // Unrecognized settings must not become restored authorization or credentials.
    f.app.db.setSetting("music:authorization:v1", { enabled: true });
    f.app.db.setSetting("music:raw:detail:invalid:v1", { unrecognized: true });
    f.ports.chooseDirectory = async () => f.dir;
    const backup = (await f.app.backup())!;
    return { ...f, backup };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

async function editBackupDatabase(
  folder: string,
  edit: (db: Database) => void,
) {
  const file = join(folder, "panxu.db");
  const db = new Database(file);
  try {
    edit(db);
    db.run("PRAGMA journal_mode=DELETE");
  } finally {
    db.close();
  }
  const manifest = JSON.parse(
    await readFile(join(folder, "manifest.json"), "utf8"),
  );
  manifest.databaseSha256 = await fileHash(file);
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
  return manifest.databaseSha256 as string;
}

test("音乐备份恢复保留榜单、原始响应和本地音频，关闭周更新且离线复用不请求", async () => {
  const f = await setup();
  let restored: Database | undefined;
  let music: MusicService | undefined;
  try {
    const exported = new DatabaseSync(
      pathToFileURL(join(f.backup, "panxu.db")).href + "?immutable=1",
      { readOnly: true },
    );
    try {
      const state = JSON.parse(
        String(
          exported
            .prepare("SELECT value FROM settings WHERE key=?")
            .get(musicStateKey)?.value,
        ),
      );
      assert.equal(state.enabled, false);
    } finally {
      exported.close();
    }
    // Creating a backup must not change the active workspace's scheduling setting.
    assert.equal(
      f.app.db.setting<{ enabled: boolean }>(musicStateKey, { enabled: false })
        .enabled,
      true,
    );
    const preview = await inspectBackup(f.backup);
    assert.deepEqual(preview.music, [audioFile]);
    // Restoration independently disables a valid older export that still has it enabled.
    const hash = await editBackupDatabase(f.backup, (db) => {
      const state = db.setting<Record<string, unknown>>(musicStateKey, {});
      db.setSetting(musicStateKey, { ...state, enabled: true });
    });
    const staged = await stageRestore(f.backup, f.dir, hash);
    assert.deepEqual(
      await readFile(join(staged.dataPath, "music", audioFile)),
      bytes,
    );
    restored = new Database(join(staged.dataPath, "panxu.db"));
    assert.equal(
      restored.setting<{ enabled: boolean }>(musicStateKey, { enabled: true })
        .enabled,
      false,
    );
    assert.deepEqual(
      restored.setting(`music:audio:${musicId}:v1`, null),
      audioMetadata,
    );
    assert.deepEqual(restored.setting("music:raw:chart:v1", null), chartRaw);
    assert.deepEqual(
      restored.setting(`music:raw:detail:${musicId}:v1`, null),
      detailRaw,
    );
    assert.equal(restored.setting("music:authorization:v1", null), null);
    assert.equal(restored.setting("music:raw:detail:invalid:v1", null), null);
    let requested = 0;
    music = new MusicService({
      db: restored,
      dataPath: staged.dataPath,
      secrets: { has: () => false, get: async () => null },
      request: async () => {
        requested++;
        throw new Error("restored cache must remain offline");
      },
      changed() {},
    });
    assert.equal(music.library().enabled, false);
    assert.equal(music.library().tracks[0].audioCached, true);
    assert.equal(
      (await music.audio({ id: musicId })).src,
      `data:audio/mpeg;base64,${bytes.toString("base64")}`,
    );
    assert.equal(requested, 0);
  } finally {
    music?.close();
    restored?.close();
    await f.cleanup();
  }
});

test("旧备份无音乐目录或设置仍可恢复", async () => {
  const f = await setup();
  let restored: Database | undefined;
  try {
    await rm(join(f.backup, "music"), { recursive: true });
    const hash = await editBackupDatabase(f.backup, (db) =>
      db.run("DELETE FROM settings WHERE key LIKE 'music:%'"),
    );
    assert.deepEqual((await inspectBackup(f.backup)).music, []);
    const staged = await stageRestore(f.backup, f.dir, hash);
    restored = new Database(join(staged.dataPath, "panxu.db"));
    assert.equal(restored.setting(musicStateKey, null), null);
  } finally {
    restored?.close();
    await f.cleanup();
  }
});

test("音乐元数据引用的文件缺失时拒绝预检与恢复", async () => {
  const f = await setup();
  try {
    const hash = (await inspectBackup(f.backup)).databaseSha256;
    await rm(join(f.backup, "music", audioFile));
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    await assert.rejects(stageRestore(f.backup, f.dir, hash), {
      code: "INVALID_BACKUP",
    });
  } finally {
    await f.cleanup();
  }
});

test("音乐内容篡改时按文件摘要拒绝预检与恢复", async () => {
  const f = await setup();
  try {
    const hash = (await inspectBackup(f.backup)).databaseSha256;
    await writeFile(join(f.backup, "music", audioFile), "tampered music");
    await assert.rejects(inspectBackup(f.backup), {
      code: "BACKUP_HASH_MISMATCH",
    });
    await assert.rejects(stageRestore(f.backup, f.dir, hash), {
      code: "BACKUP_HASH_MISMATCH",
    });
  } finally {
    await f.cleanup();
  }
});

test("音乐缓存文件和目录均拒绝符号链接", async () => {
  const f = await setup();
  try {
    const path = join(f.backup, "music", audioFile);
    await rm(path);
    await symlink(join(f.dir, "music", audioFile), path);
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    await rm(join(f.backup, "music"), { recursive: true });
    await symlink(join(f.dir, "music"), join(f.backup, "music"), "dir");
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
  } finally {
    await f.cleanup();
  }
});

test("音乐缓存拒绝异常名称、超大文件和越界元数据引用", async () => {
  const f = await setup();
  try {
    const path = join(f.backup, "music", audioFile);
    await rename(path, `${path}.exe`);
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    await rename(`${path}.exe`, path);
    const handle = await open(path, "r+");
    try {
      await handle.truncate(20 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    await writeFile(path, bytes);
    await editBackupDatabase(f.backup, (db) =>
      db.setSetting(`music:audio:${musicId}:v1`, {
        ...audioMetadata,
        asset: { file: "../outside.mp3", mime: "audio/mpeg" },
      }),
    );
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
  } finally {
    await f.cleanup();
  }
});
