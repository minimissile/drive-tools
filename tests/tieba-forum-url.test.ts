import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeTiebaForumUrlName,
  tiebaForumInputName,
} from "../shared/tieba-forums";
import { tiebaForumNameFromUrl } from "../core/tieba/autocare-page";
const gbk = "/f?kw=%B5%E7%D7%D3%CA%E9%D7%CA%D4%B4";
test("official legacy GBK keyword is decoded once by both passive links and pasted UI links", () => {
  assert.equal(
    decodeTiebaForumUrlName(gbk, { allowRelative: true }),
    "电子书资源",
  );
  assert.equal(tiebaForumNameFromUrl(gbk), "电子书资源");
  assert.equal(
    tiebaForumInputName("https://tieba.baidu.com" + gbk),
    "电子书资源",
  );
  assert.equal(
    tiebaForumInputName(
      "https://tieba.baidu.com/f?kw=%E7%94%B5%E5%AD%90%E4%B9%A6%E8%B5%84%E6%BA%90&ie=utf-8",
    ),
    "电子书资源",
  );
  assert.equal(tiebaForumNameFromUrl("/f?kw=C%2B%2B"), "C++");
  assert.equal(
    decodeTiebaForumUrlName(gbk),
    null,
    "relative links require a passive-read opt-in",
  );
});
test("invalid bytes, replacement characters, duplicate keywords and explicitly broken UTF8 fail closed", () => {
  for (const value of [
    "/f?kw",
    "/f?kw=",
    "/f?kw=%GG",
    "/f?kw=%B5",
    "/f?kw=%EF%BF%BD",
    "/f?kw=%E7%94&ie=utf-8",
    "/f?kw=%E7%94&ie=UTF8",
    gbk + "&ie=utf-8",
    "/f?kw=测试&kw=其他",
    "/f?kw=测试&%6bw=其他",
    "/p/123?kw=测试",
    "http://tieba.baidu.com/f?kw=测试",
    "https://x@tieba.baidu.com/f?kw=测试",
    "https://tieba.baidu.com:8443/f?kw=测试",
    "https://tieba.baidu.com.evil.invalid/f?kw=测试",
  ])
    assert.equal(
      decodeTiebaForumUrlName(value, { allowRelative: true }),
      null,
      value,
    );
  for (const suffix of [
    "?kw=%E7%94&ie=utf-8",
    "?kw=%EF%BF%BD",
    "?kw=测试&kw=其他",
  ])
    assert.throws(() =>
      tiebaForumInputName("https://tieba.baidu.com/f" + suffix),
    );
});
