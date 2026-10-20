import test from "node:test";
import assert from "node:assert/strict";
import { fixture, TestProvider, removeV13, currentSchemaVersion } from "./helpers";
import type { Account, RemoteFile } from "../shared/types";
import type { InsertionMaterial, InsertionRun } from "../shared/insertion";
import type { UploadAsset } from "../core/providers/small-upload";
import { Database, now } from "../core/database";
import { DatabaseSync } from "node:sqlite";
import { InsertionService } from "../core/insertion";
class InsertProvider extends TestProvider {
  folders = new Map<string, RemoteFile[]>([
    [
      "0",
      [
        {
          id: "a",
          name: "资料A",
          isDirectory: true,
          parentId: "0",
          size: null,
        },
        {
          id: "b",
          name: "资料B",
          isDirectory: true,
          parentId: "0",
          size: null,
        },
      ],
    ],
    ["a", []],
    ["b", []],
  ]);
  writes = 0;
  failAfterWrite = false;
  gate: Promise<void> | undefined;
  async list(_a?: Account, parent = "0") {
    return this.folders.get(parent) ?? [];
  }
  async ensureFolder(_a?: Account, path = "/") {
    this.writes++;
    await this.gate;
    const segments = path.split("/").filter(Boolean),
      parent = segments[0] === "资料A" ? "a" : "b",
      name = segments.at(-1)!;
    const f = {
      id: `folder-${this.writes}`,
      name,
      isDirectory: true,
      parentId: parent,
      size: null,
    };
    this.folders.get(parent)!.push(f);
    if (this.failAfterWrite) throw Error("connection lost after commit");
    return f.id;
  }
  async upload(_a: Account, parent: string, asset: UploadAsset) {
    this.writes++;
    await this.gate;
    this.folders
      .get(parent)!
      .push({
        id: `file-${this.writes}`,
        name: asset.name,
        isDirectory: false,
        parentId: parent,
        size: asset.bytes.length,
      });
    if (this.failAfterWrite) throw Error("connection lost after commit");
  }
}
async function setup() {
  const p = new InsertProvider(),
    f = await fixture({ quark: p });
  const targets = [
    { accountId: f.account.id, folderId: "a", path: "/资料A" },
    { accountId: f.account.id, folderId: "b", path: "/资料B" },
  ];
  const material = (await f.app.invoke("insertion.addMaterial", {
    kind: "folder",
    name: "更多资料见说明",
  })) as InsertionMaterial;
  return { ...f, p, targets, material };
}
async function settled(f: Awaited<ReturnType<typeof setup>>, id: string) {
  for (let n = 0; n < 200 && f.app.insertion.isBusy; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.app.insertion.isBusy, false);
  return f.app.insertion.get(id);
}
test("insertion is preview-only until explicitly confirmed, and deduplicates target directories", async () => {
  const f = await setup();
  try {
    const r = await f.app.insertion.preview(
      [...f.targets, f.targets[0]],
      [f.material.id],
    );
    assert.equal(r.items.length, 2);
    assert.equal(f.p.writes, 0);
    await assert.rejects(
      f.app.invoke("insertion.start", { id: r.id, confirmed: false }),
    );
    await f.app.invoke("insertion.start", { id: r.id, confirmed: true });
    await assert.rejects(
      f.app.invoke("insertion.start", { id: r.id, confirmed: true }),
      { code: "ALREADY_STARTED" },
    );
    const done = await settled(f, r.id);
    assert.deepEqual(
      done.items.map((i) => i.state),
      ["success", "success"],
    );
    assert.equal(f.p.writes, 2);
  } finally {
    await f.cleanup();
  }
});
test("same-name files and folders are skipped both at preview and just before execution", async () => {
  const f = await setup();
  try {
    f.p.folders
      .get("a")!
      .push({
        id: "old",
        name: f.material.name,
        isDirectory: false,
        parentId: "a",
        size: 3,
      });
    const r = await f.app.insertion.preview(f.targets, [f.material.id]);
    assert.equal(r.items[0].state, "skipped");
    f.p.folders
      .get("b")!
      .push({
        id: "race",
        name: f.material.name,
        isDirectory: true,
        parentId: "b",
        size: null,
      });
    f.app.insertion.start(r.id);
    const done = await settled(f, r.id);
    assert.deepEqual(
      done.items.map((i) => i.state),
      ["skipped", "skipped"],
    );
    assert.equal(f.p.writes, 0);
  } finally {
    await f.cleanup();
  }
});
test("TXT and image materials persist locally and are uploaded to each selected target", async () => {
  const f = await setup();
  try {
    const txt = (await f.app.invoke("insertion.addMaterial", {
      kind: "txt",
      name: "说明.txt",
      text: "资料使用说明",
    })) as InsertionMaterial;
    const img = (await f.app.invoke("insertion.addMaterial", {
      kind: "image",
      name: "海报.png",
      mime: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP/QAAAAASUVORK5CYII=",
    })) as InsertionMaterial;
    assert.equal(txt.size, Buffer.byteLength("资料使用说明"));
    const r = await f.app.insertion.preview(f.targets, [txt.id, img.id]);
    f.app.insertion.start(r.id);
    const done = await settled(f, r.id);
    assert.equal(done.items.filter((i) => i.state === "success").length, 4);
    assert.equal(f.p.writes, 4);
    assert.equal(f.app.insertion.materials().length, 3);
  } finally {
    await f.cleanup();
  }
});
test("unknown writes are never replayed; read-only recheck can resolve a created folder", async () => {
  const f = await setup();
  try {
    f.p.failAfterWrite = true;
    const r = await f.app.insertion.preview([f.targets[0]], [f.material.id]);
    f.app.insertion.start(r.id);
    const done = await settled(f, r.id);
    assert.equal(done.items[0].state, "uncertain");
    assert.equal(f.p.writes, 1);
    const checked = await f.app.insertion.recheck(r.id);
    assert.equal(checked.items[0].state, "success");
    assert.equal(f.p.writes, 1);
  } finally {
    await f.cleanup();
  }
});
test("file recheck does not infer byte integrity from name and size after a response loss", async () => {
  const f = await setup();
  try {
    const txt = f.app.insertion.addMaterial({
      kind: "txt",
      name: "说明.txt",
      text: "本人资料",
    });
    f.p.failAfterWrite = true;
    const r = await f.app.insertion.preview([f.targets[0]], [txt.id]);
    f.app.insertion.start(r.id);
    await settled(f, r.id);
    const checked = await f.app.insertion.recheck(r.id);
    assert.equal(checked.items[0].state, "uncertain");
    assert.equal(f.p.writes, 1);
  } finally {
    await f.cleanup();
  }
});
test("cancel preserves the in-flight result, stops subsequent targets, and blocks account changes", async () => {
  const f = await setup();
  let release = () => {};
  try {
    f.p.gate = new Promise<void>((resolve) => (release = resolve));
    const r = await f.app.insertion.preview(f.targets, [f.material.id]);
    f.app.insertion.start(r.id);
    for (let i = 0; i < 100 && !f.p.writes; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.p.writes, 1);
    await assert.rejects(f.app.invoke("account.clear", { id: f.account.id }), {
      code: "ACTIVE_JOBS",
    });
    f.app.insertion.cancel(r.id);
    release();
    const done = await settled(f, r.id);
    assert.deepEqual(
      done.items.map((i) => i.state),
      ["success", "cancelled"],
    );
    assert.equal(done.state, "cancelled");
    assert.equal(f.p.writes, 1);
  } finally {
    release();
    await f.cleanup();
  }
});
test("directory ID/path mismatch, root, traversal, and duplicate names fail without writes", async () => {
  const f = await setup();
  try {
    for (const target of [
      { ...f.targets[0], folderId: "wrong" },
      { ...f.targets[0], path: "/" },
      { ...f.targets[0], path: "/资料A/../资料B" },
    ])
      await assert.rejects(f.app.insertion.preview([target], [f.material.id]));
    const same = f.app.insertion.addMaterial({
      kind: "txt",
      name: f.material.name + ".txt",
      text: "a",
    });
    const same2 = f.app.insertion.addMaterial({
      kind: "txt",
      name: same.name,
      text: "b",
    });
    await assert.rejects(
      f.app.insertion.preview(f.targets, [same.id, same2.id]),
      { code: "DUPLICATE_NAME" },
    );
    assert.equal(f.p.writes, 0);
  } finally {
    await f.cleanup();
  }
});
test("UID changes block writes and concurrent batches cannot use the same account", async () => {
  const f = await setup();
  try {
    const r = await f.app.insertion.preview(f.targets, [f.material.id]);
    f.p.uid = "other-user";
    f.app.insertion.start(r.id);
    const done = await settled(f, r.id);
    assert.ok(done.items.every((i) => i.state === "failed"));
    assert.equal(f.p.writes, 0);
    f.p.uid = "owner-1";
    const a = await f.app.insertion.preview(f.targets, [f.material.id]),
      b = await f.app.insertion.preview(f.targets, [f.material.id]);
    f.app.insertion.start(a.id);
    assert.throws(() => f.app.insertion.start(b.id), { code: "ACTIVE_JOBS" });
    await settled(f, a.id);
  } finally {
    await f.cleanup();
  }
});
test("unsafe names and file types, oversized UTF-8 TXT, and missing consent are rejected", async () => {
  const f = await setup();
  try {
    for (const name of ["../逃逸", "a/b", "a\\b", ".", "..", "abc.", "x\nz"])
      assert.throws(() =>
        f.app.insertion.addMaterial({ kind: "folder", name }),
      );
    assert.throws(() =>
      f.app.insertion.addMaterial({
        kind: "image",
        name: "x.png",
        mime: "image/png",
        base64: Buffer.from("not image").toString("base64"),
      }),
    );
    assert.throws(
      () =>
        f.app.insertion.addMaterial({
          kind: "txt",
          name: "说明.txt",
          text: "中".repeat(200000),
        }),
      { code: "FILE_TOO_LARGE" },
    );
    const r = await f.app.insertion.preview(f.targets, [f.material.id]);
    await assert.rejects(f.app.invoke("insertion.start", { id: r.id }));
    assert.equal(f.p.writes, 0);
  } finally {
    await f.cleanup();
  }
});
test("insertion invalidates cached share verification before writing and records the new manifest", async () => {
  const f = await setup();
  try {
    const saved = await f.add(false);
    f.app.db.run(
      "UPDATE copies SET directory=?,folder_id=?,verified_at=?,owner_uid=?,share_verified_at=?,share_version=3 WHERE id=?",
      "/资料A",
      "a",
      now(),
      "owner-1",
      now(),
      saved.copyId,
    );
    const r = await f.app.insertion.preview([f.targets[0]], [f.material.id]);
    f.app.insertion.start(r.id);
    await settled(f, r.id);
    const copy = f.app.repo.getCopy(saved.copyId);
    assert.equal(copy.shareVerifiedAt, null);
    assert.equal(copy.shareVersion, 4);
    assert.equal(copy.files[0].name, f.material.name);
  } finally {
    await f.cleanup();
  }
});
test("restart marks in-flight writes uncertain, cancels pending work and never resumes automatically", async () => {
  const f = await setup();
  try {
    const r = await f.app.insertion.preview(f.targets, [f.material.id]);
    r.state = "running";
    r.items[0].state = "writing";
    f.app.db.run(
      "UPDATE insertion_runs SET data=? WHERE id=?",
      JSON.stringify(r),
      r.id,
    );
    const restored = new InsertionService(
      f.app.db,
      f.app.repo,
      (id, fn) => f.app.authenticated(id, fn),
      () => {},
      () => {},
    );
    const loaded = restored.get(r.id);
    assert.equal(loaded.state, "interrupted");
    assert.deepEqual(
      loaded.items.map((i) => i.state),
      ["uncertain", "cancelled"],
    );
    assert.equal(f.p.writes, 0);
  } finally {
    await f.cleanup();
  }
});
test("v12 migration is additive and keeps a single pre-v13 snapshot", async () => {
  const f = await setup(),
    path = f.dir + "/legacy.db";
  try {
    f.app.db.run("VACUUM INTO ?", path);
    const raw = new DatabaseSync(path);
    raw.exec(removeV13 + "PRAGMA user_version=12;");
    raw.close();
    const db = new Database(path);
    assert.equal(db.get<any>("PRAGMA user_version").user_version, currentSchemaVersion);
    assert.equal(db.all("SELECT * FROM insertion_runs").length, 0);
    assert.ok(db.get("SELECT id FROM accounts WHERE id=?", f.account.id));
    db.close();
  } finally {
    await f.cleanup();
  }
});
