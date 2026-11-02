import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const resourceId = "resource_332e6345-0873-4265-9d6f-4b7053a32d8c";
export async function run({ page, windowId }) {
  console.log("Reading window:", windowId);
  const backend = await page.evaluate(() => window.panxu.invoke("dev.status"));
  const build = await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) =>
    r.json(),
  );
  assert.equal(
    backend.revision,
    String(build.revision),
    "Wait for current source backend restart",
  );
  const context = await page.evaluate(
    (resourceId) =>
      window.panxu.invoke("resourceLanding.readDocument", {
        resourceId,
        fileEvidenceId: "file-1",
      }),
    resourceId,
  );
  assert(context.source.documents?.length);
  await writeFile(
    "/private/tmp/panxu-seo-qa/reading.json",
    JSON.stringify(context.source, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        documents: context.source.documents,
        facts: context.source.facts
          .filter((f) => f.id.startsWith("doc-"))
          .slice(0, 10),
      },
      null,
      2,
    ),
  );
}
