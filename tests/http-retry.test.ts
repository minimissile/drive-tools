import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson, retryAfterMilliseconds } from "../core/http";
import { ServiceHttpError } from "../core/errors";

test("Retry-After accepts seconds and HTTP dates, rejects malformed delays", () => {
  const at = Date.parse("2026-10-21T15:00:00Z");
  assert.equal(retryAfterMilliseconds("60", at), 60_000);
  assert.equal(
    retryAfterMilliseconds("Wed, 21 Oct 2026 15:01:00 GMT", at),
    60_000,
  );
  for (const raw of [null, "", "-1", "invalid", "99999999999999999999"])
    assert.equal(retryAfterMilliseconds(raw, at), null);
});
test("HTTP 429 retains Retry-After even when a proxy returns a non-JSON body", async (t) => {
  for (const body of [
    JSON.stringify({ error: { message: "Provider returned error" } }),
    "rate limited",
  ]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(body, { status: 429, headers: { "Retry-After": "45" } }),
    );
    await assert.rejects(
      fetchJson("https://fixture.invalid"),
      (error: unknown) => {
        assert.ok(error instanceof ServiceHttpError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 45_000);
        return true;
      },
    );
    t.mock.restoreAll();
  }
});
