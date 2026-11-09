import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWechatTrafficWords,
  wechatTrafficWordsInput,
  wechatTrafficWordUsage,
  planWechatTrafficWords,
} from "../shared/wechat-traffic-words";
import { Database } from "../core/database";
import {
  recordWechatTrafficWords,
  wechatTrafficWordPlan,
} from "../core/wechat/traffic-word-history";

test("流量词按行去空白与重复项，保留词组和首次大小写", () => {
  assert.deepEqual(
    normalizeWechatTrafficWords(
      " 电子版 \r\n\n电子版\rJava  教程\nJAVA 教程\nC#\nnode_js ",
    ),
    ["电子版", "Java 教程", "C#", "node_js"],
  );
  assert.deepEqual(wechatTrafficWordsInput.parse(Array(1100).fill("电子版")), [
    "电子版",
  ]);
  assert.deepEqual(wechatTrafficWordsInput.parse(["  ", "\n"]), []);
});

test("流量词只限制去重后的数量，并拒绝超长词而非截断", () => {
  assert(
    wechatTrafficWordsInput.safeParse(
      Array.from({ length: 100 }, (_, i) => `词${i}`),
    ).success,
  );
  assert(
    !wechatTrafficWordsInput.safeParse(
      Array.from({ length: 101 }, (_, i) => `词${i}`),
    ).success,
  );
  assert(!wechatTrafficWordsInput.safeParse(["词".repeat(81)]).success);
});

test("流量词覆盖统计只计算标题和正文，不把网盘地址与图片说明当作使用", () => {
  const usage = wechatTrafficWordUsage(
    ["电子版", "Java 教程", "C#", "node_js", "hidden", "图片词", "参考"],
    "电子版 Java 教程",
    "## 参考\n\n使用 **C#** 和 `node_js`。\n\n![图片词](https://example.com/hidden.png)\n\n[下载](https://example.com/hidden)",
  );
  assert.deepEqual(usage.used, [
    "电子版",
    "Java 教程",
    "C#",
    "node_js",
    "参考",
  ]);
  assert.deepEqual(usage.unused, ["hidden", "图片词"]);
});

test("流量词每轮全部保留可用，未覆盖词优先且核心词可复用", () => {
  const words = ["核心词", "长尾甲", "长尾乙"];
  const plan = planWechatTrafficWords(words, [
    { word: "核心词", uses: 2 },
    { word: "长尾甲", uses: 1 },
  ]);
  assert.deepEqual(plan.priorityWords, ["长尾乙"]);
  assert.deepEqual(plan.coveredWords, ["核心词", "长尾甲"]);
  assert.deepEqual(
    plan.usage.map((item) => item.word),
    words,
  );
  assert.equal(plan.mode, "uncovered");
  const rotated = planWechatTrafficWords(words, [
    { word: "核心词", uses: 3 },
    { word: "长尾甲", uses: 1 },
    { word: "长尾乙", uses: 2 },
  ]);
  assert.equal(rotated.mode, "least-used");
  assert.deepEqual(rotated.priorityWords, ["长尾甲"]);
  assert.deepEqual(planWechatTrafficWords([]).priorityWords, []);
});

test("同一原文的跟踪参数不拆分覆盖历史，不同原文分别统计", () => {
  const db = new Database(":memory:");
  try {
    const words = ["核心词", "长尾词"];
    recordWechatTrafficWords(
      db,
      "https://mp.weixin.qq.com/s/article-one?scene=1#foo",
      words,
      "核心词",
      "核心词 核心词",
    );
    assert.deepEqual(
      wechatTrafficWordPlan(
        db,
        "https://mp.weixin.qq.com/s/article-one?scene=8",
        words,
      ).usage,
      [
        { word: "核心词", uses: 1 },
        { word: "长尾词", uses: 0 },
      ],
    );
    assert.deepEqual(
      wechatTrafficWordPlan(db, "https://mp.weixin.qq.com/s/another", words)
        .priorityWords,
      words,
    );
    recordWechatTrafficWords(
      db,
      "https://mp.weixin.qq.com/s?__biz=biz&mid=2&idx=1&sn=abc&scene=1",
      words,
      "长尾词",
      "",
    );
    assert.deepEqual(
      wechatTrafficWordPlan(
        db,
        "https://mp.weixin.qq.com/s?sn=abc&idx=1&mid=2&__biz=biz&scene=2",
        words,
      ).coveredWords,
      ["长尾词"],
    );
    assert.equal(
      wechatTrafficWordPlan(
        db,
        "https://mp.weixin.qq.com/s?__biz=biz&mid=2&idx=2&sn=other",
        words,
      ).coveredWords.length,
      0,
    );
  } finally {
    db.close();
  }
});

test("流量词去除每行首尾半角、全角及制表空白后去重，保留词内分隔", () => {
  assert.deepEqual(
    normalizeWechatTrafficWords(
      "　 七宗罪测试 \t\n七宗罪测试\n\t 七宗罪 测试免费　\n ",
    ),
    ["七宗罪测试", "七宗罪 测试免费"],
  );
});
