import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../core/database";
import {
  MusicService,
  musicIntervalMs,
  musicStateKey,
  stopMusicForBackup,
} from "../core/music/service";
import { parseMusicChart, parseMusicJson } from "../core/music/client";
import { musicNetworkTarget } from "../core/music/network";
import { musicAudioMaxBytes, readMusicAsset } from "../core/music/assets";

const songId = "7136850194742315016";
const secondId = "7136850194742315017";
const audioUrl =
  "https://sf1-cdn-tos.douyinstatic.com/obj/music/song.mp3?signature=private";
const audio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100)]);
const song = (id = songId, url: string | null = audioUrl) => ({
  music_info: {
    id_str: id,
    title: "安静的午后",
    author: "音乐作者",
    duration: 60,
    ...(url ? { play_url: { url_list: [url] } } : {}),
  },
  rank: 1,
});
const chart = (songs = [song()]) => ({
  code: 200,
  data: { status_code: 0, music_list: songs },
});
const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
const detail = (id = songId) => ({
  code: 200,
  data: { music_info: song(id).music_info },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function eventually(predicate: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("音乐操作未到达预期状态");
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-music-"));
  const db = new Database(join(dir, "panxu.db"));
  let clock = Date.UTC(2026, 10, 7);
  let configured = true;
  let changes = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  let request = async (url: string, _init: RequestInit): Promise<Response> =>
    url.includes("fetch_music_hot_search_list")
      ? json(chart())
      : url.includes("fetch_music_detail")
        ? json(detail())
        : new Response(audio, { headers: { "content-type": "audio/mpeg" } });
  const dependencies = {
    db,
    dataPath: dir,
    clock: () => clock,
    secrets: {
      has: () => configured,
      get: async () => (configured ? "test-not-real-key" : null),
    },
    changed: () => {
      changes++;
    },
    request: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return request(url, init);
    },
  };
  let service = new MusicService(dependencies);
  return {
    dir,
    db,
    calls,
    get service() {
      return service;
    },
    get changes() {
      return changes;
    },
    advance(ms: number) {
      clock += ms;
    },
    configured(value: boolean) {
      configured = value;
    },
    useRequest(value: typeof request) {
      request = value;
    },
    reopen() {
      service.close();
      service = new MusicService(dependencies);
    },
    async cleanup() {
      service.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("music preserves 19-digit IDs and rejects unknown/non-success response shapes", () => {
  const parsed = parseMusicJson(
    `{"code":200,"data":{"music_list":[{"id":${songId},"title":"曲目"}]}}`,
  );
  assert.equal(parseMusicChart(parsed)[0].id, songId);
  assert.throws(() => parseMusicChart({ code: 200, data: null }), /结构/);
  assert.throws(
    () =>
      parseMusicChart({ code: 200, data: { status_code: 1, music_list: [] } }),
    /未返回/,
  );
  assert.throws(
    () => parseMusicChart({ code: 200, data: { items: [] } }),
    /结构/,
  );
  assert.throws(
    () =>
      parseMusicChart({
        code: 200,
        data: { music_list: [{ title: "缺少ID" }] },
      }),
    /有效歌曲/,
  );
});

test("library reads are local; shared Key, normalized tracks and independent ledger", async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.service.library().tracks, []);
    assert.equal(s.service.library().enabled, false);
    assert.equal(s.calls.length, 0);
    const state = await s.service.update();
    assert.equal(state.tracks[0].id, songId);
    assert.equal(state.tracks[0].audioCached, false);
    assert.equal(JSON.stringify(state).includes("signature"), false);
    assert.equal(
      new Headers(s.calls[0].init.headers).get("authorization"),
      "Bearer test-not-real-key",
    );
    assert.equal(s.calls[0].init.credentials, "omit");
    assert.equal(s.calls[0].init.redirect, "error");
    const record = s.db.get<{ endpoint: string; status: string }>(
      "SELECT endpoint,status FROM api_calls",
    );
    assert.deepEqual(
      { ...record },
      { endpoint: "tikhub:music", status: "success" },
    );
    assert.equal(
      s.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:pipix'",
      )?.n,
      0,
    );
  } finally {
    await s.cleanup();
  }
});

