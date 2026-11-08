import test from "node:test";
import assert from "node:assert/strict";
import { createMusicHandlers } from "../core/ipc/music";
import { queryMethods } from "../shared/ipc";
import type { MusicService } from "../core/music/service";
import { fixture } from "./helpers";

test("music IPC keeps paid operations outside local query methods and validates all commands", async () => {
  const calls: unknown[] = [];
  const music = {
    library: () => {
      calls.push("read");
      return { enabled: false };
    },
    configure: (value: unknown) => {
      calls.push(["configure", value]);
    },
    update: (value: unknown) => {
      calls.push(["update", value]);
    },
    audio: (value: unknown) => {
      calls.push(["audio", value]);
    },
  } as unknown as MusicService;
  const handlers = createMusicHandlers({ music });
  assert(queryMethods.includes("music.library"));
  assert(
    !queryMethods.some((method: string) =>
      ["music.configure", "music.update", "music.audio"].includes(method),
    ),
  );
  await handlers["music.library"]();
  await handlers["music.configure"]({ enabled: true });
  await handlers["music.update"]({});
  await handlers["music.audio"]({ id: "7136850194742315016" });
  assert.deepEqual(calls, [
    "read",
    ["configure", { enabled: true }],
    ["update", {}],
    ["audio", { id: "7136850194742315016" }],
  ]);
  const count = calls.length;
  for (const input of [{ enabled: "true" }, { enabled: true, force: true }])
    await assert.rejects(handlers["music.configure"](input));
  await assert.rejects(handlers["music.update"]({ force: true }));
  for (const id of [
    "../private",
    "https://example.com/a.mp3",
    "",
    "1".repeat(31),
  ])
    await assert.rejects(handlers["music.audio"]({ id }));
  assert.equal(calls.length, count);
});

test("music requests remain visible without entering the 5118 CNY or AI USD totals", async () => {
  const f = await fixture();
  try {
    const before = f.app.snapshot();
    for (const status of ["reserved", "success", "uncertain"])
      f.app.db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,status,created_at) VALUES(?,'tikhub:music','chart',1,?,?)",
        `music-${status}`,
        status,
        new Date().toISOString(),
      );
    const after = f.app.snapshot();
    assert.deepEqual(after.apiUsage, before.apiUsage);
    assert.equal(
      after.apiCalls.filter((call) => call.endpoint === "tikhub:music").length,
      3,
    );
    let exported = "";
    f.ports.saveFile = async (_name, bytes) => {
      exported = bytes.toString("utf8");
      return "/unused/music-ledger.csv";
    };
    await f.app.invoke("api.export");
    const rows = exported
      .split(/\r?\n/)
      .filter((row) => row.includes("tikhub:music"));
    assert.equal(rows.length, 3);
    assert(rows.every((row) => row.includes("USD") && !row.includes("CNY")));
  } finally {
    await f.cleanup();
  }
});
