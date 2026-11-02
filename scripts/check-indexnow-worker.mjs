// Isolated D1 integration; injected transport is scoped to IndexNow only.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import {
  flushIndexNow,
  indexNowKeyResponse,
} from "../cloudflare/resource-links/src/indexnow.ts";
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require(
  resolve(process.argv[2], "miniflare"),
);
let workerPayload;
const bundle = await build({ stdin: { contents: `import { flushIndexNow } from './cloudflare/resource-links/src/indexnow.ts'; export default {async fetch(request,env){await flushIndexNow(env); return new Response('done')}}`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const options = {
  workers: [
    {
      name: "indexnow-test",
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-30",
      d1Databases: { DB: "indexnow-test" },
      bindings: { PUBLIC_ORIGIN: "https://panxu.site", INDEXNOW_KEY: "isolated-indexnow-key-12345678" },
      outboundService: async (request) => { workerPayload = await request.json(); return new Response('', {status:202}); },
    },
  ],
};
const mf = new Miniflare(
  convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options,
);
let checks = 0;
const check = (value, label) => {
  assert(value, label);
  checks++;
};
try {
  const DB = await mf.getD1Database("DB");
  for (const file of [
    "0001_resource_links.sql",
    "0002_resource_pages.sql",
    "0003_indexnow.sql",
  ]) {
    const sql = await readFile(
      `cloudflare/resource-links/migrations/${file}`,
      "utf8",
    );
    let buffer = "";
    for (const line of sql.split("\n")) {
      buffer += line + "\n";
      if (
        (!/CREATE TRIGGER/i.test(buffer) && /;\s*$/.test(line)) ||
        (/CREATE TRIGGER/i.test(buffer) && /^END;/.test(line.trim()))
      ) {
        await DB.prepare(buffer).run();
        buffer = "";
      }
    }
  }
  const env = {
    DB,
    PUBLIC_ORIGIN: "https://panxu.site",
    INDEXNOW_KEY: "isolated-indexnow-key-12345678",
  };
  const keyRequest = new Request(
    "https://panxu.site/isolated-indexnow-key-12345678.txt",
  );
  check(
    (await indexNowKeyResponse(keyRequest, env).text()) === env.INDEXNOW_KEY,
    "same-origin key file exact UTF8",
  );
  check(
    indexNowKeyResponse(
      new Request("https://alias.pages.dev/isolated-indexnow-key-12345678.txt"),
      env,
    ) === null,
    "key not served on aliases",
  );
  check(
    indexNowKeyResponse(new Request(keyRequest.url, { method: "POST" }), env)
      .status === 405,
    "key write prohibited",
  );
  check(
    (await indexNowKeyResponse(
      new Request(keyRequest.url, { method: "HEAD" }),
      env,
    ).text()) === "",
    "HEAD empty",
  );
  await DB.prepare(
    `INSERT INTO resource_links VALUES('link-fixture','testSlug123','测试资源','quark','https://pan.quark.cn/s/test','SECRET-CODE',1,1,'op-1','2026-11-02','{}')`,
  ).run();
  await DB.prepare(
    `INSERT INTO resource_pages VALUES('link-fixture','{}','测试资源','学习资料','hash',92,1,'page-op-1','2026-11-02','2026-11-02','{}')`,
  ).run();
  check(
    (
      await DB.prepare(
        "SELECT count(*) n FROM indexnow_submissions WHERE path='/r/testSlug123' AND status='pending'",
      ).first()
    ).n === 1,
    "committed publish queues page",
  );
  let sent;
  await flushIndexNow(env, async (url, init) => {
    assert.equal(url, "https://api.indexnow.org/indexnow");
    sent = JSON.parse(init.body);
    return new Response("", { status: 429 });
  });
  check(
    sent.host === "panxu.site" &&
      sent.urlList.includes("https://panxu.site/r/testSlug123"),
    "canonical URLs pushed",
  );
  check(
    !JSON.stringify(sent).includes("SECRET-CODE") &&
      !JSON.stringify(sent).includes("quark.cn"),
    "no drive links or codes submitted",
  );
  const failed = await DB.prepare(
    "SELECT * FROM indexnow_submissions WHERE path='/r/testSlug123'",
  ).first();
  check(
    failed.status === "pending" &&
      failed.attempts === 1 &&
      failed.http_status === 429 &&
      failed.next_attempt_at > Date.now(),
    "failure retained with backoff",
  );
  let calls = 0;
  await flushIndexNow(env, async () => {
    calls++;
    return new Response();
  });
  check(calls === 0, "backoff prevents hot retries");
  await DB.prepare("UPDATE indexnow_submissions SET next_attempt_at=0").run();
  await flushIndexNow(env, async () => {
    await DB.prepare(
      "UPDATE indexnow_submissions SET revision=revision+1 WHERE path='/r/testSlug123'",
    ).run();
    return new Response("", { status: 202 });
  });
  check(
    (
      await DB.prepare(
        "SELECT status FROM indexnow_submissions WHERE path='/r/testSlug123'",
      ).first()
    ).status === "pending",
    "concurrent newer revision retained",
  );
  await flushIndexNow(env, async () => new Response("", { status: 200 }));
  const accepted = await DB.prepare(
    "SELECT * FROM indexnow_submissions WHERE path='/r/testSlug123'",
  ).first();
  check(
    accepted.status === "submitted" &&
      accepted.http_status === 200 &&
      accepted.submitted_at,
    "acceptance receipt persisted",
  );
  await DB.prepare(
    "UPDATE resource_pages SET document_json=NULL,version=2,last_operation_id='page-op-2' WHERE link_id='link-fixture'",
  ).run();
  check(
    (
      await DB.prepare(
        "SELECT status FROM indexnow_submissions WHERE path='/r/testSlug123'",
      ).first()
    ).status === "pending",
    "withdrawal queues same canonical URL",
  );
  await flushIndexNow(env, async () => new Response("", { status: 200 }));
  await DB.prepare(
    "UPDATE resource_pages SET document_json='{}',version=3,last_operation_id='page-op-3' WHERE link_id='link-fixture'",
  ).run();
  await flushIndexNow(env, async () => new Response("", { status: 200 }));
  await DB.prepare(
    "UPDATE resource_links SET enabled=0,revision=2,last_operation_id='op-2' WHERE id='link-fixture'",
  ).run();
  check(
    (
      await DB.prepare(
        "SELECT status FROM indexnow_submissions WHERE path='/r/testSlug123'",
      ).first()
    ).status === "pending",
    "disable notifies removal",
  );
  await DB.prepare("UPDATE indexnow_submissions SET next_attempt_at=0").run();
  await flushIndexNow(env, async () => {
    throw new Error("network");
  });
  check(
    (
      await DB.prepare(
        "SELECT status FROM indexnow_submissions WHERE path='/r/testSlug123'",
      ).first()
    ).status === "pending",
    "network failure recoverable",
  );
  await DB.prepare("UPDATE indexnow_submissions SET next_attempt_at=0").run();
  check((await mf.dispatchFetch('https://isolated.test/flush')).status === 200, 'production default fetch executes inside workerd');
  check(workerPayload?.host === 'panxu.site', 'workerd sends the real protocol body through scoped outbound service');
  const runtimeReceipt = await DB.prepare("SELECT status,http_status FROM indexnow_submissions WHERE path='/r/testSlug123'").first();
  check(runtimeReceipt.status === 'submitted' && runtimeReceipt.http_status === 202, 'workerd transport accepts and records IndexNow 202');
  console.log(
    `IndexNow: ${checks} checks passed; no external submissions made.`,
  );
} finally {
  await mf.dispose();
}
