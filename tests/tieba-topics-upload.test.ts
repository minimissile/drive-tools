import test from "node:test";
import assert from "node:assert/strict";
import { tiebaTopicInertUploadHref } from "../core/tieba/topic-upload";

test("local-upload href accepts literal inert JavaScript with official whitespace", () => {
  for (const value of [
    null,
    "",
    "#",
    "javascript:;",
    "javascript:void(0)",
    "javascript: void(0)",
    "javascript: void(0);",
    " JAVASCRIPT: void ( 0 ) ; ",
  ])
    assert.equal(tiebaTopicInertUploadHref(value), true, String(value));
});
test("local-upload href rejects navigation, expressions and appended JavaScript", () => {
  for (const value of [
    "https://tieba.baidu.com/f",
    "/upload",
    "#other",
    "javascript:alert(1)",
    "javascript:void(0);location.href='/paid'",
    "javascript:void(fetch('/upload'))",
    "javascript:void(1)",
    "javascript:void(0)//",
    "java script:void(0)",
    "data:text/html,test",
  ])
    assert.equal(tiebaTopicInertUploadHref(value), false, value);
});
