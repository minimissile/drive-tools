import test from "node:test";
import assert from "node:assert/strict";
import { parseClipboardTable } from "../src/lib/clipboard-table";
test("Excel复制保留引号单元格中的换行、制表符及转义引号", () => {
  assert.deepEqual(
    parseClipboardTable(
      '名称\t链接\t分类\t描述\r\n资料\thttps://pan.baidu.com/s/abc\t办公\t"包含第一部分\n第二部分\t及""案例"""\r\n',
    ),
    [
      ["名称", "链接", "分类", "描述"],
      [
        "资料",
        "https://pan.baidu.com/s/abc",
        "办公",
        '包含第一部分\n第二部分\t及"案例"',
      ],
    ],
  );
  assert.throws(() => parseClipboardTable('资料\t"未闭合'), /未闭合/);
  assert.throws(() => parseClipboardTable("a".repeat(500001)), /过大/);
});
