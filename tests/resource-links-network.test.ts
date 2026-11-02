import test from "node:test";
import assert from "node:assert/strict";
import { resourceLinksTarget } from "../desktop/resource-links-network";
test("desktop network accepts only the fixed-link and landing-page admin routes", () => {
  for (const path of [
    "/api/connection",
    "/api/links/link-1234",
    "/api/pages/link-1234",
  ])
    assert.equal(
      resourceLinksTarget(`https://panxu.site${path}`, "GET").pathname,
      path,
    );
  assert.equal(
    resourceLinksTarget("https://panxu.site/api/pages/link-1234", "PUT")
      .pathname,
    "/api/pages/link-1234",
  );
  for (const [url, method] of [
    ["http://panxu.site/api/pages/link-1234", "GET"],
    ["https://user:pass@panxu.site/api/pages/link-1234", "GET"],
    ["https://panxu.site/api/pages/link-1234?token=bad", "GET"],
    ["https://panxu.site/api/pages/link-1234#bad", "GET"],
    ["https://panxu.site/api/pages/short", "GET"],
    ["https://panxu.site/api/pages/link-1234", "DELETE"],
    ["https://panxu.site/api/connection", "PUT"],
    ["https://panxu.site/api/pages/link-1234/file", "GET"],
    ["https://panxu.site/unrelated", "PUT"],
  ])
    assert.throws(() => resourceLinksTarget(url, method), {
      code: "RESOURCE_LINK_REQUEST_BLOCKED",
    });
});
