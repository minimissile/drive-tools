import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectBackup } from "../core/backups";
import { fixture } from "./helpers";

const webp = [
  "UklGRh4AAABXRUJQVlA4TBEAAAAvH8AFAAfQsvq0tP+BiOh/AAA=",
  "UklGRh4AAABXRUJQVlA4TBEAAAAvH8AFAAfQxMqUrv+BiOh/AAA=",
  "UklGRh4AAABXRUJQVlA4TBEAAAAvH8AFAAdQwdZWqv+BiOh/AAA=",
];
const images = webp.map((value) => ({
  data: `data:image/webp;base64,${value}`,
}));
const ids = webp.map((value) =>
  createHash("sha256").update(Buffer.from(value, "base64")).digest("hex"),
);

test("图片资源按顺序保存、首图同步为封面，编辑与备份保留其余图片", async () => {
  let conversions = 0;
  const f = await fixture(
    {},
    {
      normalizeCover: async (bytes) => {
        conversions++;
        return bytes;
      },
    },
  );
  try {
    const saved = await f.add(false, { coverData: images[0].data });
    const get = () => f.app.repo.getResource(saved.resourceId);
    assert.deepEqual(get().imageIds, [ids[0]]);
    const edit = { id: saved.resourceId, copyId: saved.copyId };
    await f.add(false, {
      ...edit,
      images: [{ id: ids[0] }, ...images.slice(1)],
    });
    assert.deepEqual(get().imageIds, ids);
    assert.equal(get().coverId, ids[0]);
    assert.equal(conversions, 3);
    await f.add(false, { ...edit, images: [{ id: ids[2] }, { id: ids[1] }] });
    await f.add(false, { ...edit, summary: "仅编辑文字" });
    assert.deepEqual(get().imageIds, [ids[2], ids[1]]);
    assert.equal(get().coverId, ids[2]);
    assert.equal(
      await f.app.invoke("cover.get", { id: ids[1] }),
      images[1].data,
    );
    assert.equal(conversions, 3);

    f.ports.chooseDirectory = async () => f.dir;
    const backup = (await f.app.backup())!;
    assert.equal((await inspectBackup(backup)).resources, 1);
    await rm(join(backup, "covers", `${ids[1]}.webp`));
    await assert.rejects(inspectBackup(backup), /缺少资源引用的图片/);

    await f.add(false, { ...edit, images: [] });
    assert.deepEqual(get().imageIds, []);
    assert.equal(get().coverId, null);
  } finally {
    await f.cleanup();
  }
});

test("超量、损坏图片以及外部图片引用不能写入资源", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false, { images });
    const edit = { id: saved.resourceId, copyId: saved.copyId };
    await assert.rejects(
      f.add(false, { ...edit, images: [...images, images[0]] }),
      /最多保存3张/,
    );
    await assert.rejects(
      f.add(false, {
        ...edit,
        images: [images[0], { data: "data:image/png;base64,YmFk" }],
      }),
      { code: "INVALID_COVER" },
    );
    await assert.rejects(
      f.add(false, { ...edit, images: [{ id: "a".repeat(64) }] }),
      { code: "RESOURCE_IMAGE_CHANGED" },
    );
    assert.deepEqual(f.app.repo.getResource(saved.resourceId).imageIds, ids);
  } finally {
    await f.cleanup();
  }
});
