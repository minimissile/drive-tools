// Explicit paid diagnostics only. Uses the existing app's secret/budget ledger;
// never reads keys, changes default models, transfers files, or publishes.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import { devSessionRequest, devRoot } from "./dev-session-client.mjs";

export async function run({ page, windowId, checkpoint }) {
  const updates = await devSessionRequest("dev.updates");
  assert.ok(
    !updates.pending && !updates.compiling,
    "请先加载本次诊断接口，不调用旧后台",
  );
  const map = JSON.parse(
    await readFile(join(devRoot, "dist-dev/main.js.map"), "utf8"),
  );
  for (const path of [
    "core/ai.ts",
    "core/ipc/ai.ts",
    "core/ai-network.ts",
    "core/service.ts",
    "desktop/main.ts",
  ]) {
    const i = map.sources.findIndex((source) => source.endsWith("/" + path));
    assert.ok(i >= 0, `${path}未包含在已加载构建中`);
    // Formatting after compilation must not cause another backend restart.
    const [built, current] = await Promise.all([
      transform(map.sourcesContent[i], { loader: "ts", minify: true }),
      transform(await readFile(join(devRoot, path), "utf8"), {
        loader: "ts",
        minify: true,
      }),
    ]);
    assert.equal(built.code, current.code, `${path}尚未加载`);
  }
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const db = new DatabaseSync(join(snapshot.dataPath, "panxu.db"), {
    readOnly: true,
  });
  const out = `/tmp/panxu-openrouter-inference/${windowId}`;
  await mkdir(out, { recursive: true });
  const settings = () =>
    db
      .prepare(
        "SELECT key,value FROM settings WHERE key IN ('model','aiModels','dailyAiBudgetMicros') ORDER BY key",
      )
      .all();
  const before = settings();
  const calls = () =>
    db
      .prepare(
        "SELECT id,status,confirmed_micros FROM api_calls WHERE phase='connection_probe' ORDER BY created_at",
      )
      .all();
  const ids = new Set(calls().map((c) => c.id));
  const cases = JSON.parse(
    process.env.PANXU_OPENROUTER_PROBE_CASES || '[{"mode":"json-schema"}]',
  );
  assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 4);
  const results = [];
  try {
    for (const entry of cases) {
      await checkpoint();
      const previous = new Set(calls().map((c) => c.id));
      const started = Date.now();
      let result, error;
      try {
        result = await page.evaluate(
          (entry) =>
            window.panxu.invoke("ai.probe", { ...entry, authorized: true }),
          entry,
        );
      } catch (cause) {
        error = cause.message;
      }
      const billed = calls().filter((c) => !previous.has(c.id));
      const diagnostics = billed.map((call) => {
        const row = db
          .prepare("SELECT value FROM api_cache WHERE key=?")
          .get(`ai-diagnostic:${call.id}`);
        return { ...call, diagnostic: row ? JSON.parse(row.value) : null };
      });
      results.push({
        request: entry,
        result,
        error,
        elapsedMs: Date.now() - started,
        calls: diagnostics,
      });
      await writeFile(
        `${out}/report.json`,
        JSON.stringify(
          { runningRevision: updates.runningRevision, results },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(results.at(-1)));
      if (billed.some((call) => call.status === "uncertain")) break;
    }
    assert.deepEqual(settings(), before, "诊断不得改动默认模型或预算");
    return {
      out,
      runningRevision: updates.runningRevision,
      results,
      callCount: calls().filter((c) => !ids.has(c.id)).length,
      settingsUnchanged: true,
    };
  } finally {
    db.close();
  }
}