test("one chart request per seven days survives restart; successful retry cannot force another", async () => {
  const s = await setup();
  try {
    const first = await s.service.update();
    s.advance(musicIntervalMs - 1);
    await s.service.update({ retry: true });
    s.reopen();
    await s.service.update();
    assert.equal(s.calls.length, 1);
    assert.equal(s.service.library().updatedAt, first.updatedAt);
    s.advance(1);
    await s.service.update();
    assert.equal(s.calls.length, 2);
  } finally {
    await s.cleanup();
  }
});

test("concurrent chart and audio calls coalesce across callers", async () => {
  const s = await setup();
  const gate = deferred<Response>();
  try {
    s.useRequest(async () => gate.promise);
    const a = s.service.update(),
      b = s.service.update();
    assert.equal(a, b);
    await eventually(() => s.calls.length === 1);
    assert.equal(s.service.library().updating, true);
    gate.resolve(json(chart()));
    await Promise.all([a, b]);
    const audioGate = deferred<Response>();
    s.useRequest(async () => audioGate.promise);
    const x = s.service.audio({ id: songId }),
      y = s.service.audio({ id: songId });
    assert.equal(x, y);
    await eventually(() => s.calls.length === 2);
    audioGate.resolve(new Response(audio));
    await Promise.all([x, y]);
    assert.equal(s.calls.length, 2);
  } finally {
    await s.cleanup();
  }
});

test("failed weekly update preserves old results and waits a week unless explicitly retried", async () => {
  const s = await setup();
  try {
    await s.service.update();
    s.advance(musicIntervalMs);
    s.useRequest(async () => json({ code: 200, data: null }));
    await assert.rejects(s.service.update(), /结构/);
    assert.equal(s.service.library().tracks.length, 1);
    const failedAt = s.service.library().lastAttemptAt;
    await s.service.update();
    s.reopen();
    await s.service.update();
    assert.equal(s.calls.length, 2);
    assert.equal(s.service.library().lastAttemptAt, failedAt);
    s.useRequest(async () => json(chart([song(secondId)])));
    await s.service.update({ retry: true });
    assert.equal(s.calls.length, 3);
    assert.equal(s.service.library().tracks[0].id, secondId);
    assert.equal(s.service.library().error, null);
  } finally {
    await s.cleanup();
  }
});

