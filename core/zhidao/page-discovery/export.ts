import { csv } from "../../csv";
import type { PageDiscoveryRun } from "../../../shared/zhidao-page-discovery";
import { collectionDriveLabels } from "../../../shared/resource-collection";

export function exportDiscoveredPages(
  run: PageDiscoveryRun,
  format: "json" | "csv",
) {
  if (format === "json")
    return Buffer.from(
      JSON.stringify(
        {
          id: run.id,
          status: run.status,
          message: run.message,
          input: run.input,
          checked: run.checked,
          failed: run.failed,
          items: run.items,
          logs: run.logs,
        },
        null,
        2,
      ),
      "utf8",
    );
  return Buffer.from(
    csv([
      [
        "问题标题",
        "回答页",
        "问题页",
        "关键词",
        "来源",
        "回答正文",
        "网盘类型",
        "网盘链接",
        "提取码",
        "发现时间",
      ],
      ...run.items.flatMap((item) =>
        item.links.map((link) => [
          item.title,
          item.answerUrl,
          item.questionUrl,
          item.keyword,
          item.origin === "search" ? "关键词检索" : "指定页面",
          item.answer,
          collectionDriveLabels[link.provider],
          link.url,
          link.code,
          item.foundAt,
        ]),
      ),
    ]),
    "utf8",
  );
}
