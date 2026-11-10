import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { developmentCspHtml } from "../scripts/dev-csp";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
test("开发页面允许Vite断线恢复的blob Worker，不放宽脚本来源", () => {
  const result = developmentCspHtml(html, true);
  assert.match(result, /worker-src 'self' blob:;/);
  assert.match(result, /script-src 'self' 'unsafe-inline';/);
  assert.doesNotMatch(result, /script-src[^;]*blob:|worker-src[^;]*\*/);
  assert.match(result, /connect-src 'self' ws:\/\/127\.0\.0\.1:8070;/);
});
test("生产页面完全保留原安全策略，不加入开发Worker或内联脚本权限", () => {
  assert.equal(developmentCspHtml(html, false), html);
  assert.doesNotMatch(
    developmentCspHtml(html, false),
    /worker-src|'unsafe-inline'; worker-src/,
  );
});