test("enable schedules one due update; disable retains cache and suppresses scheduled spending", async () => {
  const s = await setup();
  try {
    const state = await s.service.configure({ enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.calls.length, 1);
    assert.equal(state.enabled, true);
    assert.equal(
      Date.parse(state.nextUpdateAt!) - Date.parse(state.lastAttemptAt!),
      musicIntervalMs,
    );
    await s.service.configure({ enabled: false });
    s.advance(musicIntervalMs);
    s.service.start(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.calls.length, 1);
    assert.equal(s.service.library().tracks.length, 1);
    await s.service.configure({ enabled: true });
    assert.equal(s.calls.length, 2);
    stopMusicForBackup(s.db);
    assert.equal(s.service.library().enabled, false);
    assert.equal(s.service.library().tracks.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("audio URL in chart downloads once, survives restart and never sends Key to CDN", async () => {
  const s = await setup();
  try {
    await s.service.update();
    const result = await s.service.audio({ id: songId });
    assert.equal(
      result.src,
      `data:audio/mpeg;base64,${audio.toString("base64")}`,
    );
    assert.equal(s.calls.length, 2);
    assert.equal(
      new Headers(s.calls[1].init.headers).has("authorization"),
      false,
    );
    assert.equal(s.service.library().tracks[0].audioCached, true);
    s.reopen();
    assert.equal((await s.service.audio({ id: songId })).src, result.src);
    assert.equal(s.calls.length, 2);
    // A weekly chart replacing the song does not discard its downloaded asset.
    s.advance(musicIntervalMs);
    s.useRequest(async () => json(chart([song(secondId)])));
    await s.service.update();
    assert.equal((await s.service.audio({ id: songId })).src, result.src);
    assert.equal(s.calls.length, 3);
  } finally {
    await s.cleanup();
  }
});

test("missing chart URL fetches detail only once and caches raw response before indexing", async () => {
  const s = await setup();
  try {
    s.useRequest(async (url) =>
      url.includes("hot_search")
        ? json(chart([song(songId, null)]))
        : url.includes("fetch_music_detail")
          ? json(detail())
          : new Response(audio),
    );
    await s.service.update();
    await s.service.audio({ id: songId });
    await s.service.audio({ id: songId });
    assert.equal(s.calls.length, 3);
    assert.ok(s.db.setting(`music:raw:detail:${songId}:v1`, null));
    assert.equal(
      s.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:music'",
      )?.n,
      2,
    );
  } finally {
    await s.cleanup();
  }
});

test("different songs publishing identical audio concurrently share one complete asset", async () => {
  const s = await setup();
  const largerAudio = Buffer.concat([
    Buffer.from("ID3"),
    Buffer.alloc(2 * 1024 * 1024),
  ]);
  try {
    s.useRequest(async (url) =>
      url.includes("hot_search")
        ? json(chart([song(), song(secondId)]))
        : new Response(largerAudio),
    );
    await s.service.update();
    const results = await Promise.all([
      s.service.audio({ id: songId }),
      s.service.audio({ id: secondId }),
    ]);
    assert.equal(results[0].src, results[1].src);
    assert.equal(s.calls.length, 3);
    const files = await readdir(join(s.dir, "music"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.mp3$/);
    assert.equal(
      s.service.library().tracks.every((track) => track.audioCached),
      true,
    );
  } finally {
    await s.cleanup();
  }
});

test("valid archived detail recovers audio metadata locally before spending another request", async () => {
  const s = await setup();
  try {
    s.useRequest(async (url) =>
      url.includes("hot_search")
        ? json(chart([song(songId, null)]))
        : new Response(audio),
    );
    await s.service.update();
    const at = s.service.library().lastAttemptAt;
    s.db.setSetting(`music:raw:detail:${songId}:v1`, {
      at,
      status: 200,
      body: JSON.stringify(detail()),
    });
    // An interrupted operation keeps a negative cache and still needs explicit retry.
    s.db.setSetting(`music:audio:${songId}:v1`, {
      track: {
        id: songId,
        title: "安静的午后",
        author: "音乐作者",
        rank: 1,
        audioUrls: [],
      },
      lastAttemptAt: at,
      error: "上次配乐获取未完成，请显式重试。",
    });
    await s.service.audio({ id: songId, retry: true });
    assert.equal(s.calls.length, 2);
    assert.equal(
      s.db.get<{ n: number }>("SELECT COUNT(*) n FROM api_calls")?.n,
      1,
    );
  } finally {
    await s.cleanup();
  }
});

test("audio failure is retained across restart and requires explicit retry; HTML is never cached", async () => {
  const s = await setup();
  try {
    await s.service.update();
    s.useRequest(
      async () =>
        new Response("<!doctype html><html>not audio</html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    await assert.rejects(s.service.audio({ id: songId }), /不是支持的音频/);
    s.reopen();
    await assert.rejects(s.service.audio({ id: songId }), /不是支持的音频/);
    assert.equal(s.calls.length, 2);
    s.useRequest(async (url) =>
      url.includes("fetch_music_detail") ? json(detail()) : new Response(audio),
    );
    await s.service.audio({ id: songId, retry: true });
    assert.equal(s.calls.length, 4);
    assert.equal(s.service.library().tracks[0].audioCached, true);
  } finally {
    await s.cleanup();
  }
});

test("network failure remains uncertain, archives do not leak Key, and reindexing is local", async () => {
  const s = await setup();
  try {
    s.useRequest(async () => {
      throw new Error(`network ${audioUrl} test-not-real-key`);
    });
    await assert.rejects(
      s.service.update(),
      (error: Error) =>
        !error.message.includes("test-not-real-key") &&
        !error.message.includes("signature"),
    );
    assert.equal(
      s.db.get<{ status: string }>("SELECT status FROM api_calls")?.status,
      "uncertain",
    );
    const at = s.service.library().lastAttemptAt;
    s.db.setSetting("music:raw:chart:v1", {
      at,
      status: 200,
      body: JSON.stringify(chart()),
    });
    s.reopen();
    assert.equal(s.service.library().error, null);
    assert.equal(s.service.library().tracks.length, 1);
    await s.service.update();
    assert.equal(s.calls.length, 1);
    assert.equal(s.service.library().lastAttemptAt, at);
  } finally {
    await s.cleanup();
  }
});

test("close aborts pending requests, marks uncertainty and avoids writing a closed DB", async () => {
  const s = await setup();
  const gate = deferred<Response>();
  s.useRequest(async () => gate.promise);
  const operation = s.service.update();
  await eventually(() => s.calls.length === 1);
  assert.equal(s.service.isBusy, true);
  s.service.close();
  assert.equal(
    s.db.get<{ status: string }>("SELECT status FROM api_calls")?.status,
    "uncertain",
  );
  assert.equal(s.calls[0].init.signal?.aborted, true);
  s.db.close();
  gate.resolve(json(chart()));
  await assert.rejects(operation, /音乐库已关闭/);
  await rm(s.dir, { recursive: true, force: true });
});

test("music URL boundary rejects arbitrary/private hosts, credentials, redirects and oversized bodies", async () => {
  for (const url of [
    "http://p3.douyincdn.com/a",
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://p3.douyincdn.com.attacker.test/a",
    "https://user:pass@p3.douyincdn.com/a",
    "https://p3.douyincdn.com:444/a",
    "https://api.tikhub.io/api/v1/other",
    "https://[::1]/a",
  ]) {
    assert.throws(() => musicNetworkTarget(url), /来源/);
  }
  assert.throws(() => musicNetworkTarget(audioUrl, "POST"), /来源/);
  const s = await setup();
  try {
    await s.service.update();
    s.useRequest(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/a" },
        }),
    );
    await assert.rejects(s.service.audio({ id: songId }), /HTTP 302/);
    // A stream's declared length is bounded before its body is read.
    s.advance(musicIntervalMs);
    s.useRequest(
      async () =>
        new Response(audio, {
          headers: { "content-length": String(musicAudioMaxBytes + 1) },
        }),
    );
    await assert.rejects(s.service.audio({ id: songId }), /过大/);
  } finally {
    await s.cleanup();
  }
});

test("cached audio rejects content changes and symlinks without silently issuing paid requests", async () => {
  const s = await setup();
  try {
    await s.service.update();
    await s.service.audio({ id: songId });
    const stored = s.db.setting<{ asset: { file: string; mime: string } }>(
      `music:audio:${songId}:v1`,
      null!,
    );
    const path = join(s.dir, "music", stored.asset.file);
    await writeFile(path, Buffer.from("ID3tampered audio contents"));
    await assert.rejects(s.service.audio({ id: songId }), /缓存/);
    assert.equal(s.calls.length, 2);
    await rm(path);
    const outside = join(s.dir, "outside.mp3");
    await writeFile(outside, audio);
    await symlink(outside, path);
    await assert.rejects(readMusicAsset(s.dir, stored.asset), /缓存/);
    await assert.rejects(
      readMusicAsset(s.dir, { file: "../outside.mp3", mime: "audio/mpeg" }),
      /缓存/,
    );
    const hash = createHash("sha256").update(audio).digest("hex");
    assert.equal(stored.asset.file, `${hash}.mp3`);
    await rm(join(s.dir, "music"), { recursive: true });
    await mkdir(join(s.dir, "outside-dir"));
    await symlink(join(s.dir, "outside-dir"), join(s.dir, "music"));
    await assert.rejects(readMusicAsset(s.dir, stored.asset), /缓存/);
  } finally {
    await s.cleanup();
  }
});
