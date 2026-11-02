// One explicit editorial maintenance pass using the ordinary source/review CAS.
// Preserve the already-reviewed article while refreshing its evidence snapshot.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const resourceId = "resource_332e6345-0873-4265-9d6f-4b7053a32d8c";
export async function run({ page, windowId }) {
  console.log("Evidence update window:", windowId);
  const backend = await page.evaluate(() => window.panxu.invoke("dev.status"));
  const build = await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) =>
    r.json(),
  );
  assert.equal(
    String(build.revision),
    backend.revision,
    "wait for current source backend",
  );
  const before = await page.evaluate(
    (id) => window.panxu.invoke("resourceLanding.get", { resourceId: id }),
    resourceId,
  );
  assert(before.published?.document && !before.pending && !before.generating);
  const original = before.published.document.article;
  const generated = await page.evaluate(
    (args) => window.panxu.invoke("resourceLanding.generate", args),
    { resourceId, requestId: randomUUID(), notes: before.notes },
  );
  assert(
    !generated.source.facts.some((f) => f.text.includes("shareCheckedAt")),
  );
  const saved = await page.evaluate(
    (args) => window.panxu.invoke("resourceLanding.saveDraft", args),
    {
      resourceId,
      expectedDraftVersion: generated.draftVersion,
      draft: original,
    },
  );
  const published = await page.evaluate(
    (args) => window.panxu.invoke("resourceLanding.publish", args),
    { resourceId, expectedDraftVersion: saved.draftVersion },
  );
  assert(
    !published.pending &&
      published.published.version > before.published.version,
    published.error ?? "publication did not advance",
  );
  assert.deepEqual(
    published.published.document.article,
    original,
    "preserve the curated article",
  );
  assert(
    !published.published.document.source.facts.some((f) =>
      f.text.includes("shareCheckedAt"),
    ),
  );
  return {
    pageUrl: published.pageUrl,
    publishedVersion: published.published.version,
    score: published.quality.score,
    originalArticlePreserved: true,
  };
}
